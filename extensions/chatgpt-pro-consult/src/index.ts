import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  runChatGptProConsult,
  type ChatGptProConsultDetails,
  type ChatGptProConsultParams,
  type ChatGptProConsultProgress,
  type ChatGptProConsultProgressDetails,
} from "./consult.js";

export interface ChatGptProConsultExtensionDeps {
  consult?: typeof runChatGptProConsult;
}

export type ChatGptProConsultToolDetails =
  | ChatGptProConsultDetails
  | ChatGptProConsultProgressDetails;

function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatProgressText(progress: ChatGptProConsultProgress): string {
  return `${progress.message} (${formatElapsedDuration(progress.elapsedMs)} elapsed)`;
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
      zip_path: z
        .string()
        .optional()
        .describe("Absolute or relative path to one local ZIP file to upload before submitting the prompt."),
      thread: z
        .enum(["new", "current"])
        .optional()
        .describe("Use a fresh ChatGPT thread or the selected/current ChatGPT surface."),
      keep_surface: z.boolean().optional().describe("Keep the cmux browser surface open after the consult."),
    });

    pi.registerTool<typeof ConsultParams, ChatGptProConsultToolDetails>({
      name: "chatgpt_pro_consult",
      label: "ChatGPT Pro Consult",
      description:
        "Submit one explicit prompt to ChatGPT Pro through a visible cmux browser session and return the Markdown response.",
      parameters: ConsultParams,
      async execute(
        _toolCallId,
        params,
        signal,
        onUpdate,
      ): Promise<AgentToolResult<ChatGptProConsultToolDetails>> {
        if (Object.prototype.hasOwnProperty.call(params, "timeout_ms")) {
          throw new Error(
            "timeout_ms is not supported; ChatGPT Pro consults use a fixed 120-minute limit.",
          );
        }

        const consultParams: ChatGptProConsultParams = {
          prompt: params.prompt,
          zipPath: params.zip_path,
          thread: params.thread,
          keepSurface: params.keep_surface,
          signal,
        };
        if (onUpdate) {
          consultParams.onProgress = progress => {
            onUpdate({
              content: [{ type: "text", text: formatProgressText(progress) }],
              details: { kind: "progress", progress },
            });
          };
        }

        const result = await consult(consultParams);

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
