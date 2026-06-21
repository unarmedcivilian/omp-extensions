import { describe, expect, test } from "bun:test";
import { PreviewBrowserSurface, createPreviewSurfaceOpener, type PreviewServerLike } from "../src/surface.js";
import type { CmuxTransport } from "../src/cmux.js";

class FakeServer implements PreviewServerLike {
  registered: PreviewBrowserSurface[] = [];
  unregistered: string[] = [];
  register(surface: PreviewBrowserSurface): URL { this.registered.push(surface); return new URL(`http://127.0.0.1:1234/subagent-preview/${surface.token}`); }
  unregister(token: string): void { this.unregistered.push(token); }
}

function transport(calls: string[]): CmuxTransport {
  return { async openBrowserSurface(url) { calls.push(`open:${url}`); return "surface:5"; }, async closeSurface(surface) { calls.push(`close:${surface}`); } };
}

describe("PreviewBrowserSurface", () => {
  test("host close unregisters and closes cmux surface", async () => {
    const calls: string[] = [];
    const server = new FakeServer();
    const opener = createPreviewSurfaceOpener({ server, transport: transport(calls), tokenFactory: () => "fixed" });
    const surface = await opener();

    surface.close();
    await Promise.resolve();

    expect(server.unregistered).toEqual(["fixed"]);
    expect(calls).toEqual(["open:http://127.0.0.1:1234/subagent-preview/fixed", "close:surface:5"]);
  });

  test("browser close unregisters without closing cmux surface", async () => {
    const calls: string[] = [];
    const server = new FakeServer();
    const opener = createPreviewSurfaceOpener({ server, transport: transport(calls), tokenFactory: () => "fixed" });
    const surface = await opener();

    surface.browserClosed();
    await Promise.resolve();

    expect(server.unregistered).toEqual(["fixed"]);
    expect(calls).toEqual(["open:http://127.0.0.1:1234/subagent-preview/fixed"]);
  });
});
