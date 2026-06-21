import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowAgentRunner, type WorkflowRunOptions, type WorkflowRunResult } from "./workflow.js";
import { WorkflowTextComponent } from "./text-component.js";

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
};

export interface WorkflowToolOptions
  extends Pick<
    WorkflowRunOptions,
    "cwd" | "sdk" | "agent" | "concurrency" | "tokenBudget" | "tools" | "session" | "instructions"
  > {}

export interface WorkflowToolDefinition extends ToolDefinition {
  promptSnippet: string;
  promptGuidelines: string[];
}

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const;

export function createWorkflowTool(z: ExtensionAPI["zod"], options: WorkflowToolOptions = {}): WorkflowToolDefinition {
  const workflowToolSchema = z.object({
    script: z.string().describe(
      [
        "Required raw JavaScript workflow script, with no Markdown fences.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
        "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
      ].join(" "),
    ),
    args: z.any().optional().describe("Optional JSON value exposed to the workflow script as global `args`."),
  });

  return {
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object through OMP's yield tool. Use JSON Schema syntax, not TypeScript constructors.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    ],
    parameters: workflowToolSchema,
    defaultInactive: true,
    async execute(_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<WorkflowSnapshot>> {
      const params = normalizeWorkflowToolArgs(rawParams);
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          agent: options.agent,
          sdk: options.sdk,
          signal,
          concurrency: options.concurrency,
          tokenBudget: options.tokenBudget,
          tools: options.tools,
          instructions: options.instructions,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
            ...options.session,
          },
          onLog(message) {
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            recordPhase(title);
            update();
          },
          onAgentStart(event) {
            if (signal?.aborted) throw new Error("Workflow was aborted");
            recordPhase(event.phase);
            snapshot.agents.push({
              id: snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
            });
            update();
          },
          onAgentEnd(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find(item => item.label === event.label && item.status === "running");
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
              agent.resultPreview = preview(event.result);
            }
            update();
          },
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      const details: WorkflowSnapshot = {
        ...snapshot,
        phases: result.phases,
        logs: result.logs,
        result: result.result,
        durationMs: result.durationMs,
      };

      return {
        content: [
          {
            type: "text",
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
          },
        ],
        details,
      };
    },
    renderCall(_args, _options, theme) {
      return new WorkflowTextComponent(theme.fg("toolTitle", theme.bold("workflow")));
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details;
      if (isWorkflowSnapshot(snapshot)) {
        return new WorkflowTextComponent(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions));
      }
      const text = result.content?.[0];
      return new WorkflowTextComponent(text?.type === "text" ? text.text : theme.fg("muted", "workflow"));
    },
  };
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!isRecord(args)) throw new Error("workflow requires an object argument with a script string");
  if (typeof args.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { script: normalizeWorkflowScript(args.script), args: args.args };
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /\babort(?:ed)?\b/i.test(error.message);
}

function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
  return isRecord(value) && typeof value.name === "string" && Array.isArray(value.agents);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
