import { describe, expect, test } from "bun:test";

async function readSkill(path: string) {
  const file = Bun.file(path);
  expect(await file.exists()).toBe(true);
  return file.text();
}

describe("packaged Accordion skills", () => {
  test("context folding skill tells agents to use accordion_unfold markers", async () => {
    const text = await readSkill("skills/accordion-context-folding/SKILL.md");

    expect(text).toContain("accordion_unfold");
    expect(text).toContain("{#<code> FOLDED}");
    expect(text).not.toContain("unfold({codes");
  });

  test("context recall skill tells agents to use accordion_recall markers", async () => {
    const text = await readSkill("skills/accordion-context-recall/SKILL.md");

    expect(text).toContain("accordion_recall");
    expect(text).toContain("{#<code> FOLDED}");
    expect(text).not.toContain("recall({codes");
  });
});
