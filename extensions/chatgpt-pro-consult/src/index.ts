import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  runChatGptProConsult,
  type ChatGptProConsultDetails,
} from "./consult.js";

export interface ChatGptProConsultExtensionDeps {
  consult?: typeof runChatGptProConsult;
}

const installedApis = new WeakSet<object>();

export function createChatGptProConsultExtension(
  deps: ChatGptProConsultExtensionDeps = {},
): (pi: ExtensionAPI) => void {
  return function chatGptProConsultExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi)) return;
    installedApis.add(pi);

    const z = pi.zod;
    const consult = deps.consult ?? runChatGptProConsult;

    pi.setLabel("ChatGPT Pro Consult");

    const ConsultParams = z.object({
      prompt: z.string().describe("Prompt to submit to ChatGPT Pro."),
      thread: z
        .enum(["new", "current"])
        .optional()
        .describe("Use a fresh ChatGPT thread or the selected/current ChatGPT surface."),
      timeout_ms: z.number().optional().describe("Maximum time to wait for the consult, in milliseconds."),
      keep_surface: z.boolean().optional().describe("Keep the cmux browser surface open after the consult."),
    });

    pi.registerTool<typeof ConsultParams, ChatGptProConsultDetails>({
      name: "chatgpt_pro_consult",
      label: "ChatGPT Pro Consult",
      description:
        "Submit one explicit prompt to ChatGPT Pro through a visible cmux browser session and return the Markdown response.",
      parameters: ConsultParams,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<ChatGptProConsultDetails>> {
        const result = await consult({
          prompt: params.prompt,
          thread: params.thread,
          timeoutMs: params.timeout_ms,
          keepSurface: params.keep_surface,
          signal,
        });

        return {
          content: [{ type: "text", text: result.contentText }],
          details: result.details,
          isError: result.ok ? undefined : true,
        };
      },
    });
  };
}

export default createChatGptProConsultExtension();
