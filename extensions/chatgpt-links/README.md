# omp-chatgpt-links

OMP extension for importing ChatGPT conversation links through cmux browser.

## Tool

- `chatgpt_import_conversation` opens a ChatGPT conversation URL or bare conversation id in cmux browser via the Unix socket API with CLI fallback, waits for the page to load, extracts `main` text, and saves it to disk.

The tool assumes the user is already logged into ChatGPT in the cmux browser profile. If ChatGPT shows a login wall or extraction returns no text, the browser surface is left open for debugging.

Default output path: `artifacts/chatgpt/<conversation-id>.txt`.

## Development

```sh
bun --cwd extensions/chatgpt-links test
bun --cwd extensions/chatgpt-links check
```
