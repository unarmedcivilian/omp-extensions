# ChatGPT Pro Consult Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove caller-controlled ChatGPT consult timeouts, enforce one fixed 120-minute actively-cancelled deadline, and stream honest foreground progress snapshots through OMP's supported `onUpdate` callback without changing final Markdown results.

**Architecture:** Keep the existing `codex-chatgpt-control` ask/ZIP-plan path and cmux adapters. `src/consult.ts` owns the fixed deadline, combined cancellation signal, progress phases, heartbeat lifecycle, and final result mapping; `src/index.ts` owns the public schema, stale-argument rejection, and conversion of progress snapshots into partial `AgentToolResult`s. Use OMP's generic tool renderer; do not add background jobs, custom renderers, or UI-specific status APIs.

**Tech Stack:** Bun 1.3+, TypeScript ESM, OMP `ExtensionAPI` and `AgentToolResult`, `codex-chatgpt-control`, cmux browser adapters, `bun:test`.

---

## Required skills during execution

- Use @test-driven-development before every production behavior change.
- Use @systematic-debugging for any unexpected test, build, timeout, abort, or live-browser behavior.
- Use @requesting-code-review after the implementation behavior works and before final repository verification.
- Use @verification-before-completion before claiming the extension or repository passes.
- Use @finishing-a-development-branch only after every required check passes.

## Approved specification

- `docs/superpowers/specs/2026-07-12-chatgpt-pro-consult-progress-design.md`

The older `docs/superpowers/specs/2026-06-22-chatgpt-pro-consult-design.md` is historical context only. The approved follow-up specification supersedes its public `timeout_ms` contract and timeout-budget guidance.

## Source references

Read these before editing the corresponding behavior:

- `reference/oh-my-pi/docs/extensions.md:254-302` — registered extension tool signature and `onUpdate` contract.
- `reference/oh-my-pi/packages/ai/src/utils/validation.ts:1589-1627` — OMP preserves unknown root fields after Zod parsing.
- `reference/oh-my-pi/packages/agent/src/agent-loop.ts:2067-2081,2174-2200` — update emission and same-turn shared scheduling.
- `reference/oh-my-pi/packages/coding-agent/src/modes/controllers/event-controller.ts:938-963` — partial snapshots replace the current live tool result.
- `extensions/chatgpt-pro-consult/src/cmux-page.ts:70-77,139-145` — `markPromptSubmitted()` runs before the send action resolves and therefore denotes possible submission, not confirmed delivery.
- `extensions/dynamic-workflows/src/workflow-tool.ts:77-142` and `extensions/dynamic-workflows/src/display.ts:96-124` — repository-local extension pattern for mapping internal progress to `onUpdate`.

## File structure and responsibilities

No new production source file is required.

- Modify `extensions/chatgpt-pro-consult/src/index.ts:25-60`
  - remove the public timeout field;
  - reject a stale own `timeout_ms` property;
  - accept `onUpdate` in the registered execute callback;
  - map internal progress into full partial results;
  - preserve final content/details/error mapping.
- Modify `extensions/chatgpt-pro-consult/src/consult.ts:12-61,111-213,322-364,424-460`
  - remove caller timeout input;
  - use the fixed 120-minute deadline;
  - actively abort underlying work at deadline;
  - preserve abort reasons;
  - define progress types and reporter;
  - emit phases and 15-second heartbeats;
  - stop all timers/listeners on every exit.
- Modify `extensions/chatgpt-pro-consult/scripts/live-smoke.ts:11-17,24-100,138-150`
  - remove `--timeout-ms` parsing and forwarding;
  - retain the existing unknown-argument failure path.
- Modify `extensions/chatgpt-pro-consult/tests/extension.test.ts:30-47,149-235`
  - verify schema cutover, stale-field rejection, progress forwarding, and unchanged final mapping.
- Modify `extensions/chatgpt-pro-consult/tests/consult.test.ts:14-67,69-110,158-229,273-384`
  - verify fixed budgets, active deadline abort, phase transitions, heartbeat replacement snapshots, and cleanup.
- Modify: `extensions/chatgpt-pro-consult/tests/cmux-page.test.ts:637-666`
  - remove the remaining direct runner `timeoutMs` caller while retaining the real-SDK one-submit contract.
- Modify `extensions/chatgpt-pro-consult/tests/smoke-script.test.ts:19-43`
  - verify timeout flags are rejected and remaining smoke flags still map correctly.
- Modify `extensions/chatgpt-pro-consult/README.md:5-30`
  - only after the behavior passes focused smoke/checks;
  - document the fixed ceiling and transient progress contract.

Files intentionally unchanged:

- `extensions/chatgpt-pro-consult/src/cmux.ts`
- `extensions/chatgpt-pro-consult/src/cmux-browser.ts`
- `extensions/chatgpt-pro-consult/src/cmux-page.ts`
- `extensions/chatgpt-pro-consult/src/blockers.ts`
- root `README.md`
- package dependencies and the installed `codex-chatgpt-control` version

