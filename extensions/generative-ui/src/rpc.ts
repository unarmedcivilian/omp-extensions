import type { HostToPage } from "./protocol.js";
import { isPageToHost } from "./protocol.js";
import type { WidgetSurfaceLike } from "./session.js";

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export interface RpcHost {
  handle(method: string, fn: RpcHandler): void;
  push(msg: HostToPage): void;
}

const installed = new WeakMap<WidgetSurfaceLike, RpcHost>();

export function attachRpc(surface: WidgetSurfaceLike): RpcHost {
  const existing = installed.get(surface);
  if (existing) return existing;

  const handlers = new Map<string, RpcHandler>();

  function push(msg: HostToPage): void {
    surface.send(msg);
  }

  function handle(method: string, fn: RpcHandler): void {
    handlers.set(method, fn);
  }

  surface.on("message", raw => {
    if (!isPageToHost(raw) || raw.type !== "rpc-call") return;
    const handler = handlers.get(raw.method);
    if (!handler) {
      push({ type: "rpc-result", id: raw.id, ok: false, error: `Unknown RPC method: ${raw.method}` });
      return;
    }
    try {
      const value = handler(raw.params);
      if (value && typeof (value as Promise<unknown>).then === "function") {
        void (value as Promise<unknown>)
          .then(resolved => push({ type: "rpc-result", id: raw.id, ok: true, value: resolved }))
          .catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            push({ type: "rpc-result", id: raw.id, ok: false, error: message });
          });
      } else {
        push({ type: "rpc-result", id: raw.id, ok: true, value });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      push({ type: "rpc-result", id: raw.id, ok: false, error: message });
    }
  });

  const host: RpcHost = { handle, push };
  installed.set(surface, host);
  return host;
}
