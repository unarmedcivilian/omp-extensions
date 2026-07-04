import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createAccordionBrowserOpener, type AccordionBrowserOpenResult, type OpenAccordionBrowser } from "./cmux.js";
import { AccordionSession, type AccordionSessionOptions } from "./session.js";

interface ChainLike {
  describe(text?: string): ChainLike;
  optional(): ChainLike;
}

interface ZLike {
  object(shape: Record<string, unknown>): unknown;
  array(value: unknown): unknown;
  string(): ChainLike;
}

export interface AccordionExtensionDeps {
  clientRoot?: string;
  createSession?: (options: AccordionSessionOptions) => Promise<AccordionSessionLike>;
  openBrowser?: OpenAccordionBrowser;
  requestTimeoutMs?: number;
  unfoldTimeoutMs?: number;
  recallTimeoutMs?: number;
}

interface AccordionSessionLike {
  url(): string;
  close(): Promise<void>;
  onSessionStart?(ctx: unknown): unknown;
  onBeforeAgentStart?(ctx: unknown): unknown;
  onContext?(event: unknown, ctx: unknown): unknown;
  onMessageUpdate?(event: unknown, ctx: unknown): unknown;
  onMessageEnd?(event: unknown, ctx: unknown): unknown;
  onAgentEnd?(event: unknown, ctx: unknown): unknown;
  onBeforeCompact?(event: unknown, ctx: unknown): unknown;
  requestUnfold?(codes: string[], signal?: AbortSignal): Promise<unknown>;
  requestRecall?(codes: string[], signal?: AbortSignal): Promise<unknown>;
}

const installedApis = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return !!value && typeof value === "object";
}

function toRecord(value: object): Record<PropertyKey, unknown> {
  return value as Record<PropertyKey, unknown>;
}