## Invariants

1. The model-facing schema has no `timeout_ms`.
2. A raw/stale call that owns `timeout_ms` fails before the consult dependency runs; the value is never ignored.
3. The smoke CLI has no `--timeout-ms` form.
4. Production uses exactly 7,200,000 ms as its overall consult deadline.
5. The existing preferred-Pro, legacy fallback, ZIP plan, Markdown read, and surface lifecycle remain intact.
6. Deadline expiry aborts the browser-control signal and still maps to `TimeoutError`/`consult_timeout`.
7. Explicit OMP abort propagates cooperatively through the combined signal.
8. `markPromptSubmitted()` means submission may have occurred; visible status must not claim confirmed delivery.
9. Each `onUpdate` call is a full current snapshot, not a delta.
10. Progress contains no prompt text, ZIP content, partial answer, percentage, or ETA.
11. The final result remains the only durable/LLM-visible tool result.
12. Same-turn sibling tool scheduling remains OMP-owned and unchanged.

---

### Task 1: Remove the public timeout input safely

**Files:**
- Modify: `extensions/chatgpt-pro-consult/tests/extension.test.ts:30-47,149-235`
- Modify: `extensions/chatgpt-pro-consult/src/index.ts:25-60`

- [ ] **Step 1: Write failing schema and stale-argument tests**

Update the fake tool parameter type so ordinary calls no longer expose `timeout_ms`. Add these assertions to the registration test:

```ts
expect(tool.parameters.shape).not.toHaveProperty("timeout_ms");
```

Add a test that bypasses the model-facing TypeScript shape, matching OMP's preserved-unknown-field runtime behavior:

```ts
test("rejects stale timeout_ms input before starting a consult", async () => {
  const fake = makeFakePi();
  const calls: ChatGptProConsultParams[] = [];
  const extension = createChatGptProConsultExtension({
    consult: async params => {
      calls.push(params);
      return successfulResult({
        ok: true,
        status: "ok",
        warnings: [],
        thread: "new",
        keptSurface: false,
      });
    },
  });

  extension(fake.api);

  await expect(fake.tools[0]!.execute(
    "stale-timeout",
    { prompt: "Explain this.", timeout_ms: 1 } as unknown as ConsultToolParams,
  )).rejects.toThrow("timeout_ms is not supported");
  expect(calls).toHaveLength(0);
});
```

Update the existing execute-mapping test input and expectation to omit `timeout_ms`/`timeoutMs` while retaining prompt, ZIP, thread, keep-surface, and signal assertions.

Because `toMatchObject` ignores extra own properties, add an explicit red assertion to the ordinary execute-mapping test:

```ts
expect(calls[0]).not.toHaveProperty("timeoutMs");
```

Before production deletion this fails even when the forwarded property value is `undefined`.

