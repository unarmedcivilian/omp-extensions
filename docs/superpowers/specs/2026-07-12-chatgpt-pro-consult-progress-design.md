# ChatGPT Pro Consult Progress Design

Date: 2026-07-12

## Status

Approved design for removing caller-controlled consult timeouts and adding foreground progress updates to `omp-chatgpt-pro-consult`.

This document is a focused follow-up to [`2026-06-22-chatgpt-pro-consult-design.md`](./2026-06-22-chatgpt-pro-consult-design.md). It supersedes that document's `timeout_ms` contract and timeout-budget guidance. It describes the current extension, including ZIP attachment support added after the original design.

## Goal

Make long-running `chatgpt_pro_consult` calls visibly alive without changing their foreground execution model or final Markdown result contract.

The tool must:

1. remove timeout selection from callers;
2. use a fixed 120-minute overall consult ceiling;
3. keep the tool call pending until the consult succeeds, fails, is blocked, times out, or is aborted;
4. stream honest phase and elapsed-time snapshots through OMP's supported `onUpdate` callback; and
5. actively stop underlying browser-control work on timeout or abort.

## Current behavior and problem

The registered tool currently exposes:

- `prompt`
- `zip_path?`
- `thread?`
- `timeout_ms?`
- `keep_surface?`

`src/index.ts` accepts `timeout_ms`, omits the `onUpdate` argument from its `execute` callback, and forwards the timeout into `runChatGptProConsult`.

`src/consult.ts` defaults the overall deadline to 120 seconds when callers omit the parameter. It divides that budget among mode selection, ZIP attachment, response waiting, and response reading. The installed `codex-chatgpt-control` package also defaults message waits to 120 seconds when no explicit wait is supplied. Removing only the schema field would therefore leave the short effective timeout in place.

The existing `ConsultDeadline.race()` rejects its own race when the deadline expires, but it does not abort the underlying browser-control promise. A timed-out operation may continue after OMP has reported failure and begun cleanup.

The extension emits no intermediate tool output. During a valid long Pro generation, the only observable states are tool start and final result.

## OMP API basis

The implementation must use the documented extension tool contract in `reference/oh-my-pi/docs/extensions.md`:

```ts
execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>
```

Calling `onUpdate(partialResult)` emits `tool_execution_update`. OMP replaces the current live partial result for that tool call and keeps it in progress until `execute` returns.

Important semantics established by the OMP reference implementation:

- Every partial result requires a valid `content` array.
- `details` is optional and may carry structured renderer/client state.
- Updates are complete snapshots, not appended deltas.
- Updates are transient UI/event-stream data. They are not inserted into LLM context or persisted in session history.
- The final returned result is the only durable tool result delivered to the model.
- Cancellation is cooperative through the supplied `AbortSignal`.
- Built-in `task` background jobs and `AsyncJobManager` are internal facilities, not extension APIs.

This design uses the supported foreground `onUpdate` pattern. It does not emulate task background-job delivery.

## User-visible tool contract

The model-facing tool parameters become:

| Parameter | Required | Description |
| --- | --- | --- |
| `prompt` | Yes | Prompt to submit to ChatGPT Pro. |
| `zip_path` | No | Absolute or relative path to one local ZIP file to upload before submitting the prompt. |
| `thread` | No | `new` opens a fresh ChatGPT thread; `current` uses the selected/current ChatGPT surface. Defaults to `new`. |
| `keep_surface` | No | Keep the cmux browser surface open after a successful consult. |

`timeout_ms` is removed without a deprecated alias or compatibility shim. If a stale caller still supplies an own `timeout_ms` property, `src/index.ts` rejects the call before invoking the consult runner; the value is never silently ignored.

The developer smoke CLI also removes `--timeout-ms`. An unknown timeout flag must fail through the existing unknown-argument path rather than being silently accepted.

The final result contract remains unchanged:

- success returns the ChatGPT response as Markdown text;
- failure returns the existing blocker/error text;
- final structured details retain the existing `ChatGptProConsultDetails` runtime shape; and
- `isError` remains set for unsuccessful consult results.

## Execution model

The consult remains a foreground tool:

- `execute` stays pending for the full browser-control operation;
- `execute` does not return a result to the model or launch a detached continuation while browser control remains pending;
- sibling tool calls already emitted in the same assistant turn continue under OMP's normal scheduling;
- OMP clients receive live partial snapshots while waiting; and
- the final Markdown is returned by the original tool call.

No custom messages, session entries, follow-up user messages, detached promises, or background job identifiers are introduced.

## Architecture

### `src/index.ts`

`src/index.ts` continues to own OMP registration and parameter/result mapping.

Changes:

1. Remove `timeout_ms` from the `pi.zod` schema.
2. Before invoking the consult dependency, explicitly reject raw params with an own `timeout_ms` property because OMP preserves unknown root fields after Zod parsing.
3. Use the complete registered-tool signature:

   ```ts
   execute(toolCallId, params, signal, onUpdate, ctx)
   ```

4. Pass an optional internal progress callback to `runChatGptProConsult` only when `onUpdate` is available.
5. Convert every internal progress event into a full `AgentToolResult` snapshot:

   ```ts
   onUpdate?.({
     content: [{ type: "text", text: formatConsultProgress(progress) }],
     details: { kind: "progress", progress },
   });
   ```

6. Preserve the existing final content/details/error mapping.

The registered details type may be broadened statically to a union of transient progress details and final consult details. Completed runtime details must not gain a required discriminator or otherwise change shape.

### `src/consult.ts`

`src/consult.ts` continues to own consult orchestration, deadline management, surface policy, SDK invocation, and progress state.

`ChatGptProConsultParams` removes `timeoutMs` and adds an optional internal progress callback. This callback is orchestration plumbing, not a model-facing parameter.

A small reporter in this module owns:

- the current progress phase;
- status text;
- consult start time;
- the 15-second heartbeat timer;
- current thread/ZIP/surface metadata; and
- timer cleanup.

A new standalone progress subsystem or renderer file is unnecessary.

### Existing browser/page adapters

`src/cmux-browser.ts`, `src/cmux-page.ts`, and `src/cmux.ts` retain their current responsibilities.

The existing `ConsultLifecycle.markPromptSubmitted()` signal remains the authoritative possible-submission boundary. It runs immediately before the send action resolves so ambiguous timeout/abort paths retain the surface and never retry the prompt even when delivery cannot be proven. Browser and page operations receive the combined consult signal so explicit cancellation and deadline expiry stop socket calls, CLI processes, evaluations, and abort-aware sleeps.

No selector-level progress scraping or partial response extraction is added.

## Progress model

### Structured snapshot

```ts
export type ChatGptProConsultProgressPhase =
  | "preparing"
  | "submitting"
  | "waiting";

export interface ChatGptProConsultProgress {
  phase: ChatGptProConsultProgressPhase;
  message: string;
  elapsedMs: number;
  timeoutMs: number;
  thread: ChatGptProThread;
  hasZip: boolean;
  surfaceRef?: string;
}

export interface ChatGptProConsultProgressDetails {
  kind: "progress";
  progress: ChatGptProConsultProgress;
}
```

`timeoutMs` in a progress snapshot reports the fixed internal ceiling. It is observability, not caller input.

### Phases

#### `preparing`

Emitted after prompt trimming and local ZIP-path validation succeed.

Representative status:

```text
Preparing ChatGPT Pro consult… (0s elapsed)
```

For `thread: "current"`, this phase covers resolving and validating the selected/current ChatGPT surface.

#### `submitting`

Emitted immediately before the existing SDK ask or ZIP plan begins.

Representative statuses:

```text
Opening ChatGPT Pro and submitting the prompt… (2s elapsed)
Preparing ChatGPT Pro, uploading the ZIP, and submitting the prompt… (2s elapsed)
```

