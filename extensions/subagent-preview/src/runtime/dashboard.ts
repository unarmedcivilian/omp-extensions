import type { PreviewSnapshot, PreviewStatus, PreviewSubagent } from "../model.js";

export type DashboardFilter = "all" | PreviewStatus;
export interface DashboardViewState { filter: DashboardFilter; expanded: Set<string> }

const STATUS_FILTERS: PreviewStatus[] = ["pending", "running", "completed", "failed", "aborted"];

export function filterSnapshot(snapshot: PreviewSnapshot, filter: DashboardFilter): PreviewSnapshot {
  if (filter === "all") return snapshot;
  return { ...snapshot, subagents: snapshot.subagents.filter(item => item.status === filter) };
}

export function renderDashboard(snapshot: PreviewSnapshot, state: DashboardViewState): string {
  const filtered = filterSnapshot(snapshot, state.filter);
  return `
    <section class="summary">
      <button data-action="filter" data-status="all"><span>${snapshot.subagents.length}</span><label>all</label></button>
      ${STATUS_FILTERS.map(status => `<button data-action="filter" data-status="${status}"><span>${snapshot.counts[status]}</span><label>${status}</label></button>`).join("")}
      <button data-action="follow-active"><span>${snapshot.counts.failed + snapshot.counts.aborted}</span><label>follow active</label></button>
    </section>
    <section class="agents">
      ${filtered.subagents.map(agent => renderAgent(agent, state.expanded.has(agent.id))).join("") || `<p class="empty">No subagents match this filter.</p>`}
    </section>`;
}

function renderAgent(agent: PreviewSubagent, expanded: boolean): string {
  const transcript = expanded ? `<div class="transcript">${agent.transcript.map(entry => `<div class="entry ${entry.kind}">${escapeHtml(entry.text)}</div>`).join("")}</div>` : "";
  return `<article class="agent" data-id="${escapeHtml(agent.id)}" data-status="${agent.status}">
    <header data-action="toggle" data-agent-id="${escapeHtml(agent.id)}"><strong>${escapeHtml(agent.description ?? agent.id)}</strong><span>${agent.status}</span></header>
    <button data-action="copy" data-agent-id="${escapeHtml(agent.id)}">Copy summary</button>
    <div class="meta">${escapeHtml(agent.currentTool ?? "idle")} · ${agent.tokens.toLocaleString()} tokens · ${formatDuration(agent.durationMs)} · ${agent.nestedTaskCount} nested · $${agent.cost.toFixed(4)}</div>
    ${agent.recentOutput.length ? `<pre>${escapeHtml(agent.recentOutput.join("\n"))}</pre>` : ""}
    ${transcript}
  </article>`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
