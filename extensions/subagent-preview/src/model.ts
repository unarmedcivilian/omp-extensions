import type { AgentProgress, AgentSource, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task";

export type PreviewStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface TranscriptEntry {
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  text: string;
  timestamp?: string;
  truncated?: boolean;
  isError?: boolean;
}

export interface PreviewSubagent {
  id: string;
  index: number;
  agent: string;
  agentSource: AgentSource;
  description?: string;
  assignment?: string;
  task?: string;
  status: PreviewStatus;
  sessionFile?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentTools: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput: string[];
  toolCount: number;
  tokens: number;
  contextTokens?: number;
  contextWindow?: number;
  cost: number;
  durationMs: number;
  nestedTaskCount: number;
  transcript: TranscriptEntry[];
  updatedAt: number;
}

export interface PreviewSnapshot {
  subagents: PreviewSubagent[];
  counts: Record<PreviewStatus, number>;
  updatedAt: number;
}

export interface PreviewState {
  subagents: Map<string, PreviewSubagent>;
  updatedAt: number;
}

const TERMINAL = new Set<PreviewStatus>(["completed", "failed", "aborted"]);

export function createPreviewState(): PreviewState {
  return { subagents: new Map(), updatedAt: Date.now() };
}

export function applyLifecycle(state: PreviewState, payload: SubagentLifecyclePayload): PreviewSubagent {
  const status = payload.status === "started" ? "running" : payload.status;
  const existing = state.subagents.get(payload.id);
  const next = existing ?? createSubagent(payload.id, payload.index, payload.agent, payload.agentSource);
  next.status = status;
  next.description = payload.description ?? next.description;
  next.sessionFile = payload.sessionFile ?? next.sessionFile;
  next.updatedAt = Date.now();
  state.subagents.set(next.id, next);
  state.updatedAt = next.updatedAt;
  return next;
}

export function applyProgress(state: PreviewState, payload: SubagentProgressPayload): PreviewSubagent {
  const progress = payload.progress;
  const existing = state.subagents.get(progress.id);
  const next = existing ?? createSubagent(progress.id, progress.index, progress.agent, progress.agentSource);
  if (!existing || !TERMINAL.has(existing.status)) next.status = progress.status;
  next.description = progress.description ?? next.description;
  next.assignment = progress.assignment ?? payload.assignment ?? next.assignment;
  next.task = progress.task ?? payload.task ?? next.task;
  next.sessionFile = payload.sessionFile ?? next.sessionFile;
  next.currentTool = progress.currentTool;
  next.currentToolArgs = progress.currentToolArgs;
  next.recentTools = progress.recentTools ?? [];
  next.recentOutput = progress.recentOutput ?? [];
  next.toolCount = progress.toolCount ?? 0;
  next.tokens = progress.tokens ?? 0;
  next.contextTokens = progress.contextTokens;
  next.contextWindow = progress.contextWindow;
  next.cost = progress.cost ?? 0;
  next.durationMs = progress.durationMs ?? 0;
  next.nestedTaskCount = countNestedTasks(progress);
  next.updatedAt = Date.now();
  state.subagents.set(next.id, next);
  state.updatedAt = next.updatedAt;
  return next;
}

export function replaceTranscript(state: PreviewState, id: string, transcript: TranscriptEntry[]): void {
  const subagent = state.subagents.get(id);
  if (!subagent) return;
  subagent.transcript = sortTranscriptEntries(transcript);
  subagent.updatedAt = Date.now();
  state.updatedAt = subagent.updatedAt;
}

export function snapshotPreview(state: PreviewState): PreviewSnapshot {
  const counts: PreviewSnapshot["counts"] = { pending: 0, running: 0, completed: 0, failed: 0, aborted: 0 };
  const subagents = [...state.subagents.values()].sort(compareSubagents);
  for (const subagent of subagents) counts[subagent.status] += 1;
  return { subagents, counts, updatedAt: state.updatedAt };
}

function createSubagent(id: string, index: number, agent: string, agentSource: AgentSource): PreviewSubagent {
  return {
    id,
    index,
    agent,
    agentSource,
    status: "pending",
    recentTools: [],
    recentOutput: [],
    toolCount: 0,
    tokens: 0,
    cost: 0,
    durationMs: 0,
    nestedTaskCount: 0,
    transcript: [],
    updatedAt: Date.now(),
  };
}

function compareSubagents(a: PreviewSubagent, b: PreviewSubagent): number {
  return b.index - a.index || b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
}

function sortTranscriptEntries(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript
    .map((entry, index) => ({ entry, index, timestampMs: parseTimestampMs(entry.timestamp) }))
    .sort((a, b) => {
      if (a.timestampMs !== undefined && b.timestampMs !== undefined) return b.timestampMs - a.timestampMs || b.index - a.index;
      return b.index - a.index;
    })
    .map(item => item.entry);
}

function parseTimestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function countNestedTasks(progress: AgentProgress): number {
  const inflight = progress.inflightTaskDetails?.progress?.length ?? 0;
  const finished = progress.extractedToolData?.task?.length ?? 0;
  return inflight + finished;
}
