# omp-chatgpt-pro-consult

OMP extension for asking ChatGPT Pro through a visible cmux browser session and returning the answer as Markdown. This uses the ChatGPT web UI in cmux, not the OpenAI API.

## Tool

- `chatgpt_pro_consult` selects Pro mode, submits one prompt to ChatGPT, waits for completion, and returns the response Markdown.

Parameters:

| Parameter | Required | Description |
| --- | --- | --- |
| `prompt` | Yes | Prompt to send to ChatGPT Pro. Empty prompts are rejected. |
| `zip_path` | No | Absolute or relative path to one local `.zip` file to upload before submitting the prompt. The path is resolved on the host running the extension. |
| `thread` | No | `new` opens a fresh ChatGPT thread. `current` uses the selected/current ChatGPT surface. Defaults to `new`. |
| `keep_surface` | No | Keeps the cmux browser surface open after completion. |

The tool returns Markdown as text content and structured details with status, warnings, thread, surface information, and any blocker or error details. It reports blockers/details for login requirements, action-required UI such as CAPTCHA/modals/rate limits, selector drift, timeouts, and a missing current ChatGPT surface when `thread: "current"` has no selected ChatGPT tab.

## Progress and timeout

Each consult runs in the foreground under a fixed, non-configurable 120-minute overall ceiling. While it runs, the tool emits transient `preparing`, `submitting`, and `waiting` status updates, and refreshes the current status every 15 seconds with elapsed time. These updates are status-only: they do not expose partial ChatGPT output, a completion percentage, or an ETA.

`Prompt submission initiated` is a fail-closed possible-submission boundary: once reported, the prompt may already have reached ChatGPT, so the extension does not retry the submission. OMP cancellation aborts the underlying browser and consult work. A timeout or other failure after this possible-submission boundary leaves the ChatGPT surface open and reports its `surfaceRef` for inspection.

## Privacy and safety

- Uses a visible ChatGPT browser surface managed by cmux.
- Does not call hidden ChatGPT endpoints.
- Does not scrape cookies, localStorage, access tokens, or other browser credentials.
- Requires the user to already be logged into ChatGPT in the cmux browser profile and to have ChatGPT Pro access.

## Surface lifecycle

Extension-owned surfaces close after a successful consult by default. `keep_surface` forces retention. Failures after prompt submission leave the surface open with `surfaceRef`, and login/action-required/rate-limit blockers also leave the surface open so the user can intervene. ZIP upload processing or upload-permission blockers leave the surface open; local ZIP preflight failures such as missing files do not. A missing current surface is a preflight blocker and does not keep an extension-owned surface open.

## Development

```sh
bun --cwd extensions/chatgpt-pro-consult test
bun --cwd extensions/chatgpt-pro-consult check
```

Manual live smoke is intentionally separate from `check` because it depends on the local cmux browser state, a logged-in ChatGPT session, and Pro access:

```sh
bun --cwd extensions/chatgpt-pro-consult smoke -- --prompt "Reply with exactly: omp smoke ok"
```

Upload a single ZIP during smoke:

```sh
bun --cwd extensions/chatgpt-pro-consult smoke -- --zip-path /absolute/path/context.zip --prompt "Inspect the uploaded zip and summarize it."
```
