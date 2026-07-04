# omp-extensions

Extensions for OMP, the Oh My Pi coding-agent harness.

This repository is a Bun workspace. Each extension lives under `extensions/*` as its own package and exposes OMP entry
points through `package.json#omp.extensions`.

## Packages

### `omp-accordion`

Path: `extensions/accordion`

Adds a browser-only Accordion live context map for OMP sessions:

- `/accordion` starts the session-scoped HTTP/WebSocket server and opens or reports a tokenized cmux browser URL.
- `accordion_unfold` restores folded `{#<code> FOLDED}` blocks into standing context on the next turn.
- `accordion_recall` returns folded block content in the current tool result without changing standing context.

The OMP port intentionally drops the legacy desktop/Tauri launcher and `~/.accordion` registry/focus files. The browser
client connects directly to the extension-owned loopback server for the current OMP session.

### `omp-generative-ui`

Path: `extensions/generative-ui`

Adds four OMP tools:

- `widget_read_guidelines` returns design guidance for visual widgets.
- `widget_show` renders HTML/SVG fragments in a cmux browser surface.
- `widget_save_html` writes the latest widget fragment to disk.
- `widget_save_screenshot` captures a live widget PNG through `cmux browser screenshot`.

`widget_show` streams generated markup into a local widget runtime, opens the runtime through the cmux Unix socket API
with CLI fallback, and bridges browser-to-host RPC over a local WebSocket. Widgets may call `sendPrompt(text)` from
explicit user actions; the extension queues those prompts with widget provenance through
`pi.sendUserMessage(..., { deliverAs: "followUp" })`.

Calls with the same widget title reuse the existing live surface. Set `new_surface: true` only when a separate browser
surface is intentional.

Widget artifacts default to `artifacts/widgets/<title>.html` and `artifacts/widgets/<title>.png` when `output_path` is
omitted.

### `omp-chatgpt-links`

Path: `extensions/chatgpt-links`

Adds one OMP tool:

- `chatgpt_import_conversation` opens a ChatGPT conversation URL or bare id in cmux browser via the Unix socket API with
  CLI fallback, waits for load, extracts page text, and saves it to disk.

The tool assumes the user is already logged into ChatGPT in the cmux browser profile. Conversation imports default to
`artifacts/chatgpt/<conversation-id>.txt`.

### `omp-chatgpt-pro-consult`

Path: `extensions/chatgpt-pro-consult`

Adds one OMP tool:

- `chatgpt_pro_consult` submits one prompt to ChatGPT Pro through a visible cmux browser session, selects Pro
  mode, waits for completion, and returns Markdown with structured status/blocker details.

The tool uses the ChatGPT web UI in cmux, not the OpenAI API. It requires the user to be logged into ChatGPT with Pro
access in the cmux browser profile. Extension-owned surfaces close after success by default; `keep_surface`,
post-submission failures, and login/action-required/rate-limit blockers retain the surface and report `surfaceRef`.

### `omp-dynamic-workflows`

Path: `extensions/dynamic-workflows`

Adds one OMP tool:

- `workflow` executes deterministic JavaScript workflows that orchestrate isolated OMP subagents with `agent()`,
  `parallel()`, and `pipeline()`.

Workflow scripts must start with literal `export const meta = { name, description }`. Runtime `phase(...)` calls drive
compact progress updates, and schema-based subagent output uses OMP's built-in `yield` tool.

PI-to-OMP migration notes are documented in `extensions/dynamic-workflows/PORTING.md`.

### `omp-subagent-preview`

Path: `extensions/subagent-preview`

Adds a live cmux browser dashboard for OMP task subagents. The dashboard opens on first subagent spawn, streams compact progress and transcript summaries, and can be controlled with `/subagent-preview`.

## OMP extension API references

Primary local references live in `reference/oh-my-pi/docs`:

- `extensions.md` — `ExtensionAPI`, tool registration, event surfaces, runtime constraints.
- `extension-loading.md` — discovery order, package manifest resolution, de-duplication.
- `skills/authoring-extensions.md` — practical extension authoring guide.
- `hooks.md` — event payloads and hook/extension relationship.

Key rules from the OMP API:

- Export a default factory receiving `ExtensionAPI`.
- Register tools, commands, handlers, and renderers during extension load.
- Do not call runtime actions like `pi.sendMessage()` during module load; use event handlers, tools, or commands.
- Use `pi.zod` for tool parameter schemas.
- Tool `execute` receives `(toolCallId, params, signal, onUpdate, ctx)` and returns an `AgentToolResult` with `content`
  and optional structured `details`.
- Clean up sessions and external resources from `session_shutdown`.

## Development

Install dependencies:

```sh
bun install
```

Run all checks:

```sh
bun run check
```

Run one extension check:

```sh
bun --cwd extensions/accordion check
bun --cwd extensions/generative-ui check
bun --cwd extensions/chatgpt-links check
bun --cwd extensions/dynamic-workflows check
bun --cwd extensions/chatgpt-pro-consult check
bun --cwd extensions/subagent-preview check
```

Run one extension's tests:

```sh
bun --cwd extensions/accordion test
bun --cwd extensions/dynamic-workflows test
bun --cwd extensions/generative-ui test
bun --cwd extensions/chatgpt-links test
bun --cwd extensions/subagent-preview test
bun --cwd extensions/chatgpt-pro-consult test
```

Run the ChatGPT Pro consult live smoke manually only when the cmux browser is available and logged into a ChatGPT Pro
account; it is not part of the repository or extension `check` scripts:

```sh
bun --cwd extensions/chatgpt-pro-consult smoke -- --prompt "Reply with exactly: omp smoke ok"
```

Rebuild the browser runtime bundle after changing files under `extensions/generative-ui/src/runtime`:

```sh
bun --cwd extensions/generative-ui run build:runtime
```

Rebuild Accordion's packaged browser client after changing files under `extensions/accordion/src/client`:

```sh
bun --cwd extensions/accordion build:client
```

## Loading an extension locally


The package manifest exposes the extension entry point:

```json
{
  "omp": {
    "extensions": [
      "./src/index.ts"
    ]
  }
}
```

OMP can load extension packages via configured extension paths or plugin installation. See
`reference/oh-my-pi/docs/extension-loading.md` for exact discovery and precedence rules.
