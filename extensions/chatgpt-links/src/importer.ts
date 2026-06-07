import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCmuxBrowserAutomation } from "./cmux.js";

export interface BrowserAutomation {
  open(url: string, signal?: AbortSignal): Promise<string>;
  waitForLoad(surface: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  getText(surface: string, selector: string, signal?: AbortSignal): Promise<string>;
  close(surface: string, signal?: AbortSignal): Promise<void>;
}

export interface NormalizedChatGptConversation {
  id: string;
  url: string;
}

export interface ImportChatGptConversationParams {
  conversation: string;
  outputPath?: string;
  waitTimeoutMs?: number;
  keepSurface?: boolean;
  artifactsDir?: string;
  browser?: BrowserAutomation;
  signal?: AbortSignal;
}

export interface ImportChatGptConversationResult {
  conversationId: string;
  url: string;
  path: string;
  bytes: number;
  surface: string;
}

export class ChatGptLoginRequiredError extends Error {
  constructor(readonly surface: string) {
    super(`ChatGPT login required in the cmux browser profile; surface left open at ${surface}`);
    this.name = "ChatGptLoginRequiredError";
  }
}

export class ChatGptExtractionError extends Error {
  constructor(message: string, readonly surface: string) {
    super(`${message}; surface left open at ${surface}`);
    this.name = "ChatGptExtractionError";
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_ARTIFACTS_DIR = join("artifacts", "chatgpt");
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,}$/;

export function normalizeConversation(conversation: string): NormalizedChatGptConversation {
  const raw = conversation.trim();
  if (!raw) throw new Error("ChatGPT conversation id or URL is required");

  let id = raw;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    if ((url.hostname === "chatgpt.com" || url.hostname === "www.chatgpt.com") && segments[0] === "c" && segments[1]) {
      id = decodeURIComponent(segments[1]);
    } else {
      throw new Error(`Unsupported ChatGPT conversation URL: ${raw}`);
    }
  } catch (error) {
    if (raw.includes("://")) throw error;
  }

  if (!CONVERSATION_ID_PATTERN.test(id)) throw new Error(`Invalid ChatGPT conversation id: ${id}`);
  return { id, url: `https://chatgpt.com/c/${encodeURIComponent(id)}` };
}

export function defaultConversationPath(conversationId: string, artifactsDir = DEFAULT_ARTIFACTS_DIR): string {
  return join(artifactsDir, `${conversationId}.txt`);
}

export async function importChatGptConversation(params: ImportChatGptConversationParams): Promise<ImportChatGptConversationResult> {
  throwIfAborted(params.signal);
  const { id, url } = normalizeConversation(params.conversation);
  const browser = params.browser ?? createCmuxBrowserAutomation();
  const waitTimeoutMs = params.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const outputPath = params.outputPath && params.outputPath.trim() ? params.outputPath : defaultConversationPath(id, params.artifactsDir);
  const surface = await browser.open(url, params.signal);

  try {
    throwIfAborted(params.signal);
    await browser.waitForLoad(surface, waitTimeoutMs, params.signal);
    throwIfAborted(params.signal);
    const text = normalizeExtractedText(await browser.getText(surface, "body", params.signal));
    if (looksLikeLoginWall(text)) throw new ChatGptLoginRequiredError(surface);
    if (!text) throw new ChatGptExtractionError("ChatGPT conversation extraction returned no text", surface);

    await mkdir(dirname(outputPath), { recursive: true });
    const bytes = await Bun.write(outputPath, text);
    if (params.keepSurface !== true) await browser.close(surface, params.signal);
    return { conversationId: id, url, path: outputPath, bytes, surface };
  } catch (error) {
    if (error instanceof ChatGptLoginRequiredError || error instanceof ChatGptExtractionError) throw error;
    if (params.keepSurface !== true) await closeIgnoringErrors(browser, surface, params.signal);
    throw error;
  }
}

function normalizeExtractedText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function looksLikeLoginWall(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("log in") && (lower.includes("sign up") || lower.includes("continue"));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function closeIgnoringErrors(browser: BrowserAutomation, surface: string, signal: AbortSignal | undefined): Promise<void> {
  try {
    await browser.close(surface, signal);
  } catch {
    // Preserve the original import error.
  }
}
