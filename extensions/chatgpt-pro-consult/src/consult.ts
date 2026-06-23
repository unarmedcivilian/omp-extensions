import { createChatGPT } from "codex-chatgpt-control";
import { blockerText, type ConsultBlocker } from "./blockers.js";
import {
  createCmuxBrowserAdapter,
  type CmuxBrowserAdapter,
  type SelectedChatGptSurface,
} from "./cmux-browser.js";

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
  blocker?: ConsultBlocker;
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
  createBrowser?: (options: {
    signal?: AbortSignal;
    deadline: ConsultDeadline;
    lifecycle: ConsultLifecycle;
  }) => CmuxBrowserAdapter;
  createChatGptClient?: (browser: CmuxBrowserAdapter) => ChatGptClient;
  now?: () => Date;
}

export interface ChatGptClient {
  ask(args: ChatGptAskArgs): Promise<ConsultCommandResult>;
}

export interface ChatGptAskArgs {
  prompt: string;
  thread: { type: "new" } | { type: "current" };
  existingTab: ExistingTabPolicy | undefined;
  preferExistingTab: boolean;
  mode: { intelligence: "pro"; timeoutMs: number };
  wait: { timeoutMs: number };
  read: { format: "markdown" };
  report: false;
}

export interface ExistingTabPolicy {
  target: { type: "tabId"; tabId: string };
  ifMissing: "block";
  ifMultiple: "block";
  requireChatGPT: true;
}

