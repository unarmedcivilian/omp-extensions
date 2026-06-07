# omp-generative-ui

Generative UI extension for OMP. It ports `pi-generative-ui` to OMP and renders HTML/SVG widgets in cmux browser surfaces instead of Glimpse.

## Tools

- `visualize_read_me` loads design guidance for widget generation.
- `show_widget` streams an HTML/SVG fragment into a cmux browser surface.

Widgets can call `sendPrompt(text)` from explicit user-triggered handlers. The extension queues the text as a visible OMP follow-up user message with widget provenance.

Calls to `show_widget` with the same `title` update the existing live cmux surface. Use `new_surface: true` when you intentionally want a separate window with the same title.

## Install

Add this package as an OMP extension package. Its manifest exposes:

```json
{
  "omp": { "extensions": ["./src/index.ts"] }
}
```

Requires `cmux` on `PATH` and Bun `>=1.3.14`.
