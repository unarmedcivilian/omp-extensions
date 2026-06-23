import type { BrowserLike } from "codex-chatgpt-control";
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
  signal?: AbortSignal;
  deadline?: ConsultDeadline;
  lifecycle?: ConsultLifecycle;
}

export function createCmuxBrowserAdapter(_options: CreateCmuxBrowserAdapterOptions = {}): CmuxBrowserAdapter {
  throw new Error("cmux browser adapter is not implemented yet");
}
