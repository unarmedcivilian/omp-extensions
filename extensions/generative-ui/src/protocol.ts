export interface ContentMessage {
  type: "content";
  html: string;
  final: boolean;
}

export interface RpcOk {
  type: "rpc-result";
  id: string;
  ok: true;
  value?: unknown;
}

export interface RpcErr {
  type: "rpc-result";
  id: string;
  ok: false;
  error: string;
}

export type HostToPage = ContentMessage | RpcOk | RpcErr;

export interface PageReady {
  type: "ready";
}

export interface RpcCall {
  type: "rpc-call";
  id: string;
  method: string;
  params: unknown;
}

export type PageToHost = PageReady | RpcCall;

export function isHostToPage(value: unknown): value is HostToPage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "content") return typeof record.html === "string" && typeof record.final === "boolean";
  if (record.type !== "rpc-result") return false;
  return typeof record.id === "string" && typeof record.ok === "boolean";
}

export function isPageToHost(value: unknown): value is PageToHost {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "ready") return true;
  if (record.type !== "rpc-call") return false;
  return typeof record.id === "string" && typeof record.method === "string";
}
