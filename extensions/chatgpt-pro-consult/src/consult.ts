import { resolve } from "node:path";
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
  zipPath?: string;
  thread?: ChatGptProThread;
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
  createDeadline?: typeof createConsultDeadline;
  createBrowser?: (options: {
    signal?: AbortSignal;
    deadline: ConsultDeadline;
    lifecycle: ConsultLifecycle;
    openLoadTimeoutMs?: number;
    openSettleMs?: number;
    interactionSettleMs?: number;
  }) => CmuxBrowserAdapter;
  createChatGptClient?: (browser: CmuxBrowserAdapter) => ChatGptClient;
  now?: () => Date;
}

export interface ChatGptClient {
  ask(args: ChatGptAskArgs): Promise<ConsultCommandResult>;
  runPlan(plan: ConsultSequencePlan): Promise<ConsultCommandResult>;
}

export interface ChatGptAskArgs {
  prompt: string;
  thread: { type: "new" } | { type: "current" };
  existingTab: ExistingTabPolicy | undefined;
  preferExistingTab: boolean;
  mode: { intelligence: string; timeoutMs: number };
  wait: { timeoutMs: number };
  read: { format: "markdown" };
  report: false;
}

export interface ConsultSequencePlan {
  name: string;
  policy: { stopOnError: true; returnPartial: true };
  steps: ConsultSequenceStep[];
}

