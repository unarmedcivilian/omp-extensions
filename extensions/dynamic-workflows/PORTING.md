# Porting PI dynamic workflows to OMP

This package ports `reference/pi-dynamic-workflows` from the PI extension runtime to the OMP extension runtime.

## Required API changes

- Package identity: rename from `pi-dynamic-workflows` to `omp-dynamic-workflows`; publish as an OMP package with `package.json#omp.extensions` instead of `package.json#pi.extensions`.
- Imports: use OMP packages under `@oh-my-pi/*` for public types; access runtime SDK functions through injected `ExtensionAPI.pi` so tests and package loading do not require direct host-package imports.
- Extension factory: keep a default factory receiving `ExtensionAPI`; register tools during factory execution only.
- Runtime actions: do not call `pi.getActiveTools()` or `pi.setActiveTools()` during module load. Activate the `workflow` tool from `session_start`, and `await pi.setActiveTools(...)` because OMP returns a promise.
- Tool schema: author OMP tool parameters with injected `pi.zod`; do not import TypeBox for the parent `workflow` tool.
- Tool contract: OMP tool `execute` is `(toolCallId, params, signal, onUpdate, ctx)` and returns `AgentToolResult` with user-visible `content` plus machine-readable `details`.
- Tool compatibility: OMP `ToolDefinition` does not expose PI's `prepareArguments`; normalize fenced workflow scripts inside `execute` after schema validation.
- Prompt guidance: retain PI-style `promptSnippet` / `promptGuidelines` as local tool metadata, but surface OMP-visible model guidance through a hidden one-time `before_agent_start` message.
- Subagent sessions: replace PI `createCodingTools(...)`/custom structured-output tool wiring with OMP `createAgentSession(...)`, built-in tools, in-memory `SessionManager`, and `outputSchema` + `requireYieldTool` when structured output is requested.
- Structured subagent output: replace the PI-specific `structured_output` tool with OMP's built-in `yield` tool. Extract successful `yield` tool-result `details.data` from the subagent session log.
- Rendering: keep compact workflow text rendering, but return a minimal OMP TUI `Component` instead of importing PI `Text` at module load.
- Abort handling: wire the parent `AbortSignal` to `session.abort()` and always dispose subagent sessions.
- Docs: update user-facing examples from `pi install`/`/reload` to OMP package loading and update IntelliSense references to `omp-dynamic-workflows/workflow`.

## Behavior to preserve

- Register one active `workflow` tool.
- Require a raw JavaScript script whose first statement is literal `export const meta = { name, description }`.
- Keep deterministic workflow parsing: reject dynamic metadata, `Date.now()`, `new Date()`, and `Math.random()`.
- Expose workflow globals: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, `process.cwd()`, and `budget`.
- Stream compact progress snapshots through tool updates.
- Treat runtime phases as dynamic; `meta.phases` remains optional documentation.
- Return `null` for failed non-aborted agent, `parallel`, or `pipeline` branches and log the failure.
- Throw on workflows that never call `agent()`.
