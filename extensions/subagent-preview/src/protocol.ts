import type { PreviewSnapshot } from "./model.js";

export interface SnapshotMessage { type: "snapshot"; snapshot: PreviewSnapshot }
export interface PageReady { type: "ready" }
export type HostToPage = SnapshotMessage;
export type PageToHost = PageReady;

export function isPageToHost(value: unknown): value is PageToHost {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "ready";
}
