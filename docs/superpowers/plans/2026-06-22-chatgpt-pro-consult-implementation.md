# ChatGPT Pro Consult Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OMP extension package that submits one explicit prompt to a visible ChatGPT Pro session through cmux and returns the assistant response as Markdown.

**Architecture:** The extension is a thin OMP wrapper around a standalone core consult runner. The core runner uses `codex-chatgpt-control` with a cmux-backed `BrowserLike`/`PageLike` adapter, so the same flow can be exercised by a manual smoke script outside the ExtensionAPI. cmux transport code owns socket/CLI operations, page/browser adapters own SDK compatibility, and `src/index.ts` only handles OMP registration and result formatting.

**Tech Stack:** Bun, TypeScript ESM, OMP `ExtensionAPI`, `codex-chatgpt-control`, cmux browser CLI/socket APIs, `bun:test`.

---

## Required skills during execution

- Use @test-driven-development before implementation changes.
- Use @systematic-debugging for any failing test, smoke, or unexpected browser behavior.
- Use @verification-before-completion before claiming any task or phase is complete.

## Spec reference

- `docs/superpowers/specs/2026-06-22-chatgpt-pro-consult-design.md`

## File structure

Create a new workspace package:

- `extensions/chatgpt-pro-consult/package.json` — package metadata, dependency on `codex-chatgpt-control`, OMP extension entry, package scripts.
- `extensions/chatgpt-pro-consult/README.md` — package usage and manual smoke instructions. Write after the core flow works.
- `extensions/chatgpt-pro-consult/src/index.ts` — OMP extension factory, idempotent registration, `chatgpt_pro_consult` tool schema, tool-result mapping.
- `extensions/chatgpt-pro-consult/src/consult.ts` — standalone core runner, parameter normalization, SDK call shape, timeout splitting, blocker/result mapping, cleanup policy.
- `extensions/chatgpt-pro-consult/src/cmux.ts` — abort-aware cmux transport, socket open/wait/close where available, CLI fallback for browser operations.
- `extensions/chatgpt-pro-consult/src/cmux-browser.ts` — SDK `BrowserLike` adapter and current-surface preflight.
- `extensions/chatgpt-pro-consult/src/cmux-page.ts` — SDK `PageLike`/`LocatorLike` adapter over cmux eval/get/action primitives.
- `extensions/chatgpt-pro-consult/src/blockers.ts` — small local helpers for structured blocker objects and user-visible messages.
- `extensions/chatgpt-pro-consult/scripts/live-smoke.ts` — dev-only smoke script that calls the same core runner with real cmux.
- `extensions/chatgpt-pro-consult/tests/consult.test.ts` — core runner mapping, blockers, cleanup, abort behavior with fakes.
- `extensions/chatgpt-pro-consult/tests/cmux.test.ts` — cmux socket/CLI fallback and abort behavior.
- `extensions/chatgpt-pro-consult/tests/cmux-browser.test.ts` — `BrowserLike` bootstrap/current-target behavior.
- `extensions/chatgpt-pro-consult/tests/cmux-page.test.ts` — `PageLike`/`LocatorLike` serialization and essential operations.
- `extensions/chatgpt-pro-consult/tests/extension.test.ts` — OMP registration and tool execution wrapper.
- `tests/workspace-layout.test.ts` — workspace package/root script coverage.
- `package.json` — root `test`/`check` scripts enumerate the new package.
- `README.md` — root package list update. Write after the core flow works.

---

### Task 1: Workspace package scaffold

**Files:**
- Modify: `tests/workspace-layout.test.ts`
- Modify: `package.json`
- Create: `extensions/chatgpt-pro-consult/package.json`
- Create: `extensions/chatgpt-pro-consult/src/index.ts`

- [ ] **Step 1: Write the failing workspace/package test**

Add a new constant and test to `tests/workspace-layout.test.ts`:

```ts
const CHATGPT_PRO_PACKAGE = "extensions/chatgpt-pro-consult/package.json";

// inside describe("workspace layout", ...)
test("ChatGPT Pro consult extension lives in its own workspace package and root checks include it", async () => {
  const rootPackage = await Bun.file("package.json").json() as { scripts?: Record<string, string> };
  const extensionPackage = await Bun.file(CHATGPT_PRO_PACKAGE).json() as {
    name?: string;
    omp?: { extensions?: string[] };
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  expect(extensionPackage.name).toBe("omp-chatgpt-pro-consult");
  expect(extensionPackage.omp?.extensions).toEqual(["./src/index.ts"]);
  expect(extensionPackage.dependencies?.["codex-chatgpt-control"]).toBeDefined();
  expect(extensionPackage.peerDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe("^15");
  expect(extensionPackage.scripts?.check).toContain("bun test tests/*.test.ts");
  expect(rootPackage.scripts?.test).toContain("bun --cwd extensions/chatgpt-pro-consult test");
  expect(rootPackage.scripts?.check).toContain("bun --cwd extensions/chatgpt-pro-consult check");
});
```

- [ ] **Step 2: Run the failing test**

Run:

```sh
bun test tests/workspace-layout.test.ts
```

Expected: FAIL because `extensions/chatgpt-pro-consult/package.json` does not exist.

- [ ] **Step 3: Create package manifest**

Create `extensions/chatgpt-pro-consult/package.json`:

```json
{
  "name": "omp-chatgpt-pro-consult",
  "version": "0.1.0",
  "description": "ChatGPT Pro consult tool for OMP via visible cmux browser sessions",
  "type": "module",
  "keywords": ["omp-package", "oh-my-pi", "chatgpt", "cmux"],
  "files": ["src", "scripts", "README.md"],
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "omp": { "extensions": ["./src/index.ts"] },
  "scripts": {
    "smoke": "bun scripts/live-smoke.ts",
    "test": "bun test tests/*.test.ts",
    "check": "bun test tests/*.test.ts && bun build src/index.ts --target=bun --external @oh-my-pi/pi-coding-agent --outdir /tmp/omp-chatgpt-pro-consult-check"
  },
  "dependencies": { "codex-chatgpt-control": "^0.2.0-alpha.1" },
  "peerDependencies": { "@oh-my-pi/pi-coding-agent": "^15" },
  "engines": { "bun": ">=1.3.14" },
  "license": "MIT"
}
```

- [ ] **Step 4: Add a temporary minimal extension entry**

Create `extensions/chatgpt-pro-consult/src/index.ts`:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function createChatGptProConsultExtension(): (pi: ExtensionAPI) => void {
  return function chatGptProConsultExtension(pi: ExtensionAPI): void {
    pi.setLabel("ChatGPT Pro Consult");
  };
}

