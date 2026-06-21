import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import type { TranscriptEntry } from "./model.js";

const MAX_TEXT = 500;

export class TranscriptTailer {
  #offset = 0;
  #partial = "";

  constructor(readonly path: string) {}

  async readNew(): Promise<TranscriptEntry[]> {
    let text: string;
    try {
      const file = Bun.file(this.path);
      const size = file.size;
      if (size <= this.#offset) return [];
      const length = size - this.#offset;
      const buffer = Buffer.alloc(length);
      const handle = await open(this.path, "r");
      try {
        const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
        this.#offset += bytesRead;
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }

    const combined = this.#partial + text;
    const lines = combined.split("\n");
    this.#partial = lines.pop() ?? "";
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(...summarizeSessionEntry(JSON.parse(line)));
      } catch {
        // Ignore malformed completed lines; partial trailing line is buffered separately.
      }
    }
    return entries;
  }

  stop(): void {}
}

export function summarizeSessionEntry(entry: unknown): TranscriptEntry[] {
  if (!entry || typeof entry !== "object") return [];
  const record = entry as { timestamp?: string; type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") return [];
  const message = record.message as { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown };
  const timestamp = record.timestamp;

  if (message.role === "assistant" && Array.isArray(message.content)) {
    const out: TranscriptEntry[] = [];
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const item = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      if (item.type === "text" && typeof item.text === "string") out.push(makeEntry("assistant", timestamp, truncate(item.text)));
      if (item.type === "toolCall" && typeof item.name === "string") out.push(makeEntry("tool_call", timestamp, truncate(`${item.name} ${previewJson(item.arguments)}`)));
    }
    return out;
  }

  if (message.role === "toolResult") {
    const text = Array.isArray(message.content)
      ? message.content.map(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n")
      : "";
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    return [makeEntry("tool_result", timestamp, { isError: message.isError === true, ...truncate(`${toolName}: ${text}`) })];
  }

  if (message.role === "user" && Array.isArray(message.content)) {
    const text = message.content.map(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n");
    return text ? [makeEntry("user", timestamp, truncate(text))] : [];
  }

  return [];
}

function makeEntry(kind: TranscriptEntry["kind"], timestamp: string | undefined, data: Omit<TranscriptEntry, "kind" | "timestamp">): TranscriptEntry {
  return timestamp ? { kind, timestamp, ...data } : { kind, ...data };
}

function truncate(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_TEXT) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, MAX_TEXT - 12)}… [truncated]`, truncated: true };
}

function previewJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