If `Pro Extended` is unavailable before prompt submission and the existing safe fallback retries the legacy `pro` label, emit another `submitting` snapshot stating that Pro mode selection is being retried. Do not emit a retry update after prompt submission; the existing duplicate-submission protection remains authoritative.

#### `waiting`

`ConsultLifecycle.markPromptSubmitted()` transitions the reporter to `waiting` and emits immediately when the browser adapter reaches the possible-submission boundary.

Representative status:

```text
Prompt submission initiated; waiting for ChatGPT Pro… (18s elapsed)
```

This phase means the send action may have taken effect and the consult must fail closed: retain the post-submit surface policy and never retry the prompt. It does not prove delivery, nor claim response percentage, remaining time, token count, or an ETA.

### Heartbeats

While an `onProgress` callback exists and the consult is pending, emit the latest full snapshot every 15 seconds.

Heartbeat properties:

- one concise current-status line;
- monotonically nondecreasing elapsed time;
- current `surfaceRef` when available;
- no accumulation of previous heartbeat text;
- no prompt or ZIP contents;
- no partial ChatGPT answer text; and
- no percentage, ETA, or speculative completion state.

The heartbeat timer is cleared in `finally` for every exit path. It must not keep the process alive after the consult settles.

No final `completed` partial snapshot is necessary: OMP's `tool_execution_end` and final result immediately replace the live partial state.

## Timeout and cancellation

### Fixed overall deadline

Production uses:

```ts
const CONSULT_TIMEOUT_MS = 120 * 60_000;
```

The deadline starts after local prompt/ZIP validation and covers:

- current-surface preflight;
- page opening and settling;
- SDK bootstrap;
- Pro mode selection and safe fallback;
- ZIP attachment;
- prompt submission;
- response waiting; and
- Markdown reading.

The existing interaction constants remain:

- page-load wait: 15,000 ms;
- maximum mode-selection timeout: 15,000 ms;
- minimum SDK timeout: 1,000 ms;
- response-read reserve: 5,000 ms;
- new-page settle: 2,000 ms; and
- post-interaction settle: 2,000 ms.

With the preferred mode timeout at its 15-second cap, the normal SDK wait/read budget is:

```text
7,200,000 - 15,000 - 5,000 = 7,180,000 ms
```

The design deliberately retains the existing single SDK ask/ZIP-plan path. It does not refactor submission into repeated short wait/read slices.

### Active cancellation at expiry

The consult owns an internal deadline abort controller. Browser-control work receives a signal that combines:

1. the OMP caller signal; and
2. the internal deadline signal.

When the 120-minute deadline expires:

1. create/preserve a `TimeoutError` for `chatgpt_pro_consult`;
2. abort the internal controller with that timeout cause;
3. reject the deadline race; and
4. let existing error mapping return status `timeout` and blocker code `consult_timeout`.

Abort races must preserve an `Error` carried in `signal.reason` so deadline cancellation is not misclassified as a generic `AbortError`.

When OMP aborts explicitly, the combined signal stops the same underlying work. This design does not introduce a new durable abort-result schema.

### Surface policy

Existing ownership behavior remains:

- success closes extension-owned surfaces unless `keep_surface` is true;
- a pre-submission timeout/abort/internal failure closes extension-owned surfaces;
- a post-submission timeout/abort/failure leaves the surface open for inspection;
- login, CAPTCHA, modal, rate-limit, upload-processing, upload-permission, and selector blockers retain the current action-required behavior; and
- user-owned/reused surfaces are never closed as extension-owned resources.

Cleanup continues without the already-aborted operation signal so cancellation does not prevent surface cleanup.

## Runtime data flow

