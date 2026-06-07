# Agent instructions

This repo contains OMP extension packages for the Oh My Pi coding-agent harness.

## Project shape

- Root package is a private Bun workspace host.
- Extension packages live under `extensions/*`.
- `extensions/generative-ui` publishes `omp-generative-ui` and declares its OMP entry point in
  `package.json#omp.extensions`.
- `extensions/chatgpt-links` publishes `omp-chatgpt-links` and declares its OMP entry point in
  `package.json#omp.extensions`.
- Local OMP API documentation is under `reference/oh-my-pi/docs`.

## OMP extension API rules

Use the current `ExtensionAPI` references before changing extension code:

- `reference/oh-my-pi/docs/extensions.md`
- `reference/oh-my-pi/docs/extension-loading.md`
- `reference/oh-my-pi/docs/skills/authoring-extensions.md`
- `reference/oh-my-pi/docs/hooks.md` for event details

Follow these API constraints:

- Export a default factory that receives `ExtensionAPI` from `@oh-my-pi/pi-coding-agent`.
- Register tools, event handlers, commands, renderers, labels, and flags during factory execution.
- Do not call runtime actions during module load. Runtime actions include `pi.sendMessage`, `pi.sendUserMessage`,
  `pi.appendEntry`, `pi.exec`, active-tool mutation, model/session mutation, and similar methods that require an
  initialized runner.
- Perform runtime work only inside event handlers, tool `execute` callbacks, or command handlers.
- Use `pi.zod` for tool parameter schemas.
- Tool names must be unique snake_case. Tool labels should be human-readable.
- Tool `execute` has the shape `(toolCallId, params, signal, onUpdate, ctx)` and must return an `AgentToolResult`.
- Respect `AbortSignal` in long-running tool code and external process calls.
- Return user-visible text in `content` and machine-readable state in `details`.
- Clean up long-lived resources in `session_shutdown`.
- Event handlers should be defensive: `tool_call` failures are fail-closed and can block tool execution.

## Generative UI extension conventions

For `extensions/generative-ui`:

- `src/index.ts` owns OMP tool registration and session lifecycle wiring.
- `src/session.ts` owns widget session state and content flushing.
- `src/surface.ts` owns local runtime serving, WebSocket attachment, and cmux surface lifecycle.
- `src/cmux.ts` owns the cmux transport. Prefer the Unix socket API for latency and keep CLI fallback for socket-unavailable environments.
- `src/runtime/**` is browser-side code. Rebuild `src/runtime.bundle.ts` after runtime changes.
- `src/protocol.ts` defines the host/page message contract. Update both host and runtime tests when changing it.
- Browser-originated WebSocket close must not call `surface.close`/`cmux close-surface`; only host-initiated cleanup should close cmux surfaces.
- Repeated `widget_show` calls with the same normalized title should reuse the existing session unless
  `new_surface: true` is set.
- `sendPrompt(text)` may only be exposed for explicit widget user actions and should route through
  `pi.sendUserMessage(..., { deliverAs: "followUp" })` with widget provenance.
- Keep extension install idempotent for a given `ExtensionAPI` instance; duplicate registration can duplicate hidden
  guidance and streaming listeners.
- `widget_save_html` should save the exact latest fragment tracked by `WidgetSession`; do not reconstruct markup from browser state.
- `widget_save_screenshot` should target the tracked `surfaceRef` and use `cmux browser screenshot` semantics.

## ChatGPT links extension conventions

For `extensions/chatgpt-links`:

- `src/index.ts` owns OMP tool registration.
- `src/importer.ts` owns URL/id normalization, login-wall detection, extraction validation, and file writes.
- `src/cmux.ts` owns cmux browser CLI automation.
- Assume the user is already logged into ChatGPT in the cmux browser profile; do not add login automation unless explicitly requested.
- Leave the browser surface open when login is required or extraction returns no text so the user can inspect/fix the browser state.
- Default saved conversations belong under `artifacts/chatgpt/<conversation-id>.txt`.


## Build and test

Use Bun commands from the repo root unless noted.

- Full repo check: `bun run check`
- Root workspace tests only: `bun test tests/*.test.ts`
- Generative UI tests only: `bun --cwd extensions/generative-ui test`
- Generative UI full check: `bun --cwd extensions/generative-ui check`
- ChatGPT links tests only: `bun --cwd extensions/chatgpt-links test`
- ChatGPT links full check: `bun --cwd extensions/chatgpt-links check`
- Rebuild browser runtime bundle: `bun --cwd extensions/generative-ui run build:runtime`

Before finishing changes:

1. Run the narrowest tests that cover the changed code.
2. For runtime bundle changes, run `bun --cwd extensions/generative-ui run build:runtime` and include the generated
   `src/runtime.bundle.ts` change.
3. Run `bun run check` before claiming the repo is passing.

## Documentation

- Update the root `README.md` when package-level usage, commands, or extension-loading guidance changes.
- Update package README files when extension-specific tool behavior changes.
- Keep API guidance aligned with `reference/oh-my-pi/docs`; do not document guessed OMP behavior.
