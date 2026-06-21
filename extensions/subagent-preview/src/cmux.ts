import { createConnection } from "node:net";

export interface CmuxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CmuxRunner = (args: readonly string[], signal?: AbortSignal) => Promise<CmuxExecResult>;
export type CmuxSpawn = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<CmuxExecResult>;

export interface CmuxTransport {
  openBrowserSurface(url: string, signal?: AbortSignal): Promise<string>;
  closeSurface(surface: string, signal?: AbortSignal): Promise<void>;
}

export type CmuxSocketExchange = (payload: string, socketPath: string, signal?: AbortSignal) => Promise<string>;
export type CmuxSocketRequester = (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export interface CreateCmuxSocketRequesterOptions {
  socketPath?: string;
  env?: Record<string, string | undefined>;
  idFactory?: () => string;
}

export interface CreateCmuxSocketTransportOptions {
  env?: Record<string, string | undefined>;
}

export interface CreateCmuxCliTransportOptions {
  env?: Record<string, string | undefined>;
}

export interface CreateCmuxTransportOptions {
  socket?: CmuxTransport;
  cli?: CmuxTransport;
}

export class CmuxSocketUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CmuxSocketUnavailableError";
  }
}

export function createCmuxRunner(spawn: CmuxSpawn = spawnCmuxProcess): CmuxRunner {
  return (args, signal) => spawn("cmux", args, signal);
}

async function spawnCmuxProcess(command: string, args: readonly string[], signal?: AbortSignal): Promise<CmuxExecResult> {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export function createCmuxSocketRequester(
  exchange: CmuxSocketExchange = exchangeCmuxSocket,
  options: CreateCmuxSocketRequesterOptions = {},
): CmuxSocketRequester {
  const socketPath = options.socketPath ?? resolveCmuxSocketPath(options.env ?? process.env);
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  return async (method, params = {}, signal) => {
    const id = idFactory();
    const payload = JSON.stringify({ id, method, params }) + "\n";
    let raw: string;
    try {
      raw = await exchange(payload, socketPath, signal);
    } catch (error) {
      if (isSocketUnavailableError(error)) {
        throw new CmuxSocketUnavailableError(`cmux socket unavailable at ${socketPath}`, { cause: error });
      }
      throw error;
    }
    const response = JSON.parse(raw) as { ok?: boolean; result?: unknown; error?: unknown };
    if (response.ok !== true) {
      throw new Error(String(response.error ?? "cmux socket request failed"));
    }
    return response.result;
  };
}

async function exchangeCmuxSocket(payload: string, socketPath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
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
  return await promise;
}

function resolveCmuxSocketPath(env: Record<string, string | undefined>): string {
  const explicit = env.CMUX_SOCKET_PATH || env.CMUX_SOCKET;
  if (explicit) return explicit;
  const home = env.HOME;
  if (home) return `${home}/.local/state/cmux/cmux.sock`;
  return "/tmp/cmux.sock";
}

function isSocketUnavailableError(error: unknown): boolean {
  if (error instanceof CmuxSocketUnavailableError) return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM" || code === "ETIMEDOUT" || code === "ECONNRESET";
}

function cmuxCallerParams(env: Record<string, string | undefined>, includeSurface: boolean): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const workspaceId = env.CMUX_WORKSPACE_ID;
  if (workspaceId) params.workspace_id = workspaceId;
  const surfaceId = env.CMUX_SURFACE_ID;
  if (includeSurface && surfaceId) params.surface_id = surfaceId;
  return params;
}

const SURFACE_REF = /^surface:\d+$/;

export function parseCmuxSurfaceRef(value: unknown): string {
  if (typeof value === "string" && SURFACE_REF.test(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["surface", "surface_ref", "ref", "id"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && SURFACE_REF.test(candidate)) return candidate;
    }
  }
  throw new Error("cmux browser open did not return a surface ref");
}

export async function openCmuxSurface(url: string, runner: CmuxRunner, env: Record<string, string | undefined> = process.env, signal?: AbortSignal): Promise<string> {
  const args = ["--json", "browser", "open-split", url, "--focus", "false"];
  if (env.CMUX_WORKSPACE_ID) args.push("--workspace", env.CMUX_WORKSPACE_ID);
  const result = await runner(args, signal);
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    throw new Error(`cmux browser open-split failed: ${detail}`);
  }
  try {
    return parseCmuxSurfaceRef(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof SyntaxError) return parseCmuxSurfaceRef(result.stdout.trim());
    throw error;
  }
}

export async function closeCmuxSurface(surface: string, runner: CmuxRunner, env: Record<string, string | undefined> = process.env, signal?: AbortSignal): Promise<void> {
  const args = ["close-surface", "--surface", surface];
  if (env.CMUX_WORKSPACE_ID) args.push("--workspace", env.CMUX_WORKSPACE_ID);
  const result = await runner(args, signal);
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    throw new Error(`cmux close-surface failed: ${detail}`);
  }
}

export function createCmuxCliTransport(runner: CmuxRunner = createCmuxRunner(), options: CreateCmuxCliTransportOptions = {}): CmuxTransport {
  const env = options.env ?? process.env;
  return {
    openBrowserSurface(url, signal) {
      return openCmuxSurface(url, runner, env, signal);
    },
    closeSurface(surface, signal) {
      return closeCmuxSurface(surface, runner, env, signal);
    },
  };
}

export function createCmuxSocketTransport(
  request: CmuxSocketRequester = createCmuxSocketRequester(),
  options: CreateCmuxSocketTransportOptions = {},
): CmuxTransport {
  const env = options.env ?? process.env;
  return {
    async openBrowserSurface(url, signal) {
      const params = { url, focus: false, ...cmuxCallerParams(env, true) };
      return parseCmuxSurfaceRef(await request("browser.open_split", params, signal));
    },
    async closeSurface(surface, signal) {
      const params = { surface_id: surface, ...cmuxCallerParams(env, false) };
      await request("surface.close", params, signal);
    },
  };
}

export function createCmuxTransport(options: CreateCmuxTransportOptions = {}): CmuxTransport {
  const socket = options.socket ?? createCmuxSocketTransport();
  const cli = options.cli ?? createCmuxCliTransport();
  return {
    async openBrowserSurface(url, signal) {
      try {
        return await socket.openBrowserSurface(url, signal);
      } catch (error) {
        if (error instanceof CmuxSocketUnavailableError) return cli.openBrowserSurface(url, signal);
        throw error;
      }
    },
    async closeSurface(surface, signal) {
      try {
        await socket.closeSurface(surface, signal);
      } catch (error) {
        if (error instanceof CmuxSocketUnavailableError) return cli.closeSurface(surface, signal);
        throw error;
      }
    },
  };
}
