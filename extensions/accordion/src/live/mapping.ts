import type { FoldOp, GroupOp, LegacyGroupFoldOp, WireBlock } from "./protocol.js";
import { BLOCK_OVERHEAD, estTokens } from "./tokens.js";

export interface PiTextPart {
  type: "text";
  text: string;
}

export interface PiThinkingPart {
  type: "thinking";
  thinking: string;
}

export interface PiToolCallPart {
  type: "toolCall" | "tool_call";
  id: string;
  name: string;
  arguments?: Record<string, unknown> | string;
}

export type PiPart = PiTextPart | PiThinkingPart | PiToolCallPart | { type: string; text?: unknown; [key: string]: unknown };

export interface PiMessage {
  role: string;
  content?: string | PiPart[] | Array<{ type: string; text?: string }>;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
  isError?: boolean;
  summary?: string;
  timestamp?: number;
  responseId?: string;
}

export type PlanOp = FoldOp | LegacyGroupFoldOp;

function isObject(value: unknown): value is object {
  return !!value && typeof value === "object";
}

function textPartText(part: unknown): string | null {
  if (!isObject(part) || !("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") return null;
  return part.text;
}

function thinkingPartText(part: unknown): string | null {
  if (!isObject(part) || !("type" in part) || part.type !== "thinking" || !("thinking" in part) || typeof part.thinking !== "string") return null;
  return part.thinking;
}

function isToolCallPart(part: unknown): part is PiToolCallPart {
  if (!isObject(part) || !("type" in part)) return false;
  if (part.type !== "toolCall" && part.type !== "tool_call") return false;
  return "id" in part && typeof part.id === "string" && "name" in part && typeof part.name === "string";
}

function isToolResultRole(role: string): boolean {
  return role === "toolResult" || role === "tool";
}

export function blockId(m: PiMessage, i: number, partIndex?: number): string {
  switch (m.role) {
    case "user":
      return m.timestamp != null ? `u:${m.timestamp}` : `m${i}:u`;
    case "assistant": {
      if (partIndex == null) return `m${i}:p?`;
      const anchor = m.responseId != null ? m.responseId : m.timestamp != null ? `t${m.timestamp}` : null;
      return anchor != null ? `a:${anchor}:p${partIndex}` : `m${i}:p${partIndex}`;
    }
    default:
      if (isToolResultRole(m.role)) return m.toolCallId != null ? `t:${m.toolCallId}:result` : `m${i}:r`;
      return m.timestamp != null ? `s:${m.timestamp}` : `m${i}:s`;
  }
}

export function isDurableId(id: string): boolean {
  return id.startsWith("u:") || id.startsWith("a:") || id.startsWith("t:") || id.startsWith("r:") || id.startsWith("s:");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(textPartText).filter((text): text is string => text !== null).join("\n");
}

const tokensFor = (text: string): number => estTokens(text) + BLOCK_OVERHEAD;

export function linearize(messages: PiMessage[]): WireBlock[] {
  const out: WireBlock[] = [];
  let order = 0;
  let turn = 0;

  const push = (
    id: string,
    kind: WireBlock["kind"],
    text: string,
    extra: Partial<Pick<WireBlock, "toolName" | "callId" | "model" | "isError">> = {},
  ) => {
    if (!text && kind !== "tool_result") return;
    out.push({ id, kind, turn, order: order++, text, tokens: tokensFor(text), ...extra });
  };

  messages.forEach((m, i) => {
    if (m.role === "user") {
      turn += 1;
      push(blockId(m, i), "user", textOf(m.content));
      return;
    }

    if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      parts.forEach((part, j) => {
        const thinking = thinkingPartText(part);
        if (thinking !== null) {
          push(blockId(m, i, j), "thinking", thinking, { model: m.model });
          return;
        }
        const text = textPartText(part);
        if (text !== null) {
          push(blockId(m, i, j), "text", text, { model: m.model });
          return;
        }
        if (isToolCallPart(part)) {
          const args = typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments ?? {});
          push(blockId(m, i, j), "tool_call", `${part.name} ${args}`, { toolName: part.name, callId: part.id, model: m.model });
        }
      });
      return;
    }

    if (isToolResultRole(m.role)) {
      push(blockId(m, i), "tool_result", textOf(m.content), {
        toolName: m.toolName || m.name || "tool",
        callId: m.toolCallId,
        isError: !!m.isError,
      });
      return;
    }

    if (typeof m.summary === "string" && m.summary) push(blockId(m, i), "text", m.summary);
  });

  return out;
}

interface MsgInfo {
  ids: string[];
  calls: string[];
  results: string[];
  hasNonDurable: boolean;
}

function messageInfo(m: PiMessage, i: number): MsgInfo {
  const ids: string[] = [];
  const calls: string[] = [];
  const results: string[] = [];
  let hasNonDurable = false;
  const push = (id: string) => {
    ids.push(id);
    if (!isDurableId(id)) hasNonDurable = true;
  };

  if (m.role === "user") {
    push(blockId(m, i));
  } else if (m.role === "assistant") {
    const parts = Array.isArray(m.content) ? m.content : [];
    parts.forEach((part, j) => {
      if (thinkingPartText(part) !== null || textPartText(part) !== null) push(blockId(m, i, j));
      else if (isToolCallPart(part)) {
        push(blockId(m, i, j));
        calls.push(part.id);
      }
    });
  } else if (isToolResultRole(m.role)) {
    push(blockId(m, i));
    if (m.toolCallId) results.push(m.toolCallId);
  } else if (typeof m.summary === "string" && m.summary) {
    push(blockId(m, i));
  }

  return { ids, calls, results, hasNonDurable };
}

