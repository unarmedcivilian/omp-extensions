import { describe, expect, test } from "bun:test";
import { PreviewController, type PreviewSurface } from "../src/controller.js";
import { createPreviewState, applyLifecycle, snapshotPreview, type PreviewSnapshot } from "../src/model.js";

interface TestSurface extends PreviewSurface {
  closed: boolean;
  sent: PreviewSnapshot[];
}

function makeSnapshot(id = "A") {
  const state = createPreviewState();
  applyLifecycle(state, { id, agent: "task", agentSource: "bundled", status: "started", index: 0 });
  return snapshotPreview(state);
}

function makeOpener(log: string[]) {
  return async (): Promise<TestSurface> => {
    const surface: TestSurface = {
      surfaceRef: `surface:${log.length + 1}`,
      closed: false,
      sent: [],
      send(snapshot) { this.sent.push(snapshot); },
      close() { this.closed = true; log.push(`close:${this.surfaceRef}`); },
      onBrowserClose: undefined,
      onBrowserReconnect: undefined,
      onBrowserClosed: undefined,
    };
    log.push(`open:${surface.surfaceRef}`);
    return surface;
  };
}

describe("PreviewController", () => {
  test("auto-opens on first spawn and sends snapshots", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));

    expect(log).toEqual(["open:surface:1"]);
    expect((controller.currentSurface as TestSurface | undefined)?.sent).toHaveLength(1);
  });

  test("browser close detaches but later spawn reopens with existing state", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));
    controller.handleBrowserClose();
    await controller.handleSnapshot(makeSnapshot("B"));

    expect(log).toEqual(["open:surface:1", "open:surface:2"]);
    expect((controller.currentSurface as TestSurface | undefined)?.sent.at(-1)).toMatchObject({ subagents: [{ id: "B" }] });
  });


  test("browser reconnect reuses the grace-held surface", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));
    const surface = controller.currentSurface as TestSurface;
    surface.onBrowserClose?.();
    expect(controller.currentSurface).toBeUndefined();

    surface.onBrowserReconnect?.();
    await controller.handleSnapshot(makeSnapshot("B"));

    expect(log).toEqual(["open:surface:1"]);
    expect((controller.currentSurface as TestSurface | undefined)?.surfaceRef).toBe("surface:1");
    expect(surface.sent.at(-1)).toMatchObject({ subagents: [{ id: "B" }] });
  });

  test("dispose closes a grace-held detached surface", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));
    const surface = controller.currentSurface as TestSurface;
    surface.onBrowserClose?.();
    await controller.dispose();

    expect(log).toEqual(["open:surface:1", "close:surface:1"]);
  });
  test("close command disables future auto-open", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));
    await controller.runCommand("close");
    await controller.handleSnapshot(makeSnapshot("B"));

    expect(log).toEqual(["open:surface:1", "close:surface:1"]);
  });

  test("disable and enable control auto-open without closing existing surface", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.runCommand("disable");
    await controller.handleSnapshot(makeSnapshot("A"));
    await controller.runCommand("enable");
    await controller.handleSnapshot(makeSnapshot("B"));

    expect(log).toEqual(["open:surface:1"]);
  });

  test("no-args command opens without changing disabled state", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.runCommand("disable");
    await controller.runCommand("");
    await controller.handleSnapshot(makeSnapshot("A"));

    expect(log).toEqual(["open:surface:1"]);
  });

  test("dispose closes a surface that resolves after disposal", async () => {
    const log: string[] = [];
    const deferred = Promise.withResolvers<TestSurface>();
    const controller = new PreviewController({ openSurface: async () => deferred.promise, notify: () => {} });
    const opening = controller.handleSnapshot(makeSnapshot("A"));

    const disposal = controller.dispose();
    deferred.resolve({
      surfaceRef: "surface:late",
      closed: false,
      sent: [],
      send(snapshot) { this.sent.push(snapshot); },
      close() { this.closed = true; log.push(`close:${this.surfaceRef}`); },
    });
    await Promise.all([opening, disposal]);

    expect(log).toEqual(["close:surface:late"]);
    expect(controller.currentSurface).toBeUndefined();
  });
});