```text
OMP model calls chatgpt_pro_consult
  │
  ├─ src/index.ts validates prompt/zip_path/thread/keep_surface
  ├─ src/index.ts maps internal progress to onUpdate(full snapshot)
  │
  ▼
runChatGptProConsult
  │
  ├─ trims prompt and validates ZIP path
  ├─ creates fixed deadline + combined abort signal
  ├─ starts progress reporter → preparing
  ├─ resolves current surface when requested
  ├─ transitions → submitting
  ├─ runs existing preferred-Pro ask or ZIP plan
  │    └─ safe pre-submit mode fallback may emit retry snapshot
  ├─ markPromptSubmitted() → waiting
  ├─ heartbeat emits latest waiting snapshot every 15 seconds
  ├─ SDK returns success/blocker/error
  ├─ reporter stops in finally
  └─ existing result mapping returns final Markdown/details
```

## Rendering decision

Do not add `renderCall`, `renderResult`, `ctx.ui` status/widgets, or a task-style custom renderer.

Rationale:

- OMP's generic renderer already displays partial-result text and a live spinner.
- The generic renderer works across interactive and ACP/RPC event consumers.
- A custom extension renderer does not gain additional browser-control information.
- Task's specialized renderer and async lifecycle are core internals.
- Keeping progress in normal `AgentToolResult` content is the smallest supported solution.

The installed `codex-chatgpt-control` runner stream is not used. In the installed package version, its client-side stream adapter collects run items and emits them after the run settles, so it cannot provide live progress for this call.

## Failure behavior

Final results remain authoritative.

| Condition | Progress behavior | Final behavior |
| --- | --- | --- |
| Empty prompt or invalid ZIP path | No reporter/timer starts | Existing validation failure |
| Missing current ChatGPT surface | `preparing` may be visible briefly | Existing structured preflight blocker |
| Preferred Pro label unavailable before submission | `submitting` retry snapshot | Existing safe fallback to legacy `pro` |
| Login/CAPTCHA/modal/rate limit/selector drift | Latest phase remains visible until settle | Existing structured blocker and surface policy |
| Long valid generation | `waiting` heartbeat every 15 seconds | Markdown on success |
| 120-minute deadline | Latest phase remains visible until expiry | Structured timeout; underlying work aborted |
| OMP/user abort | Heartbeat stops promptly | Cooperative cancellation through OMP lifecycle |

## Testing

### `tests/extension.test.ts`

Update registration and mapping coverage:

1. Assert the registered schema has no `timeout_ms` field.
2. Invoke `execute` with raw params that own `timeout_ms` and assert it rejects the call before the consult dependency runs.
3. Remove `timeout_ms` from test tool parameter types and ordinary calls.
4. Assert `execute` does not forward a timeout.
5. Pass a fourth-argument update callback and assert internal progress becomes a full text/details snapshot.
6. Assert final success mapping is unchanged.
7. Assert final failure/blocker mapping is unchanged.
8. Assert the caller `AbortSignal` is forwarded unchanged into consult orchestration.

### `tests/consult.test.ts`

Update orchestration and add progress/cancellation coverage:

1. Assert production uses the fixed 120-minute deadline and a 7,180,000 ms normal wait/read budget.
2. Assert the ZIP plan uses the fixed internal budget and unchanged step ordering.
3. Assert no progress is emitted before prompt/ZIP validation succeeds.
4. Assert `preparing` and `submitting` transitions for new-thread consults.
5. Assert current-thread preflight remains pinned to the selected surface.
6. Assert ZIP metadata and submission phases do not expose ZIP contents.
7. Assert `markPromptSubmitted()` emits `waiting` immediately with the tracked surface reference and possible-submission wording.
8. Assert the safe Pro-label fallback emits a retry snapshot and still never retries after prompt submission.
9. Assert 15-second heartbeats contain increasing elapsed time and full current snapshots.
10. Assert the heartbeat timer stops after success, blocker, timeout, and abort.
11. Assert a deadline expiry aborts a never-settling SDK/browser operation and maps to the existing timeout result.
12. Assert explicit caller abort stops a never-settling operation promptly.
13. Retain success/blocker/surface-close/surface-retention assertions.