export default createChatGptProConsultExtension();
```

- [ ] **Step 5: Update root scripts**

Modify root `package.json`:

```json
{
  "scripts": {
    "test": "bun test tests/*.test.ts && bun --cwd extensions/generative-ui test && bun --cwd extensions/chatgpt-links test && bun --cwd extensions/dynamic-workflows test && bun --cwd extensions/subagent-preview test && bun --cwd extensions/chatgpt-pro-consult test",
    "check": "bun test tests/*.test.ts && bun --cwd extensions/generative-ui check && bun --cwd extensions/chatgpt-links check && bun --cwd extensions/dynamic-workflows check && bun --cwd extensions/subagent-preview check && bun --cwd extensions/chatgpt-pro-consult check"
  }
}
```

Keep other root fields unchanged.

- [ ] **Step 6: Run the workspace test**

Run:

```sh
bun test tests/workspace-layout.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add package.json tests/workspace-layout.test.ts extensions/chatgpt-pro-consult/package.json extensions/chatgpt-pro-consult/src/index.ts
git commit -m "feat: scaffold chatgpt pro consult extension"
```

---

### Task 2: Core consult runner contract

**Files:**
- Create: `extensions/chatgpt-pro-consult/src/consult.ts`
- Create: `extensions/chatgpt-pro-consult/src/blockers.ts`
- Create: `extensions/chatgpt-pro-consult/tests/consult.test.ts`

- [ ] **Step 1: Write failing consult mapping tests**

Create `extensions/chatgpt-pro-consult/tests/consult.test.ts` with fake dependencies:

```ts
import { describe, expect, test } from "bun:test";
import { runChatGptProConsult, type ChatGptProConsultParams, type ChatGptProConsultDeps } from "../src/consult.js";

function depsReturning(
  result: unknown,
  options: { currentError?: Error; markSubmittedImmediately?: boolean } = {},
): ChatGptProConsultDeps & { calls: unknown[]; selectedCalls: number; closeCalls: number } {
  const calls: unknown[] = [];
  let selectedCalls = 0;
  let closeCalls = 0;
  return {
    calls,
    get selectedCalls() { return selectedCalls; },
    get closeCalls() { return closeCalls; },
    createChatGptClient: () => ({
      ask: async (args: unknown) => {
        calls.push(args);
        return result;
      },
    }),
    createBrowser: (browserOptions) => {
      if (options.markSubmittedImmediately) browserOptions.lifecycle.markPromptSubmitted();
      return {
        requireSelectedChatGptSurface: async () => {
          selectedCalls += 1;
          if (options.currentError) throw options.currentError;
          return { tabId: "surface:42", surface: "surface:42", url: "https://chatgpt.com/c/current" };
        },
        primarySurfaceRef: () => "surface:7",
        closeOwnedSurfaces: async () => { closeCalls += 1; },
      };
    },
    now: () => new Date("2026-06-22T00:00:00.000Z"),
  } as ChatGptProConsultDeps & { calls: unknown[]; selectedCalls: number; closeCalls: number };
}

describe("runChatGptProConsult", () => {
  test("submits a new-thread Pro consult with Markdown read", async () => {
    const deps = depsReturning({ ok: true, status: "ok", output_text: "omp smoke ok", warnings: [], context: { timestamp: "t" } });

    const result = await runChatGptProConsult({ prompt: "Reply once", timeoutMs: 90000 }, deps);

    expect(deps.calls).toEqual([{
      prompt: "Reply once",
      thread: { type: "new" },
      existingTab: undefined,
      preferExistingTab: false,
      mode: { intelligence: "pro", timeoutMs: 15000 },
      wait: { timeoutMs: 70000 },
      read: { format: "markdown" },
      report: false,
    }]);
    expect(result.ok).toBe(true);
    expect(result.markdown).toBe("omp smoke ok");
  });

  test("pins current-thread consults to the preflight-selected cmux surface", async () => {
    const deps = depsReturning({ ok: true, status: "ok", output_text: "done", warnings: [], context: { timestamp: "t" } });

    await runChatGptProConsult({ prompt: "Continue", thread: "current" }, deps);

    expect(deps.selectedCalls).toBe(1);
    expect(deps.calls[0]).toMatchObject({
      thread: { type: "current" },
      existingTab: {
        target: { type: "tabId", tabId: "surface:42" },
        ifMissing: "block",
        ifMultiple: "block",
        requireChatGPT: true,
      },
      preferExistingTab: true,
    });
  });

  test("returns a structured blocker when current-thread preflight has no selected ChatGPT surface", async () => {
    const deps = depsReturning(
      { ok: true, status: "ok", output_text: "should not run", warnings: [], context: { timestamp: "t" } },
      { currentError: new Error("No selected ChatGPT surface is available for thread=current") },
    );

    const result = await runChatGptProConsult({ prompt: "Continue", thread: "current" }, deps);

    expect(deps.calls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("blocked");
    expect(result.details.blocker).toMatchObject({ code: "current_chatgpt_surface_missing" });
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
      context: { timestamp: "t" },
    });

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.keptSurface).toBe(true);
    expect(result.details.surfaceRef).toBe("surface:7");
    expect(deps.closeCalls).toBe(0);
  });


  test("closes owned surfaces when the SDK times out before submission is observed", async () => {
    const deps = depsReturning(new Promise(() => undefined));

    const result = await runChatGptProConsult({ prompt: "Hi", timeoutMs: 1 }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(result.details.keptSurface).toBe(false);
    expect(deps.closeCalls).toBe(1);
  });
  test("leaves surfaces open when the SDK hangs after the prompt may have been submitted", async () => {
    const deps = depsReturning(new Promise(() => undefined), { markSubmittedImmediately: true });

    const result = await runChatGptProConsult({ prompt: "Hi", timeoutMs: 1 }, deps);

    expect(result.ok).toBe(false);
    expect(result.details.status).toBe("timeout");
    expect(result.details.keptSurface).toBe(true);
    expect(deps.closeCalls).toBe(0);
  });

  test("returns structured blocker details without pretending success", async () => {
    const deps = depsReturning({
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: { kind: "login_required", message: "Log in to ChatGPT" },
      context: { timestamp: "t" },
    });

    const result = await runChatGptProConsult({ prompt: "Hi" }, deps);

    expect(result.ok).toBe(false);
    expect(result.contentText).toContain("Log in to ChatGPT");
    expect(result.details.status).toBe("blocked");
    expect(result.details.blocker).toMatchObject({ kind: "login_required" });
  });
});
```

- [ ] **Step 2: Run failing consult tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: FAIL because `src/consult.ts` does not exist.

- [ ] **Step 3: Implement blocker helpers**

Create `extensions/chatgpt-pro-consult/src/blockers.ts`:

```ts
export interface ConsultBlocker {
  kind: string;
  message: string;
  code?: string;
  visibleText?: string;
  surfaceRef?: string;
  resumable?: boolean;
}

export function blockerText(blocker: ConsultBlocker | undefined, fallback: string): string {
  if (!blocker) return fallback;
  const surface = blocker.surfaceRef ? ` Surface left open at ${blocker.surfaceRef}.` : "";
  return `${blocker.message}${surface}`;
}
```

- [ ] **Step 4: Implement minimal core runner**

Create `extensions/chatgpt-pro-consult/src/consult.ts`:

```ts
import { createChatGPT } from "codex-chatgpt-control";
import type { CommandResult } from "codex-chatgpt-control";
import { blockerText } from "./blockers.js";
import { createCmuxBrowserAdapter, type CmuxBrowserAdapter, type SelectedChatGptSurface } from "./cmux-browser.js";

export type ChatGptProThread = "new" | "current";

export interface ChatGptProConsultParams {
  prompt: string;
  thread?: ChatGptProThread;
  timeoutMs?: number;
  keepSurface?: boolean;
  signal?: AbortSignal;
}

export interface ChatGptProConsultDetails {
  ok: boolean;
  status: string;
  warnings: string[];
  thread: ChatGptProThread;
  surfaceRef?: string;
  keptSurface: boolean;
  context?: unknown;
  blocker?: unknown;
  error?: unknown;
  raw?: unknown;
}

export interface ChatGptProConsultResult {
  ok: boolean;
  markdown: string;
  contentText: string;
  details: ChatGptProConsultDetails;
}

