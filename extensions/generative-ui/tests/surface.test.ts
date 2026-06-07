import { describe, expect, test } from "bun:test";
import { CmuxWidgetSurface, createCmuxWidgetOpener, LocalWidgetServer, type WidgetServerLike } from "../src/surface.js";
import type { HostToPage } from "../src/protocol.js";
import type { CmuxTransport } from "../src/cmux.js";

class FakeSocket {
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeServer implements WidgetServerLike {
  registered: CmuxWidgetSurface[] = [];
  unregistered: string[] = [];

  register(surface: CmuxWidgetSurface): URL {
    this.registered.push(surface);
    return new URL(`http://127.0.0.1:4311/widget/${surface.token}`);
  }

  unregister(token: string): void {
    this.unregistered.push(token);
  }
}

function fakeTransport(calls: string[]): CmuxTransport {
  return {
    async openBrowserSurface(url) {
      calls.push(`open:${url}`);
      return "surface:5";
    },
    async closeSurface(surface) {
      calls.push(`close:${surface}`);
    },
  };
}


describe("CmuxWidgetSurface", () => {
  test("queues host messages until a browser WebSocket attaches", () => {
    const surface = new CmuxWidgetSurface("t1", () => {});
    const msg: HostToPage = { type: "content", html: "<p>Hello</p>", final: true };

    surface.send(msg);
    const socket = new FakeSocket();
    surface.attachSocket(socket);

    expect(socket.sent.map(JSON.parse)).toEqual([msg]);
  });

  test("emits ready and routes browser messages", () => {
    const surface = new CmuxWidgetSurface("t1", () => {});
    const seen: unknown[] = [];
    let ready = false;
    surface.on("ready", () => { ready = true; });
    surface.on("message", msg => seen.push(msg));

    surface.receiveFromBrowser(JSON.stringify({ type: "ready" }));
    surface.receiveFromBrowser(JSON.stringify({ type: "rpc-call", id: "r1", method: "m", params: null }));

    expect(ready).toBe(true);
    expect(seen).toEqual([{ type: "rpc-call", id: "r1", method: "m", params: null }]);
  });
});

describe("createCmuxWidgetOpener", () => {
  test("registers a widget surface and opens its URL in cmux", async () => {
    const calls: string[] = [];
    const server = new FakeServer();
    const opener = createCmuxWidgetOpener({ server, transport: fakeTransport(calls), tokenFactory: () => "fixed" });

    const surface = await opener({ title: "demo", width: 800, height: 600 });

    expect(surface).toBe(server.registered[0]);
    expect(surface.surfaceRef).toBe("surface:5");
    expect(server.registered[0].title).toBe("demo");
    expect(calls).toEqual(["open:http://127.0.0.1:4311/widget/fixed"]);
  });

  test("unregisters and closes the cmux surface on close", async () => {
    const calls: string[] = [];
    const server = new FakeServer();
    const opener = createCmuxWidgetOpener({ server, transport: fakeTransport(calls), tokenFactory: () => "fixed" });
    const surface = await opener({ title: "demo", width: 800, height: 600 });

    surface.close();
    await Promise.resolve();

    expect(server.unregistered).toEqual(["fixed"]);
    expect(calls.at(-1)).toEqual("close:surface:5");
  });

  test("does not ask cmux to close a surface after the browser websocket closes", async () => {
    const calls: string[] = [];
    const server = new LocalWidgetServer("runtime");
    const opener = createCmuxWidgetOpener({ server, transport: fakeTransport(calls), tokenFactory: () => "fixed" });

    try {
      const surface = await opener({ title: "demo", width: 800, height: 600 });
      const closed = Promise.withResolvers<void>();
      surface.once("closed", () => closed.resolve());
      const ws = new WebSocket(new URL("/ws/fixed", server.baseUrl));
      await new Promise<void>(resolve => ws.addEventListener("open", () => resolve(), { once: true }));

      ws.close();
      await closed.promise;

      expect(calls).toHaveLength(1);
      expect(calls[0]).toStartWith("open:");
      expect(calls[0]).toEndWith("/widget/fixed");
    } finally {
      server.close();
    }
  });
});
