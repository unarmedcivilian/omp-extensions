import { describe, expect, test } from "bun:test";
import { LocalPreviewServer } from "../src/server.js";
import { PreviewBrowserSurface } from "../src/surface.js";

function waitForOpen(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  return promise;
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  ws.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true });
  return promise;
}

function waitForClose(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.addEventListener("close", () => resolve(), { once: true });
  return promise;
}

describe("LocalPreviewServer", () => {
  test("serves runtime HTML for registered tokens", async () => {
    const server = new LocalPreviewServer("<!doctype html><title>Subagent Preview</title>");
    const surface = new PreviewBrowserSurface("tok", () => {});
    try {
      const url = server.register(surface);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Subagent Preview");
    } finally {
      server.close();
    }
  });

  test("websocket ready receives latest snapshot", async () => {
    const server = new LocalPreviewServer("<!doctype html><title>Subagent Preview</title>");
    const surface = new PreviewBrowserSurface("tok", () => {});
    try {
      server.register(surface);
      surface.send({ subagents: [], counts: { pending: 0, running: 0, completed: 0, failed: 0, aborted: 0 }, updatedAt: 1 });
      const ws = new WebSocket(new URL("/ws/tok", server.baseUrl));
      const received = waitForMessage(ws);
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "ready" }));
      await expect(received).resolves.toMatchObject({ type: "snapshot", snapshot: { updatedAt: 1 } });
      ws.close();
    } finally {
      server.close();
    }
  });

  test("websocket disconnect keeps token registered and reconnect receives latest snapshot", async () => {
    const server = new LocalPreviewServer("<!doctype html><title>Subagent Preview</title>");
    const surface = new PreviewBrowserSurface("tok", () => {});
    try {
      server.register(surface);
      surface.send({ subagents: [], counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 }, updatedAt: 2 });
      const first = new WebSocket(new URL("/ws/tok", server.baseUrl));
      await waitForOpen(first);
      const closed = waitForClose(first);
      first.close();
      await closed;

      const second = new WebSocket(new URL("/ws/tok", server.baseUrl));
      const received = waitForMessage(second);
      await waitForOpen(second);
      second.send(JSON.stringify({ type: "ready" }));

      await expect(received).resolves.toMatchObject({ type: "snapshot", snapshot: { updatedAt: 2 } });
      second.close();
    } finally {
      server.close();
    }
  });
});
