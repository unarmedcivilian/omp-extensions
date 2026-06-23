import type { BrowserLike, BrowserUserTabInfo, PageLike } from "codex-chatgpt-control";
import { createCmuxTransport, type CmuxTransport } from "./cmux.js";
import { createCmuxPage } from "./cmux-page.js";
import type { ConsultDeadline, ConsultLifecycle } from "./consult.js";

export interface SelectedChatGptSurface {
  tabId: string;
  surface: string;
  url?: string;
  title?: string;
}

export type CmuxBrowserAdapter = BrowserLike & {
  requireSelectedChatGptSurface(signal?: AbortSignal): Promise<SelectedChatGptSurface>;
  primarySurfaceRef(): string | undefined;
  closeOwnedSurfaces(signal?: AbortSignal): Promise<void>;
};

export interface CreateCmuxBrowserAdapterOptions {
  transport?: CmuxTransport;
  selectedSurface?: SelectedChatGptSurface;
  knownSurfaces?: readonly SelectedChatGptSurface[];
  signal?: AbortSignal;
  deadline?: ConsultDeadline;
  lifecycle?: ConsultLifecycle;
}

const CHATGPT_HOSTS: Record<string, true> = {
  "chatgpt.com": true,
  "www.chatgpt.com": true,
  "chat.openai.com": true,
};

const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";

export function createCmuxBrowserAdapter(options: CreateCmuxBrowserAdapterOptions = {}): CmuxBrowserAdapter {
  const transport = options.transport ?? createCmuxTransport();
  const ownedSurfaces = new Set<string>();
  let primarySurface: string | undefined;
  const surfacesByTabId = new Map<string, SelectedChatGptSurface>();
  for (const surface of options.knownSurfaces ?? []) surfacesByTabId.set(surface.tabId, surface);
  if (options.selectedSurface !== undefined) surfacesByTabId.set(options.selectedSurface.tabId, options.selectedSurface);

  async function raceTransport<T>(operation: string, promise: Promise<T>): Promise<T> {
    return options.deadline ? options.deadline.race(operation, promise) : promise;
  }

  function trackPrimary(surface: string): void {
    primarySurface ??= surface;
  }

  function pageFor(surface: SelectedChatGptSurface, ownsSurface = false): PageLike {
    return createCmuxPage({
      surface: surface.surface,
      tabId: surface.tabId,
      transport,
      signal: options.signal,
      deadline: options.deadline,
      lifecycle: options.lifecycle,
      owned: ownsSurface,
      onClose: () => ownedSurfaces.delete(surface.surface),
    });
  }

  async function openOwnedPage(url: string): Promise<PageLike> {
    const surface = await raceTransport("cmux.browser.open", transport.open(url, options.signal));
    ownedSurfaces.add(surface);
    trackPrimary(surface);
    return pageFor({ tabId: surface, surface }, true);
  }

  async function selectedSurfaceWithUrl(surface: SelectedChatGptSurface, signal?: AbortSignal): Promise<SelectedChatGptSurface> {
    const url = surface.url ?? await raceTransport("cmux.browser.get_url", transport.getUrl(surface.surface, signal ?? options.signal));
    const title = surface.title ?? await raceTransport("cmux.browser.get_title", transport.getTitle(surface.surface, signal ?? options.signal)).catch(() => undefined);
    const hydrated = { tabId: surface.tabId, surface: surface.surface, url, title };
    surfacesByTabId.set(hydrated.tabId, hydrated);
    return hydrated;
  }

  async function currentSurface(signal?: AbortSignal): Promise<SelectedChatGptSurface | undefined> {
    const surface = await raceTransport("cmux.browser.current_surface", transport.resolveCurrentSurface(signal ?? options.signal));
    if (surface === undefined) return undefined;
    return selectedSurfaceWithUrl({ tabId: surface, surface }, signal);
  }

  async function collectOpenChatGptTabs(): Promise<BrowserUserTabInfo[]> {
    const byId = new Map(surfacesByTabId);
    const current = await currentSurface().catch(() => undefined);
    if (current !== undefined) byId.set(current.tabId, current);

    const tabs: BrowserUserTabInfo[] = [];
    for (const surface of byId.values()) {
      const hydrated = await selectedSurfaceWithUrl(surface).catch(() => undefined);
      if (hydrated?.url !== undefined && isChatGptUrl(hydrated.url)) {
        tabs.push({ id: hydrated.tabId, url: hydrated.url, title: hydrated.title });
      }
    }
    return tabs;
  }

  const browser: CmuxBrowserAdapter = {
    name: "cmux",
    tabs: {
      create: async (url: string) => openOwnedPage(url),
      new: async (url = DEFAULT_CHATGPT_URL) => openOwnedPage(url),
      selected: async () => {
        if (options.selectedSurface === undefined) return undefined;
        return pageFor(await selectedSurfaceWithUrl(options.selectedSurface));
      },
      get: async (id: string) => pageFor(surfacesByTabId.get(id) ?? { tabId: id, surface: id }),
      list: async () => {
        const tabs = await collectOpenChatGptTabs();
        return tabs.map(tab => pageFor(surfacesByTabId.get(tab.id) ?? { tabId: tab.id, surface: tab.id, url: tab.url, title: tab.title }));
      },
      finalize: async () => {},
    },
    newPage: async () => openOwnedPage(DEFAULT_CHATGPT_URL),
    user: {
      openTabs: collectOpenChatGptTabs,
      claimTab: async (tab: string | BrowserUserTabInfo) => {
        const tabId = typeof tab === "string" ? tab : tab.id;
        const surface = surfacesByTabId.get(tabId) ?? { tabId, surface: tabId };
        trackPrimary(surface.surface);
        return pageFor(surface);
      },
    },
    async requireSelectedChatGptSurface(signal?: AbortSignal) {
      const surface = options.selectedSurface !== undefined
        ? await selectedSurfaceWithUrl(options.selectedSurface, signal)
        : await currentSurface(signal);
      if (surface === undefined) {
        throw new Error("No selected or current ChatGPT cmux surface is available.");
      }
      if (!isChatGptUrl(surface.url)) {
        throw new Error(`Selected cmux surface ${surface.surface} is not a ChatGPT tab (${surface.url ?? "unknown URL"}).`);
      }
      trackPrimary(surface.surface);
      return surface;
    },
    primarySurfaceRef() {
      return primarySurface;
    },
    async closeOwnedSurfaces(signal?: AbortSignal) {
      const surfaces = [...ownedSurfaces];
      ownedSurfaces.clear();
      for (const surface of surfaces) {
        await raceTransport("cmux.browser.close", transport.close(surface, signal ?? options.signal)).catch(() => undefined);
      }
    },
  };

  return browser;
}

function isChatGptUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return CHATGPT_HOSTS[new URL(url).hostname] === true;
  } catch {
    return false;
  }
}
