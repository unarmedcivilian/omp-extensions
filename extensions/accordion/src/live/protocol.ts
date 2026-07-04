export const PROTOCOL_VERSION = 5;
export const DEFAULT_PORT = 4317;

export interface WireBlock {
  id: string;
  kind: "user" | "text" | "thinking" | "tool_call" | "tool_result";
  turn: number;
  order: number;
  text: string;
  tokens: number;
  toolName?: string;
  callId?: string;
  model?: string;
  isError?: boolean;
}

export interface FoldOp {
  id: string;
  digestText: string;
}

export interface LegacyGroupFoldOp {
  ids: string[];
  digestText: string;
}

export interface GroupOp {
  id?: string;
  memberIds: string[];
  summaryText: string | null;
}

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  sessionId?: string;
  meta: { title: string; cwd: string; model: string; contextWindow: number | null; format: "pi" };
}

export interface SyncMessage {
  type: "sync";
  reqId: number;
  full: boolean;
  blocks: WireBlock[];
  contextWindow?: number | null;
}

export interface StreamMessage {
  type: "stream";
  phase: "start" | "end" | "abort";
  kind: "thinking" | "text" | "tool_call";
  contentIndex: number;
}

export interface UnfoldRequestMessage {
  type: "unfoldRequest";
  reqId: number;
  codes: string[];
}

export interface RecallRequestMessage {
  type: "recallRequest";
  reqId: number;
  codes: string[];
}

export interface CompleteResultMessage {
  type: "completeResult";
  reqId: number | string;
  ok: boolean;
  text?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  usage?: Record<string, number>;
  error?: string;
}

export type ServerMessage = HelloMessage | SyncMessage | StreamMessage | UnfoldRequestMessage | RecallRequestMessage | CompleteResultMessage;

export interface PlanMessage {
  type: "plan";
  reqId: number;
  ops: FoldOp[];
  groups?: GroupOp[];
}

export interface CompleteRequestMessage {
  type: "completeRequest";
  reqId: number | string;
  system?: string;
  systemPrompt?: string;
  prompt?: string;
  maxOutputTokens?: number;
}

export interface UnfoldRestored {
  code: string;
  kind?: WireBlock["kind"];
  label?: string;
  title?: string;
  ids?: string[];
}

export interface UnfoldResultMessage {
  type: "unfoldResult";
  reqId: number;
  restored: UnfoldRestored[];
  missing: string[];
}

export interface RecallContent {
  code: string;
  label?: string;
  title?: string;
  text: string;
  ids?: string[];
}

export interface RecallResultMessage {
  type: "recallResult";
  reqId: number;
  restored: RecallContent[];
  missing: string[];
}

export type ClientMessage = PlanMessage | UnfoldResultMessage | RecallResultMessage | CompleteRequestMessage;

export function isServerMessage(v: unknown): v is ServerMessage {
  if (!v || typeof v !== "object" || !("type" in v)) return false;
  const type = v.type;
  return type === "hello" || type === "sync" || type === "stream" || type === "unfoldRequest" || type === "recallRequest" || type === "completeResult";
}