export interface ConsultDeadline {
  remainingMs(): number;
  throwIfExpired(operation: string): void;
  race<T>(operation: string, promise: Promise<T>): Promise<T>;
}

export interface ConsultLifecycle {
  markPromptSubmitted(): void;
}

export interface ChatGptProConsultDeps {
  createBrowser?: (options: { signal?: AbortSignal; deadline: ConsultDeadline; lifecycle: ConsultLifecycle }) => CmuxBrowserAdapter;
  createChatGptClient?: (browser: unknown) => { ask(args: unknown): Promise<CommandResult<unknown>> };
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MODE_TIMEOUT_MS = 15_000;
const READ_RESERVE_MS = 5_000;

export async function runChatGptProConsult(
  params: ChatGptProConsultParams,
  deps: ChatGptProConsultDeps = {},
): Promise<ChatGptProConsultResult> {
  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("prompt is required");

  const signal = params.signal;
  const now = deps.now ?? (() => new Date());
  throwIfAborted(signal);
  const thread = params.thread ?? "new";
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = createConsultDeadline(timeoutMs, now);
  let promptPossiblySubmitted = false;
  const lifecycle: ConsultLifecycle = { markPromptSubmitted: () => { promptPossiblySubmitted = true; } };
  const browser = deps.createBrowser?.({ signal, deadline, lifecycle }) ?? createCmuxBrowserAdapter({ signal, deadline, lifecycle });
  const modeTimeoutMs = Math.min(MODE_TIMEOUT_MS, Math.max(1_000, Math.floor(timeoutMs / 4)));
  const waitTimeoutMs = Math.max(1_000, timeoutMs - modeTimeoutMs - READ_RESERVE_MS);

  let currentTarget: SelectedChatGptSurface | undefined;
  try {
    currentTarget = thread === "current" ? await browser.requireSelectedChatGptSurface(signal) : undefined;
  } catch (error) {
    await browser.closeOwnedSurfaces(signal).catch(() => undefined);
    return blockedPreflightResult(error, thread, browser.primarySurfaceRef());
  }

  const client = deps.createChatGptClient?.(browser) ?? createChatGPT({ browser });

  let result: CommandResult<unknown> | undefined;
  try {
    result = await deadline.race("chatgpt.ask", raceAbort(client.ask({
      prompt,
      thread: thread === "current" ? { type: "current" } : { type: "new" },
      existingTab: currentTarget ? existingTabFor(currentTarget) : undefined,
      preferExistingTab: thread === "current" ? true : false,
      mode: { intelligence: "pro", timeoutMs: modeTimeoutMs },
      wait: { timeoutMs: waitTimeoutMs },
      read: { format: "markdown" },
      report: false,
    }), signal));
    const submitted = promptPossiblySubmitted || hasSubmittedPrompt(result);
    const shouldKeepSurface = shouldLeaveSurfaceOpen(result, submitted, params.keepSurface === true);
    if (!shouldKeepSurface) await browser.closeOwnedSurfaces(signal).catch(() => undefined);
    return mapCommandResult(result, thread, shouldKeepSurface, browser.primarySurfaceRef());
  } catch (error) {
    const submitted = promptPossiblySubmitted || (result ? hasSubmittedPrompt(result) : false);
    if (!submitted) await browser.closeOwnedSurfaces(signal).catch(() => undefined);
    return errorResult(error, thread, submitted, browser.primarySurfaceRef());
  }
}

function existingTabFor(surface: SelectedChatGptSurface) {
  return {
    target: { type: "tabId" as const, tabId: surface.tabId },
    ifMissing: "block" as const,
    ifMultiple: "block" as const,
    requireChatGPT: true,
  };
}

function mapCommandResult(
  result: CommandResult<unknown>,
  thread: ChatGptProThread,
  keptSurface: boolean,
  surfaceRef: string | undefined,
): ChatGptProConsultResult {
  const markdown = result.ok ? String(result.output_text ?? "") : "";
  const blocker = result.blocker ? { ...result.blocker, surfaceRef } : undefined;
  const contentText = result.ok ? markdown : blockerText(blocker, result.error?.message ?? result.status);
  return {
    ok: result.ok,
    markdown,
    contentText,
    details: {
      ok: result.ok,
      status: result.status,
      warnings: result.warnings ?? [],
      thread,
      surfaceRef,
      keptSurface,
      context: result.context,
      blocker,
      error: result.error,
      raw: result,
    },
  };
}


function blockedPreflightResult(error: unknown, thread: ChatGptProThread, surfaceRef: string | undefined): ChatGptProConsultResult {
  const message = error instanceof Error ? error.message : String(error);
  const blocker = { kind: "not_found", code: "current_chatgpt_surface_missing", message, surfaceRef };
  return {
    ok: false,
    markdown: "",
    contentText: blockerText(blocker, message),
    details: { ok: false, status: "blocked", warnings: [], thread, surfaceRef, keptSurface: false, blocker },
  };
}

function errorResult(error: unknown, thread: ChatGptProThread, submitted: boolean, surfaceRef: string | undefined): ChatGptProConsultResult {
  const message = error instanceof Error ? error.message : String(error);
  const timeout = error instanceof Error && error.name === "TimeoutError";
  const blocker = { kind: timeout ? "unknown" : "unknown", code: timeout ? "consult_timeout" : "consult_error", message, surfaceRef: submitted ? surfaceRef : undefined };
  return {
    ok: false,
    markdown: "",
    contentText: blockerText(blocker, message),
    details: { ok: false, status: timeout ? "timeout" : "error", warnings: [], thread, surfaceRef, keptSurface: submitted, blocker, error: { message } },
  };
}

function shouldLeaveSurfaceOpen(result: CommandResult<unknown>, submitted: boolean, keepSurface: boolean): boolean {
  if (keepSurface) return true;
  if (result.ok) return false;
  if (submitted) return true;
  const kind = result.blocker?.kind;
  return kind === "login_required" || kind === "captcha" || kind === "rate_limit" || kind === "modal" || kind === "selector_drift";
}


function createConsultDeadline(timeoutMs: number, now: () => Date): ConsultDeadline {
  const expiresAt = now().getTime() + timeoutMs;
  return {
    remainingMs() { return Math.max(0, expiresAt - now().getTime()); },
    throwIfExpired(operation: string) {
      if (this.remainingMs() <= 0) {
        const error = new Error(`${operation} exceeded chatgpt_pro_consult timeout`);
        error.name = "TimeoutError";
        throw error;
      }
    },
    async race<T>(operation: string, promise: Promise<T>): Promise<T> {
      this.throwIfExpired(operation);
      const remaining = this.remainingMs();
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => setTimeout(() => {
          const error = new Error(`${operation} exceeded chatgpt_pro_consult timeout`);
          error.name = "TimeoutError";
          reject(error);
        }, remaining)),
      ]);
    },
  };
}
function hasSubmittedPrompt(result: CommandResult<unknown>): boolean {
  return JSON.stringify(result.steps ?? []).includes("messages.ask") || result.context?.turnCount !== undefined;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  ]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