- [ ] **Step 2: Run the focused test and confirm the intended failures**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/extension.test.ts
```

Expected: FAIL because the schema still advertises `timeout_ms`, stale input is silently accepted, and ordinary mapping still forwards `timeoutMs`.

- [ ] **Step 3: Remove the schema field and add targeted stale-field rejection**

In `src/index.ts`, delete the `timeout_ms` Zod field. Add a targeted guard rather than making the whole schema strict; OMP intentionally preserves unknown root fields for tool-owned policy checks.

```ts
function rejectRemovedTimeoutParam(params: object): void {
  if (Object.hasOwn(params, "timeout_ms")) {
    throw new Error(
      "timeout_ms is not supported; chatgpt_pro_consult uses a fixed 120-minute limit.",
    );
  }
}
```

Call it as the first statement in `execute`, before invoking the injected consult dependency:

```ts
rejectRemovedTimeoutParam(params);
```

Delete `timeoutMs: params.timeout_ms` from the call to `consult`.

Do not add a deprecated alias, default, warning-only path, or hidden acceptance of the value.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/extension.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the public tool cutover**

```sh
git add extensions/chatgpt-pro-consult/src/index.ts extensions/chatgpt-pro-consult/tests/extension.test.ts
git commit -m "feat: remove consult timeout input"
```

---

### Task 2: Enforce a fixed deadline that aborts underlying work

**Files:**
- Modify: `extensions/chatgpt-pro-consult/tests/consult.test.ts:14-110,173-229,273-384`
- Modify: `extensions/chatgpt-pro-consult/src/consult.ts:12-61,111-213,322-364,424-460`
- Modify: `extensions/chatgpt-pro-consult/tests/cmux-page.test.ts:637-666`

- [ ] **Step 1: Update fixed-budget tests before production code**

Remove `timeoutMs` from every `runChatGptProConsult` invocation in `consult.test.ts` and from the live internal runner call in `cmux-page.test.ts:641-644`. The real-SDK test is fast and should use the fixed production deadline rather than a caller override. Update exact SDK argument assertions to the fixed production budgets:

```ts
expect(deps.calls).toEqual([{
  prompt: "Reply once",
  thread: { type: "new" },
  existingTab: undefined,
  preferExistingTab: false,
  mode: { intelligence: "Pro Extended", timeoutMs: 15_000 },
  wait: { timeoutMs: 7_180_000 },
  read: { format: "markdown" },
  report: false,
}]);
```

Update the ZIP-plan assertion so both `files.attach` and `messages.ask.wait` receive the fixed internal wait budget while step ordering remains unchanged:

```ts
{ id: "mode", command: "modes.set", args: { intelligence: "Pro Extended", timeoutMs: 15_000 } },
{ id: "attach", command: "files.attach", args: { paths: [resolve("fixtures/context.zip")], timeoutMs: 7_180_000 } },
{ id: "ask", command: "messages.ask", args: {
  text: "Inspect this",
  wait: { timeoutMs: 7_180_000 },
  read: { format: "markdown" },
} },
```

The current-thread assertion must use the same fixed wait budget.

- [ ] **Step 2: Add an internal short-deadline test seam and failing active-abort test**

Extend the test-only fake options with a deadline factory/short deadline and capture the signal passed to `createBrowser`. The production parameter type must not regain a timeout.

Add an integration test around a never-settling fake SDK call:

```ts
test("deadline expiry aborts browser work and returns the existing timeout result", async () => {
  const deps = depsReturning(neverSettles, {
    deadlineMs: 1,
    markSubmittedImmediately: true,
  });

  const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

  expect(result.ok).toBe(false);
  expect(result.details.status).toBe("timeout");
  expect(result.details.blocker?.code).toBe("consult_timeout");
  expect(deps.browserSignal?.aborted).toBe(true);
  expect((deps.browserSignal?.reason as Error | undefined)?.name).toBe("TimeoutError");
  expect(result.details.keptSurface).toBe(true);
});
```

Retain a pre-submission variant asserting owned-surface cleanup. Rename old tests that referred to caller-supplied one-millisecond timeouts so they explicitly refer to the injected test deadline.

Add a current-surface cancellation regression using a non-`AbortError` reason:

```ts
test("treats a custom Error abort during current-surface preflight as cancellation", async () => {
  const controller = new AbortController();
  const selectedStarted = Promise.withResolvers<void>();
  const deps = depsReturning({
    ok: true,
    status: "ok",
    output_text: "should not run",
    warnings: [],
  });
  const baseCreateBrowser = deps.createBrowser!;
  deps.createBrowser = options => {
    const browser = baseCreateBrowser(options);
    browser.requireSelectedChatGptSurface = async () => {
      selectedStarted.resolve();
      return await neverSettles() as never;
    };
    return browser;
  };

  const running = runChatGptProConsult({
    prompt: "Continue",
    thread: "current",
    signal: controller.signal,
  }, deps);
  await selectedStarted.promise;
  controller.abort(new Error("cancelled"));
  const result = await running;

  expect(result.details.status).toBe("error");
  expect(result.details.blocker?.code).toBe("consult_error");
  expect(result.details.blocker?.code).not.toBe("current_chatgpt_surface_missing");
  expect((result.details.error as { message?: string }).message).toBe("cancelled");
});
```

This must fail before implementation because the current preflight catch recognizes only error names and can misreport a preserved custom cancellation reason as a missing surface.

- [ ] **Step 3: Run consult tests and confirm fixed-budget/cancellation failures**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/consult.test.ts tests/cmux-page.test.ts
```

Expected: FAIL because production still defaults to 120 seconds, `ChatGptProConsultParams` still accepts `timeoutMs`, and deadline expiry does not abort the browser signal.

- [ ] **Step 4: Replace the caller timeout with a production constant**

In `src/consult.ts`:

```ts
export interface ChatGptProConsultParams {
  prompt: string;
  zipPath?: string;
  thread?: ChatGptProThread;
  keepSurface?: boolean;
  signal?: AbortSignal;
}

const CONSULT_TIMEOUT_MS = 120 * 60_000;
```

Remove `DEFAULT_TIMEOUT_MS` and all reads of `params.timeoutMs`. Calculate existing mode/wait budgets from `CONSULT_TIMEOUT_MS`:

```ts
const timeoutMs = CONSULT_TIMEOUT_MS;
const modeTimeoutMs = Math.min(
  MAX_MODE_TIMEOUT_MS,
  Math.max(MIN_MODE_TIMEOUT_MS, Math.floor(timeoutMs / 4)),
);
const waitTimeoutMs = Math.max(
  MIN_MODE_TIMEOUT_MS,
  timeoutMs - modeTimeoutMs - READ_RESERVE_MS,
);
```

Keep the fixed constant internal to production behavior. Tests should assert observed SDK arguments, not a caller override.

