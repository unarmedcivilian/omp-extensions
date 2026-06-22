import { describe, expect, test } from "bun:test";
import { filterSnapshot, renderDashboard } from "../src/runtime/dashboard.js";
import type { PreviewSnapshot } from "../src/model.js";

const snapshot: PreviewSnapshot = {
  updatedAt: 1,
  counts: { pending: 0, running: 1, completed: 1, failed: 0, aborted: 0 },
  subagents: [
    { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: ["line"], toolCount: 1, tokens: 10, cost: 0.01, durationMs: 1000, nestedTaskCount: 2, transcript: [{ kind: "assistant", text: "hello", truncated: false }], updatedAt: 2 },
    { id: "B", index: 1, agent: "task", agentSource: "bundled", status: "completed", description: "Done", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [], updatedAt: 1 },
  ],
};

describe("dashboard rendering", () => {
  test("renders running and completed states", () => {
    const html = renderDashboard(snapshot, { filter: "all", expanded: new Set(["A"]) });
    expect(html).toContain("Active");
    expect(html).toContain("running");
    expect(html).toContain("hello");
    expect(html).toContain("Done");
  });

  test("renders accessible dashboard chrome and selected controls", () => {
    const html = renderDashboard(snapshot, { filter: "running", expanded: new Set(["A"]), followActive: true });
    expect(html).toContain("Subagent transcripts");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-scroll-key="transcript:A"');
    expect(html).toContain("Copy transcript");
    expect(html).toContain('data-focus-key="filter:running"');
    expect(html).toContain('data-focus-key="copy:A"');
  });

  test("keeps live announcements compact and captions semantic", () => {
    const html = renderDashboard(snapshot, { filter: "all", expanded: new Set(["A"]) });
    expect(html).toContain('class="lede" aria-live="polite"');
    expect(html).toContain('class="chip-label"');
    expect(html).toContain('class="follow-label"');
    expect(html).not.toContain("<label>");
    expect(html).not.toContain('<section class="agents" aria-live="polite">');
  });

  test("escapes dynamic dashboard content", () => {
    const unsafeId = 'A" onclick="bad';
    const html = renderDashboard({
      updatedAt: 1,
      counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
      subagents: [
        { id: unsafeId, index: 0, agent: "task", agentSource: "bundled", status: "running", description: '<Agent & "A">', recentTools: [], recentOutput: ['<raw & "quoted">'], toolCount: 0, tokens: 0, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: '<script>"x"</script>', timestamp: '<time & "now">' }], updatedAt: 1 },
      ],
    }, { filter: "all", expanded: new Set([unsafeId]) });

    expect(html).toContain("&lt;Agent &amp; &quot;A&quot;&gt;");
    expect(html).toContain('data-id="A&quot; onclick=&quot;bad"');
    expect(html).toContain("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
    expect(html).not.toContain('<script>"x"</script>');
  });


  test("renders all status filters and trajectory metadata", () => {
    const html = renderDashboard(snapshot, { filter: "all", expanded: new Set(["A"]) });
    expect(html).toContain('data-status="pending"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('data-status="aborted"');
    expect(html).toContain("1.0s");
    expect(html).toContain("2 nested");
  });
  test("filters by status", () => {
    expect(filterSnapshot(snapshot, "running").subagents.map(item => item.id)).toEqual(["A"]);
    expect(filterSnapshot(snapshot, "completed").subagents.map(item => item.id)).toEqual(["B"]);
  });
});
