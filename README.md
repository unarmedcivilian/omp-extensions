# omp-extensions

Extensions for OMP, the Oh My Pi coding-agent harness.

This repository is a Bun workspace. Each extension lives under `extensions/*` as its own package and exposes OMP entry
points through `package.json#omp.extensions`.

## Packages

### `omp-generative-ui`

Path: `extensions/generative-ui`

Adds four OMP tools:

- `widget_read_guidelines` returns design guidance for visual widgets.
- `widget_show` renders HTML/SVG fragments in a cmux browser surface.
- `widget_save_html` writes the latest widget fragment to disk.
- `widget_save_screenshot` captures a live widget PNG through `cmux browser screenshot`.

`widget_show` streams generated markup into a local widget runtime, opens the runtime through the cmux Unix socket API with CLI fallback, and bridges browser-to-host RPC over a local WebSocket. Widgets may call `sendPrompt(text)` from explicit user actions; the extension queues those prompts with widget provenance through `pi.sendUserMessage(..., { deliverAs: "followUp" })`.

Calls with the same widget title reuse the existing live surface. Set `new_surface: true` only when a separate browser
surface is intentional.

Widget artifacts default to `artifacts/widgets/<title>.html` and `artifacts/widgets/<title>.png` when `output_path` is omitted.

### `omp-chatgpt-links`

Path: `extensions/chatgpt-links`

Adds one OMP tool:

- `chatgpt_import_conversation` opens a ChatGPT conversation URL or bare id in cmux browser, waits for load, extracts page text with `cmux browser get text`, and saves it to disk.

The tool assumes the user is already logged into ChatGPT in the cmux browser profile. Conversation imports default to `artifacts/chatgpt/<conversation-id>.txt`.

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

Run only the generative UI extension checks:

```sh
bun --cwd extensions/generative-ui check
```

Run only extension tests:

```sh
bun --cwd extensions/generative-ui test
```

Rebuild the browser runtime bundle after changing files under `extensions/generative-ui/src/runtime`:

```sh
bun --cwd extensions/generative-ui run build:runtime
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