- [ ] **Step 5: Let deadline expiry abort the operation signal**

Extend the deadline constructor with an expiry callback and expose it only through dependency injection:

```ts
export interface ChatGptProConsultDeps {
  // existing fields...
  createDeadline?: typeof createConsultDeadline;
}

export function createConsultDeadline(
  timeoutMs: number,
  now: () => Date,
  onExpire?: (error: Error) => void,
): ConsultDeadline {
  const expiresAt = now().getTime() + timeoutMs;
  const remainingMs = () => Math.max(0, expiresAt - now().getTime());

  const timeoutError = (operation: string): Error => {
    const error = createTimeoutError(operation);
    onExpire?.(error);
    return error;
  };

  return {
    remainingMs,
    throwIfExpired(operation) {
      if (remainingMs() <= 0) throw timeoutError(operation);
    },
    async race<T>(operation: string, promise: Promise<T>): Promise<T> {
      this.throwIfExpired(operation);
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(
        () => timeout.reject(timeoutError(operation)),
        remainingMs(),
      );
      try {
        return await Promise.race([promise, timeout.promise]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

Create the deadline controller and combined signal in `runChatGptProConsult`:

```ts
const deadlineController = new AbortController();
const operationSignal = params.signal
  ? AbortSignal.any([params.signal, deadlineController.signal])
  : deadlineController.signal;
const createDeadline = deps.createDeadline ?? createConsultDeadline;
const deadline = createDeadline(
  CONSULT_TIMEOUT_MS,
  deps.now ?? (() => new Date()),
  error => deadlineController.abort(error),
);
```

Use `operationSignal` for:

- `createBrowser({ signal: operationSignal, ... })`;
- current-surface preflight;
- `askWithPreferredProMode` and `raceAbort`;
- all existing browser/page operations reached through the adapter.

Keep the initial `throwIfAborted(params.signal)` check so an already-aborted caller does not allocate browser resources.

- [ ] **Step 6: Preserve timeout causes through abort races**

Change `raceAbort` so it uses an `Error` carried by `signal.reason`:

```ts
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAbortError();
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await promise;
  throwIfAborted(signal);

  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
```

Update `throwIfAborted` to throw the same preserved reason when possible. This is what keeps internal deadline aborts classified as `TimeoutError` instead of generic consult errors.

The current-surface preflight catch must also consult signal state, not only the caught error name:

```ts
return operationSignal.aborted || isTimeoutOrAbortError(error)
  ? errorResult(error, thread, false, browser.primarySurfaceRef())
  : blockedPreflightResult(error, thread);
```

This preserves custom `Error` cancellation causes instead of misclassifying them as `current_chatgpt_surface_missing`.

Do not pass the aborted operation signal into `closeOwnedSurfacesQuietly`; existing best-effort cleanup must remain able to run.

- [ ] **Step 7: Convert old one-millisecond tests to the dependency seam**

The test helper may inject:

```ts
createDeadline: options.deadlineMs === undefined
  ? undefined
  : (_productionTimeoutMs, now, onExpire) =>
      createConsultDeadline(options.deadlineMs!, now, onExpire),
```

This seam is not part of the tool schema, smoke CLI, or `ChatGptProConsultParams`.

- [ ] **Step 8: Run focused consult and adapter tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/consult.test.ts tests/cmux-browser.test.ts tests/cmux-page.test.ts
```

Expected: PASS. Existing one-submit, Pro-mode, current-target, abort-aware page, and surface cleanup assertions remain green.

- [ ] **Step 9: Commit fixed deadline behavior**

```sh
git add extensions/chatgpt-pro-consult/src/consult.ts \
  extensions/chatgpt-pro-consult/tests/consult.test.ts \
  extensions/chatgpt-pro-consult/tests/cmux-page.test.ts
git commit -m "fix: enforce consult deadline cancellation"
```

---

### Task 3: Add core progress phases and heartbeat lifecycle

**Files:**
- Modify: `extensions/chatgpt-pro-consult/tests/consult.test.ts:14-67,69-229,342-418`
- Modify: `extensions/chatgpt-pro-consult/src/consult.ts:10-213,322-364`

- [ ] **Step 1: Add a deterministic manual heartbeat harness to tests**

Use an internal scheduler dependency instead of real 15-second sleeps:

```ts
function manualHeartbeat() {
  let callback: (() => void) | undefined;
  let stopped = false;

  return {
    schedule(next: () => void, intervalMs: number): () => void {
      expect(intervalMs).toBe(15_000);
      callback = next;
      return () => {
        stopped = true;
        callback = undefined;
      };
    },
    fire() {
      callback?.();
    },
    get stopped() {
      return stopped;
    },
  };
}
```

Extend `depsReturning` so `markSubmittedImmediately` fires from the fake `ask`/`runPlan` operation immediately before it returns, not during `createBrowser`. This models the real lifecycle order and prevents a test-only `waiting`-before-`submitting` sequence.