function cloneParts(content: unknown): PiPart[] | null {
  return Array.isArray(content) ? [...content] : null;
}

function foldOne(m: PiMessage, i: number, byId: Map<string, FoldOp>, mark: () => void): PiMessage {
  if (m.role === "assistant" && Array.isArray(m.content)) {
    let parts: PiPart[] | null = null;
    m.content.forEach((part, j) => {
      const op = byId.get(blockId(m, i, j));
      if (!op?.digestText) return;
      if (textPartText(part) !== null) {
        parts ??= cloneParts(m.content);
        if (parts) parts[j] = { ...part, type: "text", text: op.digestText };
      } else if (thinkingPartText(part) !== null) {
        parts ??= cloneParts(m.content);
        if (parts) parts[j] = { ...part, type: "thinking", thinking: op.digestText } as PiThinkingPart;
      }
    });
    if (parts) {
      mark();
      return { ...m, content: parts };
    }
    return m;
  }

  if (isToolResultRole(m.role)) {
    const op = byId.get(blockId(m, i));
    if (op?.digestText) {
      mark();
      return { ...m, content: [{ type: "text", text: op.digestText }] };
    }
  }

  return m;
}

function isFoldOp(op: unknown): op is FoldOp {
  return isObject(op) && "id" in op && typeof op.id === "string" && "digestText" in op && typeof op.digestText === "string";
}

function isLegacyGroupFoldOp(op: unknown): op is LegacyGroupFoldOp {
  return isObject(op) && "ids" in op && Array.isArray(op.ids) && "digestText" in op && typeof op.digestText === "string";
}

function normalizeGroups(ops: PlanOp[], groups: GroupOp[]): GroupOp[] {
  const normalized: GroupOp[] = [];
  for (const group of groups ?? []) {
    if (!group || !Array.isArray(group.memberIds)) continue;
    normalized.push(group);
  }
  for (const op of ops ?? []) {
    if (!isLegacyGroupFoldOp(op)) continue;
    normalized.push({ memberIds: op.ids, summaryText: op.digestText });
  }
  return normalized;
}

export function applyPlan(messages: PiMessage[], ops: PlanOp[] = [], groups: GroupOp[] = []): PiMessage[] {
  const safeOps = (ops ?? []).filter(isFoldOp).filter(op => isDurableId(op.id) && op.digestText.length > 0);
  const safeGroups = normalizeGroups(ops ?? [], groups ?? []).filter(group =>
    Array.isArray(group.memberIds)
    && group.memberIds.length > 0
    && group.memberIds.every(id => typeof id === "string" && isDurableId(id))
    && (group.summaryText === null || (typeof group.summaryText === "string" && group.summaryText.trim().length > 0)),
  );

  if (!safeOps.length && !safeGroups.length) return messages;
  const byId = new Map(safeOps.map(op => [op.id, op] as const));
  const owner: (GroupOp | null)[] = new Array(messages.length).fill(null);

  if (safeGroups.length) {
    const memberToGroup = new Map<string, GroupOp>();
    for (const group of safeGroups) for (const id of group.memberIds) memberToGroup.set(id, group);
    const infos = messages.map((message, index) => messageInfo(message, index));

    for (let i = 0; i < messages.length; i += 1) {
      const info = infos[i];
      if (!info.ids.length || info.hasNonDurable) continue;
      let group: GroupOp | null = null;
      let ok = true;
      for (const id of info.ids) {
        const candidate = memberToGroup.get(id);
        if (!candidate || (group && candidate !== group)) {
          ok = false;
          break;
        }
        group = candidate;
      }
      if (ok && group) owner[i] = group;
    }

    for (let changedSet = true; changedSet;) {
      changedSet = false;
      const calls = new Set<string>();
      const results = new Set<string>();
      for (let i = 0; i < messages.length; i += 1) {
        if (!owner[i]) continue;
        for (const call of infos[i].calls) calls.add(call);
        for (const result of infos[i].results) results.add(result);
      }
      for (let i = 0; i < messages.length; i += 1) {
        if (!owner[i]) continue;
        const info = infos[i];
        if (info.calls.some(call => !results.has(call)) || info.results.some(result => !calls.has(result))) {
          owner[i] = null;
          changedSet = true;
        }
      }
    }
  }

  let changed = false;
  const mark = () => { changed = true; };
  const out: PiMessage[] = [];
  for (let i = 0; i < messages.length;) {
    const group = owner[i];
    if (group) {
      let j = i + 1;
      while (j < messages.length && owner[j] === group) j += 1;
      if (group.summaryText === null) {
        changed = true;
      } else {
        const role = messages[i].role === "assistant" ? "assistant" : "user";
        out.push({ role, content: [{ type: "text", text: group.summaryText }] });
        changed = true;
      }
      i = j;
      continue;
    }
    out.push(foldOne(messages[i], i, byId, mark));
    i += 1;
  }

  return changed ? out : messages;
}
