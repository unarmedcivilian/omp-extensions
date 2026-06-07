# omp-generative-ui

Generative UI extension for OMP. It ports `pi-generative-ui` to OMP and renders HTML/SVG widgets in cmux browser surfaces instead of Glimpse.

## Tools

- `widget_read_guidelines` loads design guidance for widget generation.
- `widget_show` streams an HTML/SVG fragment into a cmux browser surface.
- `widget_save_html` writes the latest widget fragment to disk.
- `widget_save_screenshot` captures a live widget PNG through `cmux browser screenshot`.

Widgets can call `sendPrompt(text)` from explicit user-triggered handlers. The extension queues the text as a visible OMP follow-up user message with widget provenance.

Calls to `widget_show` with the same `title` update the existing live cmux surface. Use `new_surface: true` when you intentionally want a separate window with the same title.

Save tools accept `title` and optional `output_path`. Defaults are `artifacts/widgets/<title>.html` and `artifacts/widgets/<title>.png`.

## Install

Add this package as an OMP extension package. Its manifest exposes:

```json
{
  "omp": { "extensions": ["./src/index.ts"] }
}
```

Requires cmux socket access or `cmux` on `PATH` for fallback, plus Bun `>=1.3.14`.
