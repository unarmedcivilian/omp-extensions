import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createDynamicWorkflowsExtension } from "../src/index.js";

interface Chain {
  describe(_text: string): Chain;
  optional(): Chain;
}

interface ZLike {
  object(shape: Record<string, unknown>): Chain & { shape: Record<string, unknown> };
  string(): Chain;
  any(): Chain;
}

interface FakePi {
  tools: Array<{ name: string; label: string; defaultInactive?: boolean }>;
  handlers: Map<string, (event: unknown) => unknown>;
  labels: string[];
  activeTools: string[];
  setActiveToolsCalls: string[][];
  api: ExtensionAPI;
}

function chain(): Chain {
  return {
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  };
}

function makeZ(): ZLike {
  return {
    object(shape) {
      return { ...chain(), shape };
    },
    string: chain,
    any: chain,
  };
}

function makeFakePi(activeTools: string[] = []): FakePi {
  const fake = {
    tools: [],
    handlers: new Map<string, (event: unknown) => unknown>(),
    labels: [],
    activeTools: [...activeTools],
    setActiveToolsCalls: [],
  } as FakePi;
  fake.api = {
    zod: makeZ(),
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    setLabel(label: string) {
      fake.labels.push(label);
    },
    registerTool(tool: { name: string; label: string; defaultInactive?: boolean }) {
      fake.tools.push(tool);
    },
    on(event: string, handler: (event: unknown) => unknown) {
      fake.handlers.set(event, handler);
    },
    getActiveTools() {
      return [...fake.activeTools];
    },
    async setActiveTools(toolNames: string[]) {
      fake.setActiveToolsCalls.push([...toolNames]);
      fake.activeTools = [...toolNames];
    },
  } as unknown as ExtensionAPI;
  return fake;
}

describe("dynamic workflow extension", () => {
  test("registers the workflow tool with OMP metadata", () => {
    const fake = makeFakePi();

    createDynamicWorkflowsExtension()(fake.api);

    expect(fake.labels).toEqual(["Dynamic Workflows"]);
    expect(fake.tools).toHaveLength(1);
    expect(fake.tools[0]).toMatchObject({ name: "workflow", label: "Workflow", defaultInactive: true });
    expect(fake.handlers.has("session_start")).toBe(true);
  });

  test("injects hidden workflow guidance before the first agent turn", async () => {
    const fake = makeFakePi();
    createDynamicWorkflowsExtension()(fake.api);

    const first = await fake.handlers.get("before_agent_start")?.({ type: "before_agent_start" });
    const second = await fake.handlers.get("before_agent_start")?.({ type: "before_agent_start" });

    expect(first).toMatchObject({
      message: {
        customType: "dynamic-workflows-guidance",
        display: false,
      },
    });
    expect(JSON.stringify(first)).toContain("parallel() takes functions");
    expect(JSON.stringify(first)).toContain("yield tool");
    expect(JSON.stringify(first)).toContain("skill://using-dynamic-workflows");
    expect(second).toBeUndefined();
  });

  test("ships an on-demand usage skill", async () => {
    const packageJson = (await Bun.file("package.json").json()) as { files?: string[] };
    const skillText = await Bun.file("skills/using-dynamic-workflows/SKILL.md").text();

    expect(packageJson.files).toContain("skills");
    expect(skillText).toContain("name: using-dynamic-workflows");
    expect(skillText).toContain("Use when");
    expect(skillText).toContain("parallel(thunks)");
    expect(skillText).toContain("opts.schema");
  });

  test("activates workflow on session_start when it is inactive", async () => {
    const fake = makeFakePi(["read"]);
    createDynamicWorkflowsExtension()(fake.api);

    await fake.handlers.get("session_start")?.({ reason: "startup" });

    expect(fake.setActiveToolsCalls).toEqual([["read", "workflow"]]);
  });

  test("does not duplicate workflow in active tools", async () => {
    const fake = makeFakePi(["read", "workflow"]);
    createDynamicWorkflowsExtension()(fake.api);

    await fake.handlers.get("session_start")?.({ reason: "startup" });

    expect(fake.setActiveToolsCalls).toEqual([]);
  });
});
