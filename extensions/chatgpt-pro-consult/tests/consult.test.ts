import { describe, expect, jest, test } from "bun:test";
import { resolve } from "node:path";
import {
  createConsultDeadline,
  runChatGptProConsult,
  type ChatGptProConsultDeps,
  type ChatGptProConsultProgress,
  type ScheduleConsultHeartbeat,
} from "../src/consult.js";

interface FakeDeps extends ChatGptProConsultDeps {
  calls: unknown[];
  readonly selectedCalls: number;
  readonly closeCalls: number;
  readonly browserSignal: AbortSignal | undefined;
  markPromptSubmitted(): void;
}

function depsReturning(
  result: unknown | (() => Promise<unknown>),
  options: {
    currentError?: Error;
    currentSurface?: () => Promise<{ tabId: string; surface: string; url: string }>;
    deadlineMs?: number;
    markSubmittedImmediately?: boolean;
    now?: () => Date;
    scheduleHeartbeat?: ScheduleConsultHeartbeat;
  } = {},
): FakeDeps {
  const calls: unknown[] = [];
  let selectedCalls = 0;
  let closeCalls = 0;
  let browserSignal: AbortSignal | undefined;
  let markPromptSubmittedHook: (() => void) | undefined;

  return {
    calls,
    scheduleHeartbeat: options.scheduleHeartbeat,
    createDeadline: options.deadlineMs === undefined
      ? undefined
      : (_timeoutMs: number, now: () => Date, onExpire?: (error: Error) => void) =>
          createConsultDeadline(options.deadlineMs!, now, onExpire),
    get selectedCalls() {
      return selectedCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    get browserSignal() {
      return browserSignal;
    },
    markPromptSubmitted() {
      markPromptSubmittedHook?.();
    },
    createChatGptClient: () => ({
      ask: async (args: unknown) => {
        calls.push(args);
        if (options.markSubmittedImmediately) markPromptSubmittedHook?.();
        if (typeof result === "function") return await result();
        return result;
      },
      askWithFiles: async (args: unknown) => {
        calls.push({ method: "askWithFiles", args });
        if (typeof result === "function") return await result();
        return result;
      },
      runPlan: async (plan: unknown) => {
        calls.push({ method: "runPlan", plan });
        if (options.markSubmittedImmediately) markPromptSubmittedHook?.();
        if (typeof result === "function") return await result();
        return result;
      },
    }),
    createBrowser: browserOptions => {
      browserSignal = browserOptions.signal;
      markPromptSubmittedHook = () => browserOptions.lifecycle.markPromptSubmitted();
      return {
        requireSelectedChatGptSurface: async () => {
          selectedCalls += 1;
          if (options.currentSurface) return await options.currentSurface();
          if (options.currentError) throw options.currentError;
          return { tabId: "surface:42", surface: "surface:42", url: "https://chatgpt.com/c/current" };
        },
        primarySurfaceRef: () => "surface:7",
        closeOwnedSurfaces: async () => {
          closeCalls += 1;
        },
      };
    },
    now: options.now ?? (() => new Date("2026-06-22T00:00:00.000Z")),
  } as FakeDeps;
}

function manualHeartbeat(): {
  schedule: ScheduleConsultHeartbeat;
  fire(): void;
  readonly scheduled: number;
  readonly stopCalls: number;
} {
  let callback: (() => void) | undefined;
  let scheduled = 0;
  let stopCalls = 0;

  return {
    schedule(next, intervalMs) {
      expect(intervalMs).toBe(15_000);
      scheduled += 1;
      callback = next;
      return () => {
        stopCalls += 1;
        callback = undefined;
      };
    },
    fire() {
      callback?.();
    },
    get scheduled() {
      return scheduled;
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}

function neverSettles<T = unknown>(): Promise<T> {
  return Promise.withResolvers<T>().promise;
}

describe("runChatGptProConsult", () => {
  test("submits a new-thread Pro consult with Markdown read", async () => {
    const deps = depsReturning({ ok: true, status: "ok", output_text: "omp smoke ok", warnings: [], context: { timestamp: "t" } });

    const result = await runChatGptProConsult({ prompt: "  Reply once  " }, deps);

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
    expect(result.ok).toBe(true);
    expect(result.markdown).toBe("omp smoke ok");
    expect(result.contentText).toBe("omp smoke ok");
  });

  test("emits preparing, submitting, and possible-submission waiting snapshots", async () => {
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "done", warnings: [] },
      {
        markSubmittedImmediately: true,
        scheduleHeartbeat: heartbeat.schedule,
      },
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
    expect(snapshots[0]).toMatchObject({
      phase: "preparing",
      message: "Preparing ChatGPT Pro consult…",
      timeoutMs: 7_200_000,
      thread: "new",
      hasZip: false,
    });
    expect(snapshots[1]).toMatchObject({
      phase: "submitting",
      message: "Opening ChatGPT Pro and submitting the prompt…",
    });
    expect(snapshots.at(-1)).toMatchObject({
      phase: "waiting",
      message: "Prompt submission initiated; waiting for ChatGPT Pro…",
      timeoutMs: 7_200_000,
      thread: "new",
      hasZip: false,
      surfaceRef: "surface:7",
    });
    expect(heartbeat.scheduled).toBe(1);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("stops a new-thread consult when preparing progress aborts", async () => {
    const controller = new AbortController();
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      { scheduleHeartbeat: heartbeat.schedule },
    );

    const result = await runChatGptProConsult({
      prompt: "Hi",
      signal: controller.signal,
      onProgress: snapshot => {
        snapshots.push(snapshot);
        if (snapshot.phase === "preparing") {
          controller.abort(new Error("cancelled during preparation"));
        }
      },
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("error");
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual(["preparing"]);
    expect(deps.selectedCalls).toBe(0);
    expect(deps.calls).toEqual([]);
    expect(deps.closeCalls).toBe(0);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("does not preflight current-thread work when preparing progress aborts", async () => {
    const controller = new AbortController();
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      { scheduleHeartbeat: heartbeat.schedule },
    );

    const result = await runChatGptProConsult({
      prompt: "Continue",
      thread: "current",
      signal: controller.signal,
      onProgress: snapshot => {
        snapshots.push(snapshot);
        if (snapshot.phase === "preparing") {
          controller.abort(new Error("cancelled during current preparation"));
        }
      },
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("error");
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual(["preparing"]);
    expect(deps.selectedCalls).toBe(0);
    expect(deps.calls).toEqual([]);
    expect(deps.closeCalls).toBe(0);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("attaches a single ZIP file through the SDK file workflow", async () => {
    const deps = depsReturning({ ok: true, status: "ok", output_text: "uploaded", warnings: [], context: { timestamp: "t" } });

    const result = await runChatGptProConsult({ prompt: "  Inspect this  ", zipPath: "fixtures/context.zip" }, deps);

    expect(result.ok).toBe(true);
    expect(deps.calls).toEqual([{
      method: "runPlan",
      plan: {
        name: "chatgpt-pro-consult-with-zip",
        policy: { stopOnError: true, returnPartial: true },
        steps: [
          { id: "bootstrap", command: "session.bootstrap", args: { preferExistingTab: false } },
          { id: "new", command: "threads.new" },
          { id: "mode", command: "modes.set", args: { intelligence: "Pro Extended", timeoutMs: 15_000 } },
          { id: "attach", command: "files.attach", args: { paths: [resolve("fixtures/context.zip")], timeoutMs: 7_180_000 } },
          { id: "ask", command: "messages.ask", args: { text: "Inspect this", wait: { timeoutMs: 7_180_000 }, read: { format: "markdown" } } },
        ],
      },
    }]);
  });

  test("reports ZIP presence without leaking the prompt, path, or answer", async () => {
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const prompt = "PROMPT_SECRET_7e73";
    const zipPath = "fixtures/ZIP_SECRET_7e73.zip";
    const answer = "ANSWER_SECRET_7e73";
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: answer, warnings: [] },
      {
        markSubmittedImmediately: true,
        scheduleHeartbeat: heartbeat.schedule,
      },
    );

    const result = await runChatGptProConsult({
      prompt,
      zipPath,
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);

    expect(result.ok).toBe(true);
    expect(snapshots.map(snapshot => snapshot.hasZip)).toEqual([true, true, true]);
    expect(snapshots[1]).toMatchObject({
      phase: "submitting",
      message: "Preparing ChatGPT Pro, uploading the ZIP, and submitting the prompt…",
    });
    const serializedSnapshots = JSON.stringify(snapshots);
    expect(serializedSnapshots).not.toContain(prompt);
    expect(serializedSnapshots).not.toContain(zipPath);
    expect(serializedSnapshots).not.toContain(resolve(zipPath));
    expect(serializedSnapshots).not.toContain(answer);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("rejects non-ZIP upload paths before opening ChatGPT", async () => {
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "done", warnings: [], context: { timestamp: "t" } },
      { scheduleHeartbeat: heartbeat.schedule },
    );

    const result = await runChatGptProConsult({
      prompt: "Hi",
      zipPath: "fixtures/context.txt",
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("error");
    expect((result.details.error as { message?: string } | undefined)?.message).toContain(".zip");
    expect(deps.calls).toHaveLength(0);
    expect(deps.closeCalls).toBe(0);
    expect(snapshots).toEqual([]);
    expect(heartbeat.scheduled).toBe(0);
    expect(heartbeat.stopCalls).toBe(0);
  });

  test("does not schedule a heartbeat without a progress callback", async () => {
    const heartbeat = manualHeartbeat();
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "done", warnings: [] },
      { scheduleHeartbeat: heartbeat.schedule },
    );

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(true);
    expect(heartbeat.scheduled).toBe(0);
    expect(heartbeat.stopCalls).toBe(0);
  });

  test("leaves the surface open for pre-submit upload blockers", async () => {
    const deps = depsReturning({
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: { kind: "upload_failed", code: "attachment_processing", message: "ChatGPT is still processing the upload." },
      context: { turnCount: 0 },
    });

    const result = await runChatGptProConsult({ prompt: "Inspect", zipPath: "fixtures/context.zip" }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.keptSurface).toBe(true);
    expect(result.details.blocker?.surfaceRef).toBe("surface:7");
    expect(deps.closeCalls).toBe(0);
  });

  test("closes the surface for local ZIP preflight blockers", async () => {
    const deps = depsReturning({
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: { kind: "upload_failed", code: "file_path_not_file", message: "File attachment path is not a file." },
      context: { timestamp: "t" },
    });

    const result = await runChatGptProConsult({ prompt: "Inspect", zipPath: "fixtures/missing.zip" }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.keptSurface).toBe(false);
    expect(result.details.blocker?.surfaceRef).toBeUndefined();
    expect(deps.closeCalls).toBe(1);
  });

  test("configures new-thread browser pages to settle after opening before SDK submission", async () => {
    let openSettleMs: unknown;
    const deps = depsReturning({ ok: true, status: "ok", output_text: "done", warnings: [], context: { timestamp: "t" } });
    const baseCreateBrowser = deps.createBrowser;
    deps.createBrowser = options => {
      openSettleMs = (options as { openSettleMs?: number }).openSettleMs;
      return baseCreateBrowser(options);
    };

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(true);
    expect(openSettleMs).toBeGreaterThan(0);
  });

  test("pins current-thread consults to the preflight-selected cmux surface", async () => {
    const deps = depsReturning({ ok: true, status: "ok", output_text: "done", warnings: [], context: { timestamp: "t" } });

    await runChatGptProConsult({ prompt: "Continue", thread: "current" }, deps);

    expect(deps.selectedCalls).toBe(1);
    expect(deps.calls).toEqual([{
      prompt: "Continue",
      thread: { type: "current" },
      existingTab: {
        target: { type: "tabId", tabId: "surface:42" },
        ifMissing: "block",
        ifMultiple: "block",
        requireChatGPT: true,
      },
      preferExistingTab: true,
      mode: { intelligence: "Pro Extended", timeoutMs: 15_000 },
      wait: { timeoutMs: 7_180_000 },
      read: { format: "markdown" },
      report: false,
    }]);
  });

  test("reports current-thread preparation before preflight and later includes its surface", async () => {
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    let phasesAtPreflight: ChatGptProConsultProgress["phase"][] = [];
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "done", warnings: [] },
      {
        currentSurface: async () => {
          phasesAtPreflight = snapshots.map(snapshot => snapshot.phase);
          return { tabId: "surface:42", surface: "surface:42", url: "https://chatgpt.com/c/current" };
        },
        markSubmittedImmediately: true,
        scheduleHeartbeat: heartbeat.schedule,
      },
    );

    const result = await runChatGptProConsult({
      prompt: "Continue",
      thread: "current",
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);

    expect(result.ok).toBe(true);
    expect(phasesAtPreflight).toEqual(["preparing"]);
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
      "preparing",
      "submitting",
      "waiting",
    ]);
    expect(snapshots.every(snapshot => snapshot.thread === "current")).toBe(true);
    expect(snapshots.slice(1).every(snapshot => snapshot.surfaceRef === "surface:7")).toBe(true);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("falls back to legacy Pro mode label when Pro Extended is unavailable before submission", async () => {
    let attempts = 0;
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const deps = depsReturning(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({
          ok: false,
          status: "partial",
          warnings: [],
          steps: [
            { command: "session.bootstrap", ok: true, status: "ok" },
            { command: "modes.set", ok: false, status: "unsupported" },
          ],
          blocker: {
            kind: "selector_drift",
            code: "visible_candidate_not_found",
            message: "Mode option \"Pro Extended\" was not found or was ambiguous.",
          },
          context: { timestamp: "t" },
        });
      }
      return Promise.resolve({ ok: true, status: "ok", output_text: "done", warnings: [], context: { timestamp: "t" } });
    }, { scheduleHeartbeat: heartbeat.schedule });

    const result = await runChatGptProConsult({
      prompt: "Hi",
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);

    expect(result.ok).toBe(true);
    expect(deps.calls).toHaveLength(2);
    expect(deps.calls).toMatchObject([
      { mode: { intelligence: "Pro Extended" } },
      { mode: { intelligence: "pro" } },
    ]);
    expect(deps.closeCalls).toBe(1);
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
      "preparing",
      "submitting",
      "submitting",
    ]);
    expect(snapshots.map(snapshot => snapshot.message)).toEqual([
      "Preparing ChatGPT Pro consult…",
      "Opening ChatGPT Pro and submitting the prompt…",
      "Preferred Pro mode unavailable; retrying legacy Pro mode…",
    ]);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("does not construct a legacy-mode request when its progress update aborts", async () => {
    const controller = new AbortController();
    const heartbeat = manualHeartbeat();
    let attempts = 0;
    const deps = depsReturning(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({
          ok: false,
          status: "partial",
          warnings: [],
          steps: [
            { command: "session.bootstrap", ok: true, status: "ok" },
            { command: "modes.set", ok: false, status: "unsupported" },
          ],
          blocker: {
            kind: "selector_drift",
            code: "visible_candidate_not_found",
            message: "Mode option \"Pro Extended\" was not found or was ambiguous.",
          },
          context: { timestamp: "t" },
        });
      }
      return Promise.resolve({ ok: true, status: "ok", output_text: "should not run", warnings: [] });
    }, { scheduleHeartbeat: heartbeat.schedule });

    const result = await runChatGptProConsult({
      prompt: "Hi",
      signal: controller.signal,
      onProgress: snapshot => {
        if (snapshot.message.includes("retrying legacy Pro mode")) {
          controller.abort(new Error("cancelled during fallback update"));
        }
      },
    }, deps);

    expect(result.ok).toBe(false);
    expect(deps.calls).toHaveLength(1);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("does not construct a legacy-mode request when fallback progress marks possible submission", async () => {
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    let attempts = 0;
    const deps = depsReturning(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({
          ok: false,
          status: "partial",
          warnings: [],
          steps: [
            { command: "session.bootstrap", ok: true, status: "ok" },
            { command: "modes.set", ok: false, status: "unsupported" },
          ],
          blocker: {
            kind: "selector_drift",
            code: "visible_candidate_not_found",
            message: "Mode option \"Pro Extended\" was not found or was ambiguous.",
          },
          context: { timestamp: "t" },
        });
      }
      return Promise.resolve({ ok: true, status: "ok", output_text: "should not run", warnings: [] });
    }, { scheduleHeartbeat: heartbeat.schedule });

    const result = await runChatGptProConsult({
      prompt: "Hi",
      onProgress: snapshot => {
        snapshots.push(snapshot);
        if (snapshot.message.includes("retrying legacy Pro mode")) {
          deps.markPromptSubmitted();
        }
      },
    }, deps);

    expect(result.ok).toBe(false);
    expect(deps.calls).toHaveLength(1);
    expect(result.details.keptSurface).toBe(true);
    expect(deps.closeCalls).toBe(0);
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
      "preparing",
      "submitting",
      "submitting",
      "waiting",
    ]);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("does not retry Pro mode fallback after possible submission", async () => {
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const deps = depsReturning({
      ok: false,
      status: "partial",
      warnings: [],
      steps: [
        { command: "session.bootstrap", ok: true, status: "ok" },
        { command: "modes.set", ok: false, status: "unsupported" },
      ],
      blocker: {
        kind: "selector_drift",
        code: "visible_candidate_not_found",
        message: "Mode option \"Pro Extended\" was not found or was ambiguous.",
      },
      context: { timestamp: "t" },
    }, {
      markSubmittedImmediately: true,
      scheduleHeartbeat: heartbeat.schedule,
    });

    const result = await runChatGptProConsult({
      prompt: "Hi",
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);

    expect(result.ok).toBe(false);
    expect(deps.calls).toHaveLength(1);
    expect(result.details.keptSurface).toBe(true);
    expect(deps.closeCalls).toBe(0);
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
      "preparing",
      "submitting",
      "waiting",
    ]);
    expect(snapshots.some(snapshot => snapshot.message.includes("retrying legacy Pro mode"))).toBe(false);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("returns a structured blocker when current-thread preflight has no selected ChatGPT surface", async () => {
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [], context: { timestamp: "t" } },
      {
        currentError: new Error("No selected ChatGPT surface is available for thread=current"),
        scheduleHeartbeat: heartbeat.schedule,
      },
    );

    const result = await runChatGptProConsult({
      prompt: "Continue",
      thread: "current",
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);

    expect(deps.calls).toEqual([]);
    expect(deps.closeCalls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("blocked");
    expect(result.details.keptSurface).toBe(false);
    expect(result.details.blocker).toMatchObject({ code: "current_chatgpt_surface_missing" });
    expect(heartbeat.stopCalls).toBe(1);
    const snapshotCount = snapshots.length;
    heartbeat.fire();
    expect(snapshots).toHaveLength(snapshotCount);
  });

  test("preserves the caller reason when current preflight rejects as the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const surfaceError = new Error("surface closed");
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      { currentSurface: neverSettles },
    );
    deps.createDeadline = () => ({
      remainingMs: () => 1,
      throwIfExpired() {},
      async race<T>(_operation: string, promise: Promise<T>): Promise<T> {
        void promise.catch(() => undefined);
        controller.abort(reason);
        throw surfaceError;
      },
    });

    const result = await runChatGptProConsult({
      prompt: "Continue",
      thread: "current",
      signal: controller.signal,
    }, deps);

    expect(deps.calls).toEqual([]);
    expect(deps.closeCalls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("error");
    expect(result.details.blocker).toMatchObject({ code: "consult_error" });
    expect(result.details.blocker).not.toMatchObject({ code: "current_chatgpt_surface_missing" });
    expect(result.details.error).toEqual({ name: "Error", message: "cancelled" });
  });

  test("uses the deadline reason when current preflight rejects as the deadline aborts", async () => {
    const surfaceError = new Error("surface closed");
    const timeoutError = new Error("chatgpt.current_surface exceeded chatgpt_pro_consult timeout");
    timeoutError.name = "TimeoutError";
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      { currentSurface: neverSettles },
    );
    deps.createDeadline = (_timeoutMs, _now, onExpire) => ({
      remainingMs: () => 1,
      throwIfExpired() {},
      async race<T>(_operation: string, promise: Promise<T>): Promise<T> {
        void promise.catch(() => undefined);
        onExpire?.(timeoutError);
        throw surfaceError;
      },
    });

    const result = await runChatGptProConsult({ prompt: "Continue", thread: "current" }, deps);

    expect(deps.calls).toEqual([]);
    expect(deps.closeCalls).toBe(1);
    expect(deps.browserSignal?.reason).toBe(timeoutError);
    expect(result.details.status).toBe("timeout");
    expect(result.details.blocker).toMatchObject({
      code: "consult_timeout",
      message: timeoutError.message,
    });
    expect(result.details.error).toEqual({ name: "TimeoutError", message: timeoutError.message });
  });

  test("does not preflight current-thread surface when its deadline is already expired", async () => {
    let nowCalls = 0;
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      {
        deadlineMs: 1,
        now: () => {
          nowCalls += 1;
          return new Date(nowCalls === 1 ? "2026-06-22T00:00:00.000Z" : "2026-06-22T00:00:00.002Z");
        },
      },
    );

    const result = await runChatGptProConsult({ prompt: "Continue", thread: "current" }, deps);

    expect(deps.selectedCalls).toBe(0);
    expect(deps.calls).toEqual([]);
    expect(deps.closeCalls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(result.details.blocker).toMatchObject({ code: "consult_timeout" });
    expect(result.details.blocker).not.toMatchObject({ code: "current_chatgpt_surface_missing" });
  });

  test("closes extension-owned surfaces after successful new-thread consults by default", async () => {
    const deps = depsReturning({ ok: true, status: "ok", output_text: "done", warnings: [], steps: [{ command: "messages.ask" }], context: { timestamp: "t" } });

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(true);
    expect(result.details.keptSurface).toBe(false);
    expect(deps.closeCalls).toBe(1);
  });

  test("leaves surfaces open for post-submit blockers so the user can inspect ChatGPT", async () => {
    const deps = depsReturning({
      ok: false,
      status: "timeout",
      warnings: [],
      steps: [{ command: "messages.ask" }],
      blocker: { kind: "selector_drift", message: "Could not read latest response" },
      context: { timestamp: "t", turnCount: 1 },
    });

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(false);
    expect(result.contentText).toContain("Surface left open at surface:7");
    expect(result.details.keptSurface).toBe(true);
    expect(result.details.surfaceRef).toBe("surface:7");
    expect(deps.closeCalls).toBe(0);
  });

  test("does not treat SDK messages.ask steps alone as submitted prompt proof", async () => {
    const deps = depsReturning({
      ok: false,
      status: "blocked",
      warnings: [],
      steps: [{ command: "messages.ask" }],
      blocker: { kind: "permission", message: "Browser permission is required" },
      context: { timestamp: "t" },
    });

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.keptSurface).toBe(false);
    expect(deps.closeCalls).toBe(1);
  });

  test("does not call the SDK ask when the pre-submit deadline is already expired", async () => {
    let nowCalls = 0;
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      {
        deadlineMs: 1,
        now: () => {
          nowCalls += 1;
          return new Date(nowCalls === 1 ? "2026-06-22T00:00:00.000Z" : "2026-06-22T00:00:00.002Z");
        },
      },
    );

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(deps.calls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(result.details.keptSurface).toBe(false);
    expect(deps.closeCalls).toBe(1);
  });

  test("does not construct the SDK request when submitting progress aborts", async () => {
    const controller = new AbortController();
    const heartbeat = manualHeartbeat();
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      { scheduleHeartbeat: heartbeat.schedule },
    );

    const result = await runChatGptProConsult({
      prompt: "Hi",
      signal: controller.signal,
      onProgress: snapshot => {
        if (snapshot.phase === "submitting") {
          controller.abort(new Error("cancelled during submitting update"));
        }
      },
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("error");
    expect(deps.calls).toEqual([]);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("does not construct the SDK request when submitting progress crosses the deadline", async () => {
    let nowMs = 0;
    const heartbeat = manualHeartbeat();
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      {
        deadlineMs: 1,
        now: () => new Date(nowMs),
        scheduleHeartbeat: heartbeat.schedule,
      },
    );

    const result = await runChatGptProConsult({
      prompt: "Hi",
      onProgress: snapshot => {
        if (snapshot.phase === "submitting") nowMs = 2;
      },
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(deps.calls).toEqual([]);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("emits full 15-second heartbeats with monotonic elapsed time until success", async () => {
    let nowMs = 0;
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const askStarted = Promise.withResolvers<void>();
    const askResult = Promise.withResolvers<unknown>();
    const deps = depsReturning(async () => {
      askStarted.resolve();
      return await askResult.promise;
    }, {
      markSubmittedImmediately: true,
      now: () => new Date(nowMs),
      scheduleHeartbeat: heartbeat.schedule,
    });

    const running = runChatGptProConsult({
      prompt: "Hi",
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);
    await askStarted.promise;

    nowMs = 15_000;
    heartbeat.fire();
    expect(snapshots.at(-1)).toMatchObject({
      phase: "waiting",
      message: "Prompt submission initiated; waiting for ChatGPT Pro…",
      elapsedMs: 15_000,
      timeoutMs: 7_200_000,
      thread: "new",
      hasZip: false,
      surfaceRef: "surface:7",
    });

    nowMs = 5_000;
    heartbeat.fire();
    expect(snapshots.at(-1)).toMatchObject({
      phase: "waiting",
      elapsedMs: 15_000,
    });

    askResult.resolve({ ok: true, status: "ok", output_text: "done", warnings: [] });
    const result = await running;
    expect(result.ok).toBe(true);
    expect(heartbeat.stopCalls).toBe(1);
    const snapshotCount = snapshots.length;
    heartbeat.fire();
    expect(snapshots).toHaveLength(snapshotCount);
  });

  test("closes owned surfaces when the internal deadline expires before submission is observed", async () => {
    jest.useFakeTimers();
    try {
      const heartbeat = manualHeartbeat();
      const snapshots: ChatGptProConsultProgress[] = [];
      const deps = depsReturning(neverSettles, {
        deadlineMs: 1,
        scheduleHeartbeat: heartbeat.schedule,
      });

      const pending = runChatGptProConsult({
        prompt: "Hi",
        onProgress: snapshot => snapshots.push(snapshot),
      }, deps);
      jest.advanceTimersByTime(1);

      expect(deps.browserSignal?.aborted).toBe(true);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.details.status).toBe("timeout");
      expect(result.details.keptSurface).toBe(false);
      expect(deps.closeCalls).toBe(1);
      expect(heartbeat.stopCalls).toBe(1);
      const snapshotCount = snapshots.length;
      heartbeat.fire();
      expect(snapshots).toHaveLength(snapshotCount);
    } finally {
      jest.useRealTimers();
    }
  });

  test("aborts browser work and leaves surfaces open when the post-submit deadline expires", async () => {
    jest.useFakeTimers();
    try {
      const deps = depsReturning(neverSettles, { deadlineMs: 1, markSubmittedImmediately: true });

      const pending = runChatGptProConsult({ prompt: "Hi" }, deps);
      jest.advanceTimersByTime(1);

      expect(deps.browserSignal?.aborted).toBe(true);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.details.status).toBe("timeout");
      expect(result.details.keptSurface).toBe(true);
      expect(result.contentText).toContain("Surface left open at surface:7");
      expect(result.details.blocker).toMatchObject({ code: "consult_timeout" });
      expect(deps.browserSignal?.reason).toBeInstanceOf(Error);
      expect((deps.browserSignal?.reason as Error).name).toBe("TimeoutError");
      expect(deps.closeCalls).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("stops progress after an explicit caller abort", async () => {
    const controller = new AbortController();
    const heartbeat = manualHeartbeat();
    const snapshots: ChatGptProConsultProgress[] = [];
    const askStarted = Promise.withResolvers<void>();
    const deps = depsReturning(async () => {
      askStarted.resolve();
      return await neverSettles();
    }, {
      markSubmittedImmediately: true,
      scheduleHeartbeat: heartbeat.schedule,
    });

    const running = runChatGptProConsult({
      prompt: "Hi",
      signal: controller.signal,
      onProgress: snapshot => snapshots.push(snapshot),
    }, deps);
    await askStarted.promise;
    controller.abort(new Error("cancelled"));

    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("error");
    expect(heartbeat.stopCalls).toBe(1);
    const snapshotCount = snapshots.length;
    heartbeat.fire();
    expect(snapshots).toHaveLength(snapshotCount);
  });

  test("stops the heartbeat exactly once when a progress callback throws", async () => {
    const heartbeat = manualHeartbeat();
    const callbackError = new Error("progress callback failed");
    let updateCalls = 0;
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      { scheduleHeartbeat: heartbeat.schedule },
    );

    const running = runChatGptProConsult({
      prompt: "Hi",
      onProgress: () => {
        updateCalls += 1;
        throw callbackError;
      },
    }, deps);

    await expect(running).rejects.toBe(callbackError);
    expect(updateCalls).toBe(1);
    expect(heartbeat.stopCalls).toBe(1);
    heartbeat.fire();
    expect(updateCalls).toBe(1);
  });

  test("contains heartbeat callback errors and cancels future heartbeats", async () => {
    let nowMs = 0;
    const heartbeat = manualHeartbeat();
    const callbackError = new Error("heartbeat callback failed");
    const askStarted = Promise.withResolvers<void>();
    const askResult = Promise.withResolvers<unknown>();
    let updateCalls = 0;
    const deps = depsReturning(async () => {
      askStarted.resolve();
      return await askResult.promise;
    }, {
      markSubmittedImmediately: true,
      now: () => new Date(nowMs),
      scheduleHeartbeat: heartbeat.schedule,
    });

    const running = runChatGptProConsult({
      prompt: "Hi",
      onProgress: snapshot => {
        updateCalls += 1;
        if (snapshot.elapsedMs === 15_000) throw callbackError;
      },
    }, deps);
    await askStarted.promise;

    nowMs = 15_000;
    expect(() => heartbeat.fire()).not.toThrow();
    expect(heartbeat.stopCalls).toBe(1);
    const updateCount = updateCalls;
    heartbeat.fire();
    expect(updateCalls).toBe(updateCount);

    askResult.resolve({ ok: true, status: "ok", output_text: "done", warnings: [] });
    const result = await running;
    expect(result.ok).toBe(true);
    expect(heartbeat.stopCalls).toBe(1);
  });

  test("returns structured login blocker details without pretending success", async () => {
    const deps = depsReturning({
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: {
        kind: "login_required",
        message: "Log in to ChatGPT",
        candidates: ["Sign in"],
        remediation: { action: "login" },
        diagnostics: { selector: "button" },
        fieldPath: ["session", "login"],
      },
      context: { timestamp: "t" },
    });

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(false);
    expect(result.contentText).toContain("Log in to ChatGPT");
    expect(result.details.status).toBe("blocked");
    expect(result.details.keptSurface).toBe(true);
    expect(result.details.blocker).toMatchObject({
      kind: "login_required",
      surfaceRef: "surface:7",
      candidates: ["Sign in"],
      remediation: { action: "login" },
      diagnostics: { selector: "button" },
      fieldPath: ["session", "login"],
    });
    expect(deps.closeCalls).toBe(0);
  });
});

describe("createConsultDeadline", () => {
  test("observes an eager rejection when race starts after expiry", async () => {
    const deadline = createConsultDeadline(0, () => new Date("2026-06-22T00:00:00.000Z"));
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", recordUnhandled);

    try {
      const inputError = new Error("input rejected after deadline abort");
      const input = Promise.reject(inputError);

      await expect(deadline.race("chatgpt.ask", input)).rejects.toMatchObject({ name: "TimeoutError" });
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  test("reuses one TimeoutError and expires once across repeated checks", async () => {
    const expirations: Error[] = [];
    const deadline = createConsultDeadline(
      0,
      () => new Date("2026-06-22T00:00:00.000Z"),
      error => expirations.push(error),
    );
    let first: unknown;
    let second: unknown;

    try {
      deadline.throwIfExpired("first");
    } catch (error) {
      first = error;
    }
    try {
      deadline.throwIfExpired("second");
    } catch (error) {
      second = error;
    }

    expect(first).toBeInstanceOf(Error);
    expect((first as Error).name).toBe("TimeoutError");
    expect((first as Error).message).toContain("first");
    expect(second).toBe(first);
    await expect(deadline.race("third", Promise.resolve("unused"))).rejects.toBe(first);
    expect(expirations).toHaveLength(1);
    expect(expirations[0]).toBe(first);
  });
});