export interface ConsultSequenceStep {
  id: string;
  command: string;
  args?: Record<string, unknown>;
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

const CONSULT_TIMEOUT_MS = 120 * 60_000;
const MAX_MODE_TIMEOUT_MS = 15_000;
const MIN_MODE_TIMEOUT_MS = 1_000;
const READ_RESERVE_MS = 5_000;
const NEW_THREAD_OPEN_LOAD_TIMEOUT_MS = 15_000;
const NEW_THREAD_OPEN_SETTLE_MS = 2_000;
const CHATGPT_INTERACTION_SETTLE_MS = 2_000;
const PREFERRED_PRO_MODE_LABEL = "Pro Extended";
const LEGACY_PRO_MODE_LABEL = "pro";

const ACTION_REQUIRED_BLOCKERS: Record<string, true> = {
  login: true,
  login_required: true,
  captcha: true,
  rate_limit: true,
  modal: true,
  selector_drift: true,
  attachment_processing: true,
  upload_permission_required: true,
};

export async function runChatGptProConsult(
  params: ChatGptProConsultParams,
  deps: ChatGptProConsultDeps = {},
): Promise<ChatGptProConsultResult> {
  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("prompt is required");

  const callerSignal = params.signal;
  throwIfAborted(callerSignal);

  const thread = params.thread ?? "new";
  let zipPath: string | undefined;
  try {
    zipPath = normalizeZipPath(params.zipPath);
  } catch (error) {
    return errorResult(error, thread, false, undefined);
  }

  const deadlineController = new AbortController();
  const deadline = (deps.createDeadline ?? createConsultDeadline)(
    CONSULT_TIMEOUT_MS,
    deps.now ?? (() => new Date()),
    error => deadlineController.abort(error),
  );
  const operationSignal = callerSignal
    ? AbortSignal.any([callerSignal, deadlineController.signal])
    : deadlineController.signal;
  let promptPossiblySubmitted = false;
  const lifecycle: ConsultLifecycle = {
    markPromptSubmitted() {
      promptPossiblySubmitted = true;
    },
  };

  const browserOptions = {
    signal: operationSignal,
    deadline,
    lifecycle,
    openLoadTimeoutMs: NEW_THREAD_OPEN_LOAD_TIMEOUT_MS,
    openSettleMs: NEW_THREAD_OPEN_SETTLE_MS,
    interactionSettleMs: CHATGPT_INTERACTION_SETTLE_MS,
  };
  const browser = deps.createBrowser?.(browserOptions) ?? createCmuxBrowserAdapter(browserOptions);
  const modeTimeoutMs = Math.min(MAX_MODE_TIMEOUT_MS, Math.max(MIN_MODE_TIMEOUT_MS, Math.floor(CONSULT_TIMEOUT_MS / 4)));
  const waitTimeoutMs = Math.max(MIN_MODE_TIMEOUT_MS, CONSULT_TIMEOUT_MS - modeTimeoutMs - READ_RESERVE_MS);

  let currentTarget: SelectedChatGptSurface | undefined;
  if (thread === "current") {
    try {
      deadline.throwIfExpired("chatgpt.current_surface");
      currentTarget = await deadline.race(
        "chatgpt.current_surface",
        raceAbort(browser.requireSelectedChatGptSurface(operationSignal), operationSignal),
      );
    } catch (error) {
      const abortReason = operationSignal.aborted ? abortErrorFromSignal(operationSignal) : undefined;
      await closeOwnedSurfacesQuietly(browser);
      return abortReason !== undefined || isTimeoutOrAbortError(error)
        ? errorResult(abortReason ?? error, thread, false, browser.primarySurfaceRef())
        : blockedPreflightResult(error, thread);
    }
  }

  const client = deps.createChatGptClient?.(browser) ?? (createChatGPT({ browser }) as unknown as ChatGptClient);
  let result: ConsultCommandResult | undefined;

  try {
    deadline.throwIfExpired("chatgpt.ask");
    result = await askWithPreferredProMode({
      client,
      prompt,
      thread,
      currentTarget,
      modeTimeoutMs,
      waitTimeoutMs,
      deadline,
      signal: operationSignal,
      zipPath,
    });

    const submitted = promptPossiblySubmitted || hasSubmittedPrompt(result);
    const keptSurface = shouldLeaveSurfaceOpen(result, submitted, params.keepSurface === true);
    if (!keptSurface) await closeOwnedSurfacesQuietly(browser);
    return mapCommandResult(result, thread, keptSurface, browser.primarySurfaceRef());
  } catch (error) {
    const submitted = promptPossiblySubmitted || (result ? hasSubmittedPrompt(result) : false);
    if (!submitted) await closeOwnedSurfacesQuietly(browser);
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

async function askWithPreferredProMode(args: {
  client: ChatGptClient;
  prompt: string;
  thread: ChatGptProThread;
  currentTarget: SelectedChatGptSurface | undefined;
  modeTimeoutMs: number;
  waitTimeoutMs: number;
  deadline: ConsultDeadline;
  signal: AbortSignal;
  zipPath: string | undefined;
}): Promise<ConsultCommandResult> {
  const preferred = await askWithMode(args, PREFERRED_PRO_MODE_LABEL);
  if (!isModeFallbackCandidate(preferred)) return preferred;
  args.deadline.throwIfExpired("chatgpt.ask");
  return askWithMode(args, LEGACY_PRO_MODE_LABEL);
}

async function askWithMode(args: {
  client: ChatGptClient;
  prompt: string;
  thread: ChatGptProThread;
  currentTarget: SelectedChatGptSurface | undefined;
  modeTimeoutMs: number;
  waitTimeoutMs: number;
  deadline: ConsultDeadline;
  signal: AbortSignal;
  zipPath: string | undefined;
}, modeLabel: string): Promise<ConsultCommandResult> {
  const request: ChatGptAskArgs = {
    prompt: args.prompt,
    thread: args.thread === "current" ? { type: "current" } : { type: "new" },
    existingTab: args.currentTarget ? existingTabFor(args.currentTarget) : undefined,
    preferExistingTab: args.thread === "current" ? true : false,
    mode: { intelligence: modeLabel, timeoutMs: args.modeTimeoutMs },
    wait: { timeoutMs: args.waitTimeoutMs },
    read: { format: "markdown" },
    report: false,
  };
  const ask = args.zipPath
    ? args.client.runPlan(buildZipAskPlan(request, args.zipPath, args.waitTimeoutMs))
    : args.client.ask(request);
  return args.deadline.race("chatgpt.ask", raceAbort(ask, args.signal));
}

function buildZipAskPlan(request: ChatGptAskArgs, zipPath: string, attachTimeoutMs: number): ConsultSequencePlan {
  return {
    name: "chatgpt-pro-consult-with-zip",
    policy: { stopOnError: true, returnPartial: true },
    steps: [
      bootstrapStep(request),
      ...threadSteps(request.thread),
      { id: "mode", command: "modes.set", args: request.mode },
      { id: "attach", command: "files.attach", args: { paths: [zipPath], timeoutMs: attachTimeoutMs } },
      { id: "ask", command: "messages.ask", args: { text: request.prompt, wait: request.wait, read: request.read } },
    ],
  };
}

function bootstrapStep(request: ChatGptAskArgs): ConsultSequenceStep {
  const args: Record<string, unknown> = { preferExistingTab: request.preferExistingTab };
  if (request.existingTab !== undefined) args.existingTab = request.existingTab;
  return { id: "bootstrap", command: "session.bootstrap", args };
}

function threadSteps(thread: ChatGptAskArgs["thread"]): ConsultSequenceStep[] {
  return thread.type === "new" ? [{ id: "new", command: "threads.new" }] : [];
}

function isModeFallbackCandidate(result: ConsultCommandResult): boolean {
  if (result.ok || hasSubmittedPrompt(result)) return false;
  const message = blockerMessage(result);
  if (message === undefined || !message.includes(`Mode option "${PREFERRED_PRO_MODE_LABEL}"`)) return false;
  const commands = stepCommands(result);
  return commands.length === 0 || (commands.includes("modes.set") && !commands.includes("messages.ask"));
}

function stepCommands(result: ConsultCommandResult): string[] {
  if (!Array.isArray(result.steps)) return [];
  return result.steps
    .map(step => (typeof step === "object" && step !== null ? (step as Record<string, unknown>).command : undefined))
    .filter((command): command is string => typeof command === "string");
}

function blockerMessage(result: ConsultCommandResult): string | undefined {
  const blocker = result.blocker;
  if (typeof blocker !== "object" || blocker === null) return undefined;
  const message = (blocker as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

function normalizeZipPath(zipPath: string | undefined): string | undefined {
  if (zipPath === undefined) return undefined;
  const trimmed = zipPath.trim();
  if (!trimmed) throw new Error("zip_path must not be empty");
  if (!/\.zip$/i.test(trimmed)) throw new Error("zip_path must point to a .zip file");
  return resolve(trimmed);
}

function isPositiveCount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createConsultDeadline(
  timeoutMs: number,
  now: () => Date,
  onExpire?: (error: Error) => void,
): ConsultDeadline {
  const expiresAt = now().getTime() + timeoutMs;
  const remainingMs = () => Math.max(0, expiresAt - now().getTime());
  let timeoutError: Error | undefined;
  const expire = (operation: string): Error => {
    if (timeoutError) return timeoutError;
    timeoutError = createTimeoutError(operation);
    onExpire?.(timeoutError);
    return timeoutError;
  };

  return {
    remainingMs,
    throwIfExpired(operation: string) {
      if (remainingMs() <= 0) throw expire(operation);
    },
    async race<T>(operation: string, promise: Promise<T>): Promise<T> {
      try {
        this.throwIfExpired(operation);
      } catch (error) {
        void promise.catch(() => undefined);
        throw error;
      }
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => timeout.reject(expire(operation)), remainingMs());

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

  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(abortErrorFromSignal(signal));
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    throwIfAborted(signal);
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortErrorFromSignal(signal);
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : createAbortError();
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

async function closeOwnedSurfacesQuietly(browser: CmuxBrowserAdapter): Promise<void> {
  try {
    await browser.closeOwnedSurfaces();
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