- [ ] **Step 2: Write failing phase-transition tests**

Capture progress directly from the core runner:

```ts
test("emits preparing, submitting, and possible-submission waiting snapshots", async () => {
  const snapshots: ChatGptProConsultProgress[] = [];
  const deps = depsReturning(
    { ok: true, status: "ok", output_text: "done", warnings: [] },
    { markSubmittedImmediately: true },
  );

  const result = await runChatGptProConsult({
    prompt: "Hi",
    onProgress: snapshot => snapshots.push(snapshot),
  }, deps);

  expect(result.ok).toBe(true);
  expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
    "preparing",
    "submitting",
    "waiting",
  ]);
  expect(snapshots.at(-1)).toMatchObject({
    phase: "waiting",
    message: "Prompt submission initiated; waiting for ChatGPT Pro…",
    timeoutMs: 7_200_000,
    thread: "new",
    hasZip: false,
    surfaceRef: "surface:7",
  });
});
```

Add variants that prove:

- invalid ZIP input emits no progress;
- current-thread `preparing` precedes preflight and later snapshots carry the selected surface;
- ZIP snapshots set `hasZip: true` but contain no path or ZIP contents;
- safe pre-submit legacy-Pro fallback emits another `submitting` snapshot with retry wording;
- no retry snapshot appears after possible submission.

- [ ] **Step 3: Write failing heartbeat and cleanup tests**

Use a mutable injected `now` and a pending fake ask:

```ts
let nowMs = 0;
const heartbeat = manualHeartbeat();
const snapshots: ChatGptProConsultProgress[] = [];
const askStarted = Promise.withResolvers<void>();
const askResult = Promise.withResolvers<unknown>();
const deps = depsReturning(async () => {
  askStarted.resolve();
  return await askResult.promise;
}, {
  now: () => new Date(nowMs),
  scheduleHeartbeat: heartbeat.schedule,
  markSubmittedImmediately: true,
});

const running = runChatGptProConsult({
  prompt: "Hi",
  onProgress: snapshot => snapshots.push(snapshot),
}, deps);
await askStarted.promise;

nowMs = 15_000;
heartbeat.fire();
expect(snapshots.at(-1)).toMatchObject({ phase: "waiting", elapsedMs: 15_000 });

nowMs = 5_000;
heartbeat.fire();
expect(snapshots.at(-1)).toMatchObject({ phase: "waiting", elapsedMs: 15_000 });

askResult.resolve({ ok: true, status: "ok", output_text: "done", warnings: [] });
await running;
expect(heartbeat.stopped).toBe(true);
```

Repeat the stop assertion for blocker, injected deadline expiry, and explicit caller abort. After stop, firing the harness must not append another snapshot.

- [ ] **Step 4: Run consult tests and confirm progress failures**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/consult.test.ts
```

Expected: FAIL because the core runner has no `onProgress` callback, progress types, scheduler, phases, or heartbeat cleanup.

- [ ] **Step 5: Define progress and scheduler types**

Add to `src/consult.ts`:

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

export type ScheduleConsultHeartbeat = (
  callback: () => void,
  intervalMs: number,
) => () => void;
```

Extend only internal orchestration contracts:

```ts
export interface ChatGptProConsultParams {
  // existing non-timeout fields...
  onProgress?: (progress: ChatGptProConsultProgress) => void;
}

export interface ChatGptProConsultDeps {
  // existing fields...
  scheduleHeartbeat?: ScheduleConsultHeartbeat;
}
```

- [ ] **Step 6: Implement a small full-snapshot reporter in `consult.ts`**

Use one default scheduler:

```ts
const PROGRESS_HEARTBEAT_MS = 15_000;

const scheduleConsultHeartbeat: ScheduleConsultHeartbeat = (
  callback,
  intervalMs,
) => {
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
```

Implement the reporter locally in `consult.ts`; do not create a new file or renderer:

```ts
function createConsultProgressReporter(options: {
  now: () => Date;
  timeoutMs: number;
  thread: ChatGptProThread;
  hasZip: boolean;
  getSurfaceRef: () => string | undefined;
  onProgress: ((progress: ChatGptProConsultProgress) => void) | undefined;
  scheduleHeartbeat: ScheduleConsultHeartbeat;
}) {
  const startedAt = options.now().getTime();
  let phase: ChatGptProConsultProgressPhase = "preparing";
  let message = "Preparing ChatGPT Pro consult…";
  let stopped = false;
  let lastElapsedMs = 0;

  const snapshot = (): ChatGptProConsultProgress => {
    const elapsedMs = Math.max(
      lastElapsedMs,
      options.now().getTime() - startedAt,
      0,
    );
    lastElapsedMs = elapsedMs;
    return {
      phase,
      message,
      elapsedMs,
      timeoutMs: options.timeoutMs,
      thread: options.thread,
      hasZip: options.hasZip,
      surfaceRef: options.getSurfaceRef(),
    };
  };

  const emit = () => {
    if (!stopped) options.onProgress?.(snapshot());
  };

  const cancelHeartbeat = options.onProgress
    ? options.scheduleHeartbeat(emit, PROGRESS_HEARTBEAT_MS)
    : () => {};

  return {
    update(nextPhase: ChatGptProConsultProgressPhase, nextMessage: string) {
      phase = nextPhase;
      message = nextMessage;
      emit();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelHeartbeat();
    },
  };
}
```

