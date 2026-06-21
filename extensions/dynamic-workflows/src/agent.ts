import type { AssistantMessage, Static, TSchema } from "@oh-my-pi/pi-ai";
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  SessionManager,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";

export interface WorkflowAgentSdk {
  createAgentSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  getAgentDir(): string;
  SessionManager: {
    inMemory(cwd?: string): SessionManager;
  };
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** OMP SDK exports. Extension code should pass `pi.pi` so this module has no runtime dependency on the host package. */
  sdk?: WorkflowAgentSdk;
  /** Extra tools available to the subagent in addition to OMP's built-in coding tools. */
  tools?: ToolDefinition[];
  /** Override createAgentSession options such as model, authStorage, resourceLoader, or settings. */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly sdk?: WorkflowAgentSdk;
  private readonly extraTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.sdk = options.sdk;
    this.extraTools = options.tools ?? [];
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const sdk = this.sdk;
    if (!sdk) throw new Error("WorkflowAgent requires OMP SDK dependencies; pass ExtensionAPI.pi as `sdk`.");

    const customTools = [...this.extraTools, ...(options.tools ?? [])];
    const agentDir = this.sessionOptions.agentDir ?? sdk.getAgentDir();
    const { session } = await sdk.createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: sdk.SessionManager.inMemory(this.cwd),
      ...this.sessionOptions,
      customTools,
      outputSchema: options.schema ?? this.sessionOptions.outputSchema,
      requireYieldTool: Boolean(options.schema) || this.sessionOptions.requireYieldTool === true,
    });

    let removeAbortListener: (() => void) | undefined;
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => {
          void session.abort();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(this.buildPrompt(prompt, options, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      if (options.schema) {
        return this.lastYieldData(session.messages) as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      await session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<TSchema | undefined>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter((part): part is string => Boolean(part));

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a yield tool call.",
          "- Call yield with { result: { data: <your output> } } matching the requested schema.",
          "- Do not emit a prose final answer instead of yield.",
          "- If you need to inspect files or run commands first, do so, then call yield exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastYieldData(messages: readonly unknown[]): unknown {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!isRecord(message)) continue;
      if (message.role !== "toolResult" || message.toolName !== "yield" || message.isError === true) continue;
      const details = message.details;
      if (!isRecord(details)) continue;
      if (details.status === "success") return details.data;
      if (details.status === "aborted") {
        const error = typeof details.error === "string" ? details.error : "yield reported an error";
        throw new Error(error);
      }
    }
    throw new Error("Subagent finished without calling yield");
  }

  private lastAssistantText(messages: readonly unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!isAssistantMessage(message)) continue;
      const text = message.content
        .map(part => (isTextContent(part) ? part.text : ""))
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
