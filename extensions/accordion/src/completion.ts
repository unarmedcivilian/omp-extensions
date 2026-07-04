import { complete as completeWithPiAi } from "@oh-my-pi/pi-ai";
import type { CompleteRequestMessage, CompleteResultMessage } from "./app/src/lib/live/protocol.js";

export interface CompletionInput {
  model: unknown;
  apiKey: string;
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
}

export interface CompletionOutput {
  content?: unknown;
  usage?: Record<string, number>;
  model?: string;
}

export type CompleteDependency = (input: CompletionInput) => Promise<CompletionOutput>;

export interface CompletionRelayDeps {
  complete?: CompleteDependency;
}

interface ContextLike {
  model?: unknown;
  modelRegistry?: {
    getApiKey?: (model: unknown) => string | null | Promise<string | null>;
  };
}

function isObject(value: unknown): value is object {
  return !!value && typeof value === "object";
}

function toRecord(value: object): Record<PropertyKey, unknown> {
  return value as Record<PropertyKey, unknown>;
}


function modelMaxTokens(model: unknown): number | undefined {
  if (!isObject(model)) return undefined;
  const record = toRecord(model);
  return typeof record.maxTokens === "number" && record.maxTokens > 0 ? record.maxTokens : undefined;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    const record = toRecord(part);
    if (record.type === "text" && typeof record.text === "string") chunks.push(record.text);
  }
  return chunks.join("");
}

async function defaultComplete(input: CompletionInput): Promise<CompletionOutput> {
  const context = {
    ...(input.systemPrompt ? { systemPrompt: [input.systemPrompt] } : {}),
    messages: [{ role: "user" as const, content: input.prompt, timestamp: Date.now() }],
  };
  const options = {
    apiKey: input.apiKey,
    ...(input.maxOutputTokens !== undefined ? { maxTokens: input.maxOutputTokens } : {}),
  };
  const result = await completeWithPiAi(input.model as never, context as never, options as never);
  return result as CompletionOutput;
}

export async function runCompletionRequest(
  req: CompleteRequestMessage,
  ctx: ContextLike | null | undefined,
  latestModel: unknown,
  deps: CompletionRelayDeps = {},
): Promise<CompleteResultMessage> {
  const reqId = req.reqId;
  try {
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    if (!prompt.trim()) return { type: "completeResult", reqId, ok: false, error: "missing or empty prompt" };

    const model = latestModel ?? ctx?.model;
    if (!model) return { type: "completeResult", reqId, ok: false, error: "no model available" };

    const apiKey = await ctx?.modelRegistry?.getApiKey?.(model);
    if (!apiKey) return { type: "completeResult", reqId, ok: false, error: "could not resolve API key" };

    let maxOutputTokens: number | undefined;
    if (typeof req.maxOutputTokens === "number" && req.maxOutputTokens > 0) {
      const ceiling = modelMaxTokens(model);
      maxOutputTokens = ceiling === undefined ? req.maxOutputTokens : Math.min(req.maxOutputTokens, ceiling);
    }

    const complete = deps.complete ?? defaultComplete;
    const output = await complete({
      model,
      apiKey,
      prompt,
      systemPrompt: typeof req.systemPrompt === "string" ? req.systemPrompt : typeof req.system === "string" ? req.system : undefined,
      maxOutputTokens,
    });

    return {
      type: "completeResult",
      reqId,
      ok: true,
      text: textFromContent(output.content),
      ...(output.usage ? { usage: output.usage } : {}),
    };
  } catch (error) {
    return { type: "completeResult", reqId, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
