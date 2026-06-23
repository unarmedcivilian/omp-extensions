import { describe, expect, test } from "bun:test";
import {
  runChatGptProConsult,
  type ChatGptProConsultDeps,
} from "../src/consult.js";

interface FakeDeps extends ChatGptProConsultDeps {
  calls: unknown[];
  readonly selectedCalls: number;
  readonly closeCalls: number;
}

function depsReturning(
  result: unknown | (() => Promise<unknown>),
  options: { currentError?: Error; markSubmittedImmediately?: boolean; now?: () => Date } = {},
): FakeDeps {
  const calls: unknown[] = [];
  let selectedCalls = 0;
  let closeCalls = 0;

  return {
    calls,
    get selectedCalls() {
      return selectedCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    createChatGptClient: () => ({
      ask: async (args: unknown) => {
        calls.push(args);
        if (typeof result === "function") return await result();
        return result;
      },
    }),
    createBrowser: browserOptions => {
      if (options.markSubmittedImmediately) browserOptions.lifecycle.markPromptSubmitted();
      return {
        requireSelectedChatGptSurface: async () => {
          selectedCalls += 1;
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

function neverSettles(): Promise<unknown> {
  return Promise.withResolvers<unknown>().promise;
}

describe("runChatGptProConsult", () => {
  test("submits a new-thread Pro consult with Markdown read", async () => {
    const deps = depsReturning({ ok: true, status: "ok", output_text: "omp smoke ok", warnings: [], context: { timestamp: "t" } });

    const result = await runChatGptProConsult({ prompt: "  Reply once  ", timeoutMs: 90_000 }, deps);

    expect(deps.calls).toEqual([{
      prompt: "Reply once",
      thread: { type: "new" },
      existingTab: undefined,
      preferExistingTab: false,
      mode: { intelligence: "pro", timeoutMs: 15_000 },
      wait: { timeoutMs: 70_000 },
      read: { format: "markdown" },
      report: false,
    }]);
    expect(result.ok).toBe(true);
    expect(result.markdown).toBe("omp smoke ok");
    expect(result.contentText).toBe("omp smoke ok");
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
      mode: { intelligence: "pro", timeoutMs: 15_000 },
      wait: { timeoutMs: 100_000 },
      read: { format: "markdown" },
      report: false,
    }]);
  });

  test("returns a structured blocker when current-thread preflight has no selected ChatGPT surface", async () => {
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [], context: { timestamp: "t" } },
      { currentError: new Error("No selected ChatGPT surface is available for thread=current") },
    );

    const result = await runChatGptProConsult({ prompt: "Continue", thread: "current" }, deps);

    expect(deps.calls).toEqual([]);
    expect(deps.closeCalls).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("blocked");
    expect(result.details.keptSurface).toBe(false);
    expect(result.details.blocker).toMatchObject({ code: "current_chatgpt_surface_missing" });
  });

  test("does not preflight current-thread surface when its deadline is already expired", async () => {
    let nowCalls = 0;
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [] },
      {
        now: () => {
          nowCalls += 1;
          return new Date(nowCalls === 1 ? "2026-06-22T00:00:00.000Z" : "2026-06-22T00:00:00.002Z");
        },
      },
    );

    const result = await runChatGptProConsult({ prompt: "Continue", thread: "current", timeoutMs: 1 }, deps);

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
        now: () => {
          nowCalls += 1;
          return new Date(nowCalls === 1 ? "2026-06-22T00:00:00.000Z" : "2026-06-22T00:00:00.002Z");
        },
      },
    );

    const result = await runChatGptProConsult({ prompt: "Hi", timeoutMs: 1 }, deps);

    expect(deps.calls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(result.details.keptSurface).toBe(false);
    expect(deps.closeCalls).toBe(1);
  });

  test("closes owned surfaces when the SDK times out before submission is observed", async () => {
    const deps = depsReturning(neverSettles);

    const result = await runChatGptProConsult({ prompt: "Hi", timeoutMs: 1 }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(result.details.keptSurface).toBe(false);
    expect(deps.closeCalls).toBe(1);
  });

  test("leaves surfaces open when the SDK hangs after the prompt may have been submitted", async () => {
    const deps = depsReturning(neverSettles, { markSubmittedImmediately: true });

    const result = await runChatGptProConsult({ prompt: "Hi", timeoutMs: 1 }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(result.details.keptSurface).toBe(true);
    expect(result.contentText).toContain("Surface left open at surface:7");
    expect(deps.closeCalls).toBe(0);
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
