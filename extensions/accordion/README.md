# omp-accordion

Source-preserved Accordion live context map and conductor UI for OMP.

Accordion serves the original Svelte Accordion app from this package, connects it to the current OMP session over the extension-owned loopback WebSocket, lets the app return fold/group plans during OMP `context` hooks, and exposes tools that let the agent recover folded content by code.

## What changed from the Pi extension

This OMP package keeps the original browser app, live protocol, mapping code, store, and in-process conductor source under `src/app` and `src/conductors`. The OMP-specific layer is the extension host boundary:

- default OMP extension factory using `@oh-my-pi/pi-coding-agent`
- OMP command/tool/hook registration
- session-scoped loopback HTTP/WebSocket server
- cmux browser opening with manual URL fallback
- OMP model completion relay for conductor summaries
- `session_shutdown` cleanup

The port intentionally does not launch the legacy Tauri desktop app and does not write `~/.accordion/sessions/*.json` or `~/.accordion/focus.json`. Browser-served mode connects directly to the loopback server that served the page.

The live header and conductor pressure use OMP's host-reported context usage when available. That total includes system/developer/tool/runtime overhead outside Accordion's block list; the UI also shows total Accordion block usage and the provider-safe non-tail foldable block usage so fold savings remain visible.

The browser UI snapshots same-session live state in `sessionStorage`: hard-refreshing or reopening the Accordion page for the same OMP session restores the armed folding switch, budget/protect settings, manual folds/pins, and valid groups before the next fold plan is sent. Snapshots are keyed by OMP session id and are not reused across sessions.

## Commands and tools

### `/accordion`

Starts or reuses the Accordion session for the current OMP process and opens/reports the tokenized browser URL.

### `accordion_unfold`

Input:

```json
{ "codes": ["abc123"] }
```

Use codes copied from `{#<code> FOLDED}` markers. The browser app resolves matching folded blocks in its live store and marks them unfolded for the next OMP context pass. Tool output lists restored and missing codes but does not echo full restored content.

### `accordion_recall`

Input:

```json
{ "codes": ["abc123"] }
```

Reads matching folded blocks into the current tool result without changing standing context.

## Packaged skills

The extension exposes two skills through `resources_discover`:

- `accordion-context-folding` tells agents how to use `accordion_unfold`.
- `accordion-context-recall` tells agents how to use `accordion_recall`.

## Development

Run the OMP extension tests, source app tests, and build/type check:

```sh
bun --cwd extensions/accordion test
bun --cwd extensions/accordion test:app
bun --cwd extensions/accordion check
```

Rebuild the packaged browser client after changing files under `src/app` or `src/conductors`:

```sh
bun --cwd extensions/accordion build:client
```