Do not expose prompt text, ZIP path, SDK raw result, or partial answer through the snapshot.

- [ ] **Step 7: Wire lifecycle transitions without changing SDK orchestration**

After prompt and ZIP validation:

1. declare `let browser: CmuxBrowserAdapter | undefined` so progress can resolve the current surface lazily;
2. create the reporter with the fixed timeout, thread, `hasZip`, injected/default scheduler, and `() => browser?.primarySurfaceRef()`;
3. enter an outer `try/finally` before the first `progress.update` so callback exceptions cannot leak the timer;
4. emit `preparing` before current-surface preflight;
5. emit `submitting` immediately before the existing SDK ask/ZIP plan;
6. stop the reporter in the outer `finally` regardless of any inner return.

Make `markPromptSubmitted` idempotent and fail-closed:

```ts
const lifecycle: ConsultLifecycle = {
  markPromptSubmitted() {
    if (promptPossiblySubmitted) return;
    promptPossiblySubmitted = true;
    progress.update(
      "waiting",
      "Prompt submission initiated; waiting for ChatGPT Pro…",
    );
  },
};
```

Before the legacy mode retry, invoke a callback passed into `askWithPreferredProMode`:

```ts
args.onModeFallback?.();
```

The callback keeps phase `submitting` and uses status text such as:

```text
Preferred Pro mode unavailable; retrying legacy Pro mode…
```

Do not move `markPromptSubmitted()` after the transport action; its current early position protects against duplicate submission and unsafe surface cleanup when delivery is ambiguous.

- [ ] **Step 8: Run progress and existing core-flow tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/consult.test.ts tests/cmux-page.test.ts tests/cmux-browser.test.ts
```

Expected: PASS, including existing SDK-plus-fake-cmux one-submit/Markdown tests.

- [ ] **Step 9: Commit core progress reporting**

```sh
git add extensions/chatgpt-pro-consult/src/consult.ts extensions/chatgpt-pro-consult/tests/consult.test.ts
git commit -m "feat: report chatgpt consult progress"
```

---

### Task 4: Forward progress through the OMP tool contract

**Files:**
- Modify: `extensions/chatgpt-pro-consult/tests/extension.test.ts:30-47,190-235`
- Modify: `extensions/chatgpt-pro-consult/src/index.ts:1-65`

- [ ] **Step 1: Extend the fake registered-tool signature and write a failing update test**

Update `TestTool.execute` to accept the fourth callback argument:

```ts
execute(
  toolCallId: string,
  params: ConsultToolParams,
  signal?: AbortSignal,
  onUpdate?: (result: AgentToolResult<ChatGptProConsultToolDetails>) => void,
): Promise<AgentToolResult<ChatGptProConsultToolDetails>>;
```

Add a test whose injected consult emits one progress snapshot before returning:

```ts
test("forwards consult progress as a full partial tool result", async () => {
  const fake = makeFakePi();
  const updates: AgentToolResult<ChatGptProConsultToolDetails>[] = [];
  const extension = createChatGptProConsultExtension({
    consult: async params => {
      params.onProgress?.({
        phase: "waiting",
        message: "Prompt submission initiated; waiting for ChatGPT Pro…",
        elapsedMs: 75_000,
        timeoutMs: 7_200_000,
        thread: "new",
        hasZip: false,
        surfaceRef: "surface:7",
      });
      return successfulResult({
        ok: true,
        status: "ok",
        warnings: [],
        thread: "new",
        keptSurface: false,
      });
    },
  });

  extension(fake.api);
  await fake.tools[0]!.execute(
    "progress-call",
    { prompt: "Explain this." },
    undefined,
    update => updates.push(update),
  );

  expect(updates).toEqual([{
    content: [{
      type: "text",
      text: "Prompt submission initiated; waiting for ChatGPT Pro… (1m 15s elapsed)",
    }],
    details: {
      kind: "progress",
      progress: expect.objectContaining({
        phase: "waiting",
        elapsedMs: 75_000,
        surfaceRef: "surface:7",
      }),
    },
  }]);
});
```

Also assert no `onProgress` callback is passed to the injected consult when OMP supplies no `onUpdate`, avoiding an unnecessary heartbeat timer for direct/headless callers.

- [ ] **Step 2: Run the extension test and confirm it fails**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/extension.test.ts
```

Expected: FAIL because `execute` ignores the fourth argument and does not map progress.

