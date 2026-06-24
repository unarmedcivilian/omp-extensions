import { describe, expect, test } from "bun:test";
import { createChatGPT, type BrowserUserTabInfo } from "codex-chatgpt-control";
import { createCmuxBrowserAdapter, type SelectedChatGptSurface } from "../src/cmux-browser.js";
import type { CmuxTransport } from "../src/cmux.js";

interface FakeSurfaceState {
  url: string;
  title?: string;
  text?: string;
  html?: string;
}

class FakeCmuxTransport implements CmuxTransport {
  readonly surfaces = new Map<string, FakeSurfaceState>();
  readonly openedUrls: string[] = [];
  readonly loadWaits: Array<{ surface: string; timeoutMs: number }> = [];
  readonly closedSurfaces: string[] = [];
  resolveCurrentCalls = 0;
  nextSurfaceNumber = 1;
  currentSurface: string | undefined;

  constructor(surfaces: Record<string, FakeSurfaceState> = {}, currentSurface?: string) {
    for (const [surface, state] of Object.entries(surfaces)) this.surfaces.set(surface, { ...state });
    this.currentSurface = currentSurface;
  }

  async open(url: string): Promise<string> {
    const surface = `surface:${this.nextSurfaceNumber++}`;
    this.openedUrls.push(url);
    this.surfaces.set(surface, {
      url,
      title: "ChatGPT",
      text: "New chat\nChat with ChatGPT",
      html: "<main>New chat</main>",
    });
    return surface;
  }

  async goto(surface: string, url: string): Promise<void> {
    this.state(surface).url = url;
  }

  async waitForLoad(surface: string, timeoutMs: number): Promise<void> {
    this.loadWaits.push({ surface, timeoutMs });
    this.state(surface).url = "https://chatgpt.com/c/loaded";
  }

  async getUrl(surface: string): Promise<string> {
    return this.state(surface).url;
  }

  async getTitle(surface: string): Promise<string> {
    return this.state(surface).title ?? "";
  }

  async getText(surface: string): Promise<string> {
    return this.state(surface).text ?? "";
  }

  async getHtml(surface: string): Promise<string> {
    return this.state(surface).html ?? "";
  }

  async eval(surface: string): Promise<string> {
    return this.state(surface).text ?? "";
  }

  async press(): Promise<void> {}

  async close(surface: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
    this.closedSurfaces.push(surface);
  }

  async resolveCurrentSurface(): Promise<string | undefined> {
    this.resolveCurrentCalls += 1;
    return this.currentSurface;
  }

  private state(surface: string): FakeSurfaceState {
    const state = this.surfaces.get(surface);
    if (state === undefined) throw new Error(`unknown surface ${surface}`);
    return state;
  }
}