```

This references `cmux-browser.ts`, which Task 4 will fill in. For Task 2 only, export placeholder types/functions if necessary to make the tests compile.

- [ ] **Step 5: Run consult tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: PASS for `consult.test.ts`; other test files do not exist yet.

- [ ] **Step 6: Commit**

```sh
git add extensions/chatgpt-pro-consult/src/consult.ts extensions/chatgpt-pro-consult/src/blockers.ts extensions/chatgpt-pro-consult/tests/consult.test.ts
git commit -m "feat: add chatgpt pro consult runner"
```

---

### Task 3: cmux transport

**Files:**
- Create: `extensions/chatgpt-pro-consult/src/cmux.ts`
- Create: `extensions/chatgpt-pro-consult/tests/cmux.test.ts`

- [ ] **Step 1: Write failing cmux transport tests**

Create `extensions/chatgpt-pro-consult/tests/cmux.test.ts` covering socket fallback and CLI operations:

```ts
import { describe, expect, test } from "bun:test";
import { CmuxSocketUnavailableError, createCmuxTransport, type CmuxRunner, type CmuxSocketRequester } from "../src/cmux.js";

describe("cmux transport", () => {
  test("falls back to CLI when socket open is unavailable", async () => {
    const calls: string[][] = [];
    const socket: CmuxSocketRequester = async () => { throw new CmuxSocketUnavailableError("missing socket"); };
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ surface: "surface:7" }), stderr: "", exitCode: 0 };
    };

    const transport = createCmuxTransport({ socket, runner });

    await expect(transport.open("https://chatgpt.com/", undefined)).resolves.toBe("surface:7");
    expect(calls[0]).toEqual(["--json", "browser", "open-split", "https://chatgpt.com/", "--focus", "false"]);
  });

  test("runs browser eval through CLI and returns stdout", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 };
    };
    const transport = createCmuxTransport({ runner });

    const result = await transport.eval("surface:7", "JSON.stringify({ ok: true })");

    expect(result).toBe("{\"ok\":true}");
    expect(calls[0]).toEqual(["browser", "surface:7", "eval", "JSON.stringify({ ok: true })"]);
  });

  test("resolves current ChatGPT surface from explicit environment", async () => {
    const transport = createCmuxTransport({ env: { CHATGPT_PRO_CONSULT_SURFACE: "surface:99" } });

    await expect(transport.resolveCurrentSurface()).resolves.toBe("surface:99");
  });
});
```

- [ ] **Step 2: Run failing cmux tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: FAIL because `src/cmux.ts` does not exist.

- [ ] **Step 3: Implement abort-aware transport**

Create `extensions/chatgpt-pro-consult/src/cmux.ts` with these exports:

```ts
import { createConnection } from "node:net";

export interface CmuxRunResult { stdout: string; stderr: string; exitCode: number }
export type CmuxRunner = (args: readonly string[], signal?: AbortSignal) => Promise<CmuxRunResult>;
export type CmuxSocketRequester = (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export interface CmuxTransport {
  open(url: string, signal?: AbortSignal): Promise<string>;
  goto(surface: string, url: string, signal?: AbortSignal): Promise<void>;
  waitForLoad(surface: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  getUrl(surface: string, signal?: AbortSignal): Promise<string>;
  getTitle(surface: string, signal?: AbortSignal): Promise<string>;
  getText(surface: string, selector: string, signal?: AbortSignal): Promise<string>;
  getHtml(surface: string, selector: string, signal?: AbortSignal): Promise<string>;
  eval(surface: string, code: string, signal?: AbortSignal): Promise<string>;
  press(surface: string, key: string, signal?: AbortSignal): Promise<void>;
  close(surface: string, signal?: AbortSignal): Promise<void>;
  resolveCurrentSurface(signal?: AbortSignal): Promise<string | undefined>;
}

export interface CreateCmuxTransportOptions {
  socket?: CmuxSocketRequester;
  runner?: CmuxRunner;
  env?: Record<string, string | undefined>;
  surfaceStore?: { lastChatGptSurface?: string };
}

export class CmuxSocketUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CmuxSocketUnavailableError";
  }
}
```

Use the existing repo patterns from `extensions/chatgpt-links/src/cmux.ts` and `extensions/generative-ui/src/cmux.ts`:

- `createCmuxRunner()` uses `Bun.spawn(["cmux", ...args], { stdout: "pipe", stderr: "pipe", signal })`.
- `createCmuxSocketRequester()` sends newline-delimited JSON RPC to `${HOME}/.local/state/cmux/cmux.sock` or `CMUX_SOCKET_PATH`/`CMUX_SOCKET`.
- `createCmuxTransport()` tries socket only for known `browser.open_split`, `browser.wait`, and `surface.close`; use CLI for `goto`, `get`, `eval`, and `press` until a lightweight socket API exists.
- `resolveCurrentSurface()` checks, in order: explicit adapter option, `CHATGPT_PRO_CONSULT_SURFACE`, `CMUX_CHATGPT_SURFACE_ID`, a tracked last ChatGPT surface store, then `cmux identify --json` if the CLI exposes a browser surface id. It must verify the resolved surface URL is a ChatGPT host before returning it.
- CLI command shapes:
  - open: `cmux --json browser open-split <url> --focus false`
  - goto: `cmux browser <surface> goto <url>`
  - wait: `cmux browser <surface> wait --load-state complete --timeout-ms <ms>`
  - get URL/title: `cmux browser <surface> get url|title`
  - get text/html: `cmux browser <surface> get text|html <selector>`
  - eval: `cmux browser <surface> eval <code>`
  - press: `cmux browser <surface> press <key>`
  - close: `cmux close-surface --surface <surface>`

- [ ] **Step 4: Run cmux tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add extensions/chatgpt-pro-consult/src/cmux.ts extensions/chatgpt-pro-consult/tests/cmux.test.ts
git commit -m "feat: add cmux transport for chatgpt consult"
```

---

### Task 4: SDK BrowserLike adapter

**Files:**
- Create: `extensions/chatgpt-pro-consult/src/cmux-browser.ts`
- Create: `extensions/chatgpt-pro-consult/tests/cmux-browser.test.ts`
- Modify: `extensions/chatgpt-pro-consult/src/consult.ts`

- [ ] **Step 1: Write failing BrowserLike tests**

