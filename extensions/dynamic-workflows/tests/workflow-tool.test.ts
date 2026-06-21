import { describe, expect, test } from "bun:test";
import { createWorkflowTool } from "../src/workflow-tool.js";

interface Chain {
  describe(_text: string): Chain;
  optional(): Chain;
}

interface ZLike {
  object(shape: Record<string, unknown>): Chain & { shape: Record<string, unknown> };
  string(): Chain;
  any(): Chain;
}

function makeZ(): ZLike {
  const chain: Chain = {
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  };
  return {
    object(shape) {
      return { ...chain, shape };
    },
    string() {
      return chain;
    },
    any() {
      return chain;
    },
  };
}

describe("createWorkflowTool", () => {
  test("describes phases as optional and dynamic", () => {
    const tool = createWorkflowTool(makeZ());

    expect(tool.promptSnippet ?? "").toContain("export const meta = { name: 'short_snake_case', description:");
    expect(tool.promptSnippet ?? "").not.toContain("phases: [");
    expect(tool.promptGuidelines?.some(line => line.includes("meta.phases is optional metadata"))).toBe(true);
    expect(tool.promptGuidelines?.some(line => line.includes("Phase names may be conditional or built in a loop"))).toBe(true);
  });

  test("executes normalized fenced scripts and returns workflow details", async () => {
    const tool = createWorkflowTool(makeZ(), {
      agent: {
        async run(prompt: string) {
          return `result:${prompt}`;
        },
      },
    });
    const updates: unknown[] = [];

    const result = await tool.execute(
      "call-1",
      {
        script: "```js\nexport const meta = { name: 'demo_workflow', description: 'Demo workflow' }\nphase('Scan')\nconst scan = await agent('inspect')\nreturn { scan }\n```",
      },
      undefined,
      update => updates.push(update),
      { cwd: "/repo", modelRegistry: {}, model: {} } as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Workflow demo_workflow completed with 1 agent(s).",
    );
    expect(result.details).toMatchObject({ name: "demo_workflow", phases: ["Scan"], result: { scan: "result:inspect" } });
    expect(updates.length).toBeGreaterThan(0);
  });
});