describe("cmux browser adapter", () => {
  test("tabs.create opens ChatGPT, returns a transport-backed page, and sets the primary surface", async () => {
    const transport = new FakeCmuxTransport();
    const browser = createCmuxBrowserAdapter({ transport });

    const page = await browser.tabs?.create?.("https://chatgpt.com/");
    if (page === undefined) throw new Error("expected tabs.create to return a page");
    transport.surfaces.get("surface:1")!.url = "https://chatgpt.com/c/created";

    expect(transport.openedUrls).toEqual(["https://chatgpt.com/"]);
    await expect(page.url?.()).resolves.toBe("https://chatgpt.com/c/created");
    expect(browser.primarySurfaceRef()).toBe("surface:1");
    const selected = await browser.tabs?.selected?.() as { tabId?: string } | undefined;
    expect(selected?.tabId).toBe("surface:1");
  });

  test("tabs.create waits for a newly opened ChatGPT page before exposing it to the SDK", async () => {
    const transport = new FakeCmuxTransport();
    const browser = createCmuxBrowserAdapter({ transport, openLoadTimeoutMs: 12_000 });

    const page = await browser.tabs?.create?.("https://chatgpt.com/");
    if (page === undefined) throw new Error("expected tabs.create to return a page");

    expect(transport.loadWaits).toEqual([{ surface: "surface:1", timeoutMs: 12_000 }]);
    await expect(page.url?.()).resolves.toBe("https://chatgpt.com/c/loaded");
  });

  test("opened ChatGPT surfaces are rediscoverable as user tabs", async () => {
    const transport = new FakeCmuxTransport();
    const browser = createCmuxBrowserAdapter({ transport });

    await browser.tabs?.create?.("https://chatgpt.com/");

    await expect(browser.user?.openTabs?.()).resolves.toEqual([{
      id: "surface:1",
      url: "https://chatgpt.com/",
      title: "ChatGPT",
    }]);
    const listed = await browser.tabs?.list?.();
    expect((listed?.[0] as { tabId?: string } | undefined)?.tabId).toBe("surface:1");
  });

  test("requireSelectedChatGptSurface rejects when no selected or current ChatGPT surface exists", async () => {
    const transport = new FakeCmuxTransport();
    const browser = createCmuxBrowserAdapter({ transport });

    await expect(browser.requireSelectedChatGptSurface()).rejects.toThrow("No selected or current ChatGPT cmux surface");
  });

  test("requireSelectedChatGptSurface resolves from transport current-surface discovery", async () => {
    const transport = new FakeCmuxTransport({
      "surface:7": { url: "https://chatgpt.com/c/current", title: "Current" },
    }, "surface:7");
    const browser = createCmuxBrowserAdapter({ transport });

    await expect(browser.requireSelectedChatGptSurface()).resolves.toEqual({
      tabId: "surface:7",
      surface: "surface:7",
      url: "https://chatgpt.com/c/current",
      title: "Current",
    });
    expect(browser.primarySurfaceRef()).toBe("surface:7");
    const selected = await browser.tabs?.selected?.() as { tabId?: string } | undefined;
    expect(selected?.tabId).toBe("surface:7");
  });

  test("selectedSurface path pins the exact selected surface id", async () => {
    const selectedSurface: SelectedChatGptSurface = {
      tabId: "surface:5",
      surface: "surface:5",
      url: "https://chatgpt.com/c/selected",
      title: "Selected",
    };
    const transport = new FakeCmuxTransport({
      "surface:5": { url: "https://chatgpt.com/c/selected", title: "Selected" },
      "surface:99": { url: "https://chatgpt.com/c/current", title: "Current" },
    }, "surface:99");
    const browser = createCmuxBrowserAdapter({ transport, selectedSurface });

    await expect(browser.requireSelectedChatGptSurface()).resolves.toEqual(selectedSurface);
    const page = await browser.tabs?.selected?.() as { tabId?: string } | undefined;

    expect(page?.tabId).toBe("surface:5");
    expect(transport.resolveCurrentCalls).toBe(0);
  });

  test("SDK bootstrap with preferExistingTab false works without globalThis.agent and creates a cmux surface", async () => {
    const transport = new FakeCmuxTransport();
    const browser = createCmuxBrowserAdapter({ transport });

    const result = await createChatGPT({ browser }).session.bootstrap({ preferExistingTab: false });

    expect(result.ok).toBe(true);
    expect(transport.openedUrls).toEqual(["https://chatgpt.com/"]);
    expect(result.data).toMatchObject({ tabId: "surface:1", url: "https://chatgpt.com/", loggedIn: true });
  });

  test("SDK bootstrap with exact tabId target claims the selected surface when multiple ChatGPT tabs exist", async () => {
    const transport = new FakeCmuxTransport({
      "surface:1": { url: "https://chatgpt.com/c/other", title: "Other", text: "New chat" },
      "surface:2": { url: "https://chatgpt.com/c/selected", title: "Selected", text: "New chat" },
    });
    const browser = createCmuxBrowserAdapter({
      transport,
      selectedSurface: { tabId: "surface:2", surface: "surface:2", url: "https://chatgpt.com/c/selected", title: "Selected" },
      knownSurfaces: [
        { tabId: "surface:1", surface: "surface:1", url: "https://chatgpt.com/c/other", title: "Other" },
      ],
    });

    const result = await createChatGPT({ browser }).session.bootstrap({
      existingTab: {
        target: { type: "tabId", tabId: "surface:2" },
        ifMissing: "block",
        ifMultiple: "block",
        requireChatGPT: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(transport.openedUrls).toEqual([]);
    expect(result.data).toMatchObject({ tabId: "surface:2", url: "https://chatgpt.com/c/selected" });
    expect(browser.primarySurfaceRef()).toBe("surface:2");
  });

  test("closeOwnedSurfaces closes only owned surfaces, not claimed current surfaces", async () => {
    const transport = new FakeCmuxTransport({
      "surface:50": { url: "https://chatgpt.com/c/current", title: "Current" },
    }, "surface:50");
    const browser = createCmuxBrowserAdapter({ transport });

    await browser.requireSelectedChatGptSurface();
    const claimedPage = await browser.user?.claimTab?.({ id: "surface:50", url: "https://chatgpt.com/c/current" } satisfies BrowserUserTabInfo);
    await claimedPage?.close?.();
    expect(transport.closedSurfaces).toEqual([]);

    const ownedPage = await browser.tabs?.create?.("https://chatgpt.com/");
    await ownedPage?.close?.();
    expect(transport.closedSurfaces).toEqual(["surface:1"]);

    await browser.tabs?.create?.("https://chatgpt.com/");
    await browser.closeOwnedSurfaces();

    expect(transport.closedSurfaces).toEqual(["surface:1", "surface:2"]);
    expect(browser.primarySurfaceRef()).toBe("surface:50");
  });

  test("closeOwnedSurfaces ignores an already aborted consult signal during cleanup", async () => {
    const controller = new AbortController();
    const transport = new FakeCmuxTransport();
    const browser = createCmuxBrowserAdapter({ transport, signal: controller.signal });

    await browser.tabs?.create?.("https://chatgpt.com/");
    controller.abort();
    await browser.closeOwnedSurfaces();

    expect(transport.closedSurfaces).toEqual(["surface:1"]);
  });
});
