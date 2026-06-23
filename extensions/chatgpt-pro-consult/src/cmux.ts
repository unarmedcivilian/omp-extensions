import { createConnection } from "node:net";

export interface CmuxRunResult { stdout: string; stderr: string; exitCode: number }
export type CmuxRunner = (args: readonly string[], signal?: AbortSignal) => Promise<CmuxRunResult>;
export type CmuxSocketRequester = (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export type CmuxSocketExchange = (payload: string, socketPath: string, signal?: AbortSignal) => Promise<string>;

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

export interface CreateCmuxSocketRequesterOptions {
  env?: Record<string, string | undefined>;
  socketPath?: string;
  idFactory?: () => string;
}

export class CmuxSocketUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CmuxSocketUnavailableError";
  }
}

const SURFACE_REF = /^surface:\d+$/;
const SURFACE_REF_KEYS = ["surface", "surface_ref", "surfaceRef", "ref", "id"] as const;

export function createCmuxRunner(command = "cmux"): CmuxRunner {
  return async (args, signal) => {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", signal });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
}

export function createCmuxSocketRequester(
  exchange: CmuxSocketExchange = exchangeCmuxSocket,
  options: CreateCmuxSocketRequesterOptions = {},
): CmuxSocketRequester {
  const socketPath = options.socketPath ?? resolveCmuxSocketPath(options.env ?? process.env);
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());

  return async (method, params = {}, signal) => {
    const payload = JSON.stringify({ id: idFactory(), method, params }) + "\n";
    let raw: string;
    try {
      raw = await exchange(payload, socketPath, signal);
    } catch (error) {
      if (isSocketUnavailableError(error)) {
        throw new CmuxSocketUnavailableError(`cmux socket unavailable at ${socketPath}`, { cause: error });
      }
      throw error;
    }

    const response: unknown = JSON.parse(raw);
    if (!response || typeof response !== "object") throw new Error("cmux socket returned an invalid response");
    if (field(response, "ok") !== true) throw new Error(formatCmuxRpcError(field(response, "error")));
    return field(response, "result");
  };
}

export function createCmuxTransport(options: CreateCmuxTransportOptions = {}): CmuxTransport {
  const env = options.env ?? process.env;
  const runner = options.runner ?? createCmuxRunner();
  const socket = options.socket ?? createCmuxSocketRequester(undefined, { env });
  const surfaceStore = options.surfaceStore;

  function rememberSurface(surface: string): string {
    if (surfaceStore) surfaceStore.lastChatGptSurface = surface;
    return surface;
  }

  return {
    async open(url, signal) {
      try {
        const surface = parseCmuxSurfaceRef(await socket("browser.open_split", { url, focus: false, ...callerParams(env, true) }, signal));
        return rememberSurface(surface);
      } catch (error) {
        if (!(error instanceof CmuxSocketUnavailableError)) throw error;
        return rememberSurface(await openWithCli(url, runner, env, signal));
      }
    },

    async goto(surface, url, signal) {
      await runChecked(runner, ["browser", surface, "goto", url], "cmux browser goto", signal);
    },

    async waitForLoad(surface, timeoutMs, signal) {
      try {
        await socket("browser.wait", { surface_id: surface, ...callerParams(env, false), load_state: "complete", timeout_ms: timeoutMs }, signal);
      } catch (error) {
        if (!(error instanceof CmuxSocketUnavailableError)) throw error;
        await runChecked(runner, ["browser", surface, "wait", "--load-state", "complete", "--timeout-ms", String(timeoutMs)], "cmux browser wait", signal);
      }
    },

    async getUrl(surface, signal) {
      return (await runChecked(runner, ["browser", surface, "get", "url"], "cmux browser get url", signal)).stdout;
    },

    async getTitle(surface, signal) {
      return (await runChecked(runner, ["browser", surface, "get", "title"], "cmux browser get title", signal)).stdout;
    },

    async getText(surface, selector, signal) {
      return (await runChecked(runner, ["browser", surface, "get", "text", selector], "cmux browser get text", signal)).stdout;
    },

    async getHtml(surface, selector, signal) {
      return (await runChecked(runner, ["browser", surface, "get", "html", selector], "cmux browser get html", signal)).stdout;
    },

    async eval(surface, code, signal) {
      return (await runChecked(runner, ["browser", surface, "eval", code], "cmux browser eval", signal)).stdout;
    },

    async press(surface, key, signal) {
      await runChecked(runner, ["browser", surface, "press", key], "cmux browser press", signal);
    },

    async close(surface, signal) {
      try {
        await socket("surface.close", { surface_id: surface, ...callerParams(env, false) }, signal);
      } catch (error) {
        if (!(error instanceof CmuxSocketUnavailableError)) throw error;
        await closeWithCli(surface, runner, env, signal);
      }
    },

    async resolveCurrentSurface(signal) {
      return await resolveCurrentSurface(surfaceStore, env, runner, signal);
    },
  };
}