- [ ] **Step 3: Add the progress-details union and elapsed formatter**

In `src/index.ts`:

```ts
export type ChatGptProConsultToolDetails =
  | ChatGptProConsultDetails
  | ChatGptProConsultProgressDetails;

function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

function formatConsultProgress(progress: ChatGptProConsultProgress): string {
  return `${progress.message} (${formatElapsedMs(progress.elapsedMs)} elapsed)`;
}
```

Import the progress types from `consult.ts`. Keep final `ChatGptProConsultDetails` runtime objects unchanged.

- [ ] **Step 4: Adopt the complete extension execute signature and map updates**

Change registration to:

```ts
pi.registerTool<typeof ConsultParams, ChatGptProConsultToolDetails>({
  // existing metadata...
  async execute(_toolCallId, params, signal, onUpdate) {
    rejectRemovedTimeoutParam(params);
    const result = await consult({
      prompt: params.prompt,
      zipPath: params.zip_path,
      thread: params.thread,
      keepSurface: params.keep_surface,
      signal,
      onProgress: onUpdate
        ? progress => onUpdate({
            content: [{ type: "text", text: formatConsultProgress(progress) }],
            details: { kind: "progress", progress },
          })
        : undefined,
    });

    return {
      content: [{ type: "text", text: result.contentText }],
      details: result.details,
      isError: result.ok ? undefined : true,
    };
  },
});
```

Do not add `renderCall`, `renderResult`, `ctx.ui`, session entries, or async/background details.

- [ ] **Step 5: Run extension and consult tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/extension.test.ts tests/consult.test.ts
```

Expected: PASS. Final success and blocker tests must still assert the original content/details/isError behavior.

- [ ] **Step 6: Commit OMP progress forwarding**

```sh
git add extensions/chatgpt-pro-consult/src/index.ts extensions/chatgpt-pro-consult/tests/extension.test.ts
git commit -m "feat: stream consult tool updates"
```

---

### Task 5: Remove timeout control from the manual smoke CLI

**Files:**
- Modify: `extensions/chatgpt-pro-consult/tests/smoke-script.test.ts:19-43`
- Modify: `extensions/chatgpt-pro-consult/scripts/live-smoke.ts:11-17,24-100,138-150`

- [ ] **Step 1: Write failing smoke parser tests**

Remove timeout arguments and `timeoutMs` from the existing full-flag mapping test. Retain prompt, current thread, ZIP path, and keep-surface assertions.

Add both stale flag forms:

```ts
test("rejects removed timeout flags", () => {
  expect(() => parseLiveSmokeArgs(["--timeout-ms", "45000"]))
    .toThrow("Unknown live smoke argument: --timeout-ms");
  expect(() => parseLiveSmokeArgs(["--timeout-ms=45000"]))
    .toThrow("Unknown live smoke argument: --timeout-ms=45000");
});
```

- [ ] **Step 2: Run the smoke parser test and confirm failure**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/smoke-script.test.ts
```

Expected: FAIL because timeout flags are still parsed and forwarded.

- [ ] **Step 3: Delete smoke timeout parsing and forwarding**

From `scripts/live-smoke.ts`, remove:

- `LiveSmokeArgs.timeoutMs`;
- the local `timeoutMs` variable;
- both `--timeout-ms` branches;
- the `parsed.timeoutMs` assignment; and
- `parseTimeoutMs`.

Do not replace the flag with another duration unit, environment variable, hidden default parameter, or warning-only acceptance. The existing unknown-argument branch becomes the rejection path.

- [ ] **Step 4: Run smoke and extension tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test tests/smoke-script.test.ts tests/extension.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the smoke CLI cutover**

```sh
git add extensions/chatgpt-pro-consult/scripts/live-smoke.ts extensions/chatgpt-pro-consult/tests/smoke-script.test.ts
git commit -m "feat: remove consult smoke timeout flag"
```

---

### Task 6: Prove behavior, document it, and verify the repository

**Files:**
- Modify after behavior gate: `extensions/chatgpt-pro-consult/README.md:5-30`
- Verify: all changed source/tests plus root workspace

Do not start documentation until Steps 1-2 prove the behavior works.

- [ ] **Step 1: Run the complete extension test suite**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: all extension tests PASS, including:

- schema and stale-timeout rejection;
- fixed deadline budgets;
- active deadline abort;
- explicit caller abort;
- phase ordering and possible-submission wording;
- heartbeat timing/cleanup;
- `onUpdate` mapping;
- smoke timeout rejection;
- existing SDK/cmux one-submit and Markdown behavior.

If any test fails, use @systematic-debugging; do not weaken assertions or increase arbitrary waits.

