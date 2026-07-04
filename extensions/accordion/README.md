# omp-accordion

Browser-only Accordion live context map for OMP.

Accordion shows the current OMP session context in a browser surface, lets the browser client return fold/group plans during OMP `context` hooks, and exposes tools that let the agent recover folded content by code.

## What changed from the Pi extension

This OMP package intentionally ports the core live-context behavior only:

- No Tauri/desktop launcher.
- No `~/.accordion/sessions/*.json` registry files.
- No `~/.accordion/focus.json` focus handoff.
- No generic legacy `unfold` or `recall` tool names.

The OMP extension owns one session-scoped loopback HTTP/WebSocket server. `/accordion` opens the tokenized browser URL through cmux when the cmux Unix socket is available; otherwise it reports the URL for manual opening.

## Commands and tools

### `/accordion`

Starts or reuses the Accordion session for the current OMP process and opens/reports the browser URL.

### `accordion_unfold`

Input:

```json
{ "codes": ["abc123"] }
```

Use codes copied from `{#<code> FOLDED}` markers. The browser restores matching folded blocks into the next turn's standing context. Tool output lists restored and missing codes but does not echo full restored content.

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

Run the package tests and build check:

```sh
bun --cwd extensions/accordion test
bun --cwd extensions/accordion check
```

Rebuild the packaged browser client after changing files under `src/client`:

```sh
bun --cwd extensions/accordion build:client
```