Create `extensions/chatgpt-pro-consult/tests/cmux-browser.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createChatGPT } from "codex-chatgpt-control";
import { createCmuxBrowserAdapter } from "../src/cmux-browser.js";
import type { CmuxTransport } from "../src/cmux.js";

function fakeTransport(currentSurface?: string): CmuxTransport & { opened: string[]; closed: string[] } {
  const opened: string[] = [];
  const closed: string[] = [];
  return {
    opened,
    closed,
    async open(url) { opened.push(url); return `surface:${opened.length}`; },
    async goto() {},
    async waitForLoad() {},
    async getUrl(surface) { return surface === "surface:99" ? "https://chatgpt.com/c/current" : "https://chatgpt.com/"; },
    async getTitle() { return "ChatGPT"; },
    async getText() { return "ChatGPT New chat"; },
    async getHtml() { return "<main></main>"; },
    async eval() { return "\"ChatGPT New chat\""; },
    async press() {},
    async close(surface) { closed.push(surface); },
    async resolveCurrentSurface() { return currentSurface; },
  };
}

describe("cmux BrowserLike adapter", () => {
  test("creates extension-owned pages for new-thread bootstrap", async () => {
    const transport = fakeTransport();
    const browser = createCmuxBrowserAdapter({ transport });

    const page = await browser.tabs!.create!("https://chatgpt.com/");

    expect(transport.opened).toEqual(["https://chatgpt.com/"]);
    expect(await page.url?.()).toBe("https://chatgpt.com/");
    expect(browser.primarySurfaceRef()).toBe("surface:1");
  });

  test("blocks current-thread preflight when no selected ChatGPT surface exists", async () => {
    const browser = createCmuxBrowserAdapter({ transport: fakeTransport() });

    await expect(browser.requireSelectedChatGptSurface()).rejects.toThrow("No selected ChatGPT surface");
  });

  test("resolves current-thread preflight from the cmux current-surface discovery path", async () => {
    const browser = createCmuxBrowserAdapter({ transport: fakeTransport("surface:99") });

    const selected = await browser.requireSelectedChatGptSurface();

    expect(selected.tabId).toBe("surface:99");
  });

  test("pins current-thread preflight to exact selected surface id", async () => {
    const browser = createCmuxBrowserAdapter({ transport: fakeTransport(), selectedSurface: "surface:99" });

    const selected = await browser.requireSelectedChatGptSurface();
    const tabs = await browser.user!.openTabs!();

    expect(selected.tabId).toBe("surface:99");
    expect(tabs.map(tab => tab.id)).toContain("surface:99");
  });

  test("SDK bootstrap creates a cmux surface without globalThis.agent", async () => {
    const previousAgent = (globalThis as Record<string, unknown>).agent;
    delete (globalThis as Record<string, unknown>).agent;
    const transport = fakeTransport();
    const browser = createCmuxBrowserAdapter({ transport });
    try {
      const result = await createChatGPT({ browser }).session.bootstrap({ preferExistingTab: false });
      expect(result.ok).toBe(true);
      expect(transport.opened).toEqual(["https://chatgpt.com/"]);
    } finally {
      (globalThis as Record<string, unknown>).agent = previousAgent;
    }
  });

  test("SDK bootstrap with current tabId target claims only the preflight-selected tab when multiple ChatGPT tabs exist", async () => {
    const transport = fakeTransport();
    const browser = createCmuxBrowserAdapter({ transport, selectedSurface: "surface:99", knownSurfaces: ["surface:1", "surface:99"] });

    const result = await createChatGPT({ browser }).session.bootstrap({
      existingTab: { target: { type: "tabId", tabId: "surface:99" }, ifMissing: "block", ifMultiple: "block", requireChatGPT: true },
    });

    expect(result.ok).toBe(true);
    expect(result.context.tabId).toBe("surface:99");
  });
});
```

- [ ] **Step 2: Run failing BrowserLike tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```
Expected: FAIL because `src/cmux-browser.ts` does not exist or lacks methods.

- [ ] **Step 3: Implement BrowserLike adapter**

Create `extensions/chatgpt-pro-consult/src/cmux-browser.ts`:

```ts
import type { BrowserLike, BrowserUserTabInfo, PageLike } from "codex-chatgpt-control";
import { createCmuxTransport, type CmuxTransport } from "./cmux.js";
import { createCmuxPage } from "./cmux-page.js";
import type { ConsultDeadline, ConsultLifecycle } from "./consult.js";

export interface SelectedChatGptSurface {
  tabId: string;
  surface: string;
  url?: string;
  title?: string;
}

export type CmuxBrowserAdapter = BrowserLike & {
  requireSelectedChatGptSurface(signal?: AbortSignal): Promise<SelectedChatGptSurface>;
  primarySurfaceRef(): string | undefined;
  closeOwnedSurfaces(signal?: AbortSignal): Promise<void>;
};

export interface CreateCmuxBrowserAdapterOptions {
  transport?: CmuxTransport;
  selectedSurface?: string;
  knownSurfaces?: string[];
  signal?: AbortSignal;
  deadline?: ConsultDeadline;
  lifecycle?: ConsultLifecycle;
}

export function createCmuxBrowserAdapter(options: CreateCmuxBrowserAdapterOptions = {}): CmuxBrowserAdapter {
  const transport = options.transport ?? createCmuxTransport();
  const owned = new Set<string>();
  const claimed = new Map<string, PageLike>();
  let primarySurface: string | undefined;

  const run = <T>(operation: string, promise: Promise<T>): Promise<T> =>
    options.deadline ? options.deadline.race(operation, promise) : promise;

  async function pageFor(surface: string, ownsSurface: boolean): Promise<PageLike> {
    if (ownsSurface) owned.add(surface);
    primarySurface ??= surface;
    const page = createCmuxPage({ surface, transport, signal: options.signal, deadline: options.deadline, lifecycle: options.lifecycle });
    claimed.set(surface, page);
    return page;
  }

  const browser: CmuxBrowserAdapter = {
    name: "cmux",
    tabs: {
      create: async (url: string) => pageFor(await run("cmux.open", transport.open(url, options.signal)), true),
      new: async (url = "https://chatgpt.com/") => pageFor(await run("cmux.open", transport.open(url, options.signal)), true),
      selected: async () => options.selectedSurface ? pageFor(options.selectedSurface, false) : undefined,
      get: async (id: string) => pageFor(id, false),
    },
    newPage: async () => pageFor(await run("cmux.open", transport.open("https://chatgpt.com/", options.signal)), true),
    user: {
      openTabs: async () => {
        const discovered = await run("cmux.resolveCurrentSurface", transport.resolveCurrentSurface(options.signal)).catch(() => undefined);
        const surfaces = [...new Set([...(options.knownSurfaces ?? []), options.selectedSurface, discovered].filter((value): value is string => typeof value === "string"))];
        const tabs = await Promise.all(surfaces.map(async surface => {
          const url = await run("cmux.getUrl", transport.getUrl(surface, options.signal)).catch(() => undefined);
          const title = await run("cmux.getTitle", transport.getTitle(surface, options.signal)).catch(() => undefined);
          return { id: surface, url, title };
        }));
        return tabs.filter(tab => isChatGptUrl(tab.url)) as BrowserUserTabInfo[];
      },
      claimTab: async (tab: string | BrowserUserTabInfo) => pageFor(typeof tab === "string" ? tab : tab.id, false),
    },
    async requireSelectedChatGptSurface(signal?: AbortSignal) {
      const surface = options.selectedSurface ?? await run("cmux.resolveCurrentSurface", transport.resolveCurrentSurface(signal ?? options.signal));
      if (!surface) throw new Error("No selected ChatGPT surface is available for thread=current");
      const url = await run("cmux.getUrl", transport.getUrl(surface, signal ?? options.signal));
      if (!isChatGptUrl(url)) throw new Error(`No selected ChatGPT surface: ${url}`);
      return { tabId: surface, surface, url };
    },
    primarySurfaceRef: () => primarySurface,
    async closeOwnedSurfaces(signal?: AbortSignal) {
      await Promise.all([...owned].map(surface => run("cmux.close", transport.close(surface, signal ?? options.signal)).catch(() => undefined)));
      owned.clear();
    },
  };
  return browser;
}

function isChatGptUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "chatgpt.com" || host === "www.chatgpt.com" || host === "chat.openai.com";
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run BrowserLike tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: PASS for existing tests; `cmux-page.ts` may need a temporary stub exporting `createCmuxPage` until Task 5.

- [ ] **Step 5: Commit**

```sh
git add extensions/chatgpt-pro-consult/src/cmux-browser.ts extensions/chatgpt-pro-consult/tests/cmux-browser.test.ts extensions/chatgpt-pro-consult/src/consult.ts
git commit -m "feat: add cmux browser adapter"
```

---

### Task 5: SDK PageLike and LocatorLike adapter

**Files:**
- Create: `extensions/chatgpt-pro-consult/src/cmux-page.ts`
- Create: `extensions/chatgpt-pro-consult/tests/cmux-page.test.ts`