- [ ] **Step 2: Run the package build/check gate**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult check
```

Expected: tests PASS and `src/index.ts` builds successfully for Bun with `@oh-my-pi/pi-coding-agent` externalized.

At this point the requested behavior is demonstrably working; only now begin documentation/cleanup.

- [ ] **Step 3: Update the package README**

In `extensions/chatgpt-pro-consult/README.md`:

1. remove the `timeout_ms` parameter row;
2. add a concise progress/timeout section:

```md
## Progress and timeout

Consults remain foreground tool calls and use a fixed 120-minute overall ceiling. The timeout is not caller-configurable.

While a consult is pending, OMP receives transient status snapshots for preparation, submission, and waiting, followed by an elapsed-time heartbeat every 15 seconds. These updates report status only: they do not contain partial ChatGPT output, percentages, or ETAs. “Prompt submission initiated” is a fail-closed boundary because the visible send action may have taken effect even if its transport acknowledgement fails.

OMP cancellation aborts the underlying browser-control work. A timeout or failure after possible submission leaves the ChatGPT surface open for inspection under the existing lifecycle policy.
```

3. retain privacy, visible-browser, ZIP, thread, surface lifecycle, and manual smoke guidance;
4. do not document background execution or claim partial updates enter LLM context.

- [ ] **Step 4: Run the manual live smoke when the environment supports it**

Preconditions: cmux browser available, logged into ChatGPT, Pro access active.

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult smoke -- --prompt "Reply with exactly: omp smoke ok"
```

Expected: exit 0; one visible Pro submission; final output contains `omp smoke ok`; extension-owned surface closes by default.

If the environment returns login/action-required/selector/rate-limit blockers, record the exact structured blocker and retained `surfaceRef`; do not misreport that as a passing live smoke. Automated tests/check remain mandatory regardless.

- [ ] **Step 5: Request code review against the approved spec**

Use @requesting-code-review with:

- spec: `docs/superpowers/specs/2026-07-12-chatgpt-pro-consult-progress-design.md`;
- plan: `docs/superpowers/plans/2026-07-12-chatgpt-pro-consult-progress.md`;
- changed extension source/tests/docs;
- explicit attention to abort listener/timer cleanup, false submission claims, stale timeout rejection, and final result compatibility.

Fix every blocking correctness issue with a failing regression test first. Re-run the focused test that proves each fix.

- [ ] **Step 6: Run final package verification after review fixes and docs**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
bun --cwd extensions/chatgpt-pro-consult check
```

Expected: both PASS.

- [ ] **Step 7: Run the required root repository check**

Run from the repository root:

```sh
bun run check
```

Expected: PASS across root tests and every extension package. Do not claim repository-wide success from package-only checks.

- [ ] **Step 8: Commit documentation and any reviewed fixes**

Stage only files belonging to this feature. If review fixes changed source/tests, include them with their regression tests; do not sweep unrelated user changes into the commit.

```sh
git add extensions/chatgpt-pro-consult/README.md \
  extensions/chatgpt-pro-consult/src/index.ts \
  extensions/chatgpt-pro-consult/src/consult.ts \
  extensions/chatgpt-pro-consult/scripts/live-smoke.ts \
  extensions/chatgpt-pro-consult/tests/extension.test.ts \
  extensions/chatgpt-pro-consult/tests/consult.test.ts \
  extensions/chatgpt-pro-consult/tests/smoke-script.test.ts
git commit -m "docs: explain consult progress behavior"
```

Omit unchanged paths from the actual commit. If review fixes were already committed separately, this final commit should contain only the README.

- [ ] **Step 9: Record final evidence for handoff**

Report exact observed results for:

- extension tests;
- extension check;
- root check;
- live smoke, or the exact blocker/precondition that prevented it;
- code-review disposition;
- final commit range.

Do not claim that interim updates are LLM-visible or persisted. Do not claim confirmed prompt delivery at the possible-submission boundary.

---

## Final acceptance checklist

- [ ] Tool schema omits `timeout_ms`.
- [ ] Raw/stale `timeout_ms` is rejected before consult execution.
- [ ] Smoke CLI rejects both timeout flag forms.
- [ ] SDK observes the fixed 120-minute overall budget.
- [ ] Deadline expiry aborts the underlying combined signal and maps to timeout.
- [ ] Explicit OMP abort stops pending browser-control work.
- [ ] Progress phases are `preparing`, `submitting`, and `waiting`.
- [ ] Waiting text says submission was initiated/may have occurred, never confirmed.
- [ ] Heartbeats emit full snapshots every 15 seconds and stop on every exit.
- [ ] No progress snapshot includes prompt/ZIP/partial-answer content, percentage, or ETA.
- [ ] OMP `onUpdate` receives valid text content plus structured progress details.
- [ ] Final Markdown/details/isError behavior remains compatible.
- [ ] Existing surface ownership/retention behavior remains compatible.
- [ ] Existing SDK/cmux one-submit and Markdown tests pass.
- [ ] Package tests and check pass.
- [ ] Root `bun run check` passes.
- [ ] Manual live-smoke result is reported accurately.
