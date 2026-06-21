# omp-dynamic-workflows

Dynamic multi-agent workflows for OMP.

This OMP extension adds a `workflow` tool. The model writes a small deterministic JavaScript script that fans out work across isolated OMP subagent sessions, then synthesizes the result.

Useful for codebase audits, multi-perspective review, large refactors, and fan-out research.

## Loading

Install or load this package as an OMP extension package. Its manifest exposes the entry point through `package.json#omp.extensions`:

```json
{
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

For local development, point OMP at `extensions/dynamic-workflows` through your OMP extension configuration or CLI extension path. Restart or reload the session runtime after changing extension code.

## Tool

The extension registers one tool:

- `workflow` — execute a deterministic JavaScript workflow using `agent()`, `parallel()`, and `pipeline()`.

The tool is registered as default-inactive and activated on `session_start` so existing active-tool lists keep their order and gain `workflow` exactly once.

The package also ships an on-demand skill, `skill://using-dynamic-workflows`, for nontrivial workflow scripts and multi-agent orchestration patterns.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [{ title: 'Scan' }, { title: 'Analyze' }],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent('Summarize the main modules from this inventory:\n' + inventory, {
  label: 'module summary',
})

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. Skipped branches do not render empty phase rows.

### Editor IntelliSense

Reusable workflow files can opt into editor hints:

```js
/// <reference types="omp-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, `process.cwd()`, and `budget`.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated OMP subagent. Returns final text or, with `opts.schema`, a schema-validated value returned through OMP's `yield` tool. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(previous, original, index)`. |
| `phase(title)` | Mark the current phase for live progress grouping. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed through the workflow tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for workflow and subagents. |
| `budget` | `{ total, spent(), remaining() }` token-budget estimate. |

### Determinism rules

Workflow scripts run inside a Node `vm` sandbox. These are intentionally unavailable or rejected:

- `Date.now()`, `new Date()`, and `Math.random()`
- `require`, `import`, `fs`, and network APIs
- spreads, computed keys, template interpolation, and function calls inside `meta`

This keeps metadata parseable, workflow runs reproducible, and the sandbox surface small.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent returns a validated value:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under OMP, schema mode uses the built-in hidden `yield` tool with `outputSchema` and `requireYieldTool`; the workflow extracts `yield` result data from the subagent session log.

## Package modules

| File | Purpose |
| --- | --- |
| `src/index.ts` | OMP extension factory and public exports. |
| `src/workflow-tool.ts` | `workflow` tool schema, guidance, progress updates, rendering, and abort mapping. |
| `src/workflow.ts` | Literal metadata parser and sandboxed workflow runtime. |
| `src/agent.ts` | OMP subagent session runner. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `types/workflow.d.ts` | Ambient workflow globals for editor IntelliSense. |
| `PORTING.md` | PI-to-OMP migration notes and required API changes. |

`WorkflowAgent` has no direct runtime import of the OMP host package; extension code passes `ExtensionAPI.pi` as the SDK dependency. Standalone callers must provide the same SDK exports.

## Development

```sh
bun --cwd extensions/dynamic-workflows test
bun --cwd extensions/dynamic-workflows check
```

## Status

Prototype port. It implements the core workflow primitive: script parsing, subagents, parallel/pipeline, dynamic phases, abort handling, structured output, and compact progress rendering. It does not implement persisted or resumable workflow runs.
