---
name: using-dynamic-workflows
description: Use when writing or deciding to call the OMP dynamic workflow tool for workflows, fan-out, multi-agent orchestration, large audits, multi-perspective review, repository research, or structured subagent output.
---

# Using Dynamic Workflows

## Overview

Use the `workflow` tool to run deterministic JavaScript that coordinates isolated OMP subagents, shows live phase progress, and returns compact fan-in results.

Prefer it when the task decomposes into independent branches or staged item processing. Avoid it for a single quick read/edit, one-off shell command, or work that needs shared mutable state between branches.

## Script Contract

- Pass raw JavaScript in `script`; no Markdown fences.
- First statement must be literal metadata:

```js
export const meta = { name: 'short_snake_case', description: 'non-empty description' }
```

- Call `agent()` at least once.
- Available globals: `agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`, `cwd`, `process.cwd()`, `budget`.
- Do not use imports, `require()`, TypeScript syntax, `Date.now()`, `Math.random()`, or `new Date()`.

## Patterns

| Need | Pattern |
| --- | --- |
| Parallel fan-out | `await parallel(items.map(item => () => agent(prompt, { label })))` |
| Ordered staged work | `await pipeline(items, stage1, stage2)` |
| Progress grouping | Call `phase('Name')` when each runtime group starts |
| Machine-readable subagent result | `agent(prompt, opts)` with `opts.schema`; subagent must use OMP `yield` |
| Branch failures | `agent`, `parallel`, and `pipeline` return `null` for failed non-aborted branches |
| Final answer | Return compact JSON-serializable data, usually `{ ok, ... }` |

`parallel()` takes functions, not promises. Never write `parallel(items.map(item => agent(...)))`.

Every `agent()` call should include a unique short `label`, and every prompt must include enough context because subagents do not inherit the parent assistant's file reads or reasoning.

## Complete Example

```js
export const meta = { name: 'review_modules', description: 'Inspect modules in parallel and synthesize risks' }

const modules = args.modules ?? ['src/api.ts', 'src/db.ts']

phase('Inspect')
const findings = await parallel(modules.map((path, index) => () => agent(
  `Inspect ${path} for correctness risks. Return concise findings only.`,
  { label: `inspect ${index + 1}` },
)))

const usable = findings.filter(Boolean)
if (usable.length !== findings.length) {
  return { ok: false, findings, error: 'one or more inspection branches failed' }
}

phase('Synthesize')
const summary = await agent(
  `Synthesize these findings into the top risks and fixes: ${JSON.stringify(usable)}`,
  { label: 'risk synthesis' },
)

return { ok: Boolean(summary), findings: usable, summary }
```

## Structured Output Example

```js
const result = await agent('Return severity and title through yield.', {
  label: 'structured check',
  schema: {
    type: 'object',
    required: ['severity', 'title'],
    properties: {
      severity: { type: 'string', enum: ['low', 'medium', 'high'] },
      title: { type: 'string' },
    },
    additionalProperties: false,
  },
})
```

## Common Mistakes

- Using workflow for non-decomposable work; use ordinary tools instead.
- Passing promises to `parallel()` instead of thunks.
- Omitting labels, making live status unreadable.
- Synthesizing without checking for `null` failed branches.
- Returning large transcripts instead of compact results.
