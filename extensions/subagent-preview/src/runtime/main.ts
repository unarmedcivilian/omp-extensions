import type { PreviewSnapshot } from "../model.js";
import { renderDashboard, type DashboardFilter } from "./dashboard.js";

export interface RuntimeSocketLike {
  readyState: number;
  send(data: string): void;
  addEventListener(type: string, fn: (event: unknown) => void): void;
}

export interface RuntimeRootLike {
  innerHTML: string;
  addEventListener?: (type: string, fn: (event: unknown) => void) => void;
  querySelector?: (selector: string) => { scrollIntoView?: () => void } | null;
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
  const userExpanded = new Set<string>();
  const userCollapsed = new Set<string>();
  let followActive = true;
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;

  function syncExpansion(snapshot: PreviewSnapshot): void {
    for (const agent of snapshot.subagents) {
      if (agent.status === "running" && !userCollapsed.has(agent.id)) expanded.add(agent.id);
      if (agent.status !== "running" && !userExpanded.has(agent.id)) expanded.delete(agent.id);
    }
  }

  function render(): void {
    root.innerHTML = latest ? renderDashboard(latest, { filter, expanded }) : `<p class="empty">Waiting for subagents...</p>`;
    if (followActive) root.querySelector?.('[data-status="running"]')?.scrollIntoView?.();
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
        userExpanded.delete(data.agentId);
      } else {
        expanded.add(data.agentId);
        userExpanded.add(data.agentId);
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
