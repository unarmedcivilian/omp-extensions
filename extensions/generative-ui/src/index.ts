import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getGuidelines, AVAILABLE_MODULES, type Module } from "./guidelines.js";
import { attachAgentPrompt } from "./features/agent-prompt.js";
import { attach as attachSvgSaver } from "./features/svg-saver.js";
import { createCmuxTransport } from "./cmux.js";
import { createCmuxWidgetOpener, LocalWidgetServer } from "./surface.js";
import { WidgetSession, type WidgetSurfaceOpener } from "./session.js";
import { RUNTIME_HTML } from "./runtime.bundle.js";

interface ReadMeDetails {
  modules: readonly Module[];
}

interface ShowWidgetDetails {
  title: string;
  width: number;
  height: number;
  isSVG: boolean;
  surface?: string;
}

interface ToolCallBlock {
  type: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface AssistantStreamEvent {
  type: string;
  contentIndex: number;
  partial?: { content?: ToolCallBlock[] };
  toolCall?: { arguments?: Record<string, unknown> };
}

interface MutableTitle {
  value: string;
}

export interface GenerativeUiExtensionDeps {
  openSurface?: WidgetSurfaceOpener;
  closeServer?: () => void;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const installedApis = new WeakSet<object>();

const HIDDEN_GUIDANCE = `[Generative UI extension active]
Use show_widget when the user asks for visual content: charts, diagrams, interactive explainers, UI mockups, or generative art.
Call visualize_read_me once before the first show_widget call, silently, and choose relevant modules: interactive, chart, mockup, art, diagram.
show_widget renders HTML/SVG fragments in a cmux browser surface. Do not include DOCTYPE/html/head/body wrappers.
Widgets may call sendPrompt(text) only from explicit user actions such as button clicks or clickable diagram nodes. sendPrompt queues a visible follow-up user message with widget provenance; never call it automatically on load, timers, animation frames, or data changes.
Keep widgets focused and appropriately sized. Default size is 800x600; SVG code must start with <svg>. When iterating on a design, reuse the same title to update the existing cmux surface; set new_surface: true only when you intentionally want a separate window.`;

export function createGenerativeUiExtension(deps: GenerativeUiExtensionDeps = {}): (pi: ExtensionAPI) => void {
  return function generativeUiExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi as object)) {
      pi.logger.warn("generative-ui extension already installed; skipping duplicate registration");
      return;
    }
    installedApis.add(pi as object);

    const { z } = pi.zod;
    const activeSessions = new Set<WidgetSession>();
    const sessionsByTitle = new Map<string, WidgetSession>();
    const server = deps.openSurface ? undefined : new LocalWidgetServer(RUNTIME_HTML);
    const openSurface = deps.openSurface ?? createCmuxWidgetOpener({ server: server!, transport: createCmuxTransport() });
    const closeServer = deps.closeServer ?? (() => server?.close());

    let pendingIndex: number | undefined;
    let pendingSession: WidgetSession | undefined;
    let pendingOpening: Promise<WidgetSession | undefined> | undefined;
    let pendingTitle: MutableTitle | undefined;

    pi.setLabel("Generative UI");

    function clearPending(): void {
      pendingIndex = undefined;
      pendingSession = undefined;
      pendingOpening = undefined;
      pendingTitle = undefined;
    }

    function trackSession(session: WidgetSession, title: string | (() => string)): WidgetSession {
      activeSessions.add(session);
      session.onClosed(() => {
        activeSessions.delete(session);
        for (const [key, existing] of sessionsByTitle) {
          if (existing === session) sessionsByTitle.delete(key);
        }
      });
      attachSvgSaver(session.rpc);
      attachAgentPrompt(session.rpc, {
        title,
        sendUserMessage(text, options) {
          pi.sendUserMessage(text, options);
        },
      });
      return session;
    }

    async function openWidgetSession(displayTitle: string, promptTitle: string | (() => string), width: number, height: number, floating: boolean | undefined, signal?: AbortSignal): Promise<WidgetSession> {
      const session = await WidgetSession.create(openSurface, { title: displayTitle, width, height, floating }, signal);
      return trackSession(session, promptTitle);
    }

    async function getPendingSession(): Promise<WidgetSession | undefined> {
      if (pendingSession) return pendingSession;
      if (!pendingOpening) return undefined;
      pendingSession = await pendingOpening;
      return pendingSession;
    }

    async function openOrReuseWidgetSession(title: string, width: number, height: number, floating: boolean | undefined, forceNewSurface: boolean, signal: AbortSignal | undefined, promptTitle: string | (() => string) = title): Promise<WidgetSession> {
      if (!forceNewSurface) {
        const existing = sessionsByTitle.get(title);
        if (existing) return existing;
      }
      const session = await openWidgetSession(title, promptTitle, width, height, floating, signal);
      sessionsByTitle.set(title, session);
      return session;
    }

    pi.on("before_agent_start", async () => ({
      message: {
        customType: "generative-ui-guidance",
        content: HIDDEN_GUIDANCE,
        display: false,
      },
    }));