export function parseCmuxSurfaceRef(raw: unknown): string {
  if (typeof raw === "string" && SURFACE_REF.test(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of SURFACE_REF_KEYS) {
      const value = field(raw, key);
      if (typeof value === "string" && SURFACE_REF.test(value)) return value;
    }
  }
  throw new Error(`Unable to parse cmux surface ref from ${formatUnknown(raw)}`);
}

async function openWithCli(url: string, runner: CmuxRunner, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<string> {
  const args = ["--json", "browser", "open-split", url, "--focus", "false"];
  appendWorkspaceArg(args, env);
  const result = await runChecked(runner, args, "cmux browser open-split", signal);
  return parseCliSurfaceRef(result.stdout);
}

async function closeWithCli(surface: string, runner: CmuxRunner, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<void> {
  const args = ["close-surface", "--surface", surface];
  appendWorkspaceArg(args, env);
  await runChecked(runner, args, "cmux close-surface", signal);
}

async function resolveCurrentSurface(
  surfaceStore: { lastChatGptSurface?: string } | undefined,
  env: Record<string, string | undefined>,
  runner: CmuxRunner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return tryParseCmuxSurfaceRef(surfaceStore?.lastChatGptSurface)
    ?? tryParseCmuxSurfaceRef(env.CHATGPT_PRO_CONSULT_SURFACE)
    ?? tryParseCmuxSurfaceRef(env.CMUX_CHATGPT_SURFACE_ID)
    ?? await identifyCurrentSurface(runner, signal);
}

async function identifyCurrentSurface(runner: CmuxRunner, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await runner(["identify", "--json"], signal);
    if (result.exitCode !== 0) return undefined;
    return parseCliSurfaceRefIfValid(result.stdout);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function parseCliSurfaceRef(stdout: string): string {
  const parsed = parseCliSurfaceRefIfValid(stdout);
  if (parsed) return parsed;
  throw new Error(`Unable to parse cmux surface ref from ${JSON.stringify(stdout)}`);
}

function parseCliSurfaceRefIfValid(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return tryParseCmuxSurfaceRef(parsed);
  } catch (error) {
    if (!(error instanceof SyntaxError)) return undefined;
    return tryParseCmuxSurfaceRef(trimmed);
  }
}

function tryParseCmuxSurfaceRef(value: unknown): string | undefined {
  try {
    return parseCmuxSurfaceRef(value);
  } catch {
    return undefined;
  }
}

async function exchangeCmuxSocket(payload: string, socketPath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  return await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let chunks = "";
    let settled = false;

    function settle(error: unknown, value?: string): void {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.end();
      resolve(value ?? "");
    }

    function onAbort(): void {
      settle(new DOMException("Aborted", "AbortError"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", chunk => {
      chunks += chunk;
      const newline = chunks.indexOf("\n");
      if (newline >= 0) settle(undefined, chunks.slice(0, newline));
    });
    socket.on("end", () => {
      if (chunks.length > 0) settle(undefined, chunks);
      else settle(new Error("cmux socket closed without a response"));
    });
    socket.on("error", settle);
  });
}

async function runChecked(runner: CmuxRunner, args: readonly string[], label: string, signal: AbortSignal | undefined): Promise<CmuxRunResult> {
  const result = await runner(args, signal);
  if (result.exitCode !== 0) throw new Error(`${label} failed: ${formatRunFailure(result)}`);
  return result;
}

function formatRunFailure(result: CmuxRunResult): string {
  const details = [`exit ${result.exitCode}`];
  if (result.stdout) details.push(`stdout: ${result.stdout}`);
  if (result.stderr) details.push(`stderr: ${result.stderr}`);
  return details.join("; ");
}

function resolveCmuxSocketPath(env: Record<string, string | undefined>): string {
  const explicit = env.CMUX_SOCKET_PATH || env.CMUX_SOCKET;
  if (explicit) return explicit;
  return env.HOME ? `${env.HOME}/.local/state/cmux/cmux.sock` : "/tmp/cmux.sock";
}

function callerParams(env: Record<string, string | undefined>, includeSurface: boolean): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (env.CMUX_WORKSPACE_ID) params.workspace_id = env.CMUX_WORKSPACE_ID;
  if (includeSurface && env.CMUX_SURFACE_ID) params.surface_id = env.CMUX_SURFACE_ID;
  return params;
}

function appendWorkspaceArg(args: string[], env: Record<string, string | undefined>): void {
  if (env.CMUX_WORKSPACE_ID) args.push("--workspace", env.CMUX_WORKSPACE_ID);
}

function isSocketUnavailableError(error: unknown): boolean {
  if (error instanceof CmuxSocketUnavailableError) return true;
  const code = field(error, "code");
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM" || code === "ETIMEDOUT" || code === "ECONNRESET";
}

function isAbortError(error: unknown): boolean {
  return (error instanceof Error && error.name === "AbortError") || field(error, "name") === "AbortError";
}

function formatCmuxRpcError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "cmux socket request failed";
  return formatUnknown(error);
}

function formatUnknown(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  return Reflect.get(value, key);
}
