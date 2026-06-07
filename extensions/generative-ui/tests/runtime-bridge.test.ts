import { describe, expect, test } from "bun:test";
import { computeWebSocketUrl, installBridge, type RuntimeSocketLike } from "../src/runtime/bridge.js";

class FakeSocket implements RuntimeSocketLike {
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(fn);
    this.listeners.set(type, bucket);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

describe("runtime bridge", () => {
  test("computes a token-scoped WebSocket URL from the widget URL", () => {
    expect(computeWebSocketUrl(new URL("http://127.0.0.1:1234/widget/abc"))).toBe("ws://127.0.0.1:1234/ws/abc");
    expect(computeWebSocketUrl(new URL("https://example.test/widget/t"))).toBe("wss://example.test/ws/t");
  });

  test("announces ready when the socket opens", () => {
    const socket = new FakeSocket();
    installBridge({ socket, globals: {} });

    socket.open();

    expect(socket.sent.map(JSON.parse)).toEqual([{ type: "ready" }]);
  });

  test("sendPrompt sends agent.prompt RPC and resolves on rpc-result", async () => {
    const socket = new FakeSocket();
    const globals: Record<string, unknown> = {};
    installBridge({ socket, globals });
    socket.open();

    const sendPrompt = globals.sendPrompt;
    if (typeof sendPrompt !== "function") throw new Error("sendPrompt missing");
    const promise = sendPrompt("Explain this card") as Promise<unknown>;
    const rpcCall = socket.sent.map(JSON.parse).find((msg: unknown): msg is { type: string; id: string; method: string; params: unknown } => {
      return Boolean(msg && typeof msg === "object" && (msg as { type?: unknown }).type === "rpc-call");
    });
    if (!rpcCall) throw new Error("rpc call missing");

    expect(rpcCall).toMatchObject({ type: "rpc-call", method: "agent.prompt", params: { text: "Explain this card" } });

    socket.message({ type: "rpc-result", id: rpcCall.id, ok: true, value: { queued: true } });

    await expect(promise).resolves.toEqual({ queued: true });
  });
});
