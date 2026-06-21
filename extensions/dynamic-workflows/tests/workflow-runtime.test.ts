import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

describe("runWorkflow", () => {
  test("accepts metadata without phases and records runtime phases", async () => {
    const result = await runWorkflow(
      `export const meta = {
        name: 'runtime_phases',
        description: 'Runtime phases demo'
      }
      phase('Scan')
      const scan = await agent('scan')
      return { scan }
      `,
      { agent: fakeAgent },
    );
    const value = result.result as { scan: string };

    expect(result.phases).toEqual(["Scan"]);
    expect(result.agentCount).toBe(1);
    expect(value.scan).toBe("result:scan");
  });

  test("records loop-created phases without skipped conditional phases", async () => {
    const result = await runWorkflow(
      `export const meta = {
        name: 'loop_phases',
        description: 'Loop-created phases demo'
      }
      const areas = ['API', 'UI']
      const outputs = []
      for (const area of areas) {
        phase('Inspect ' + area)
        outputs.push(await agent('inspect ' + area, { label: area }))
      }
      if (false) phase('Skipped')
      return outputs
      `,
      { agent: fakeAgent },
    );

    expect(result.phases).toEqual(["Inspect API", "Inspect UI"]);
    expect(result.agentCount).toBe(2);
  });

  test("rejects unawaited nested agent promises before returning details", async () => {
    let ended = 0;

    await expect(
      runWorkflow(
        `export const meta = {
          name: 'bad_promises',
          description: 'Bad promise demo'
        }
        const pending = agent('scan')
        return { pending }
        `,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended += 1;
          },
        },
      ),
    ).rejects.toThrow(/workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/);

    expect(ended).toBe(1);
  });

  test("rejects non-string runtime phase titles", async () => {
    await expect(
      runWorkflow(
        `export const meta = { name: 'bad_phase', description: 'Bad phase demo' }
        phase(123)
        return {}
        `,
        { agent: fakeAgent },
      ),
    ).rejects.toThrow(/phase title must be a string/);
  });

  test("allows prompts that mention nondeterministic API names", async () => {
    const result = await runWorkflow(
      `export const meta = { name: 'text_mentions', description: 'Text mentions demo' }
      const output = await agent('Explain why Date.now() and Math.random() are not allowed')
      return { output }
      `,
      { agent: fakeAgent },
    );
    const value = result.result as { output: string };

    expect(value.output).toContain("Date.now()");
  });
});
