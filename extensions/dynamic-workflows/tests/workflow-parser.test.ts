import { describe, expect, test } from "bun:test";
import { parseWorkflowScript } from "../src/workflow.js";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  whenToUse: 'When testing parser behavior',
  phases: [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }]
}

phase('Scan')
return { ok: true }
`;

describe("parseWorkflowScript", () => {
  test("accepts literal workflow metadata", () => {
    const parsed = parseWorkflowScript(validScript);

    expect(parsed.meta.name).toBe("demo_workflow");
    expect(parsed.meta.description).toBe("A useful workflow");
    expect(parsed.meta.phases).toEqual([{ title: "Scan", detail: "Collect inputs", model: "default" }]);
    expect(parsed.body).toContain("phase('Scan')");
    expect(parsed.body).not.toContain("export const meta");
  });

  test("accepts static template literals", () => {
    const parsed = parseWorkflowScript("export const meta = { name: `demo`, description: `static text` }\nreturn 1");

    expect(parsed.meta).toMatchObject({ name: "demo", description: "static text" });
  });

  test("requires meta export first", () => {
    expect(() => parseWorkflowScript("const x = 1; export const meta = { name: 'x', description: 'y' }"))
      .toThrow(/must be the first statement/);
  });

  test("requires name and description", () => {
    expect(() => parseWorkflowScript("export const meta = { name: '', description: 'ok' }"))
      .toThrow(/meta.name/);
    expect(() => parseWorkflowScript("export const meta = { name: 'ok' }"))
      .toThrow(/meta.description/);
  });

  test("rejects non-literal metadata", () => {
    const cases = [
      "export const meta = buildMeta()",
      "export const meta = { name: process.env.NAME, description: 'x' }",
      "export const meta = { name: 'x', description: `${value}` }",
    ];

    for (const script of cases) {
      expect(() => parseWorkflowScript(script)).toThrow();
    }
  });

  test("rejects object and array hazards", () => {
    const cases = [
      "export const meta = { __proto__: { polluted: true }, name: 'x', description: 'y' }",
      "export const meta = { ...base, name: 'x', description: 'y' }",
      "export const meta = { name: 'x', description: 'y', phases: [,,] }",
      "export const meta = { name: 'x', description: 'y', phases: [...items] }",
    ];

    for (const script of cases) {
      expect(() => parseWorkflowScript(script)).toThrow();
    }
  });

  test("rejects nondeterministic APIs", () => {
    const cases = [
      "export const meta = { name: 'x', description: 'y' }\nDate.now()",
      "export const meta = { name: 'x', description: 'y' }\nMath.random()",
      "export const meta = { name: 'x', description: 'y' }\nnew Date()",
    ];

    for (const script of cases) {
      expect(() => parseWorkflowScript(script)).toThrow(/deterministic/);
    }
  });

  test("rejects quoted reserved metadata keys and inherited-only metadata", () => {
    const cases = [
      "export const meta = { \"__proto__\": { name: 'x', description: 'y' } }",
      "export const meta = { name: 'x', description: 'y', nested: { \"constructor\": 'bad' } }",
      "export const meta = { name: 'x', description: 'y', phases: [{ \"prototype\": 'bad', title: 'Scan' }] }",
      "export const meta = { \"\\u005f\\u005fproto\\u005f\\u005f\": { name: 'x', description: 'y' } }",
      "export const meta = { name: 'x', description: 'y', nested: { \"\\x63onstructor\": 'bad' } }",
      "export const meta = { name: 'x', description: 'y', phases: [{ \"\\u{70}rototype\": 'bad', title: 'Scan' }] }",
    ];

    for (const script of cases) {
      expect(() => parseWorkflowScript(script)).toThrow(/reserved key name/);
    }
  });

  test("rejects deterministic but non-literal metadata expressions", () => {
    const cases = [
      "export const meta = { name: 'x' + 'y', description: 'z' }",
      "export const meta = { name: true ? 'x' : 'y', description: 'z' }",
      "export const meta = { name: String.name, description: 'z' }",
      "export const meta = ({ name: 'x', description: 'z' })",
      "export const meta = { name: 'x', description: 'z' }, other = 1",
    ];

    for (const script of cases) {
      expect(() => parseWorkflowScript(script)).toThrow();
    }
  });

  test("allows deterministic Date and Math APIs", () => {
    const parsed = parseWorkflowScript(
      "export const meta = { name: 'x', description: 'y' }\nconst d = Date.UTC(2020, 0, 1); const m = Math.max(1, 2); return { d, m }",
    );

    expect(parsed.body).toContain("Date.UTC");
    expect(parsed.body).toContain("Math.max");
  });

  test("allows nondeterministic API names in text", () => {
    const parsed = parseWorkflowScript(
      "export const meta = { name: 'x', description: 'Mentions Date.now() and Math.random() only as words' }\nreturn 'new Date() text'",
    );

    expect(parsed.meta.description).toContain("Date.now()");
  });

  test("allows banned API names inside regex literals", () => {
    const parsed = parseWorkflowScript(
      "export const meta = { name: 'x', description: 'Regex text only' }\nconst re = /Date.now(?:)|Math.random(?:)|new Date(?:)/; return re",
    );

    expect(parsed.body).toContain("Date.now");
  });
});