    pi.on("message_update", async event => {
      const raw = event.assistantMessageEvent as AssistantStreamEvent | undefined;
      if (!raw) return;

      if (raw.type === "toolcall_start") {
        const block = raw.partial?.content?.[raw.contentIndex];
        if (block?.type !== "toolCall" || block.name !== "show_widget") return;
        const args = block.arguments ?? {};
        pendingIndex = raw.contentIndex;
        pendingTitle = { value: readTitle(args) ?? "" };
        pendingSession = undefined;
        pendingOpening = undefined;
        return;
      }

      if (raw.contentIndex !== pendingIndex) return;

      if (raw.type === "toolcall_delta") {
        const block = raw.partial?.content?.[raw.contentIndex];
        const args = block?.arguments ?? {};
        const streamedTitle = readTitle(args);
        if (streamedTitle && pendingTitle) pendingTitle.value = streamedTitle;
        const html = args.widget_code;
        if (typeof html !== "string") return;
        if (!pendingOpening && !pendingSession && pendingTitle?.value) {
          const width = typeof args.width === "number" ? args.width : DEFAULT_WIDTH;
          const height = typeof args.height === "number" ? args.height : DEFAULT_HEIGHT;
          const floating = typeof args.floating === "boolean" ? args.floating : undefined;
          const forceNewSurface = args.new_surface === true;
          const titleRef = pendingTitle;
          pendingOpening = openOrReuseWidgetSession(titleRef.value, width, height, floating, forceNewSurface, undefined, () => titleRef.value).catch(error => {
            pi.logger.error("generative-ui failed to open streaming cmux surface", { error });
            clearPending();
            return undefined;
          });
        }
        const session = await getPendingSession();
        session?.onChunk(html);
        return;
      }

      if (raw.type === "toolcall_end") {
        const html = raw.toolCall?.arguments?.widget_code;
        if (typeof html !== "string") return;
        const session = await getPendingSession();
        await session?.onComplete(html);
      }
    });

    const moduleEnum = z.enum(AVAILABLE_MODULES);
    const ReadMeParams = z.object({
      modules: z.array(moduleEnum).describe("Which design guideline module(s) to load. Pick all that fit."),
    });

    pi.registerTool<typeof ReadMeParams, ReadMeDetails>({
      name: "visualize_read_me",
      label: "Read Guidelines",
      description: "Returns design guidelines for show_widget. Call once before your first show_widget call. Do not mention this setup call to the user.",
      parameters: ReadMeParams,
      async execute(_toolCallId, params) {
        const modules = params.modules as readonly Module[];
        return {
          content: [{ type: "text", text: getGuidelines(modules) }],
          details: { modules },
        };
      },
    });

    const ShowWidgetParams = z.object({
      i_have_seen_read_me: z.boolean().describe("Confirm you already called visualize_read_me in this conversation."),
      title: z.string().describe("Short snake_case identifier for this widget, used as the browser title and prompt provenance."),
      widget_code: z.string().describe("HTML or SVG fragment to render. For SVG: raw SVG starting with <svg>. For HTML: raw fragment, no DOCTYPE/html/head/body."),
      width: z.number().optional().describe("Preferred widget width in pixels. Default: 800."),
      height: z.number().optional().describe("Preferred widget height in pixels. Default: 600."),
      floating: z.boolean().optional().describe("Compatibility flag from the Pi/Glimpse version. cmux surfaces ignore this."),
      new_surface: z.boolean().optional().describe("Open a fresh cmux surface even when another live widget has the same title. Default: false."),
    });

    pi.registerTool<typeof ShowWidgetParams, ShowWidgetDetails>({
      name: "show_widget",
      label: "Show Widget",
      description:
        "Render visual content — SVG graphics, diagrams, charts, or interactive HTML/JS widgets — in a cmux browser surface. " +
        "Call visualize_read_me first. Widget code may call sendPrompt(text) from explicit user-triggered handlers. " +
        "Calls with the same title update the existing live widget; set new_surface: true to force a separate cmux surface. " +
        "Use HTML/SVG fragments only; no DOCTYPE/html/head/body wrappers.",
      parameters: ShowWidgetParams,
      async execute(_toolCallId, params, signal) {
        if (!params.i_have_seen_read_me) {
          throw new Error("You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.");
        }
        if (signal?.aborted) throw new Error("show_widget aborted before execution");

        const code = params.widget_code;
        const title = normalizeTitle(params.title);
        if (pendingTitle) pendingTitle.value = title;
        const width = params.width ?? DEFAULT_WIDTH;
        const height = params.height ?? DEFAULT_HEIGHT;
        const forceNewSurface = params.new_surface === true;

        let session: WidgetSession;
        if (pendingSession || pendingOpening) {
          const existing = await getPendingSession();
          if (!existing) throw new Error("show_widget streaming session failed to open");
          session = existing;
          sessionsByTitle.set(title, session);
          clearPending();
        } else {
          session = await openOrReuseWidgetSession(title, width, height, params.floating, forceNewSurface, signal);
        }

        if (signal) {
          if (signal.aborted) {
            session.close();
            throw new Error("show_widget aborted before execution");
          }
          signal.addEventListener("abort", () => session.close(), { once: true });
        }

        await session.onComplete(code);

        return {
          content: [{ type: "text", text: `Widget "${title}" rendered in cmux (${width}×${height}).` }],
          details: { title, width, height, isSVG: code.trimStart().startsWith("<svg"), surface: session.surface.surfaceRef },
        };
      },
    });

    pi.on("session_shutdown", async () => {
      if (pendingSession) pendingSession.close();
      clearPending();
      for (const session of activeSessions) session.close();
      activeSessions.clear();
      sessionsByTitle.clear();
      closeServer();
    });
  };
}

function readTitle(args: Record<string, unknown>): string | undefined {
  return typeof args.title === "string" ? normalizeTitle(args.title) : undefined;
}

function normalizeTitle(title: string): string {
  return title.replace(/_/g, " ");
}

const generativeUiExtension = createGenerativeUiExtension();
export default generativeUiExtension;