function zFrom(pi: ExtensionAPI): ZLike {
  const moduleValue: unknown = pi.zod;
  if (isObject(moduleValue)) {
    const moduleRecord = toRecord(moduleValue);
    if (isObject(moduleRecord.z)) return moduleRecord.z as ZLike;
  }
  return moduleValue as ZLike;
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function defaultClientRoot(): string {
  return join(packageRoot(), "dist", "client");
}

function notify(pi: ExtensionAPI, ctx: unknown, text: string, type: "info" | "warning" = "info"): void {
  if (isObject(ctx)) {
    const ctxRecord = toRecord(ctx);
    if (isObject(ctxRecord.ui)) {
      const uiRecord = toRecord(ctxRecord.ui);
      if (typeof uiRecord.notify === "function") {
        uiRecord.notify(text, type);
        return;
      }
    }
  }
  const piValue: unknown = pi;
  if (!isObject(piValue)) return;
  const piRecord = toRecord(piValue);
  if (typeof piRecord.sendMessage === "function") piRecord.sendMessage(text);
}

function codesFromParams(params: Record<string, unknown>): string[] {
  const raw = params.codes;
  return Array.isArray(raw) ? raw.map(item => String(item).trim()).filter(Boolean) : [];
}

function labelOf(item: unknown): string {
  if (!isObject(item)) return "block";
  const record = toRecord(item);
  if (typeof record.label === "string") return record.label;
  if (typeof record.title === "string") return record.title;
  return "block";
}

function codeOf(item: unknown): string {
  if (!isObject(item)) return "?";
  const record = toRecord(item);
  return typeof record.code === "string" ? record.code : "?";
}

function textOf(item: unknown): string {
  if (!isObject(item)) return "";
  const record = toRecord(item);
  return typeof record.text === "string" ? record.text : "";
}

function resultRecord(value: unknown): { restored: unknown[]; missing: string[] } | null {
  if (!isObject(value)) return null;
  const record = toRecord(value);
  return {
    restored: Array.isArray(record.restored) ? record.restored : [],
    missing: Array.isArray(record.missing) ? record.missing.map(item => String(item)) : [],
  };
}

function textResult<TDetails = unknown>(text: string, details?: TDetails, isError = false): AgentToolResult<TDetails> {
  return { content: [{ type: "text", text }], ...(details !== undefined ? { details } : {}), ...(isError ? { isError: true } : {}) };
}

function openLine(result: AccordionBrowserOpenResult): string {
  if (result.ok) return result.surface ? `Surface: opened in cmux (${result.surface})` : "Surface: opened in cmux";
  return `cmux open failed: ${result.error ?? "socket unavailable"}`;
}

export function createAccordionExtension(deps: AccordionExtensionDeps = {}): (pi: ExtensionAPI) => void {
  return function accordionExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi as object)) {
      pi.logger.warn("accordion extension already installed; skipping duplicate registration");
      return;
    }
    installedApis.add(pi as object);

    const z = zFrom(pi);
    const clientRoot = deps.clientRoot ?? defaultClientRoot();
    const createSession = deps.createSession ?? ((options: AccordionSessionOptions) => AccordionSession.create(options));
    const openBrowser = deps.openBrowser ?? createAccordionBrowserOpener();
    let session: AccordionSessionLike | null = null;

    const ensureSession = async (ctx?: unknown): Promise<AccordionSessionLike> => {
      if (session) return session;
      session = await createSession({
        clientRoot,
        ctx,
        requestTimeoutMs: deps.requestTimeoutMs,
        unfoldTimeoutMs: deps.unfoldTimeoutMs,
        recallTimeoutMs: deps.recallTimeoutMs,
      });
      return session;
    };

    pi.setLabel("Accordion");

    const CodesParams = z.object({
      codes: z.array(z.string().describe("A fold code copied verbatim from a {#<code> FOLDED} tag.")),
    });

    pi.registerCommand("accordion", {
      description: "Open Accordion for this OMP session",
      handler: async (_args: string, ctx: unknown) => {
        const active = await ensureSession(ctx);
        const url = active.url();
        const opened = await openBrowser(url).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        notify(pi, ctx, [`Accordion ready for this OMP session.`, opened.ok ? `Browser: ${url}` : `Open this URL manually: ${url}`, openLine(opened)].join("\n"), opened.ok ? "info" : "warning");
      },
    });

    pi.registerTool<typeof CodesParams, unknown>({
      name: "accordion_unfold",
      label: "Accordion Unfold",
      description: "Restore Accordion-folded context by code from a `{#<code> FOLDED}` marker. The original content is preserved and returns on the next turn.",
      parameters: CodesParams,
      async execute(_toolCallId, params, signal) {
        const codes = codesFromParams(params);
        if (!codes.length) return textResult("No fold codes given. Pass codes from `{#<code> FOLDED}` markers.");
        if (!session?.requestUnfold) return textResult(`Accordion is detached. Run /accordion, then retry accordion_unfold with: ${codes.join(", ")}`);
        const raw = await session.requestUnfold(codes, signal);
        const result = resultRecord(raw);
        if (!result) return textResult(signal?.aborted ? "accordion_unfold cancelled before Accordion responded." : "Accordion did not respond. Run /accordion and retry.", raw, signal?.aborted);
        const lines: string[] = [];
        if (result.restored.length) {
          lines.push(`Unfolded ${result.restored.length} block(s); full content returns on your next turn:`);
          for (const item of result.restored) lines.push(`  • ${labelOf(item)} (#${codeOf(item)})`);
        }
        if (result.missing.length) lines.push(`No folded block for: ${result.missing.map(code => `#${code}`).join(", ")}`);
        return textResult(lines.join("\n") || "Nothing unfolded.", raw);
      },
    });

    pi.registerTool<typeof CodesParams, unknown>({
      name: "accordion_recall",
      label: "Accordion Recall",
      description: "Read Accordion-folded context immediately by code from a `{#<code> FOLDED}` marker without changing standing context.",
      parameters: CodesParams,
      async execute(_toolCallId, params, signal) {
        const codes = codesFromParams(params);
        if (!codes.length) return textResult("No fold codes given. Pass codes from `{#<code> FOLDED}` markers.");
        if (!session?.requestRecall) return textResult(`Accordion is detached. Run /accordion, then retry accordion_recall with: ${codes.join(", ")}`);
        const raw = await session.requestRecall(codes, signal);
        const result = resultRecord(raw);
        if (!result) return textResult(signal?.aborted ? "accordion_recall cancelled before Accordion responded." : "Accordion did not respond. Run /accordion and retry.", raw, signal?.aborted);
        const content = result.restored.map(item => `[recalled ${labelOf(item)} (#${codeOf(item)})]\n${textOf(item)}`);
        if (result.missing.length) content.push(`No folded block for: ${result.missing.map(code => `#${code}`).join(", ")}`);
        return textResult(content.join("\n") || "Nothing to recall.", raw);
      },
    });

    pi.on("session_start", async (_event, ctx) => (await ensureSession(ctx)).onSessionStart?.(ctx));
    pi.on("before_agent_start", async (_event, ctx) => (await ensureSession(ctx)).onBeforeAgentStart?.(ctx));
    pi.on("context", async (event, ctx) => session?.onContext?.(event, ctx));
    pi.on("message_update", (event, ctx) => session?.onMessageUpdate?.(event, ctx));
    pi.on("message_end", (event, ctx) => session?.onMessageEnd?.(event, ctx));
    pi.on("agent_end", (event, ctx) => session?.onAgentEnd?.(event, ctx));
    pi.on("session_before_compact", (event, ctx) => session?.onBeforeCompact?.(event, ctx));
    pi.on("session_shutdown", async () => {
      await session?.close();
      session = null;
    });
    pi.on("resources_discover", () => {
      const skillRoot = join(packageRoot(), "skills");
      const skillPaths = ["accordion-context-folding", "accordion-context-recall"]
        .map(name => join(skillRoot, name))
        .filter(path => existsSync(path));
      return skillPaths.length ? { skillPaths } : {};
    });
  };
}

export default createAccordionExtension();