Tests may use an injected clock/timer abstraction or Bun fake timers. They must not expose a production timeout override through tool or smoke inputs.

### Existing cmux/SDK tests

Retain the SDK-plus-fake-cmux contract tests proving:

- SDK bootstrap through the cmux adapter;
- exact current-tab targeting;
- one prompt submission;
- Pro mode selection;
- ZIP attachment behavior;
- Markdown extraction; and
- default successful surface cleanup.

Progress work must not replace these end-to-end adapter checks with source-text assertions.

### `tests/smoke-script.test.ts`

1. Remove timeout parsing and forwarding assertions.
2. Assert `--timeout-ms` is rejected as unknown input.
3. Preserve prompt/thread/ZIP/keep-surface parsing and result-output coverage.

## Documentation

Update `extensions/chatgpt-pro-consult/README.md`:

- remove `timeout_ms` from the parameter table;
- document the fixed 120-minute ceiling;
- document the transient `preparing`, `submitting`, and `waiting` updates;
- state that waiting updates include elapsed time every 15 seconds;
- clarify that partial updates are status only, not partial ChatGPT output; and
- retain surface-lifecycle and manual-smoke guidance.

No root README change is required because package-level usage and extension loading do not change.

## Non-goals

- No background or detached consult jobs.
- No `AsyncJobManager` integration.
- No extension-owned detached/background execution; OMP's normal scheduling of sibling tools already emitted in the same turn remains unchanged.
- No custom progress renderer or task renderer reuse.
- No progress persistence or session reconstruction.
- No partial response streaming or answer scraping.
- No percentage, ETA, token count, or cost estimate.
- No SDK dependency upgrade.
- No retry of prompt submission.
- No new upload formats or multiple-file support.
- No changes to login, CAPTCHA, modal, or permission automation.

## Compatibility and migration

This is a clean cutover:

- generated tool schemas stop advertising `timeout_ms`;
- stale callers that supply `timeout_ms` are rejected before consult work begins, without an alias or deprecation path;
- the smoke CLI no longer accepts `--timeout-ms`;
- direct internal consult callers stop passing `timeoutMs`; and
- final success/failure details remain runtime-compatible.

The fixed production limit is intentionally visible only through documentation and progress metadata, not configurable input.

## Verification

After implementation:

1. Run `bun --cwd extensions/chatgpt-pro-consult test`.
2. Run `bun --cwd extensions/chatgpt-pro-consult check`.
3. Run the manual live smoke when a logged-in cmux ChatGPT Pro surface is available:

   ```sh
   bun --cwd extensions/chatgpt-pro-consult smoke -- --prompt "Reply with exactly: omp smoke ok"
   ```

4. Run `bun run check` from the repository root.

The manual smoke is environment-dependent and must remain outside automated `check` scripts.

## Acceptance criteria

The change is complete when all of the following hold:

1. `chatgpt_pro_consult` no longer exposes or accepts `timeout_ms`.
2. The developer smoke CLI no longer exposes or accepts `--timeout-ms`.
3. Production consults use one fixed 7,200,000 ms overall deadline.
4. The current SDK submit/ZIP-plan and final Markdown paths remain intact.
5. A validated consult emits `preparing` before browser work.
6. It emits `submitting` before the SDK ask/plan.
7. Reaching the possible-submission boundary emits `waiting` immediately without claiming confirmed delivery.
8. The latest full progress snapshot is emitted every 15 seconds until settle.
9. Progress never exposes prompt contents, ZIP contents, partial answers, percentages, or ETAs.
10. OMP's generic renderer receives valid partial `AgentToolResult` snapshots and shows the call as in progress.
11. Final content, final details, `isError`, and surface policy remain compatible.
12. Explicit abort and deadline expiry stop underlying browser-control work.
13. Deadline expiry still maps to the existing structured timeout result.
14. All progress timers and abort listeners are cleaned up on every exit path.
15. Focused automated tests, package check, and root check pass.