export interface ConsultCommandResult {
  ok: boolean;
  status: string;
  output_text?: unknown;
  warnings?: unknown;
  steps?: unknown;
  context?: unknown;
  blocker?: unknown;
  error?: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_MODE_TIMEOUT_MS = 15_000;
const MIN_MODE_TIMEOUT_MS = 1_000;
const READ_RESERVE_MS = 5_000;
const ACTION_REQUIRED_BLOCKERS: Record<string, true> = {
  login: true,
  login_required: true,
  captcha: true,
  rate_limit: true,
  modal: true,
  selector_drift: true,
};

export async function runChatGptProConsult(
  params: ChatGptProConsultParams,
  deps: ChatGptProConsultDeps = {},
): Promise<ChatGptProConsultResult> {
  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("prompt is required");

  const signal = params.signal;
  throwIfAborted(signal);

  const thread = params.thread ?? "new";
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = createConsultDeadline(timeoutMs, deps.now ?? (() => new Date()));
  let promptPossiblySubmitted = false;
  const lifecycle: ConsultLifecycle = {
    markPromptSubmitted() {
      promptPossiblySubmitted = true;
    },
  };

  const browser = deps.createBrowser?.({ signal, deadline, lifecycle }) ?? createCmuxBrowserAdapter({ signal, deadline, lifecycle });
  const modeTimeoutMs = Math.min(MAX_MODE_TIMEOUT_MS, Math.max(MIN_MODE_TIMEOUT_MS, Math.floor(timeoutMs / 4)));
  const waitTimeoutMs = Math.max(MIN_MODE_TIMEOUT_MS, timeoutMs - modeTimeoutMs - READ_RESERVE_MS);

  let currentTarget: SelectedChatGptSurface | undefined;
  if (thread === "current") {
    try {
      deadline.throwIfExpired("chatgpt.current_surface");
      currentTarget = await deadline.race(
        "chatgpt.current_surface",
        raceAbort(browser.requireSelectedChatGptSurface(signal), signal),
      );
    } catch (error) {
      await closeOwnedSurfacesQuietly(browser, signal);
      return isTimeoutOrAbortError(error)
        ? errorResult(error, thread, false, browser.primarySurfaceRef())
        : blockedPreflightResult(error, thread);
    }
  }

  const client = deps.createChatGptClient?.(browser) ?? (createChatGPT({ browser }) as unknown as ChatGptClient);
  let result: ConsultCommandResult | undefined;

  try {
    deadline.throwIfExpired("chatgpt.ask");
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
    const keptSurface = shouldLeaveSurfaceOpen(result, submitted, params.keepSurface === true);
    if (!keptSurface) await closeOwnedSurfacesQuietly(browser, signal);
    return mapCommandResult(result, thread, keptSurface, browser.primarySurfaceRef());
  } catch (error) {
    const submitted = promptPossiblySubmitted || (result ? hasSubmittedPrompt(result) : false);
    if (!submitted) await closeOwnedSurfacesQuietly(browser, signal);
    return errorResult(error, thread, submitted, browser.primarySurfaceRef());
  }
}

function existingTabFor(surface: SelectedChatGptSurface): ExistingTabPolicy {
  return {
    target: { type: "tabId", tabId: surface.tabId },
    ifMissing: "block",
    ifMultiple: "block",
    requireChatGPT: true,
  };
}

function mapCommandResult(
  result: ConsultCommandResult,
  thread: ChatGptProThread,
  keptSurface: boolean,
  surfaceRef: string | undefined,
): ChatGptProConsultResult {
  const markdown = result.ok ? String(result.output_text ?? "") : "";
  const blocker = normalizeBlocker(result.blocker, keptSurface ? surfaceRef : undefined);
  const contentText = result.ok ? markdown : blockerText(blocker, errorMessage(result.error) ?? result.status);

  return {
    ok: result.ok,
    markdown,
    contentText,
    details: {
      ok: result.ok,
      status: result.status,
      warnings: normalizeWarnings(result.warnings),
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

export function blockedPreflightResult(error: unknown, thread: ChatGptProThread): ChatGptProConsultResult {
  const message = errorMessage(error) ?? String(error);
  const blocker: ConsultBlocker = { kind: "not_found", code: "current_chatgpt_surface_missing", message };

  return {
    ok: false,
    markdown: "",
    contentText: blockerText(blocker, message),
    details: {
      ok: false,
      status: "blocked",
      warnings: [],
      thread,
      keptSurface: false,
      blocker,
      error: { message },
    },
  };
}

export function errorResult(
  error: unknown,
  thread: ChatGptProThread,
  submitted: boolean,
  surfaceRef: string | undefined,
): ChatGptProConsultResult {
  const message = errorMessage(error) ?? String(error);
  const timeout = errorName(error) === "TimeoutError";
  const blocker: ConsultBlocker = {
    kind: "unknown",
    code: timeout ? "consult_timeout" : "consult_error",
    message,
    surfaceRef: submitted ? surfaceRef : undefined,
  };

  return {
    ok: false,
    markdown: "",
    contentText: blockerText(blocker, message),
    details: {
      ok: false,
      status: timeout ? "timeout" : "error",
      warnings: [],
      thread,
      surfaceRef,
      keptSurface: submitted,
      blocker,
      error: { name: errorName(error), message },
    },
  };
}

export function shouldLeaveSurfaceOpen(result: ConsultCommandResult, submitted: boolean, keepSurface: boolean): boolean {
  if (keepSurface) return true;
  if (result.ok) return false;
  if (submitted) return true;

  const blocker = normalizeBlocker(result.blocker, undefined);
  return blocker ? ACTION_REQUIRED_BLOCKERS[blocker.kind] === true || ACTION_REQUIRED_BLOCKERS[blocker.code ?? ""] === true : false;
}

export function hasSubmittedPrompt(result: ConsultCommandResult): boolean {
  const context = result.context;
  if (typeof context !== "object" || context === null) return false;

  const record = context as Record<string, unknown>;
  return isPositiveCount(record.turnCount) || isPositiveCount(record.assistantTurnCount);
}

function isPositiveCount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createConsultDeadline(timeoutMs: number, now: () => Date): ConsultDeadline {
  const expiresAt = now().getTime() + timeoutMs;
  const remainingMs = () => Math.max(0, expiresAt - now().getTime());

  return {
    remainingMs,
    throwIfExpired(operation: string) {
      if (remainingMs() <= 0) throw createTimeoutError(operation);
    },
    async race<T>(operation: string, promise: Promise<T>): Promise<T> {
      this.throwIfExpired(operation);
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => timeout.reject(createTimeoutError(operation)), remainingMs());

      try {
        return await Promise.race([promise, timeout.promise]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  throwIfAborted(signal);

  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(createAbortError());
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function createTimeoutError(operation: string): Error {
  const error = new Error(`${operation} exceeded chatgpt_pro_consult timeout`);
  error.name = "TimeoutError";
  return error;
}

async function closeOwnedSurfacesQuietly(browser: CmuxBrowserAdapter, signal: AbortSignal | undefined): Promise<void> {
  try {
    await browser.closeOwnedSurfaces(signal);
  } catch {
    // Cleanup is best-effort; preserve the original consult result.
  }
}

function normalizeBlocker(blocker: unknown, surfaceRef: string | undefined): ConsultBlocker | undefined {
  if (typeof blocker !== "object" || blocker === null) return undefined;
  const record = blocker as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : undefined;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  if (!message || !kind) return undefined;

  const normalized = { ...record, kind, message } as ConsultBlocker;
  if (surfaceRef !== undefined) normalized.surfaceRef = surfaceRef;
  return normalized;
}

function normalizeWarnings(warnings: unknown): string[] {
  return Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === "string") : [];
}


function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return typeof error === "string" ? error : undefined;
}

function isTimeoutOrAbortError(error: unknown): boolean {
  const name = errorName(error);
  return name === "TimeoutError" || name === "AbortError";
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null) {
    const name = (error as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}