- [ ] **Step 1: Write failing PageLike tests**

Create `extensions/chatgpt-pro-consult/tests/cmux-page.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createChatGPT } from "codex-chatgpt-control";
import { createCmuxBrowserAdapter } from "../src/cmux-browser.js";
import { createCmuxPage } from "../src/cmux-page.js";
import type { CmuxTransport } from "../src/cmux.js";

function pageTransport(evalResults: string[] = []): CmuxTransport & { evals: string[]; presses: string[] } {
  const evals: string[] = [];
  const presses: string[] = [];
  return {
    evals,
    presses,
    async open() { return "surface:1"; },
    async goto() {},
    async waitForLoad() {},
    async getUrl() { return "https://chatgpt.com/"; },
    async getTitle() { return "ChatGPT"; },
    async getText() { return "ChatGPT"; },
    async getHtml() { return "<main></main>"; },
    async eval(_surface, code) { evals.push(code); return evalResults.shift() ?? "null"; },
    async press(_surface, key) { presses.push(key); },
    async close() {},
    async resolveCurrentSurface() { return undefined; },
  };
}

function sdkHappyPathTransport(): CmuxTransport & { operations: string[] } {
  const operations: string[] = [];
  let assistantReady = false;
  return {
    operations,
    async open(url) { operations.push(`open:${url}`); return "surface:1"; },
    async goto(_surface, url) { operations.push(`goto:${url}`); },
    async waitForLoad() {},
    async getUrl() { return "https://chatgpt.com/"; },
    async getTitle() { return "ChatGPT"; },
    async getText() { return "ChatGPT New chat"; },
    async getHtml() { return "<main><div data-message-author-role=\"assistant\">omp smoke ok</div></main>"; },
    async press() { operations.push("submit"); assistantReady = true; },
    async close() {},
    async resolveCurrentSurface() { return undefined; },
    async eval(_surface, code) {
      // Implement this fake as a small state machine for the SDK scripts:
      // - page-state/body text reads return JSON.stringify("ChatGPT New chat").\n      // - mode menu enumeration returns a Pro candidate; clicking it records "mode:pro".\n      // - composer fill records "composer:<prompt>".\n      // - send button click records "submit" and flips assistantReady.\n      // - wait/read scripts return a stable latest assistant message once assistantReady is true.\n      if (code.includes("model-switcher") || code.includes("menuitemradio")) operations.push("mode:pro");
      if (code.includes("Reply with exactly: omp smoke ok")) operations.push("composer:Reply with exactly: omp smoke ok");
      if (code.includes("click") && code.toLowerCase().includes("send")) { operations.push("submit"); assistantReady = true; }
      if (code.includes("data-message-author-role") && assistantReady) operations.push("read:assistant:markdown");
      return JSON.stringify(scriptAwareSdkResult(code, { assistantReady }));
    },
  };
}

function scriptAwareSdkResult(code: string, state: { assistantReady: boolean }): unknown {
  if (code.includes("document.body") || code.includes("innerText")) return "ChatGPT New chat";
  if (code.includes("querySelectorAll") && code.includes("data-message-author-role")) {
    return state.assistantReady
      ? [{ role: "assistant", html: "omp smoke ok", metadataHtml: "<div data-message-author-role=\"assistant\">omp smoke ok</div>" }]
      : [];
  }
  if (code.includes("countPageMessages")) return state.assistantReady ? 2 : 0;
  if (code.includes("click") || code.includes("dispatchEvent")) return true;
  if (code.includes("getAttribute") && code.includes("data-testid")) return undefined;
  return true;
}

describe("cmux PageLike adapter", () => {
  test("evaluates functions with JSON arguments", async () => {
    const transport = pageTransport(["42"]);
    const page = createCmuxPage({ surface: "surface:7", transport });

    await expect(page.evaluate!((value: number) => value + 1, 41)).resolves.toBe(42);
    expect(transport.evals[0]).toContain("JSON.stringify");
  });

  test("races eval calls against the consult deadline", async () => {
    const transport = pageTransport(["42"]);
    const page = createCmuxPage({
      surface: "surface:7",
      transport,
      deadline: {
        remainingMs: () => 0,
        throwIfExpired: operation => { throw new Error(`${operation} expired`); },
        race: async operation => { throw new Error(`${operation} expired`); },
      },
    });

    await expect(page.evaluate!((value: number) => value + 1, 41)).rejects.toThrow("cmux.eval expired");
  });

  test("supports role locator count and click", async () => {
    const transport = pageTransport(["1", "true"]);
    const page = createCmuxPage({ surface: "surface:7", transport });

    const button = page.getByRole!("button", { name: /send/i });
    await expect(button.count!()).resolves.toBe(1);
    await expect(button.click!()).resolves.toBeUndefined();
  });

  test("presses keys through cmux", async () => {
    const transport = pageTransport();
    const page = createCmuxPage({ surface: "surface:7", transport });

    await page.keyboard!.press!("Enter");

    expect(transport.presses).toEqual(["Enter"]);
  });

  test("drives SDK mode and message commands through the cmux adapters", async () => {
    const transport = sdkHappyPathTransport();
    const browser = createCmuxBrowserAdapter({ transport });
    const chatgpt = createChatGPT({ browser });

    await expect(chatgpt.session.bootstrap({ preferExistingTab: false })).resolves.toMatchObject({ ok: true });
    await expect(chatgpt.modes.set({ intelligence: "pro", timeoutMs: 1000 })).resolves.toMatchObject({ ok: true });
    await expect(chatgpt.messages.ask({
      text: "Reply with exactly: omp smoke ok",
      wait: { timeoutMs: 1000, stableMs: 1, pollMs: 1 },
      read: { format: "markdown" },
    })).resolves.toMatchObject({ ok: true, output_text: "omp smoke ok" });
    expect(transport.operations).toEqual(expect.arrayContaining([
      "open:https://chatgpt.com/",
      "mode:pro",
      "composer:Reply with exactly: omp smoke ok",
      "submit",
      "read:assistant:markdown",
    ]));
  });
});
```

- [ ] **Step 2: Run failing PageLike tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: FAIL because `cmux-page.ts` is missing/incomplete.

- [ ] **Step 3: Implement `createCmuxPage`**

Create `extensions/chatgpt-pro-consult/src/cmux-page.ts` with:

```ts
import type { LocatorLike, PageLike } from "codex-chatgpt-control";
import type { ConsultDeadline, ConsultLifecycle } from "./consult.js";
import type { CmuxTransport } from "./cmux.js";

export interface CreateCmuxPageOptions {
  surface: string;
  transport: CmuxTransport;
  signal?: AbortSignal;
  deadline?: ConsultDeadline;
  lifecycle?: ConsultLifecycle;
}

export function createCmuxPage(options: CreateCmuxPageOptions): PageLike {
  const { surface, transport, signal, deadline } = options;
  const run = <T>(operation: string, promise: Promise<T>): Promise<T> =>
    deadline ? deadline.race(operation, promise) : promise;
  const page = {
    id: surface,
    tabId: surface,
    url: () => run("cmux.getUrl", transport.getUrl(surface, signal)),
    title: () => run("cmux.getTitle", transport.getTitle(surface, signal)),
    goto: (url: string) => run("cmux.goto", transport.goto(surface, url, signal)),
    content: () => run("cmux.getHtml", transport.getHtml(surface, "body", signal)),
    waitForTimeout: ms => deadline ? deadline.race("cmux.sleep", sleep(ms, signal)) : sleep(ms, signal),
    keyboard: {
      press: key => {
        if (key === "Enter") options.lifecycle?.markPromptSubmitted();
        return run("cmux.press", transport.press(surface, key, signal));
      },
    },
    evaluate: (fn, arg) => evaluateOnPage(transport, surface, fn, arg, signal, deadline),
    locator: selector => createLocator({ pageEval: code => run("cmux.eval", transport.eval(surface, code, signal)), resolver: { type: "css", selector }, lifecycle: options.lifecycle }),
    getByRole: (role, opts) => createLocator({ pageEval: code => run("cmux.eval", transport.eval(surface, code, signal)), resolver: { type: "role", role, name: serializeMatcher(opts?.name) }, lifecycle: options.lifecycle }),
    getByText: (text, opts) => createLocator({ pageEval: code => run("cmux.eval", transport.eval(surface, code, signal)), resolver: { type: "text", text: serializeMatcher(text), exact: opts?.exact === true }, lifecycle: options.lifecycle }),
    getByPlaceholder: text => createLocator({ pageEval: code => run("cmux.eval", transport.eval(surface, code, signal)), resolver: { type: "placeholder", text: serializeMatcher(text) }, lifecycle: options.lifecycle }),
    close: () => run("cmux.close", transport.close(surface, signal)),
  } satisfies PageLike & { id: string; tabId: string };
  return page;
}
```

Implement helper internals:

- `evaluateOnPage` serializes the function and argument:

```ts
async function evaluateOnPage<T, A>(
  transport: CmuxTransport,
  surface: string,
  fn: (arg: A) => T | Promise<T>,
  arg?: A,
  signal?: AbortSignal,
  deadline?: ConsultDeadline,
): Promise<T> {
  const code = `Promise.resolve((${fn.toString()})(${JSON.stringify(arg)})).then(value => JSON.stringify(value === undefined ? { __undefined: true } : value))`;
  const evalPromise = transport.eval(surface, code, signal);
  const raw = await (deadline ? deadline.race("cmux.eval", evalPromise) : evalPromise);
  const parsed = JSON.parse(raw);
  return parsed?.__undefined === true ? undefined as T : parsed as T;
}
```

- `createLocator` stores a JSON resolver descriptor and implements `count`, `click`, `fill`, `textContent`, `innerText`, `innerHTML`, `isVisible`, `evaluate`, `locator`, `filter`, `nth`, `first`, and `last` by calling a shared page-side resolver script.
- `click()` calls `lifecycle.markPromptSubmitted()` before clicking when the locator descriptor is the ChatGPT send control (`role: "button"` with a send-label matcher, or the SDK send-button selector). This lets the consult runner preserve inspectable surfaces when the SDK times out after submission.
- The resolver script should:
  - Support CSS selectors.
  - Support role matching for buttons/textboxes/menuitems/options using native tags, `[role]`, `aria-label`, visible text, and placeholder text.
  - Support text and placeholder matching with string or RegExp descriptors.
  - Apply `filter({ hasText })` and index selection.
  - Throw if `click`, `fill`, or element-evaluate does not resolve exactly one element.
  - For `fill`, handle `HTMLInputElement`, `HTMLTextAreaElement`, and `[contenteditable]`, then dispatch `input` and `change` events.

- [ ] **Step 4: Run PageLike tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add extensions/chatgpt-pro-consult/src/cmux-page.ts extensions/chatgpt-pro-consult/tests/cmux-page.test.ts
git commit -m "feat: add cmux page adapter"
```

---

### Task 6: OMP extension tool wrapper

**Files:**
- Modify: `extensions/chatgpt-pro-consult/src/index.ts`
- Create: `extensions/chatgpt-pro-consult/tests/extension.test.ts`

- [ ] **Step 1: Write failing extension tests**

Create `extensions/chatgpt-pro-consult/tests/extension.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import chatGptProConsultExtension, { createChatGptProConsultExtension } from "../src/index.js";

interface Chain { describe(): Chain; optional(): Chain; default(value: unknown): Chain }
interface TestTool { name: string; label?: string; description?: string; execute?: (...args: any[]) => Promise<any> }

function makeZ() {
  const chain: Chain = { describe() { return this; }, optional() { return this; }, default() { return this; } };
  return { object() { return chain; }, string() { return chain; }, number() { return chain; }, boolean() { return chain; }, enum() { return chain; } };
}

function fakePi() {
  const tools: TestTool[] = [];
  const labels: string[] = [];
  const api = {
    zod: { z: makeZ() },
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    setLabel(label: string) { labels.push(label); },
    registerTool(tool: TestTool) { tools.push(tool); },
    on() {},
  } as unknown as ExtensionAPI;
  return { api, tools, labels };
}

