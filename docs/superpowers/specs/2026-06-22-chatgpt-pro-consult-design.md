# ChatGPT Pro Consult Extension Design

Date: 2026-06-22

## Goal

Add an OMP extension package that lets the coding agent ask a user-visible ChatGPT Pro session for a single second-opinion response from inside OMP.

The first implementation is a single-consult workflow. File uploads are intentionally deferred to a second pass, but the package boundaries should make uploads a natural extension rather than a rewrite.

## Background

The reference project, [`adamallcock/codex-chatgpt-control`](https://github.com/adamallcock/codex-chatgpt-control), is a visible-session SDK for driving `chatgpt.com`. It is not an OpenAI API wrapper and does not use hidden ChatGPT endpoints.

Relevant SDK traits:

- Browser-required operations need a compatible visible browser bridge.
- The SDK can run through `createChatGPT({ agent: globalThis.agent })` in Codex-style hosts.
- The SDK also accepts a runtime environment with browser/page-like objects, so a cmux-backed adapter can satisfy the needed surface.
- It returns structured `CommandResult` data with blockers such as `browser_bridge_unavailable`, `login_required`, `captcha`, `rate_limit`, `modal`, `permission`, `selector_drift`, and `timeout`-style failures.
- It already owns ChatGPT DOM selectors, mode selection, submit/wait/read behavior, and Markdown response extraction.

Repo conventions:

- Extension packages live under `extensions/*`.
- Packages expose OMP entry points through `package.json#omp.extensions`.
- Extension factories receive `ExtensionAPI` from `@oh-my-pi/pi-coding-agent` and register tools during factory execution.
- Runtime work must happen inside tool `execute` callbacks, event handlers, or command handlers.
- Tool schemas use `pi.zod`.
- Long-running work must respect `AbortSignal`.
- cmux-facing packages prefer the Unix socket API with CLI fallback.

## User-visible feature set

### MVP

Register one tool: `chatgpt_pro_consult`.

The tool submits one prompt to ChatGPT Pro and returns the latest assistant response as Markdown.

Parameters:

- `prompt: string` — required prompt to submit to ChatGPT.
- `thread?: "new" | "current"` — optional, default `new`.
  - `new` opens a fresh ChatGPT conversation.
  - `current` reuses an already-open ChatGPT surface when available.
- `timeout_ms?: number` — optional overall wait budget for submit/wait/read; default should match SDK defaults where practical.
- `keep_surface?: boolean` — optional; when true, leave the cmux browser surface open after a successful run.

Result:

- `content`: assistant Markdown or a clear blocker/error message.
- `details`: structured metadata including status, thread URL/conversation id when known, selected mode candidates, warnings, blocker fields, surface ref, and whether the surface was kept open.

### Second pass

Add file uploads once the consult flow is stable.

Likely additions:

- `files?: string[]` or a separate `chatgpt_pro_consult_with_files` tool.
- Preflight absolute local paths, sizes, duplicate inputs, and extension-derived categories before opening ChatGPT.
- Upload through visible controls only after explicit tool invocation.
- Return permission blockers for missing browser/upload gates; do not retry blindly.

## Non-goals

- No OpenAI API integration.
- No hidden ChatGPT endpoints.
- No account automation, captcha solving, or login automation.
- No automatic disclosure of files or repo content.
- No multi-turn workflows in the MVP.
- No downloads/artifact capture in the MVP.
- No attempt to claim that ChatGPT output is verified truth; the result is a model opinion.

## Recommended architecture

Create a new package at `extensions/chatgpt-pro-consult`.

### Files

- `package.json`
  - Name: `omp-chatgpt-pro-consult`.
  - `type: "module"`.
  - `omp.extensions: ["./src/index.ts"]`.
  - Peer dependency on `@oh-my-pi/pi-coding-agent`.
  - Runtime dependency on `codex-chatgpt-control`.
  - `test` and `check` scripts matching existing extension conventions.

- `src/index.ts`
  - OMP extension factory.
  - Registers `chatgpt_pro_consult`.
  - Supports dependency injection for tests.
  - Uses `pi.zod` for schema.
  - Maps tool params to the consult runner.

- `src/consult.ts`
  - Pure workflow orchestration.
  - Builds a `codex-chatgpt-control` client using the cmux adapter.
  - Selects Pro mode.
  - Opens a new/current thread.
  - Submits the prompt.
  - Waits and reads Markdown.
  - Converts SDK `CommandResult`/run result into OMP tool details.

- `src/cmux.ts`
  - cmux transport helpers.
  - Prefer Unix socket RPC where available.
  - Fall back to CLI commands.
  - Keep enough surface lifecycle control to close only host-opened surfaces.

- `src/cmux-page.ts`
  - Adapter from cmux browser operations to the SDK `PageLike` subset needed by the MVP.
  - Methods likely needed by SDK submit/wait/read/mode code: `url`, `title`, `goto`, `locator`, `getByRole`, `getByText`, `getByPlaceholder`, `keyboard.press`, `waitForTimeout`, `evaluate`, `content`, and `close`.
  - The adapter should be intentionally small and tested against fake cmux responses. Avoid exposing a generic browser automation framework.

- `tests/*.test.ts`
  - Extension registration tests.
  - Consult orchestration tests with a fake ChatGPT client/adapter.
  - cmux transport fallback tests.
  - Page adapter selector/action tests for the subset used by the SDK.

### Data flow

```text
OMP model calls chatgpt_pro_consult
  -> src/index.ts validates params with pi.zod
  -> src/consult.ts creates/receives ChatGPT client
  -> src/cmux.ts opens or claims visible ChatGPT surface
  -> src/cmux-page.ts exposes SDK-compatible PageLike
  -> codex-chatgpt-control selects Pro mode, submits, waits, reads Markdown
  -> consult runner returns OMP AgentToolResult
```

## cmux browser strategy

Use a cmux adapter, not the SDK's default `globalThis.agent` path.

Rationale:

- This repository already targets OMP + cmux, not Codex Desktop's browser bridge.
- Existing `omp-chatgpt-links` and `omp-generative-ui` use cmux Unix socket APIs with CLI fallback.
- The SDK's browser bridge requirement is host-specific; relying only on `globalThis.agent` would likely make the extension inert in ordinary OMP sessions.

The adapter should keep actions visible in the user's cmux browser surface and preserve the SDK safety model: structured blockers, visible control use, no hidden credentials, no private endpoints.

## Thread behavior

MVP default: `thread: "new"`.

A fresh thread avoids accidental contamination from an unrelated ChatGPT conversation and makes duplicate-submission behavior easier to reason about.

`thread: "current"` may reuse a tracked active ChatGPT surface if the extension opened it earlier or if cmux can identify the caller/current browser surface. If no usable current surface exists, return a structured blocker instead of guessing.

URL/thread search support should wait for a later pass unless needed immediately.

## Error handling

Return structured failures, not generic thrown errors, where possible.

Important cases:

- Login wall: leave the surface open and return a login-required blocker.
- Captcha/human verification: leave the surface open and return an action-required blocker.
- Rate limit: leave the surface open and return rate-limit details.
- Pro mode unavailable/ambiguous: return selected/candidate mode data if available.
- Selector drift: include the operation that failed and safe candidate labels when available.
- Timeout: return partial metadata and do not resubmit the prompt automatically.
- Abort: stop waiting, close only host-owned surfaces unless `keep_surface` is true, and surface cancellation cleanly.

Do not retry prompt submission blindly. Duplicate ChatGPT submissions are worse than a clear partial/blocked result.

## Surface ownership and cleanup

Track whether this extension opened a surface.

- On success, close extension-opened surfaces unless `keep_surface` is true.
- On login/action-required blockers, leave the surface open for user inspection.
- On abort or internal error, close only extension-opened surfaces when safe.
- Never close a surface that was merely reused/claimed from the user unless the user explicitly asked the tool to own it.

## Security and privacy

- The tool sends only the explicit `prompt` string to ChatGPT in the MVP.
- No repo files are attached in the MVP.
- Future file uploads must require explicit file paths in tool params and should preflight before upload.
- Result details should not include hidden tokens, cookies, storage, or raw browser internals.
- Local reports, if added later, should be redacted by default, following SDK guidance.

## Testing plan

Narrow tests:

- `bun --cwd extensions/chatgpt-pro-consult test`
- `bun --cwd extensions/chatgpt-pro-consult check`

Root verification after implementation:

- `bun run check`

Behavioral coverage:

- Tool registration uses the expected name, label, schema, and result mapping.
- Prompt params map to consult runner inputs.
- Success returns Markdown and structured details.
- Login/blocker result maps to user-visible content and details without closing the inspection surface.
- Abort propagates to the runner and cleanup path.
- cmux transport falls back from socket-unavailable to CLI.
- Adapter invokes the expected cmux commands/RPC for navigation, fill, click, text/html extraction, and wait.

A live ChatGPT smoke should be manual/optional because it depends on account login, Pro access, and visible browser state.

## Acceptance criteria

MVP is complete when:

1. `omp-chatgpt-pro-consult` exists as a workspace extension package.
2. The package exposes `src/index.ts` via `package.json#omp.extensions`.
3. The extension registers `chatgpt_pro_consult` exactly once per `ExtensionAPI` instance.
4. The tool can submit one explicit prompt to a visible ChatGPT Pro session through cmux.
5. The tool returns the assistant response as Markdown on success.
6. The tool returns structured blockers for login/action-required/selector/timeout failures.
7. It does not call runtime OMP actions during module load.
8. It respects `AbortSignal` during long-running browser work.
9. Extension tests and checks pass.
10. Root `bun run check` passes before claiming repo-wide success.
