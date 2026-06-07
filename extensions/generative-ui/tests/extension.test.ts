import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import generativeUiExtension, { createGenerativeUiExtension } from "../src/index.js";
import type { HostToPage } from "../src/protocol.js";
import type { WidgetSurfaceLike } from "../src/session.js";

interface Chain {
  describe(): Chain;
  optional(): Chain;
}

interface ZLike {
  object(shape: Record<string, unknown>): Chain;
  array(value: unknown): Chain;
  enum(values: readonly string[]): Chain;
  string(): Chain;
  boolean(): Chain;
  number(): Chain;
}

interface TestTool {
  name: string;
  description: string;
  execute?: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

interface FakePi {
  tools: TestTool[];
  handlers: Map<string, (event: unknown) => Promise<unknown> | unknown>;
  labels: string[];
  sentMessages: Array<{ text: string; deliverAs?: string }>;
  api: ExtensionAPI;
}

class FakeSurface extends EventEmitter implements WidgetSurfaceLike {
  surfaceRef = "surface:99";
  sent: HostToPage[] = [];
  closed = false;

  send(msg: HostToPage): void {
    this.sent.push(msg);
  }

  close(): void {
    this.closed = true;
    this.emit("closed");
  }
}

function makeZ(): ZLike {
  const chain: Chain = {
    describe() { return this; },
    optional() { return this; },
  };
  return {
    object() { return chain; },
    array() { return chain; },
    enum() { return chain; },
    string() { return chain; },
    boolean() { return chain; },
    number() { return chain; },
  };
}

function makeFakePi(): FakePi {
  const tools: TestTool[] = [];
  const handlers = new Map<string, (event: unknown) => Promise<unknown> | unknown>();
  const labels: string[] = [];
  const sentMessages: Array<{ text: string; deliverAs?: string }> = [];
  const api = {
    zod: { z: makeZ() },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    setLabel(label: string) { labels.push(label); },
    registerTool(tool: TestTool) { tools.push(tool); },
    on(event: string, handler: (event: unknown) => Promise<unknown> | unknown) { handlers.set(event, handler); },
    sendUserMessage(text: string, options?: { deliverAs?: string }) { sentMessages.push({ text, deliverAs: options?.deliverAs }); },
  } as unknown as ExtensionAPI;
  return { tools, handlers, labels, sentMessages, api };
}

function contentMessages(surface: FakeSurface): HostToPage[] {
  return surface.sent.filter(msg => msg.type === "content");
}

describe("generativeUiExtension", () => {
  test("registers widget-prefixed tools plus hidden prompt guidance", async () => {
    const pi = makeFakePi();

    generativeUiExtension(pi.api);

    expect(pi.labels).toEqual(["Generative UI"]);
    expect(pi.tools.map(tool => tool.name)).toEqual(["widget_read_guidelines", "widget_show", "widget_save_html", "widget_save_screenshot"]);
    expect(pi.tools.find(tool => tool.name === "widget_show")?.description).toContain("sendPrompt(text)");

    const beforeAgentStart = pi.handlers.get("before_agent_start");
    expect(beforeAgentStart).toBeFunction();
    const result = await beforeAgentStart?.({});
    expect(result).toMatchObject({ message: { display: false } });
  });

  test("does not register duplicate tools when installed twice on the same API", () => {
    const pi = makeFakePi();
    const extension = createGenerativeUiExtension({ openSurface: async () => new FakeSurface(), closeServer() {} });

    extension(pi.api);
    extension(pi.api);

    expect(pi.labels).toEqual(["Generative UI"]);
    expect(pi.tools.map(tool => tool.name)).toEqual(["widget_read_guidelines", "widget_show", "widget_save_html", "widget_save_screenshot"]);
  });

  test("uses final widget_show title for prompts from a streamed widget session", async () => {
    const pi = makeFakePi();
    const surface = new FakeSurface();
    const extension = createGenerativeUiExtension({ openSurface: async () => surface, closeServer() {} });
    extension(pi.api);

    await pi.handlers.get("message_update")?.({
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: { content: [{ type: "toolCall", name: "widget_show", arguments: {} }] },
      },
    });

    const showWidget = pi.tools.find(tool => tool.name === "widget_show");
    setTimeout(() => surface.emit("ready"), 0);
    await showWidget?.execute?.("call-1", {
      i_have_seen_read_me: true,
      title: "extension_smoke_test",
      widget_code: "<button>ok</button>",
    });
    surface.emit("message", { type: "rpc-call", id: "r1", method: "agent.prompt", params: { text: "Confirm the prompt path." } });

    expect(pi.sentMessages).toEqual([{ text: 'From widget "extension smoke test":\nConfirm the prompt path.', deliverAs: "followUp" }]);
  });

  test("updates an existing live widget when widget_show is called again with the same title", async () => {
    const pi = makeFakePi();
    const surfaces: FakeSurface[] = [];
    const extension = createGenerativeUiExtension({
      openSurface: async () => {
        const surface = new FakeSurface();
        surfaces.push(surface);
        setTimeout(() => surface.emit("ready"), 0);
        return surface;
      },
      closeServer() {},
    });
    extension(pi.api);

    const showWidget = pi.tools.find(tool => tool.name === "widget_show");
    await showWidget?.execute?.("call-1", { i_have_seen_read_me: true, title: "design_iteration", widget_code: "<p>First pass</p>" });
    await showWidget?.execute?.("call-2", { i_have_seen_read_me: true, title: "design_iteration", widget_code: "<p>Second pass</p>" });

    expect(surfaces).toHaveLength(1);
    expect(contentMessages(surfaces[0])).toEqual([
      { type: "content", html: "<p>First pass</p>", final: true },
      { type: "content", html: "<p>Second pass</p>", final: true },
    ]);
  });

  test("opens a fresh widget when new_surface is true even if the title matches", async () => {
    const pi = makeFakePi();
    const surfaces: FakeSurface[] = [];
    const extension = createGenerativeUiExtension({
      openSurface: async () => {
        const surface = new FakeSurface();
        surfaces.push(surface);
        setTimeout(() => surface.emit("ready"), 0);
        return surface;
      },
      closeServer() {},
    });
    extension(pi.api);

    const showWidget = pi.tools.find(tool => tool.name === "widget_show");
    await showWidget?.execute?.("call-1", { i_have_seen_read_me: true, title: "design_iteration", widget_code: "<p>First surface</p>" });
    await showWidget?.execute?.("call-2", { i_have_seen_read_me: true, title: "design_iteration", widget_code: "<p>Second surface</p>", new_surface: true });

    expect(surfaces).toHaveLength(2);
  });

  test("does not open a placeholder surface on streamed starts before final title is known", async () => {
    const pi = makeFakePi();
    const surfaces: FakeSurface[] = [];
    const extension = createGenerativeUiExtension({
      openSurface: async () => {
        const surface = new FakeSurface();
        surfaces.push(surface);
        setTimeout(() => surface.emit("ready"), 0);
        return surface;
      },
      closeServer() {},
    });
    extension(pi.api);

    const showWidget = pi.tools.find(tool => tool.name === "widget_show");
    await pi.handlers.get("message_update")?.({ assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", name: "widget_show", arguments: {} }] } } });
    await showWidget?.execute?.("call-1", { i_have_seen_read_me: true, title: "design_iteration", widget_code: "<p>First streamed pass</p>" });
    await pi.handlers.get("message_update")?.({ assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", name: "widget_show", arguments: {} }] } } });
    await showWidget?.execute?.("call-2", { i_have_seen_read_me: true, title: "design_iteration", widget_code: "<p>Second streamed pass</p>" });

    expect(surfaces).toHaveLength(1);
    expect(contentMessages(surfaces[0])).toEqual([
      { type: "content", html: "<p>First streamed pass</p>", final: true },
      { type: "content", html: "<p>Second streamed pass</p>", final: true },
    ]);
  });

  test("saves the latest widget HTML to the default artifact path", async () => {
    const pi = makeFakePi();
    const artifactsDir = await mkdtemp(join(tmpdir(), "omp-widget-html-"));
    const extension = createGenerativeUiExtension({
      artifactsDir,
      openSurface: async () => {
        const surface = new FakeSurface();
        setTimeout(() => surface.emit("ready"), 0);
        return surface;
      },
      closeServer() {},
    });
    extension(pi.api);

    try {
      await pi.tools.find(tool => tool.name === "widget_show")?.execute?.("show", {
        i_have_seen_read_me: true,
        title: "design_iteration",
        widget_code: "<section>Saved HTML</section>",
      });
      const result = await pi.tools.find(tool => tool.name === "widget_save_html")?.execute?.("save-html", {
        title: "design_iteration",
      }) as { content: Array<{ text: string }>; details: { title: string; path: string; bytes: number } };

      const expectedPath = join(artifactsDir, "design-iteration.html");
      expect(await readFile(expectedPath, "utf8")).toBe("<section>Saved HTML</section>");
      expect(result.details).toEqual({ title: "design iteration", path: expectedPath, bytes: 29 });
      expect(result.content[0]?.text).toContain(expectedPath);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  test("saves a widget screenshot using its cmux surface", async () => {
    const pi = makeFakePi();
    const artifactsDir = await mkdtemp(join(tmpdir(), "omp-widget-shot-"));
    const screenshots: Array<{ surface: string; outputPath: string }> = [];
    const extension = createGenerativeUiExtension({
      artifactsDir,
      screenshotSurface: async (surface, outputPath) => {
        screenshots.push({ surface, outputPath });
        await writeFile(outputPath, "png");
      },
      openSurface: async () => {
        const surface = new FakeSurface();
        setTimeout(() => surface.emit("ready"), 0);
        return surface;
      },
      closeServer() {},
    });
    extension(pi.api);

    try {
      await pi.tools.find(tool => tool.name === "widget_show")?.execute?.("show", {
        i_have_seen_read_me: true,
        title: "design_iteration",
        widget_code: "<section>Screenshot me</section>",
      });
      const result = await pi.tools.find(tool => tool.name === "widget_save_screenshot")?.execute?.("save-shot", {
        title: "design_iteration",
      }) as { details: { title: string; path: string; surface: string } };

      const expectedPath = join(artifactsDir, "design-iteration.png");
      expect(screenshots).toEqual([{ surface: "surface:99", outputPath: expectedPath }]);
      expect(await readFile(expectedPath, "utf8")).toBe("png");
      expect(result.details).toEqual({ title: "design iteration", path: expectedPath, surface: "surface:99" });
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  test("treats blank save output paths as omitted", async () => {
    const pi = makeFakePi();
    const artifactsDir = await mkdtemp(join(tmpdir(), "omp-widget-blank-path-"));
    const screenshots: Array<{ surface: string; outputPath: string }> = [];
    const extension = createGenerativeUiExtension({
      artifactsDir,
      screenshotSurface: async (surface, outputPath) => {
        screenshots.push({ surface, outputPath });
        await writeFile(outputPath, "png");
      },
      openSurface: async () => {
        const surface = new FakeSurface();
        setTimeout(() => surface.emit("ready"), 0);
        return surface;
      },
      closeServer() {},
    });
    extension(pi.api);

    try {
      await pi.tools.find(tool => tool.name === "widget_show")?.execute?.("show", {
        i_have_seen_read_me: true,
        title: "design_iteration",
        widget_code: "<section>Blank path</section>",
      });

      await pi.tools.find(tool => tool.name === "widget_save_html")?.execute?.("save-html", {
        title: "design_iteration",
        output_path: "",
      });
      await pi.tools.find(tool => tool.name === "widget_save_screenshot")?.execute?.("save-shot", {
        title: "design_iteration",
        output_path: "",
      });

      expect(await readFile(join(artifactsDir, "design-iteration.html"), "utf8")).toBe("<section>Blank path</section>");
      expect(screenshots).toEqual([{ surface: "surface:99", outputPath: join(artifactsDir, "design-iteration.png") }]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  test("rejects saving HTML for an unknown widget title", async () => {
    const pi = makeFakePi();
    const extension = createGenerativeUiExtension({ openSurface: async () => new FakeSurface(), closeServer() {} });
    extension(pi.api);

    await expect(pi.tools.find(tool => tool.name === "widget_save_html")?.execute?.("save-html", {
      title: "missing_widget",
    })).rejects.toThrow('No active widget named "missing widget"');
  });
});