describe("chatGptProConsultExtension", () => {
  test("registers chatgpt_pro_consult once", () => {
    const pi = fakePi();

    chatGptProConsultExtension(pi.api);

    expect(pi.labels).toEqual(["ChatGPT Pro Consult"]);
    expect(pi.tools.map(tool => tool.name)).toEqual(["chatgpt_pro_consult"]);
  });

  test("tool execution delegates to the core runner", async () => {
    const pi = fakePi();
    const calls: unknown[] = [];
    const extension = createChatGptProConsultExtension({
      consult: async params => {
        calls.push(params);
        return { ok: true, markdown: "done", contentText: "done", details: { ok: true, status: "ok", warnings: [], thread: "new", keptSurface: false } };
      },
    });
    extension(pi.api);

    const response = await pi.tools[0].execute!("tool-1", { prompt: "Ask", timeout_ms: 1000, keep_surface: true }, new AbortController().signal);

    expect(calls[0]).toMatchObject({ prompt: "Ask", timeoutMs: 1000, keepSurface: true });
    expect(response.content[0].text).toBe("done");
    expect(response.details.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Run failing extension tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: FAIL because `src/index.ts` does not register the tool yet.

- [ ] **Step 3: Implement extension registration**

Modify `extensions/chatgpt-pro-consult/src/index.ts`:

```ts
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { runChatGptProConsult, type ChatGptProConsultDetails, type ChatGptProConsultParams, type ChatGptProConsultResult } from "./consult.js";

export interface ChatGptProConsultExtensionDeps {
  consult?: (params: ChatGptProConsultParams) => Promise<ChatGptProConsultResult>;
}

const installedApis = new WeakSet<object>();

export function createChatGptProConsultExtension(deps: ChatGptProConsultExtensionDeps = {}): (pi: ExtensionAPI) => void {
  return function chatGptProConsultExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi as object)) {
      pi.logger.warn("chatgpt-pro-consult extension already installed; skipping duplicate registration");
      return;
    }
    installedApis.add(pi as object);

    const { z } = pi.zod;
    const consult = deps.consult ?? runChatGptProConsult;

    pi.setLabel("ChatGPT Pro Consult");

    const ConsultParams = z.object({
      prompt: z.string().describe("Prompt to submit to the visible ChatGPT Pro session."),
      thread: z.enum(["new", "current"]).optional().describe("Use a fresh ChatGPT thread or the selected/current ChatGPT surface. Defaults to new."),
      timeout_ms: z.number().optional().describe("Overall timeout in milliseconds. Defaults to 120000."),
      keep_surface: z.boolean().optional().describe("Leave the cmux browser surface open after a successful consult."),
    });

    pi.registerTool<typeof ConsultParams, ChatGptProConsultDetails>({
      name: "chatgpt_pro_consult",
      label: "ChatGPT Pro Consult",
      description: "Submit one explicit prompt to ChatGPT Pro through a visible cmux browser session and return the Markdown response.",
      parameters: ConsultParams,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<ChatGptProConsultDetails>> {
        const result = await consult({
          prompt: params.prompt,
          thread: params.thread,
          timeoutMs: params.timeout_ms,
          keepSurface: params.keep_surface,
          signal,
        });
        return {
          content: [{ type: "text", text: result.contentText }],
          details: result.details,
          isError: result.ok ? undefined : true,
        };
      },
    });
  };
}

export default createChatGptProConsultExtension();
```

- [ ] **Step 4: Run extension tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add extensions/chatgpt-pro-consult/src/index.ts extensions/chatgpt-pro-consult/tests/extension.test.ts
git commit -m "feat: register chatgpt pro consult tool"
```

---

### Task 7: Standalone smoke script

**Files:**
- Create: `extensions/chatgpt-pro-consult/scripts/live-smoke.ts`
- Optionally create: `extensions/chatgpt-pro-consult/tests/smoke.test.ts`

- [ ] **Step 1: Write a failing smoke argument/parser test**

If extracting parsing is useful, create `scripts/live-smoke.ts` with exported `parseSmokeArgs(argv)` first and test:

```ts
import { describe, expect, test } from "bun:test";
import { parseSmokeArgs } from "../scripts/live-smoke.js";

describe("live smoke args", () => {
  test("parses prompt and keep-surface", () => {
    expect(parseSmokeArgs(["--prompt", "hi", "--keep-surface"])).toEqual({ prompt: "hi", keepSurface: true });
  });
});
```

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: FAIL until parser exists.

- [ ] **Step 2: Implement live smoke script**

Create `extensions/chatgpt-pro-consult/scripts/live-smoke.ts`:

```ts
import { runChatGptProConsult } from "../src/consult.js";

export interface SmokeArgs {
  prompt: string;
  thread?: "new" | "current";
  timeoutMs?: number;
  keepSurface?: boolean;
}

export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const args: SmokeArgs = { prompt: "Reply with exactly: omp smoke ok" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt") args.prompt = requiredValue(argv, ++index, arg);
    else if (arg === "--thread") args.thread = requiredValue(argv, ++index, arg) as "new" | "current";
    else if (arg === "--timeout-ms") args.timeoutMs = Number(requiredValue(argv, ++index, arg));
    else if (arg === "--keep-surface") args.keepSurface = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.main) {
  const result = await runChatGptProConsult(parseSmokeArgs(Bun.argv.slice(2)));
  console.log(JSON.stringify(result.details, null, 2));
  if (result.markdown) console.log(`\n${result.markdown}`);
  if (!result.ok) process.exit(1);
}
```

- [ ] **Step 3: Run package tests**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: PASS.

- [ ] **Step 4: Run a dry smoke help/parser path only**

Do not run the live ChatGPT smoke automatically in CI. Manually validate only when the user/session is ready:

```sh
bun --cwd extensions/chatgpt-pro-consult run smoke -- --prompt "Reply with exactly: omp smoke ok" --keep-surface
```

Expected with valid cmux + logged-in ChatGPT Pro: response Markdown contains `omp smoke ok` and JSON details show `status: "ok"`.
Expected without browser/login: non-zero exit with structured blocker and `surfaceRef` when available.

- [ ] **Step 5: Commit**

```sh
git add extensions/chatgpt-pro-consult/scripts/live-smoke.ts extensions/chatgpt-pro-consult/tests/smoke.test.ts
git commit -m "feat: add chatgpt pro live smoke"
```

---

### Task 8: Package docs after core flow works

**Files:**
- Create: `extensions/chatgpt-pro-consult/README.md`
- Modify: `README.md`

Do this only after Tasks 1-7 pass and at least the non-live test suite confirms the core runner and smoke script are wired.

- [ ] **Step 1: Update package README**

Create `extensions/chatgpt-pro-consult/README.md`:

```md
# omp-chatgpt-pro-consult

OMP extension for asking ChatGPT Pro through a visible cmux browser session.

## Tool

- `chatgpt_pro_consult` submits one explicit prompt to ChatGPT Pro and returns the latest assistant response as Markdown.

The MVP sends only the `prompt` string. It does not upload files, automate login, solve captchas, or use hidden ChatGPT endpoints.

Parameters:

- `prompt` — prompt to submit.
- `thread` — `new` by default, or `current` to use the preflight-selected ChatGPT surface.
- `timeout_ms` — optional overall timeout.
- `keep_surface` — keep the cmux surface open after success.

## Standalone smoke

```sh
bun --cwd extensions/chatgpt-pro-consult run smoke -- --prompt "Reply with exactly: omp smoke ok"
```

The smoke uses real cmux and ChatGPT browser state. It is not part of `check` because it submits a real prompt and requires login plus Pro access.

## Development

```sh
bun --cwd extensions/chatgpt-pro-consult test
bun --cwd extensions/chatgpt-pro-consult check
```
```

- [ ] **Step 2: Update root README package list**

Add a section after `omp-chatgpt-links`:

```md
### `omp-chatgpt-pro-consult`

Path: `extensions/chatgpt-pro-consult`

Adds one OMP tool:

- `chatgpt_pro_consult` submits one explicit prompt to ChatGPT Pro through a visible cmux browser session and returns the latest assistant response as Markdown.

The MVP sends only the explicit prompt text. File uploads are planned for a later pass. A dev-only smoke script can exercise the core flow outside the ExtensionAPI:

```sh
bun --cwd extensions/chatgpt-pro-consult run smoke -- --prompt "Reply with exactly: omp smoke ok"
```
```

Also add the package to the one-extension check/test examples.

- [ ] **Step 3: Run docs-adjacent tests**

Run:

```sh
bun test tests/workspace-layout.test.ts
bun --cwd extensions/chatgpt-pro-consult test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```sh
git add README.md extensions/chatgpt-pro-consult/README.md
git commit -m "docs: document chatgpt pro consult extension"
```

---

### Task 9: Verification and final integration

**Files:**
- Potentially modify files from prior tasks only to fix verification failures.

- [ ] **Step 1: Run package check**

Run:

```sh
bun --cwd extensions/chatgpt-pro-consult check
```

Expected: PASS. If it fails, use @systematic-debugging; do not suppress tests or weaken behavior.

- [ ] **Step 2: Run root check**

Run:

```sh
bun run check
```

Expected: PASS and includes `extensions/chatgpt-pro-consult check` through the root script.

- [ ] **Step 3: Optional live smoke with user-visible ChatGPT**

Only run when the user/session has a logged-in ChatGPT Pro cmux browser state and accepts a real prompt submission:

```sh
bun --cwd extensions/chatgpt-pro-consult run smoke -- --prompt "Reply with exactly: omp smoke ok" --keep-surface
```

Expected success: JSON details show ok/status and response text contains `omp smoke ok`.
Expected blocker: JSON details include blocker kind/message and `surfaceRef` when available.

- [ ] **Step 4: Commit verification fixes if any**

```sh
git add <fixed files>
git commit -m "fix: pass chatgpt pro consult verification"
```

Skip this commit if no files changed during verification.

- [ ] **Step 5: Final status**

Report:

- Files changed.
- Tests/checks run with exact commands.
- Whether live smoke was run or intentionally skipped, with reason.
- Any blocker details if ChatGPT/cmux state prevented live smoke.
