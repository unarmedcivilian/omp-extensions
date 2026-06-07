import type { RpcHost } from "../rpc.js";

const DEFAULT_MAX_PROMPTS = 12;
const MAX_PROMPT_CHARS = 4000;

export interface AgentPromptOptions {
  title: string | (() => string);
  maxPrompts?: number;
  sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export function attachAgentPrompt(rpc: RpcHost, options: AgentPromptOptions): void {
  let promptCount = 0;
  const maxPrompts = options.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const title = typeof options.title === "function" ? options.title : () => options.title;

  rpc.handle("agent.prompt", params => {
    const text = readPromptText(params);
    if (promptCount >= maxPrompts) {
      throw new Error("agent.prompt limit reached for this widget");
    }
    promptCount += 1;
    options.sendUserMessage(`From widget "${title()}":\n${text}`, { deliverAs: "followUp" });
    return { queued: true };
  });
}

function readPromptText(params: unknown): string {
  if (!params || typeof params !== "object") {
    throw new Error("agent.prompt requires non-empty text");
  }
  const raw = (params as { text?: unknown }).text;
  if (typeof raw !== "string") {
    throw new Error("agent.prompt requires non-empty text");
  }
  const text = raw.trim();
  if (!text) {
    throw new Error("agent.prompt requires non-empty text");
  }
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error("agent.prompt text exceeds 4000 characters");
  }
  return text;
}
