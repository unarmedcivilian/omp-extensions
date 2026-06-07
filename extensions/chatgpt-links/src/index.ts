import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { importChatGptConversation, type ImportChatGptConversationParams, type ImportChatGptConversationResult } from "./importer.js";

export interface ChatGptLinksExtensionDeps {
  importConversation?: (params: ImportChatGptConversationParams) => Promise<ImportChatGptConversationResult>;
}

export function createChatGptLinksExtension(deps: ChatGptLinksExtensionDeps = {}): (pi: ExtensionAPI) => void {
  return function chatGptLinksExtension(pi: ExtensionAPI): void {
    const { z } = pi.zod;
    const importConversation = deps.importConversation ?? importChatGptConversation;

    pi.setLabel("ChatGPT Links");

    const ImportConversationParams = z.object({
      conversation: z.string().describe("ChatGPT conversation URL or bare conversation id, for example https://chatgpt.com/c/<id>."),
      output_path: z.string().optional().describe("File path to write. Defaults to artifacts/chatgpt/<conversation-id>.txt."),
      wait_timeout_ms: z.number().optional().describe("Maximum time to wait for ChatGPT page load. Defaults to 30000."),
      keep_surface: z.boolean().optional().describe("Keep the cmux browser surface open after a successful import. Defaults to false."),
    });

    pi.registerTool<typeof ImportConversationParams, ImportChatGptConversationResult>({
      name: "chatgpt_import_conversation",
      label: "Import ChatGPT Conversation",
      description: "Open a ChatGPT conversation link in cmux browser, extract the loaded conversation text, and save it to disk. Assumes ChatGPT is already logged in in the cmux browser profile.",
      parameters: ImportConversationParams,
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<ImportChatGptConversationResult>> {
        if (signal?.aborted) throw new Error("chatgpt_import_conversation aborted before execution");
        const result = await importConversation({
          conversation: params.conversation,
          outputPath: params.output_path,
          waitTimeoutMs: params.wait_timeout_ms,
          keepSurface: params.keep_surface,
          signal,
        });
        return {
          content: [{ type: "text", text: `Imported ChatGPT conversation ${result.conversationId} to ${result.path}.` }],
          details: result,
        };
      },
    });
  };
}

export default createChatGptLinksExtension();
