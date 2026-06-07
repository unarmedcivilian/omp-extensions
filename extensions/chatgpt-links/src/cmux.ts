import { createConnection } from "node:net";
import type { BrowserAutomation } from "./importer.js";

export interface CmuxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CmuxRunner = (args: string[], signal?: AbortSignal) => Promise<CmuxRunResult>;
export type BrowserRpcExchange = (payload: string, socketPath: string, signal?: AbortSignal) => Promise<string>;
export type BrowserRpcRequester = (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export type CmuxBrowserAutomation = BrowserAutomation;

export interface CreateCmuxSocketRequesterOptions {
  socketPath?: string;
  env?: Record<string, string | undefined>;
  idFactory?: () => string;
}

export interface CreateCmuxSocketBrowserAutomationOptions {
  env?: Record<string, string | undefined>;
}

export interface CreateCmuxBrowserAutomationOptions {
  socket?: CmuxBrowserAutomation;
  cli?: CmuxBrowserAutomation;
}

export class CmuxSocketUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CmuxSocketUnavailableError";
  }
}

export function createCmuxRunner(command = "cmux"): CmuxRunner {
  return async (args, signal) => {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", signal });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };
}

export function createCmuxSocketRequester(
  exchange: BrowserRpcExchange = exchangeCmuxSocket,
  options: CreateCmuxSocketRequesterOptions = {},
): BrowserRpcRequester {
  const socketPath = options.socketPath ?? resolveCmuxSocketPath(options.env ?? process.env);
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  return async (method, params = {}, signal) => {
    const id = idFactory();
    const payload = JSON.stringify({ id, method, params }) + "\n";
    let raw: string;
    try {
      raw = await exchange(payload, socketPath, signal);
    } catch (error) {
      if (isSocketUnavailableError(error)) throw new CmuxSocketUnavailableError(`cmux socket unavailable at ${socketPath}`, { cause: error });
      throw error;
    }
    const response = JSON.parse(raw) as { ok?: boolean; result?: unknown; error?: unknown };
    if (response.ok !== true) throw new Error(formatCmuxRpcError(response.error));
    return response.result;
  };
}

export function createCmuxSocketBrowserAutomation(
  request: BrowserRpcRequester = createCmuxSocketRequester(),
  options: CreateCmuxSocketBrowserAutomationOptions = {},
): CmuxBrowserAutomation {
  const env = options.env ?? process.env;
  return {
    async open(url, signal) {
      return parseCmuxSurfaceRef(await request("browser.open_split", { url, focus: false, ...callerParams(env, true) }, signal));
    },
    async waitForLoad(surface, timeoutMs, signal) {
      await request("browser.wait", { surface_id: surface, ...callerParams(env, false), load_state: "complete", timeout_ms: timeoutMs }, signal);
    },
    async getText(_surface, _selector, _signal) {
      throw new CmuxSocketUnavailableError("cmux socket text extraction is unavailable without heavyweight snapshots");
    },
    async close(surface, signal) {
      await request("surface.close", { surface_id: surface, ...callerParams(env, false) }, signal);
    },
  };
}

export function createCmuxCliBrowserAutomation(runner: CmuxRunner = createCmuxRunner(), env: Record<string, string | undefined> = process.env): CmuxBrowserAutomation {
  return {
    async open(url, signal) {
      const args = ["--json", "browser", "open-split", url];
      if (env.CMUX_WORKSPACE_ID) args.push("--workspace", env.CMUX_WORKSPACE_ID);
      args.push("--focus", "false");
      const result = await runner(args, signal);
      if (result.exitCode !== 0) throw new Error(`cmux browser open-split failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
      return parseCmuxSurfaceRef(JSON.parse(result.stdout));
    },
    async waitForLoad(surface, timeoutMs, signal) {
      await runChecked(runner, ["browser", surface, "wait", "--load-state", "complete", "--timeout-ms", String(timeoutMs)], "cmux browser wait", signal);
    },
    async getText(surface, selector, signal) {
      const result = await runner(["browser", surface, "get", "text", selector], signal);
      if (result.exitCode !== 0) throw new Error(`cmux browser get text failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
      return result.stdout;
    },
    async close(surface, signal) {
      const args = ["close-surface", "--surface", surface];
      if (env.CMUX_WORKSPACE_ID) args.push("--workspace", env.CMUX_WORKSPACE_ID);
      await runChecked(runner, args, "cmux close-surface", signal);
    },
  };
}

export function createCmuxBrowserAutomation(options: CreateCmuxBrowserAutomationOptions = {}): CmuxBrowserAutomation {
  const socket = options.socket ?? createCmuxSocketBrowserAutomation();
  const cli = options.cli ?? createCmuxCliBrowserAutomation();
  return {
    async open(url, signal) {
      try {
        return await socket.open(url, signal);
      } catch (error) {
        if (error instanceof CmuxSocketUnavailableError) return cli.open(url, signal);
        throw error;
      }
    },
    async waitForLoad(surface, timeoutMs, signal) {
      try {
        await socket.waitForLoad(surface, timeoutMs, signal);
      } catch (error) {
        if (error instanceof CmuxSocketUnavailableError) return cli.waitForLoad(surface, timeoutMs, signal);
        throw error;
      }
    },
    async getText(surface, selector, signal) {
      try {
        return await socket.getText(surface, selector, signal);
      } catch (error) {
        if (error instanceof CmuxSocketUnavailableError) return cli.getText(surface, selector, signal);
        throw error;
      }
    },
    async close(surface, signal) {
      try {
        await socket.close(surface, signal);
      } catch (error) {
        if (error instanceof CmuxSocketUnavailableError) return cli.close(surface, signal);
        throw error;
      }
    },
  };
}

export function parseCmuxSurfaceRef(raw: unknown): string {
  if (typeof raw === "string" && raw.startsWith("surface:")) return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["surface", "surface_ref", "surfaceRef", "ref"]) {
      const value = record[key];
      if (typeof value === "string" && value.startsWith("surface:")) return value;
    }
  }
  throw new Error(`Unable to parse cmux surface ref from ${JSON.stringify(raw)}`);
}


function formatCmuxRpcError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "cmux socket request failed";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
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

async function runChecked(runner: CmuxRunner, args: string[], label: string, signal: AbortSignal | undefined): Promise<void> {
  const result = await runner(args, signal);
  if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
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

function isSocketUnavailableError(error: unknown): boolean {
  if (error instanceof CmuxSocketUnavailableError) return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM" || code === "ETIMEDOUT" || code === "ECONNRESET";
}
