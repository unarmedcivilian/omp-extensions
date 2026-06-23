# omp-chatgpt-pro-consult

OMP extension for asking ChatGPT Pro through a visible cmux browser session and returning the answer as Markdown. This uses the ChatGPT web UI in cmux, not the OpenAI API.

## Tool

- `chatgpt_pro_consult` selects Pro mode, submits one prompt to ChatGPT, waits for completion, and returns the response Markdown.

Parameters:

| Parameter | Required | Description |
| --- | --- | --- |
| `prompt` | Yes | Prompt to send to ChatGPT Pro. Empty prompts are rejected. |
| `thread` | No | `new` opens a fresh ChatGPT thread. `current` uses the selected/current ChatGPT surface. Defaults to `new`. |
| `timeout_ms` | No | Maximum time to spend selecting Pro mode, waiting for the answer, and reading Markdown. |
| `keep_surface` | No | Keeps the cmux browser surface open after completion. |

The tool returns Markdown as text content and structured details with status, warnings, thread, surface information, and any blocker or error details. It reports blockers/details for login requirements, action-required UI such as CAPTCHA/modals/rate limits, selector drift, timeouts, and a missing current ChatGPT surface when `thread: "current"` has no selected ChatGPT tab.

## Privacy and safety

- Uses a visible ChatGPT browser surface managed by cmux.
- Does not call hidden ChatGPT endpoints.
- Does not scrape cookies, localStorage, access tokens, or other browser credentials.
- Requires the user to already be logged into ChatGPT in the cmux browser profile and to have ChatGPT Pro access.

## Surface lifecycle

Extension-owned surfaces close after a successful consult by default. `keep_surface` forces retention. Failures after prompt submission leave the surface open with `surfaceRef`, and login/action-required/rate-limit blockers also leave the surface open so the user can intervene. A missing current surface is a preflight blocker and does not keep an extension-owned surface open.

## Development

```sh
bun --cwd extensions/chatgpt-pro-consult test
bun --cwd extensions/chatgpt-pro-consult check
```

Manual live smoke is intentionally separate from `check` because it depends on the local cmux browser state, a logged-in ChatGPT session, and Pro access:

```sh
bun --cwd extensions/chatgpt-pro-consult smoke -- --prompt "Reply with exactly: omp smoke ok"
```
