import type { PreviewSnapshot, PreviewStatus, PreviewSubagent } from "../model.js";

export type DashboardFilter = "all" | PreviewStatus;
export interface DashboardViewState { filter: DashboardFilter; expanded: Set<string>; followActive?: boolean }

const STATUS_FILTERS: PreviewStatus[] = ["pending", "running", "completed", "failed", "aborted"];

export function filterSnapshot(snapshot: PreviewSnapshot, filter: DashboardFilter): PreviewSnapshot {
  if (filter === "all") return snapshot;
  return { ...snapshot, subagents: snapshot.subagents.filter(item => item.status === filter) };
}

export function renderDashboard(snapshot: PreviewSnapshot, state: DashboardViewState): string {
  const filtered = filterSnapshot(snapshot, state.filter);
  const followActive = state.followActive ?? false;
  return `
    <section class="hero">
      <div>
        <p class="eyebrow">OMP subagents</p>
        <h1>Subagent transcripts</h1>
        <p class="lede" aria-live="polite">${snapshot.subagents.length} trajectories · updated ${formatUpdated(snapshot.updatedAt)}</p>
      </div>
      <button class="follow-toggle ${followActive ? "is-on" : ""}" data-action="follow-active" data-focus-key="follow-active" aria-pressed="${followActive}">
        <span class="follow-state">${followActive ? "On" : "Off"}</span><span class="follow-label">follow active</span>
      </button>
    </section>
    <section class="summary" role="toolbar" aria-label="Filter transcripts">
      ${renderFilterButton("all", "all", snapshot.subagents.length, state.filter)}
      ${STATUS_FILTERS.map(status => renderFilterButton(status, status, snapshot.counts[status], state.filter)).join("")}
    </section>
    <section class="agents">
      ${filtered.subagents.map(agent => renderAgent(agent, state.expanded.has(agent.id))).join("") || `<p class="empty">No subagents match this filter.</p>`}
    </section>`;
}

function renderFilterButton(status: DashboardFilter, label: string, count: number, activeFilter: DashboardFilter): string {
  const active = activeFilter === status;
  return `<button class="filter-chip" data-action="filter" data-status="${status}" data-focus-key="filter:${status}" aria-pressed="${active}"><span>${count}</span><span class="chip-label">${label}</span></button>`;
}

function renderAgent(agent: PreviewSubagent, expanded: boolean): string {
  const agentId = escapeHtml(agent.id);
  const title = escapeHtml(agent.description ?? agent.id);
  const transcript = expanded ? renderTranscript(agent, agentId, title) : "";
  const recentOutput = agent.recentOutput.length ? `<section class="console"><p class="console-label">recent output</p><pre>${escapeHtml(agent.recentOutput.join("\n"))}</pre></section>` : "";
  return `<article class="agent" data-id="${agentId}" data-status="${agent.status}">
    <header class="agent-header">
      <button class="agent-toggle" data-action="toggle" data-agent-id="${agentId}" data-focus-key="toggle:${agentId}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} transcript for ${title}">
        <span class="agent-title">${title}</span>
        <span class="agent-subtitle">${agentId} · ${escapeHtml(agent.agent)}</span>
        <span class="status-pill">${agent.status}</span>
      </button>
    </header>
    <div class="agent-body">
      <dl class="meta">
        <div><dt>tool</dt><dd>${escapeHtml(agent.currentTool ?? "idle")}</dd></div>
        <div><dt>tokens</dt><dd>${agent.tokens.toLocaleString()}</dd></div>
        <div><dt>time</dt><dd>${formatDuration(agent.durationMs)}</dd></div>
        <div><dt>nested</dt><dd>${agent.nestedTaskCount} nested</dd></div>
        <div><dt>cost</dt><dd>$${agent.cost.toFixed(4)}</dd></div>
      </dl>
      <button class="copy-button" data-action="copy" data-agent-id="${agentId}" data-focus-key="copy:${agentId}">Copy transcript</button>
      ${recentOutput}
      ${transcript}
    </div>
  </article>`;
}

function renderTranscript(agent: PreviewSubagent, agentId: string, title: string): string {
  const entries = agent.transcript.map(entry => `<article class="entry ${entry.kind}" data-kind="${entry.kind}">
    <div class="entry-meta"><span>${formatKind(entry.kind)}</span>${entry.timestamp ? `<time>${escapeHtml(entry.timestamp)}</time>` : ""}${entry.truncated ? `<em>truncated</em>` : ""}</div>
    <div class="entry-text">${escapeHtml(entry.text)}</div>
  </article>`).join("");
  return `<section class="transcript-panel" aria-label="Transcript">
    <div class="transcript" data-scroll-key="transcript:${agentId}" data-focus-key="transcript:${agentId}" tabindex="0" aria-label="Transcript for ${title}">
      ${entries || `<p class="empty transcript-empty">No transcript lines yet.</p>`}
    </div>
  </section>`;
}

function formatUpdated(updatedAt: number): string {
  if (!updatedAt) return "never";
  return new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatKind(kind: PreviewSubagent["transcript"][number]["kind"]): string {
  return kind.replaceAll("_", " ");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
