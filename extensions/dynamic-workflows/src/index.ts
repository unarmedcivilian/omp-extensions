import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { WorkflowAgent } from "./agent.js";
import {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
  type WorkflowAgentSnapshot,
  type WorkflowAgentStatus,
  type WorkflowDisplay,
  type WorkflowDisplayOptions,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type AgentOptions, type WorkflowMeta, type WorkflowMetaPhase, type WorkflowRunOptions, type WorkflowRunResult } from "./workflow.js";
import { createWorkflowTool, type WorkflowToolInput, type WorkflowToolOptions } from "./workflow-tool.js";

const installedApis = new WeakSet<object>();

const HIDDEN_WORKFLOW_GUIDANCE = `[Dynamic Workflows extension active]
Use the workflow tool only when the user explicitly asks for workflows, fan-out, or multi-agent orchestration.
Workflow scripts must be raw JavaScript with first statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }.
Available globals inside workflow scripts: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget.
parallel() takes functions, not promises: await parallel(items.map(item => () => agent('...', { label: '...' }))).
Call phase(title) when a runtime group starts; phase names may be conditional or loop-created.
Every agent() call should include a unique short label. Failed non-aborted branches return null; check nulls before synthesis.
For nontrivial workflow scripts, read skill://using-dynamic-workflows before composing the script.
For structured subagent output, pass a plain JSON Schema via opts.schema; the subagent must finish through OMP's yield tool.
Return compact JSON-serializable workflow results.`;

export function createDynamicWorkflowsExtension(): (pi: ExtensionAPI) => void {
  return function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi as object)) {
      pi.logger.warn("dynamic-workflows extension already installed; skipping duplicate registration");
      return;
    }
    installedApis.add(pi as object);
    pi.setLabel("Dynamic Workflows");

    const workflowTool = createWorkflowTool(pi.zod, { sdk: pi.pi });
    pi.registerTool(workflowTool);

    let hiddenGuidanceSent = false;
    pi.on("before_agent_start", async () => {
      if (hiddenGuidanceSent) return undefined;
      hiddenGuidanceSent = true;
      return {
        message: {
          customType: "dynamic-workflows-guidance",
          content: HIDDEN_WORKFLOW_GUIDANCE,
          display: false,
        },
      };
    });

    pi.on("session_start", async () => {
      const active = pi.getActiveTools();
      if (!active.includes(workflowTool.name)) {
        await pi.setActiveTools([...active, workflowTool.name]);
      }
    });
  };
}

const dynamicWorkflowsExtension = createDynamicWorkflowsExtension();
export default dynamicWorkflowsExtension;

export { WorkflowAgent };
export type {
  AgentOptions,
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowDisplay,
  WorkflowDisplayOptions,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowSnapshot,
  WorkflowToolInput,
  WorkflowToolOptions,
};
export {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  createWorkflowTool,
  parseWorkflowScript,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
  runWorkflow,
};
