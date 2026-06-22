import type { PreviewSnapshot } from "../model.js";
import { renderDashboard, type DashboardFilter } from "./dashboard.js";

const ACTIVE_STATUSES = new Set(["pending", "running"]);

export interface RuntimeSocketLike {
  readyState: number;
  send(data: string): void;
  addEventListener(type: string, fn: (event: unknown) => void): void;
}

export interface RuntimeElement {
  scrollTop?: number;
  scrollHeight?: number;
  getAttribute?: (name: string) => string | null;
  focus?: (options?: unknown) => void;
  scrollIntoView?: () => void;
  setAttribute?: (name: string, value: string) => void;
  classList?: { toggle?: (name: string, force?: boolean) => void };
  querySelector?: (selector: string) => RuntimeElement | null;
  textContent?: string | null;
}

export interface RuntimeRootLike {
  innerHTML: string;
  ownerDocument?: { activeElement?: RuntimeElement | null };
  addEventListener?: (type: string, fn: (event: unknown) => void, options?: unknown) => void;
  querySelector?: (selector: string) => RuntimeElement | null;
  querySelectorAll?: (selector: string) => ArrayLike<RuntimeElement> | Iterable<RuntimeElement>;
}

export interface RuntimeInstallOptions {
  socket?: RuntimeSocketLike;
  root?: RuntimeRootLike;
  location?: URL;
  clipboard?: { writeText(text: string): Promise<void> };
}

export function computeWebSocketUrl(url: URL): string {
  const token = url.pathname.split("/").filter(Boolean).at(-1);
  if (!token) throw new Error("subagent preview URL does not include a session token");
  const ws = new URL(url);
  ws.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  ws.pathname = `/ws/${token}`;
  ws.search = "";
  ws.hash = "";
  return ws.toString();
}

export function installRuntime(options: RuntimeInstallOptions = {}): void {
  const root = options.root ?? document.getElementById("root") ?? document.body;
  const socket = options.socket ?? new WebSocket(computeWebSocketUrl(options.location ?? new URL(globalThis.location.href)));
  let latest: PreviewSnapshot | undefined;
  let filter: DashboardFilter = "all";
  const expanded = new Set<string>();
  const userCollapsed = new Set<string>();
  let followActive = false;
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;

  const activeSelector = '.agent[data-status="pending"],.agent[data-status="running"]';
  const scrollSelector = "[data-scroll-key]";
  const focusSelector = "[data-focus-key]";


  function collectScrollPositions(): Map<string, { scrollTop: number; scrollHeight?: number }> {
    const elements = root.querySelectorAll?.(scrollSelector);
    const positions = new Map<string, { scrollTop: number; scrollHeight?: number }>();
    if (!elements) return positions;
    for (const element of Array.from(elements)) {
      const key = element.getAttribute?.("data-scroll-key");
      if (key && typeof element.scrollTop === "number") positions.set(key, {
        scrollTop: element.scrollTop,
        scrollHeight: typeof element.scrollHeight === "number" ? element.scrollHeight : undefined,
      });
    }
    return positions;
  }

  function restoreScrollPositions(positions: Map<string, { scrollTop: number; scrollHeight?: number }>): void {
    if (positions.size === 0) return;
    const elements = root.querySelectorAll?.(scrollSelector);
    if (!elements) return;
    for (const element of Array.from(elements)) {
      const key = element.getAttribute?.("data-scroll-key");
      const position = key ? positions.get(key) : undefined;
      if (!position) continue;
      const heightDelta = position.scrollTop > 0 && typeof element.scrollHeight === "number" && position.scrollHeight !== undefined
        ? element.scrollHeight - position.scrollHeight
        : 0;
      element.scrollTop = Math.max(0, position.scrollTop + heightDelta);
    }
  }

  function collectFocusKey(): string | undefined {
    const activeElement = root.ownerDocument?.activeElement ?? globalThis.document?.activeElement as RuntimeElement | undefined;
    const key = activeElement?.getAttribute?.("data-focus-key");
    return key || undefined;
  }

  function restoreFocus(focusKey: string | undefined): void {
    if (!focusKey) return;
    const elements = root.querySelectorAll?.(focusSelector);
    if (!elements) return;
    for (const element of Array.from(elements)) {
      if (element.getAttribute?.("data-focus-key") !== focusKey || !element.focus) continue;
      try {
        element.focus({ preventScroll: true });
      } catch {
        element.focus();
      }
      return;
    }
  }


  function eventTargetsTranscript(event: unknown): boolean {
    const target = (event as { target?: { closest?: (selector: string) => unknown; getAttribute?: (name: string) => string | null } }).target;
    return !!target && (!!target.getAttribute?.("data-scroll-key") || !!target.closest?.(scrollSelector));
  }

  function syncFollowActiveControl(): void {
    const control = root.querySelector?.('[data-action="follow-active"]');
    control?.setAttribute?.("aria-pressed", String(followActive));
    control?.classList?.toggle?.("is-on", followActive);
    const state = control?.querySelector?.(".follow-state");
    if (state) state.textContent = followActive ? "On" : "Off";
  }

  function disableFollowActiveOnTranscriptIntent(event: unknown): void {
    if (!followActive || !eventTargetsTranscript(event)) return;
    followActive = false;
    syncFollowActiveControl();
  }



  function syncExpansion(snapshot: PreviewSnapshot): void {
    for (const agent of snapshot.subagents) {
      if (ACTIVE_STATUSES.has(agent.status) && !userCollapsed.has(agent.id)) expanded.add(agent.id);
    }
  }

  function render(): void {
    const scrollPositions = collectScrollPositions();
    const focusKey = collectFocusKey();
    root.innerHTML = latest ? renderDashboard(latest, { filter, expanded, followActive }) : `<p class="empty">Waiting for subagents...</p>`;
    restoreScrollPositions(scrollPositions);
    restoreFocus(focusKey);
    if (followActive && latest && (latest.counts.pending > 0 || latest.counts.running > 0)) root.querySelector?.(activeSelector)?.scrollIntoView?.();
  }

  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    root.addEventListener?.(type, disableFollowActiveOnTranscriptIntent, true);
  }

  root.addEventListener?.("click", event => {
    const actionEl = (event as { target?: { closest?: (selector: string) => { dataset?: Record<string, string> } | null } }).target?.closest?.("[data-action]");
    const data = actionEl?.dataset;
    if (!data?.action) return;
    if (data.action === "filter" && data.status) filter = data.status as DashboardFilter;
    if (data.action === "toggle" && data.agentId) {
      if (expanded.has(data.agentId)) {
        expanded.delete(data.agentId);
        userCollapsed.add(data.agentId);
      } else {
        expanded.add(data.agentId);
        userCollapsed.delete(data.agentId);
      }
    }
    if (data.action === "copy" && data.agentId && latest) {
      const agent = latest.subagents.find(item => item.id === data.agentId);
      if (agent) void clipboard?.writeText(`${agent.description ?? agent.id}\n${agent.transcript.map(entry => entry.text).join("\n")}`);
    }
    if (data.action === "follow-active") followActive = !followActive;
    render();
  });

  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "ready" })));
  socket.addEventListener("message", event => {
    const data = typeof (event as { data?: unknown }).data === "string" ? JSON.parse((event as { data: string }).data) : undefined;
    if (data?.type === "snapshot") {
      latest = data.snapshot;
      syncExpansion(latest);
      render();
    }
  });

  render();
}

if (typeof document !== "undefined") installRuntime();
