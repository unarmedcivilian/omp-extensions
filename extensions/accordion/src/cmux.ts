import { existsSync } from "node:fs";
import { Socket } from "node:net";

export interface AccordionBrowserOpenResult {
  ok: boolean;
  surface?: string;
  error?: string;
}

export type OpenAccordionBrowser = (url: string, signal?: AbortSignal) => Promise<AccordionBrowserOpenResult>;

type CmuxSocketExchange = (payload: string, socketPath: string, signal?: AbortSignal) => Promise<string>;

const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";

function socketPath(env: Record<string, string | undefined> = process.env): string {
  return env.CMUX_SOCKET || env.CMUX_SOCKET_PATH || DEFAULT_SOCKET_PATH;
}

function resultSurface(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("surface" in value) || typeof value.surface !== "string") return undefined;
  return value.surface;
}

async function exchangeSocket(payload: string, path: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("Accordion browser open aborted");
  if (!existsSync(path)) throw new Error(`cmux socket not found at ${path}`);
  const gate = Promise.withResolvers<string>();
  const socket = new Socket();
  let chunks = "";
  const cleanup = () => {
    signal?.removeEventListener("abort", onAbort);
    socket.removeAllListeners();
  };
  const onAbort = () => {
    cleanup();
    try { socket.destroy(); } catch { /* ignore */ }
    gate.reject(new Error("Accordion browser open aborted"));
  };
  socket.once("error", error => {
    cleanup();
    gate.reject(error);
  });
  socket.setEncoding("utf8");
  socket.once("connect", () => socket.end(payload));
  socket.on("data", chunk => { chunks += chunk; });
  socket.once("end", () => {
    cleanup();
    gate.resolve(chunks);
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.connect(path);
  return gate.promise;
}

export function createAccordionBrowserOpener(exchange: CmuxSocketExchange = exchangeSocket): OpenAccordionBrowser {
  return async function openAccordionBrowser(url: string, signal?: AbortSignal): Promise<AccordionBrowserOpenResult> {
    if (signal?.aborted) return { ok: false, error: "Accordion browser open aborted" };
    try {
      const payload = JSON.stringify({ method: "browser.open", params: { url, split: "right" } }) + "\n";
      const raw = await exchange(payload, socketPath(), signal);
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : null;
      return { ok: true, surface: resultSurface(parsed) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
