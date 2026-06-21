# Subagent Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `omp-subagent-preview`, a standalone OMP extension that opens a cmux browser dashboard for live subagent trajectory summaries.

**Architecture:** The extension subscribes to OMP task lifecycle/progress channels through `pi.events`, normalizes state in memory, enriches rows by tailing subagent session JSONL files, and streams snapshots to one cmux browser split. Browser close detaches only; explicit commands control auto-open enablement.

**Tech Stack:** Bun workspace package, TypeScript ESM, OMP `ExtensionAPI`, `@oh-my-pi/pi-coding-agent/task` event exports, Bun HTTP/WebSocket server, cmux socket API with CLI fallback, browser runtime bundled with Bun.

---

## Reference inputs

- Spec: `docs/superpowers/specs/2026-06-21-subagent-preview-design.md`
- Extension API docs:
  - `reference/oh-my-pi/docs/extensions.md`
  - `reference/oh-my-pi/docs/extension-loading.md`
  - `reference/oh-my-pi/docs/skills/authoring-extensions.md`
- Existing patterns:
  - `extensions/generative-ui/src/cmux.ts`
  - `extensions/generative-ui/src/surface.ts`
  - `extensions/generative-ui/src/session.ts`
  - `extensions/generative-ui/src/protocol.ts`
  - `extensions/chatgpt-links/src/cmux.ts`
  - `extensions/dynamic-workflows/tests/extension.test.ts`

## File structure

Create `extensions/subagent-preview` with these responsibilities:

- `package.json` — OMP package manifest, scripts, peer dependencies.
- `README.md` — user-facing behavior, commands, privacy defaults, development commands. Write in the final docs task.
- `src/index.ts` — OMP factory, idempotent install, lifecycle handlers, command registration.
- `src/controller.ts` — session controller, auto-open state machine, command behavior, snapshot broadcast orchestration.
- `src/model.ts` — normalized state types and pure update/snapshot helpers.
- `src/collector.ts` — task event-channel subscription and event-to-model adapter.
- `src/transcript.ts` — session JSONL incremental tailer and compact transcript summarizer.
- `src/cmux.ts` — cmux socket/CLI transport for browser surfaces.
- `src/surface.ts` — browser surface object and host-vs-browser close handling.
- `src/server.ts` — local Bun HTTP/WebSocket server, token registration, snapshot delivery.
- `src/protocol.ts` — host/page message validation types.
- `src/runtime/main.ts` — browser entrypoint: WebSocket connect, state, controls.
- `src/runtime/dashboard.ts` — pure dashboard rendering helpers used by runtime tests.
- `src/runtime.bundle.ts` — generated runtime HTML export.
- `src/build.mjs` — builds `runtime.bundle.ts` from `src/runtime/main.ts`.
- `tests/*.test.ts` — package tests described below.

Modify root files:

- `package.json` — add `bun --cwd extensions/subagent-preview test/check` to root `test` and `check` scripts.
- `README.md` — add package description and commands in the final docs task.

---

### Task 1: Package scaffold and extension registration

**Files:**
- Create: `extensions/subagent-preview/package.json`
- Create: `extensions/subagent-preview/src/index.ts`
- Create: `extensions/subagent-preview/tests/extension.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing extension registration test**

Create `extensions/subagent-preview/tests/extension.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createSubagentPreviewExtension } from "../src/index.js";

interface FakeEventBus {
  handlers: Map<string, Array<(data: unknown) => void>>;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

function makeEventBus(): FakeEventBus {
  return {
    handlers: new Map(),
    on(channel, handler) {
      const list = this.handlers.get(channel) ?? [];
      list.push(handler);
      this.handlers.set(channel, list);
      return () => this.handlers.set(channel, (this.handlers.get(channel) ?? []).filter(item => item !== handler));
    },
  };
}

function makePi() {
  const events = makeEventBus();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
  const labels: string[] = [];
  const pi = {
    events,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    setLabel(label: string) { labels.push(label); },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, handlers, commands, labels };
}

describe("subagent preview extension", () => {
  test("registers label, lifecycle handlers, and preview command", () => {
    const fake = makePi();

    createSubagentPreviewExtension()(fake.pi);

    expect(fake.labels).toEqual(["Subagent Preview"]);
    expect(fake.commands.has("subagent-preview")).toBe(true);
    expect(fake.handlers.has("session_start")).toBe(true);
    expect(fake.handlers.has("session_switch")).toBe(true);
    expect(fake.handlers.has("session_branch")).toBe(true);
    expect(fake.handlers.has("session_tree")).toBe(true);
    expect(fake.handlers.has("session_shutdown")).toBe(true);
  });

  test("does not double-register on the same ExtensionAPI", () => {
    const fake = makePi();
    const install = createSubagentPreviewExtension();

    install(fake.pi);
    install(fake.pi);

    expect(fake.labels).toEqual(["Subagent Preview"]);
    expect(fake.handlers.get("session_start")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test
```

Expected: FAIL because `extensions/subagent-preview` does not exist or `../src/index.js` cannot be resolved.

- [ ] **Step 3: Create package manifest and minimal extension**

Create `extensions/subagent-preview/package.json`:

```json
{
  "name": "omp-subagent-preview",
  "version": "0.1.0",
  "description": "Live cmux browser dashboard for OMP subagent trajectories",
  "type": "module",
  "keywords": ["omp-package", "oh-my-pi", "subagents", "cmux"],
  "files": ["src", "README.md"],
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "omp": { "extensions": ["./src/index.ts"] },
  "scripts": {
    "build:runtime": "bun src/build.mjs",
    "test": "bun test tests/*.test.ts",
    "check": "bun run build:runtime && bun test tests/*.test.ts && bun build src/index.ts --target=bun --external @oh-my-pi/pi-coding-agent --external @oh-my-pi/pi-ai --outdir /tmp/omp-subagent-preview-check"
  },
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": "^15",
    "@oh-my-pi/pi-ai": "^15"
  },
  "engines": { "bun": ">=1.3.14" },
  "license": "MIT"
}
```

Create `extensions/subagent-preview/src/index.ts`:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const installedApis = new WeakSet<object>();

export function createSubagentPreviewExtension(): (pi: ExtensionAPI) => void {
  return function subagentPreviewExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi as object)) {
      pi.logger.warn("subagent-preview extension already installed; skipping duplicate registration");
      return;
    }
    installedApis.add(pi as object);
    pi.setLabel("Subagent Preview");

    pi.on("session_start", async () => undefined);
    pi.on("session_switch", async () => undefined);
    pi.on("session_branch", async () => undefined);
    pi.on("session_tree", async () => undefined);
    pi.on("session_shutdown", async () => undefined);

    pi.registerCommand("subagent-preview", {
      description: "Open, close, enable, or disable the subagent preview dashboard",
      handler: async () => undefined,
    });
  };
}

const subagentPreviewExtension = createSubagentPreviewExtension();
export default subagentPreviewExtension;
```

Modify root `package.json` scripts to include the new package:

```json
{
  "scripts": {
    "test": "bun test tests/*.test.ts && bun --cwd extensions/generative-ui test && bun --cwd extensions/chatgpt-links test && bun --cwd extensions/dynamic-workflows test && bun --cwd extensions/subagent-preview test",
    "check": "bun test tests/*.test.ts && bun --cwd extensions/generative-ui check && bun --cwd extensions/chatgpt-links check && bun --cwd extensions/dynamic-workflows check && bun --cwd extensions/subagent-preview check"
  }
}
```

Create a temporary `extensions/subagent-preview/src/build.mjs` so `check` has a runtime artifact until Task 7 replaces it:

```js
await Bun.write(new URL("./runtime.bundle.ts", import.meta.url), "export const RUNTIME_HTML = `<!doctype html><title>Subagent Preview</title><div id=\"root\"></div>`;\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
bun --cwd extensions/subagent-preview test
```

Expected: PASS for `extension.test.ts`.

- [ ] **Step 5: Commit**

```sh
git add package.json extensions/subagent-preview/package.json extensions/subagent-preview/src/index.ts extensions/subagent-preview/src/build.mjs extensions/subagent-preview/tests/extension.test.ts
git commit -m "feat: scaffold subagent preview extension"
```

---

### Task 2: Normalized preview model and collector

**Files:**
- Create: `extensions/subagent-preview/src/model.ts`
- Create: `extensions/subagent-preview/src/collector.ts`
- Create: `extensions/subagent-preview/tests/model.test.ts`
- Create: `extensions/subagent-preview/tests/collector.test.ts`

- [ ] **Step 1: Write failing model tests**

Create `extensions/subagent-preview/tests/model.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyLifecycle, applyProgress, createPreviewState, snapshotPreview } from "../src/model.js";

describe("preview model", () => {
  test("creates subagents from lifecycle and updates terminal state", () => {
    const state = createPreviewState();
    applyLifecycle(state, {
      id: "AgentA",
      agent: "task",
      agentSource: "bundled",
      description: "Inspect API",
      status: "started",
      sessionFile: "/tmp/a.jsonl",
      index: 0,
    });
    applyLifecycle(state, {
      id: "AgentA",
      agent: "task",
      agentSource: "bundled",
      description: "Inspect API",
      status: "completed",
      sessionFile: "/tmp/a.jsonl",
      index: 0,
    });

    const snapshot = snapshotPreview(state);
    expect(snapshot.counts.completed).toBe(1);
    expect(snapshot.subagents[0]).toMatchObject({ id: "AgentA", status: "completed", sessionFile: "/tmp/a.jsonl" });
  });

  test("progress updates live fields and active agents sort before terminal agents", () => {
    const state = createPreviewState();
    applyLifecycle(state, { id: "Done", agent: "task", agentSource: "bundled", status: "completed", index: 0 });
    applyProgress(state, {
      index: 1,
      agent: "task",
      agentSource: "bundled",
      task: "Run tests",
      assignment: "Run tests",
      progress: {
        index: 1,
        id: "Active",
        agent: "task",
        agentSource: "bundled",
        status: "running",
        task: "Run tests",
        assignment: "Run tests",
        description: "Test runner",
        currentTool: "bash",
        currentToolArgs: "bun test",
        recentTools: [],
        recentOutput: ["running"],
        toolCount: 1,
        tokens: 12,
        cost: 0.001,
        durationMs: 500,
      },
      sessionFile: "/tmp/b.jsonl",
    });

    const snapshot = snapshotPreview(state);
    expect(snapshot.subagents.map(item => item.id)).toEqual(["Active", "Done"]);
    expect(snapshot.subagents[0]).toMatchObject({ currentTool: "bash", recentOutput: ["running"], tokens: 12 });
  });

  test("terminal lifecycle state is not reverted by stale progress", () => {
    const state = createPreviewState();
    applyLifecycle(state, { id: "A", agent: "task", agentSource: "bundled", status: "completed", index: 0 });
    applyProgress(state, {
      index: 0,
      agent: "task",
      agentSource: "bundled",
      task: "Old progress",
      progress: {
        index: 0,
        id: "A",
        agent: "task",
        agentSource: "bundled",
        status: "running",
        task: "Old progress",
        recentTools: [],
        recentOutput: ["late"],
        toolCount: 1,
        tokens: 2,
        cost: 0,
        durationMs: 10,
      },
    });

    expect(snapshotPreview(state).subagents[0].status).toBe("completed");
    expect(snapshotPreview(state).counts.completed).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/model.test.ts
```

Expected: FAIL because `src/model.ts` does not exist.

- [ ] **Step 3: Implement the model**

Create `extensions/subagent-preview/src/model.ts` with these exports:

```ts
import type { AgentProgress, AgentSource, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task";

export type PreviewStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface TranscriptEntry {
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  text: string;
  timestamp?: string;
  truncated?: boolean;
  isError?: boolean;
}

export interface PreviewSubagent {
  id: string;
  index: number;
  agent: string;
  agentSource: AgentSource;
  description?: string;
  assignment?: string;
  task?: string;
  status: PreviewStatus;
  sessionFile?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentTools: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput: string[];
  toolCount: number;
  tokens: number;
  contextTokens?: number;
  contextWindow?: number;
  cost: number;
  durationMs: number;
  nestedTaskCount: number;
  transcript: TranscriptEntry[];
  updatedAt: number;
}

export interface PreviewSnapshot {
  subagents: PreviewSubagent[];
  counts: Record<PreviewStatus, number>;
  updatedAt: number;
}

export interface PreviewState {
  subagents: Map<string, PreviewSubagent>;
  updatedAt: number;
}

const TERMINAL = new Set<PreviewStatus>(["completed", "failed", "aborted"]);

export function createPreviewState(): PreviewState {
  return { subagents: new Map(), updatedAt: Date.now() };
}

export function applyLifecycle(state: PreviewState, payload: SubagentLifecyclePayload): PreviewSubagent {
  const status = payload.status === "started" ? "running" : payload.status;
  const existing = state.subagents.get(payload.id);
  const next = existing ?? createSubagent(payload.id, payload.index, payload.agent, payload.agentSource);
  next.status = status;
  next.description = payload.description ?? next.description;
  next.sessionFile = payload.sessionFile ?? next.sessionFile;
  next.updatedAt = Date.now();
  state.subagents.set(next.id, next);
  state.updatedAt = next.updatedAt;
  return next;
}

export function applyProgress(state: PreviewState, payload: SubagentProgressPayload): PreviewSubagent {
  const progress = payload.progress;
  const existing = state.subagents.get(progress.id);
  const next = existing ?? createSubagent(progress.id, progress.index, progress.agent, progress.agentSource);
  if (!existing || !TERMINAL.has(existing.status)) next.status = progress.status;
  next.description = progress.description ?? next.description;
  next.assignment = progress.assignment ?? payload.assignment ?? next.assignment;
  next.task = progress.task ?? payload.task ?? next.task;
  next.sessionFile = payload.sessionFile ?? next.sessionFile;
  next.currentTool = progress.currentTool;
  next.currentToolArgs = progress.currentToolArgs;
  next.recentTools = progress.recentTools ?? [];
  next.recentOutput = progress.recentOutput ?? [];
  next.toolCount = progress.toolCount ?? 0;
  next.tokens = progress.tokens ?? 0;
  next.contextTokens = progress.contextTokens;
  next.contextWindow = progress.contextWindow;
  next.cost = progress.cost ?? 0;
  next.durationMs = progress.durationMs ?? 0;
  next.nestedTaskCount = countNestedTasks(progress);
  next.updatedAt = Date.now();
  state.subagents.set(next.id, next);
  state.updatedAt = next.updatedAt;
  return next;
}

export function replaceTranscript(state: PreviewState, id: string, transcript: TranscriptEntry[]): void {
  const subagent = state.subagents.get(id);
  if (!subagent) return;
  subagent.transcript = transcript;
  subagent.updatedAt = Date.now();
  state.updatedAt = subagent.updatedAt;
}

export function snapshotPreview(state: PreviewState): PreviewSnapshot {
  const counts: PreviewSnapshot["counts"] = { pending: 0, running: 0, completed: 0, failed: 0, aborted: 0 };
  const subagents = [...state.subagents.values()].sort(compareSubagents);
  for (const subagent of subagents) counts[subagent.status] += 1;
  return { subagents, counts, updatedAt: state.updatedAt };
}

function createSubagent(id: string, index: number, agent: string, agentSource: AgentSource): PreviewSubagent {
  return {
    id,
    index,
    agent,
    agentSource,
    status: "pending",
    recentTools: [],
    recentOutput: [],
    toolCount: 0,
    tokens: 0,
    cost: 0,
    durationMs: 0,
    nestedTaskCount: 0,
    transcript: [],
    updatedAt: Date.now(),
  };
}

function compareSubagents(a: PreviewSubagent, b: PreviewSubagent): number {
  const aTerminal = TERMINAL.has(a.status);
  const bTerminal = TERMINAL.has(b.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
  return b.updatedAt - a.updatedAt || a.index - b.index || a.id.localeCompare(b.id);
}

function countNestedTasks(progress: AgentProgress): number {
  const inflight = progress.inflightTaskDetails?.progress?.length ?? 0;
  const finished = progress.extractedToolData?.task?.length ?? 0;
  return inflight + finished;
}
```

- [ ] **Step 4: Run model test to verify it passes**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing collector tests**

Create `extensions/subagent-preview/tests/collector.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { SubagentPreviewCollector } from "../src/collector.js";

function makeEventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    handlers,
    on(channel: string, handler: (data: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter(item => item !== handler));
    },
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

describe("SubagentPreviewCollector", () => {
  test("subscribes to lifecycle and progress and emits snapshots", () => {
    const bus = makeEventBus();
    const snapshots: unknown[] = [];
    const collector = new SubagentPreviewCollector(bus, snapshot => snapshots.push(snapshot), { debounceMs: 0 });

    collector.start();
    bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
      index: 0,
      agent: "task",
      agentSource: "bundled",
      task: "Inspect",
      progress: { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", task: "Inspect", recentTools: [], recentOutput: ["hi"], toolCount: 0, tokens: 1, cost: 0, durationMs: 1 },
    });

    expect(snapshots).toHaveLength(2);
    expect((snapshots.at(-1) as { subagents: Array<{ id: string; recentOutput: string[] }> }).subagents[0]).toMatchObject({ id: "A", recentOutput: ["hi"] });
    collector.stop();
  });

  test("stop unsubscribes from event bus", () => {
    const bus = makeEventBus();
    const collector = new SubagentPreviewCollector(bus, () => {}, { debounceMs: 0 });
    collector.start();
    collector.stop();
    expect(bus.handlers.get(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toEqual([]);
    expect(bus.handlers.get(TASK_SUBAGENT_PROGRESS_CHANNEL)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run collector test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/collector.test.ts
```

Expected: FAIL because `src/collector.ts` does not exist.

- [ ] **Step 7: Implement collector**

Create `extensions/subagent-preview/src/collector.ts` with:

```ts
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
  type SubagentLifecyclePayload,
  type SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task";
import { applyLifecycle, applyProgress, createPreviewState, snapshotPreview, type PreviewSnapshot, type PreviewState } from "./model.js";

export interface CollectorOptions { debounceMs?: number }
export type CollectorEventBus = Pick<EventBus, "on">;

export class SubagentPreviewCollector {
  readonly state: PreviewState = createPreviewState();
  #unsubscribers: Array<() => void> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #debounceMs: number;

  constructor(
    readonly eventBus: CollectorEventBus,
    readonly onSnapshot: (snapshot: PreviewSnapshot) => void,
    options: CollectorOptions = {},
  ) {
    this.#debounceMs = options.debounceMs ?? 150;
  }

  start(): void {
    if (this.#unsubscribers.length > 0) return;
    this.#unsubscribers.push(
      this.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
        applyLifecycle(this.state, data as SubagentLifecyclePayload);
        this.#emitSoon();
      }),
      this.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
        applyProgress(this.state, data as SubagentProgressPayload);
        this.#emitSoon();
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #emitSoon(): void {
    if (this.#debounceMs <= 0) {
      this.onSnapshot(snapshotPreview(this.state));
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.onSnapshot(snapshotPreview(this.state));
    }, this.#debounceMs);
  }
}
```

If TypeScript rejects importing `EventBus` through package exports during `check`, replace the import with the local structural type only:

```ts
export interface CollectorEventBus { on(channel: string, handler: (data: unknown) => void): () => void }
```

- [ ] **Step 8: Run collector and model tests**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/model.test.ts tests/collector.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add extensions/subagent-preview/src/model.ts extensions/subagent-preview/src/collector.ts extensions/subagent-preview/tests/model.test.ts extensions/subagent-preview/tests/collector.test.ts
git commit -m "feat: collect subagent preview state"
```

---

### Task 3: Controller auto-open, close, and command state

**Files:**
- Create: `extensions/subagent-preview/src/controller.ts`
- Create: `extensions/subagent-preview/tests/controller.test.ts`

- [ ] **Step 1: Write failing controller tests**

Create `extensions/subagent-preview/tests/controller.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PreviewController, type PreviewSurface } from "../src/controller.js";
import { createPreviewState, applyLifecycle, snapshotPreview } from "../src/model.js";

function makeSnapshot(id = "A") {
  const state = createPreviewState();
  applyLifecycle(state, { id, agent: "task", agentSource: "bundled", status: "started", index: 0 });
  return snapshotPreview(state);
}

function makeOpener(log: string[]) {
  return async (): Promise<PreviewSurface> => {
    const surface: PreviewSurface = {
      surfaceRef: `surface:${log.length + 1}`,
      closed: false,
      sent: [],
      send(snapshot) { this.sent.push(snapshot); },
      close() { this.closed = true; log.push(`close:${this.surfaceRef}`); },
      onBrowserClose: undefined,
    };
    log.push(`open:${surface.surfaceRef}`);
    return surface;
  };
}

describe("PreviewController", () => {
  test("auto-opens on first spawn and sends snapshots", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));

    expect(log).toEqual(["open:surface:1"]);
    expect(controller.currentSurface?.sent).toHaveLength(1);
  });

  test("browser close detaches but later spawn reopens with existing state", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));
    controller.handleBrowserClose();
    await controller.handleSnapshot(makeSnapshot("B"));

    expect(log).toEqual(["open:surface:1", "open:surface:2"]);
    expect(controller.currentSurface?.sent.at(-1)).toMatchObject({ subagents: [{ id: "B" }] });
  });

  test("close command disables future auto-open", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.handleSnapshot(makeSnapshot("A"));
    await controller.runCommand("close");
    await controller.handleSnapshot(makeSnapshot("B"));

    expect(log).toEqual(["open:surface:1", "close:surface:1"]);
  });

  test("disable and enable control auto-open without closing existing surface", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.runCommand("disable");
    await controller.handleSnapshot(makeSnapshot("A"));
    await controller.runCommand("enable");
    await controller.handleSnapshot(makeSnapshot("B"));

    expect(log).toEqual(["open:surface:1"]);
  });

  test("no-args command opens without changing disabled state", async () => {
    const log: string[] = [];
    const controller = new PreviewController({ openSurface: makeOpener(log), notify: () => {} });

    await controller.runCommand("disable");
    await controller.runCommand("");
    await controller.handleSnapshot(makeSnapshot("A"));

    expect(log).toEqual(["open:surface:1"]);
  });

  test("dispose closes a surface that resolves after disposal", async () => {
    const log: string[] = [];
    const deferred = Promise.withResolvers<PreviewSurface>();
    const controller = new PreviewController({ openSurface: async () => deferred.promise, notify: () => {} });
    const opening = controller.handleSnapshot(makeSnapshot("A"));

    await controller.dispose();
    deferred.resolve({
      surfaceRef: "surface:late",
      closed: false,
      sent: [],
      send(snapshot) { this.sent.push(snapshot); },
      close() { this.closed = true; log.push(`close:${this.surfaceRef}`); },
    });
    await opening;

    expect(log).toEqual(["close:surface:late"]);
    expect(controller.currentSurface).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/controller.test.ts
```

Expected: FAIL because `src/controller.ts` does not exist.

- [ ] **Step 3: Implement controller**

Create `extensions/subagent-preview/src/controller.ts`:

```ts
import type { PreviewSnapshot } from "./model.js";

export interface PreviewSurface {
  surfaceRef?: string;
  closed: boolean;
  sent: PreviewSnapshot[];
  send(snapshot: PreviewSnapshot): void;
  close(): void;
  onBrowserClose?: (() => void) | undefined;
}

export interface PreviewControllerOptions {
  openSurface: () => Promise<PreviewSurface>;
  notify: (message: string, level?: "info" | "warn" | "error") => void;
}

export class PreviewController {
  currentSurface: PreviewSurface | undefined;
  #latestSnapshot: PreviewSnapshot | undefined;
  #autoOpenEnabled = true;
  #opening: Promise<void> | undefined;
  #generation = 0;

  constructor(readonly options: PreviewControllerOptions) {}

  async handleSnapshot(snapshot: PreviewSnapshot): Promise<void> {
    this.#latestSnapshot = snapshot;
    if (!this.currentSurface && this.#autoOpenEnabled && snapshot.subagents.length > 0) {
      await this.#ensureSurface();
    }
    this.currentSurface?.send(snapshot);
  }

  handleBrowserClose(): void {
    this.currentSurface = undefined;
  }

  async runCommand(rawArgs: string): Promise<void> {
    const command = rawArgs.trim().toLowerCase();
    if (command === "close") {
      this.#autoOpenEnabled = false;
      const surface = this.currentSurface;
      this.currentSurface = undefined;
      surface?.close();
      return;
    }
    if (command === "disable") {
      this.#autoOpenEnabled = false;
      return;
    }
    if (command === "enable") {
      this.#autoOpenEnabled = true;
      if (this.#latestSnapshot?.subagents.length) await this.#ensureSurface();
      return;
    }
    if (command === "" || command === "open") {
      await this.#ensureSurface();
      return;
    }
    this.options.notify("Usage: /subagent-preview [open|close|enable|disable]", "warn");
  }

  async dispose(): Promise<void> {
    this.#generation++;
    const surface = this.currentSurface;
    this.currentSurface = undefined;
    surface?.close();
    await this.#opening;
  }

  async #ensureSurface(): Promise<void> {
    if (this.currentSurface) {
      if (this.#latestSnapshot) this.currentSurface.send(this.#latestSnapshot);
      return;
    }
    if (this.#opening) return this.#opening;
    const generation = this.#generation;
    this.#opening = (async () => {
      try {
        const surface = await this.options.openSurface();
        if (generation !== this.#generation) {
          surface.close();
          return;
        }
        surface.onBrowserClose = () => this.handleBrowserClose();
        this.currentSurface = surface;
        if (this.#latestSnapshot) surface.send(this.#latestSnapshot);
      } catch (error) {
        if (generation === this.#generation) this.options.notify(`Subagent preview unavailable: ${String(error)}`, "warn");
      } finally {
        if (generation === this.#generation) this.#opening = undefined;
      }
    })();
    return this.#opening;
  }
}
```

This structural `PreviewSurface` will be adapted to the real surface in Task 4.

- [ ] **Step 4: Run controller test to verify it passes**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/controller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add extensions/subagent-preview/src/controller.ts extensions/subagent-preview/tests/controller.test.ts
git commit -m "feat: add subagent preview controller"
```

---

### Task 4: cmux transport, surface lifecycle, and local server

**Files:**
- Create: `extensions/subagent-preview/src/cmux.ts`
- Create: `extensions/subagent-preview/src/protocol.ts`
- Create: `extensions/subagent-preview/src/surface.ts`
- Create: `extensions/subagent-preview/src/server.ts`
- Create: `extensions/subagent-preview/tests/cmux.test.ts`
- Create: `extensions/subagent-preview/tests/surface.test.ts`
- Create: `extensions/subagent-preview/tests/server.test.ts`
- Modify: `extensions/subagent-preview/src/controller.ts`

- [ ] **Step 1: Write failing cmux transport tests**

Create `extensions/subagent-preview/tests/cmux.test.ts` using the same cases as `extensions/generative-ui/tests/cmux.test.ts`, but with `openBrowserSurface` expected to call socket method `browser.open_split` and CLI command `cmux --json browser open-split <url> --focus false`.

Minimum test body:

```ts
import { describe, expect, test } from "bun:test";
import { CmuxSocketUnavailableError, createCmuxSocketTransport, createCmuxTransport, parseCmuxSurfaceRef, type CmuxTransport } from "../src/cmux.js";

describe("subagent preview cmux transport", () => {
  test("parses cmux surface refs", () => {
    expect(parseCmuxSurfaceRef({ surface_ref: "surface:42" })).toBe("surface:42");
    expect(() => parseCmuxSurfaceRef({ pane: "pane:1" })).toThrow("cmux browser open did not return a surface ref");
  });

  test("opens browser split through socket", async () => {
    const calls: unknown[] = [];
    const transport = createCmuxSocketTransport(async (method, params) => {
      calls.push({ method, params });
      return { surface_ref: "surface:7" };
    }, { env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" } });

    await expect(transport.openBrowserSurface("http://127.0.0.1:1234/subagent-preview/t")).resolves.toBe("surface:7");
    expect(calls).toEqual([{ method: "browser.open_split", params: { url: "http://127.0.0.1:1234/subagent-preview/t", focus: false, workspace_id: "workspace:1", surface_id: "surface:1" } }]);
  });

  test("falls back to CLI when socket is unavailable", async () => {
    const calls: string[] = [];
    const socket: CmuxTransport = { async openBrowserSurface() { calls.push("socket.open"); throw new CmuxSocketUnavailableError("missing"); }, async closeSurface() { calls.push("socket.close"); throw new CmuxSocketUnavailableError("missing"); } };
    const cli: CmuxTransport = { async openBrowserSurface() { calls.push("cli.open"); return "surface:8"; }, async closeSurface() { calls.push("cli.close"); } };
    const transport = createCmuxTransport({ socket, cli });

    await expect(transport.openBrowserSurface("http://example.test")).resolves.toBe("surface:8");
    await expect(transport.closeSurface("surface:8")).resolves.toBeUndefined();
    expect(calls).toEqual(["socket.open", "cli.open", "socket.close", "cli.close"]);
  });
});
```

- [ ] **Step 2: Run cmux test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/cmux.test.ts
```

Expected: FAIL because `src/cmux.ts` does not exist.

- [ ] **Step 3: Implement cmux transport**

Create `extensions/subagent-preview/src/cmux.ts` by adapting `extensions/generative-ui/src/cmux.ts` and `extensions/chatgpt-links/src/cmux.ts`:

- Keep `CmuxSocketUnavailableError`, `createCmuxSocketRequester`, `createCmuxSocketTransport`, `createCmuxCliTransport`, `createCmuxTransport`, `parseCmuxSurfaceRef`.
- Socket open method: `browser.open_split` with `{ url, focus: false, workspace_id, surface_id }`.
- Socket close method: `surface.close` with `{ surface_id, workspace_id }`.
- CLI open command: `cmux --json browser open-split <url> --focus false`, plus `--workspace <id>` when `CMUX_WORKSPACE_ID` exists.
- CLI close command: `cmux close-surface --surface <surface>`, plus `--workspace <id>` when present.
- Fallback only on `CmuxSocketUnavailableError`.

- [ ] **Step 4: Run cmux test to verify it passes**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/cmux.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing surface and server tests**

Create `extensions/subagent-preview/tests/surface.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PreviewBrowserSurface, createPreviewSurfaceOpener, type PreviewServerLike } from "../src/surface.js";
import type { CmuxTransport } from "../src/cmux.js";

class FakeServer implements PreviewServerLike {
  registered: PreviewBrowserSurface[] = [];
  unregistered: string[] = [];
  register(surface: PreviewBrowserSurface): URL { this.registered.push(surface); return new URL(`http://127.0.0.1:1234/subagent-preview/${surface.token}`); }
  unregister(token: string): void { this.unregistered.push(token); }
}

function transport(calls: string[]): CmuxTransport {
  return { async openBrowserSurface(url) { calls.push(`open:${url}`); return "surface:5"; }, async closeSurface(surface) { calls.push(`close:${surface}`); } };
}

describe("PreviewBrowserSurface", () => {
  test("host close unregisters and closes cmux surface", async () => {
    const calls: string[] = [];
    const server = new FakeServer();
    const opener = createPreviewSurfaceOpener({ server, transport: transport(calls), tokenFactory: () => "fixed" });
    const surface = await opener();

    surface.close();
    await Promise.resolve();

    expect(server.unregistered).toEqual(["fixed"]);
    expect(calls).toEqual(["open:http://127.0.0.1:1234/subagent-preview/fixed", "close:surface:5"]);
  });

  test("browser close unregisters without closing cmux surface", async () => {
    const calls: string[] = [];
    const server = new FakeServer();
    const opener = createPreviewSurfaceOpener({ server, transport: transport(calls), tokenFactory: () => "fixed" });
    const surface = await opener();

    surface.browserClosed();
    await Promise.resolve();

    expect(server.unregistered).toEqual(["fixed"]);
    expect(calls).toEqual(["open:http://127.0.0.1:1234/subagent-preview/fixed"]);
  });
});
```

Create `extensions/subagent-preview/tests/server.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { LocalPreviewServer } from "../src/server.js";
import { PreviewBrowserSurface } from "../src/surface.js";

describe("LocalPreviewServer", () => {
  test("serves runtime HTML for registered tokens", async () => {
    const server = new LocalPreviewServer("<!doctype html><title>Subagent Preview</title>");
    const surface = new PreviewBrowserSurface("tok", () => {});
    try {
      const url = server.register(surface);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Subagent Preview");
    } finally {
      server.close();
    }
  });

  test("websocket ready receives latest snapshot", async () => {
    const server = new LocalPreviewServer("<!doctype html><title>Subagent Preview</title>");
    const surface = new PreviewBrowserSurface("tok", () => {});
    try {
      server.register(surface);
      surface.send({ subagents: [], counts: { pending: 0, running: 0, completed: 0, failed: 0, aborted: 0 }, updatedAt: 1 });
      const ws = new WebSocket(new URL("/ws/tok", server.baseUrl));
      const received = Promise.withResolvers<unknown>();
      ws.addEventListener("message", event => received.resolve(JSON.parse(String(event.data))), { once: true });
      await new Promise<void>(resolve => ws.addEventListener("open", () => resolve(), { once: true }));
      ws.send(JSON.stringify({ type: "ready" }));
      await expect(received.promise).resolves.toMatchObject({ type: "snapshot", snapshot: { updatedAt: 1 } });
      ws.close();
    } finally {
      server.close();
    }
  });

  test("websocket disconnect keeps token registered and reconnect receives latest snapshot", async () => {
    const server = new LocalPreviewServer("<!doctype html><title>Subagent Preview</title>");
    const surface = new PreviewBrowserSurface("tok", () => {});
    try {
      server.register(surface);
      surface.send({ subagents: [], counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 }, updatedAt: 2 });
      const first = new WebSocket(new URL("/ws/tok", server.baseUrl));
      await new Promise<void>(resolve => first.addEventListener("open", () => resolve(), { once: true }));
      first.close();
      await new Promise(resolve => setTimeout(resolve, 0));

      const second = new WebSocket(new URL("/ws/tok", server.baseUrl));
      const received = Promise.withResolvers<unknown>();
      second.addEventListener("message", event => received.resolve(JSON.parse(String(event.data))), { once: true });
      await new Promise<void>(resolve => second.addEventListener("open", () => resolve(), { once: true }));
      second.send(JSON.stringify({ type: "ready" }));

      await expect(received.promise).resolves.toMatchObject({ type: "snapshot", snapshot: { updatedAt: 2 } });
      second.close();
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 6: Run surface/server tests to verify they fail**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/surface.test.ts tests/server.test.ts
```

Expected: FAIL because `surface.ts`, `server.ts`, and `protocol.ts` do not exist.

- [ ] **Step 7: Implement protocol, surface, and server**

Create `extensions/subagent-preview/src/protocol.ts`:

```ts
import type { PreviewSnapshot } from "./model.js";

export interface SnapshotMessage { type: "snapshot"; snapshot: PreviewSnapshot }
export interface PageReady { type: "ready" }
export type HostToPage = SnapshotMessage;
export type PageToHost = PageReady;

export function isPageToHost(value: unknown): value is PageToHost {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "ready";
}
```

Create `extensions/subagent-preview/src/surface.ts` by adapting the generative UI surface lifecycle:

- `PreviewBrowserSurface` stores `token`, `surfaceRef`, latest snapshot, optional socket, and close source.
- `send(snapshot)` stores latest snapshot and sends `{ type: "snapshot", snapshot }` if socket attached.
- `receiveFromBrowser(data)` parses JSON and on `ready` sends latest snapshot.
- `detachSocket(socket)` clears only the matching WebSocket; it keeps the token registered and does not detach the dashboard.
- `browserClosed()` calls internal close with source `browser` for an actual cmux/browser-surface close.
- `close()` calls internal close with source `host`.
- `createPreviewSurfaceOpener` registers a token URL, opens cmux browser surface, and on host close invokes transport close.

Create `extensions/subagent-preview/src/server.ts` by adapting `LocalWidgetServer`:

- Path prefix: `/subagent-preview/<token>`.
- WebSocket path: `/ws/<token>`.
- On WebSocket close, call `surface.detachSocket(wsSocket)`; do not call `surface.browserClosed()` for transient socket disconnects.
- Serve `RUNTIME_HTML` string passed to constructor.

- [ ] **Step 8: Run surface/server tests to verify they pass**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/cmux.test.ts tests/surface.test.ts tests/server.test.ts
```

Expected: PASS.

- [ ] **Step 9: Adapt controller to real surface**

Modify `extensions/subagent-preview/src/controller.ts` so `PreviewSurface` matches `PreviewBrowserSurface`:

- Remove test-only `sent` and `closed` from production interface if needed.
- Keep tests using a fake structural surface.
- Ensure `handleBrowserClose()` is wired through `PreviewBrowserSurface` close callback in the opener.

- [ ] **Step 10: Run controller and surface tests**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/controller.test.ts tests/surface.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```sh
git add extensions/subagent-preview/src/cmux.ts extensions/subagent-preview/src/protocol.ts extensions/subagent-preview/src/surface.ts extensions/subagent-preview/src/server.ts extensions/subagent-preview/src/controller.ts extensions/subagent-preview/tests/cmux.test.ts extensions/subagent-preview/tests/surface.test.ts extensions/subagent-preview/tests/server.test.ts
git commit -m "feat: add subagent preview browser surface"
```

---

### Task 5: Transcript tailing and summarization

**Files:**
- Create: `extensions/subagent-preview/src/transcript.ts`
- Create: `extensions/subagent-preview/tests/transcript.test.ts`
- Modify: `extensions/subagent-preview/src/model.ts`

- [ ] **Step 1: Write failing transcript tests**

Create `extensions/subagent-preview/tests/transcript.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarizeSessionEntry, TranscriptTailer } from "../src/transcript.js";

describe("transcript summarizer", () => {
  test("summarizes assistant text and hides thinking", () => {
    const entry = { type: "message", timestamp: "t", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Visible answer" }] } };
    expect(summarizeSessionEntry(entry)).toEqual([{ kind: "assistant", timestamp: "t", text: "Visible answer", truncated: false }]);
  });

  test("summarizes tool calls and truncates large results", () => {
    const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x".repeat(1000) } }] } };
    const result = { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "y".repeat(1000) }] } };
    expect(summarizeSessionEntry(call)[0]).toMatchObject({ kind: "tool_call", text: expect.stringContaining("bash"), truncated: true });
    expect(summarizeSessionEntry(result)[0]).toMatchObject({ kind: "tool_result", isError: true, truncated: true });
  });
});

describe("TranscriptTailer", () => {
  test("parses appended JSONL incrementally and tolerates partial lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-preview-"));
    const file = join(dir, "session.jsonl");
    try {
      await writeFile(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } })}\n`);
      const tailer = new TranscriptTailer(file);
      expect(await tailer.readNew()).toEqual([{ kind: "assistant", text: "one", truncated: false }]);
      await appendFile(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "two" }] } })}`);
      expect(await tailer.readNew()).toEqual([]);
      await appendFile(file, "\n");
      expect(await tailer.readNew()).toEqual([{ kind: "assistant", text: "two", truncated: false }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/transcript.test.ts
```

Expected: FAIL because `src/transcript.ts` does not exist.

- [ ] **Step 3: Implement transcript summarizer and tailer**

Create `extensions/subagent-preview/src/transcript.ts`:

```ts
import { open } from "node:fs/promises";
import { Buffer } from "node:buffer";
import type { TranscriptEntry } from "./model.js";

const MAX_TEXT = 500;

export class TranscriptTailer {
  #offset = 0;
  #partial = "";

  constructor(readonly path: string) {}

  async readNew(): Promise<TranscriptEntry[]> {
    let text: string;
    try {
      const file = Bun.file(this.path);
      const size = file.size;
      if (size <= this.#offset) return [];
      const length = size - this.#offset;
      const buffer = Buffer.alloc(length);
      const handle = await open(this.path, "r");
      try {
        const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
        this.#offset += bytesRead;
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }

    const combined = this.#partial + text;
    const lines = combined.split("\n");
    this.#partial = lines.pop() ?? "";
    const entries: TranscriptEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(...summarizeSessionEntry(JSON.parse(line)));
      } catch {
        // Ignore malformed completed lines; partial trailing line is buffered separately.
      }
    }
    return entries;
  }
}

export function summarizeSessionEntry(entry: unknown): TranscriptEntry[] {
  if (!entry || typeof entry !== "object") return [];
  const record = entry as { timestamp?: string; type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") return [];
  const message = record.message as { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown };
  const timestamp = record.timestamp;

  if (message.role === "assistant" && Array.isArray(message.content)) {
    const out: TranscriptEntry[] = [];
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const item = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      if (item.type === "text" && typeof item.text === "string") out.push({ kind: "assistant", timestamp, ...truncate(item.text) });
      if (item.type === "toolCall" && typeof item.name === "string") out.push({ kind: "tool_call", timestamp, ...truncate(`${item.name} ${previewJson(item.arguments)}`) });
    }
    return out;
  }

  if (message.role === "toolResult") {
    const text = Array.isArray(message.content)
      ? message.content.map(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n")
      : "";
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    return [{ kind: "tool_result", timestamp, isError: message.isError === true, ...truncate(`${toolName}: ${text}`) }];
  }

  if (message.role === "user" && Array.isArray(message.content)) {
    const text = message.content.map(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n");
    return text ? [{ kind: "user", timestamp, ...truncate(text) }] : [];
  }

  return [];
}

function truncate(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_TEXT) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, MAX_TEXT - 12)}… [truncated]`, truncated: true };
}

function previewJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "[unserializable]"; }
}
```

- [ ] **Step 4: Run transcript test to verify it passes**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/transcript.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add extensions/subagent-preview/src/transcript.ts extensions/subagent-preview/tests/transcript.test.ts
git commit -m "feat: summarize subagent transcripts"
```

---

### Task 6: Wire extension, collector, controller, transcript tailers, and session resets

**Files:**
- Modify: `extensions/subagent-preview/src/index.ts`
- Modify: `extensions/subagent-preview/src/controller.ts`
- Modify: `extensions/subagent-preview/src/model.ts`
- Create: `extensions/subagent-preview/tests/integration.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `extensions/subagent-preview/tests/integration.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { createSubagentPreviewRuntime } from "../src/index.js";

function makeEventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    handlers,
    on(channel: string, handler: (data: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter(item => item !== handler));
    },
    emit(channel: string, data: unknown) { for (const handler of handlers.get(channel) ?? []) handler(data); },
  };
}

describe("subagent preview runtime wiring", () => {
  test("lifecycle event opens dashboard and shutdown disposes it", async () => {
    const eventBus = makeEventBus();
    const calls: string[] = [];
    const runtime = createSubagentPreviewRuntime({
      eventBus,
      debounceMs: 0,
      openSurface: async () => ({ surfaceRef: "surface:1", send() {}, close() { calls.push("close"); } }),
      notify: message => calls.push(`notify:${message}`),
    });

    runtime.start();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/a.jsonl", index: 0 });
    await runtime.flush();
    await runtime.shutdown();

    expect(calls).toContain("close");
  });

  test("session reset closes an open surface and keeps one active subscription", async () => {
    const eventBus = makeEventBus();
    const calls: string[] = [];
    const runtime = createSubagentPreviewRuntime({ eventBus, debounceMs: 0, transcriptPollMs: 0, openSurface: async () => ({ send() {}, close() { calls.push("close"); } }), notify: () => {} });

    runtime.start();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    await runtime.flush();
    await runtime.resetSession();

    expect(calls).toEqual(["close"]);
    expect(eventBus.handlers.get(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toHaveLength(1);
    await runtime.shutdown();
  });

  test("session reset restores auto-open defaults after disable", async () => {
    const eventBus = makeEventBus();
    const calls: string[] = [];
    const runtime = createSubagentPreviewRuntime({ eventBus, debounceMs: 0, transcriptPollMs: 0, openSurface: async () => { calls.push("open"); return { send() {}, close() { calls.push("close"); } }; }, notify: () => {} });

    runtime.start();
    await runtime.runCommand("disable");
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    await runtime.flush();
    expect(calls).toEqual([]);

    await runtime.resetSession();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "B", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    await runtime.flush();

    expect(calls).toEqual(["open"]);
    await runtime.shutdown();
  });

  test("runtime polling starts transcript tailers and merges bounded summaries", async () => {
    const eventBus = makeEventBus();
    const sent: unknown[] = [];
    const runtime = createSubagentPreviewRuntime({
      eventBus,
      debounceMs: 0,
      transcriptPollMs: 0,
      openSurface: async () => ({ send(snapshot) { sent.push(snapshot); }, close() {} }),
      notify: () => {},
      createTranscriptTailer: path => ({
        readNew: async () => [{ kind: "assistant", text: `summary from ${path}`, truncated: false }],
        stop: () => {},
      }),
    });

    runtime.start();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/a.jsonl", index: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(JSON.stringify(sent.at(-1))).toContain("summary from /tmp/a.jsonl");
    await runtime.shutdown();
  });
});
```

- [ ] **Step 2: Run integration test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/integration.test.ts
```

Expected: FAIL because `createSubagentPreviewRuntime` does not exist or controller is not wired.

- [ ] **Step 3: Implement runtime wiring**

Modify `extensions/subagent-preview/src/index.ts`:

- Export `createSubagentPreviewRuntime(options)` for tests.
- In the default extension, create runtime on `session_start` with:
  - `eventBus: pi.events`
  - `openSurface` using `LocalPreviewServer`, `createCmuxTransport`, `createPreviewSurfaceOpener`, and `RUNTIME_HTML`
  - `notify` using `ctx.ui.notify` when available or `pi.logger.warn` fallback
- On `session_switch`, `session_branch`, and `session_tree`, call `runtime.resetSession()`.
- On `session_shutdown`, call `runtime.shutdown()`.
- Register `/subagent-preview` command to forward args to `runtime.runCommand(args)` so commands always hit the current controller after session resets.
- Runtime wiring must start a `TranscriptTailer` for every subagent with a `sessionFile`, merge new entries with `replaceTranscript`, stop tailers for terminal subagents, and stop all tailers on reset/shutdown.

Implementation outline:

```ts
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SubagentPreviewCollector } from "./collector.js";
import { PreviewController } from "./controller.js";
import { createCmuxTransport } from "./cmux.js";
import { replaceTranscript, snapshotPreview, type PreviewSnapshot, type PreviewStatus } from "./model.js";
import { LocalPreviewServer } from "./server.js";
import { createPreviewSurfaceOpener } from "./surface.js";
import { TranscriptTailer } from "./transcript.js";
import { RUNTIME_HTML } from "./runtime.bundle.js";

export interface RuntimeTranscriptTailer {
  readNew(): Promise<import("./model.js").TranscriptEntry[]>;
  stop?(): void;
}

export interface RuntimeOptions {
  eventBus: { on(channel: string, handler: (data: unknown) => void): () => void };
  openSurface: () => Promise<{ send(snapshot: unknown): void; close(): void; surfaceRef?: string }>;
  notify: (message: string, level?: "info" | "warn" | "error") => void;
  debounceMs?: number;
  createTranscriptTailer?: (path: string) => RuntimeTranscriptTailer;
  transcriptPollMs?: number;
}

const TERMINAL = new Set<PreviewStatus>(["completed", "failed", "aborted"]);

export function createSubagentPreviewRuntime(options: RuntimeOptions) {
  const createController = () => new PreviewController({ openSurface: options.openSurface, notify: options.notify });
  let controller = createController();
  const createTailer = options.createTranscriptTailer ?? (path => new TranscriptTailer(path));
  const tailers = new Map<string, RuntimeTranscriptTailer>();
  let collector: SubagentPreviewCollector | undefined;
  let transcriptTimer: ReturnType<typeof setInterval> | undefined;
  let lastSnapshot: PreviewSnapshot | undefined;

  const handleSnapshot = (snapshot: PreviewSnapshot) => {
    lastSnapshot = snapshot;
    for (const subagent of snapshot.subagents) {
      if (subagent.sessionFile && !tailers.has(subagent.id) && !TERMINAL.has(subagent.status)) {
        tailers.set(subagent.id, createTailer(subagent.sessionFile));
        if (options.transcriptPollMs === 0) queueMicrotask(() => { void flushTranscripts(); });
      }
      if (TERMINAL.has(subagent.status) && tailers.has(subagent.id)) {
        const tailer = tailers.get(subagent.id)!;
        void flushTailer(subagent.id, tailer).finally(() => {
          tailer.stop?.();
          tailers.delete(subagent.id);
        });
      }
    }
    void controller.handleSnapshot(snapshot);
  };

  async function flushTailer(id: string, tailer: RuntimeTranscriptTailer): Promise<void> {
    if (!collector) return;
    const entries = await tailer.readNew();
    if (entries.length === 0) return;
    const existing = collector.state.subagents.get(id)?.transcript ?? [];
    replaceTranscript(collector.state, id, [...existing, ...entries].slice(-50));
  }

  async function flushTranscripts(): Promise<void> {
    if (!collector) return;
    for (const [id, tailer] of tailers) await flushTailer(id, tailer);
    handleSnapshot(snapshotPreview(collector.state));
  }

  function startTranscriptPolling(): void {
    if (options.transcriptPollMs === 0) return;
    const interval = options.transcriptPollMs ?? 500;
    transcriptTimer = setInterval(() => { void flushTranscripts(); }, interval);
  }

  function stopTranscriptPolling(): void {
    if (transcriptTimer) clearInterval(transcriptTimer);
    transcriptTimer = undefined;
  }

  return {
    get controller() { return controller; },
    start() {
      collector?.stop();
      collector = new SubagentPreviewCollector(options.eventBus, handleSnapshot, { debounceMs: options.debounceMs });
      collector.start();
      startTranscriptPolling();
    },
    async runCommand(args: string) {
      await controller.runCommand(args);
    },
    async flush() {
      if (lastSnapshot) await controller.handleSnapshot(lastSnapshot);
    },
    async resetSession() {
      collector?.stop();
      stopTranscriptPolling();
      for (const tailer of tailers.values()) tailer.stop?.();
      tailers.clear();
      await controller.dispose();
      controller = createController();
      lastSnapshot = undefined;
      collector = new SubagentPreviewCollector(options.eventBus, handleSnapshot, { debounceMs: options.debounceMs });
      collector.start();
      startTranscriptPolling();
    },
    async shutdown() {
      collector?.stop();
      collector = undefined;
      stopTranscriptPolling();
      for (const tailer of tailers.values()) tailer.stop?.();
      tailers.clear();
      await controller.dispose();
    },
  };
}
```

Then adapt the factory to own the real server and opener. Keep all runtime actions inside handlers/commands.

- [ ] **Step 4: Run integration and extension tests**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/extension.test.ts tests/integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add extensions/subagent-preview/src/index.ts extensions/subagent-preview/src/controller.ts extensions/subagent-preview/src/model.ts extensions/subagent-preview/tests/integration.test.ts
git commit -m "feat: wire subagent preview extension runtime"
```

---

### Task 7: Browser runtime dashboard and runtime bundle

**Files:**
- Create: `extensions/subagent-preview/src/runtime/dashboard.ts`
- Create: `extensions/subagent-preview/src/runtime/main.ts`
- Modify: `extensions/subagent-preview/src/build.mjs`
- Modify generated: `extensions/subagent-preview/src/runtime.bundle.ts`
- Create: `extensions/subagent-preview/tests/runtime-dashboard.test.ts`
- Create: `extensions/subagent-preview/tests/runtime-bridge.test.ts`

- [ ] **Step 1: Write failing pure dashboard tests**

Create `extensions/subagent-preview/tests/runtime-dashboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { filterSnapshot, renderDashboard } from "../src/runtime/dashboard.js";
import type { PreviewSnapshot } from "../src/model.js";

const snapshot: PreviewSnapshot = {
  updatedAt: 1,
  counts: { pending: 0, running: 1, completed: 1, failed: 0, aborted: 0 },
  subagents: [
    { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: ["line"], toolCount: 1, tokens: 10, cost: 0.01, durationMs: 1000, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "hello", truncated: false }], updatedAt: 2 },
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

  test("filters by status", () => {
    expect(filterSnapshot(snapshot, "running").subagents.map(item => item.id)).toEqual(["A"]);
    expect(filterSnapshot(snapshot, "completed").subagents.map(item => item.id)).toEqual(["B"]);
  });
});
```

- [ ] **Step 2: Run dashboard test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/runtime-dashboard.test.ts
```

Expected: FAIL because `src/runtime/dashboard.ts` does not exist.

- [ ] **Step 3: Implement pure dashboard rendering**

Create `extensions/subagent-preview/src/runtime/dashboard.ts`:

```ts
import type { PreviewSnapshot, PreviewStatus, PreviewSubagent } from "../model.js";

export type DashboardFilter = "all" | PreviewStatus;
export interface DashboardViewState { filter: DashboardFilter; expanded: Set<string> }

export function filterSnapshot(snapshot: PreviewSnapshot, filter: DashboardFilter): PreviewSnapshot {
  if (filter === "all") return snapshot;
  return { ...snapshot, subagents: snapshot.subagents.filter(item => item.status === filter) };
}

export function renderDashboard(snapshot: PreviewSnapshot, state: DashboardViewState): string {
  const filtered = filterSnapshot(snapshot, state.filter);
  return `
    <section class="summary">
      <button data-action="filter" data-status="all"><span>${snapshot.subagents.length}</span><label>all</label></button>
      <button data-action="filter" data-status="running"><span>${snapshot.counts.running}</span><label>running</label></button>
      <button data-action="filter" data-status="completed"><span>${snapshot.counts.completed}</span><label>completed</label></button>
      <button data-action="follow-active"><span>${snapshot.counts.failed + snapshot.counts.aborted}</span><label>follow active</label></button>
    </section>
    <section class="agents">
      ${filtered.subagents.map(agent => renderAgent(agent, state.expanded.has(agent.id))).join("") || `<p class="empty">No subagents match this filter.</p>`}
    </section>`;
}

function renderAgent(agent: PreviewSubagent, expanded: boolean): string {
  const transcript = expanded ? `<div class="transcript">${agent.transcript.map(entry => `<div class="entry ${entry.kind}">${escapeHtml(entry.text)}</div>`).join("")}</div>` : "";
  return `<article class="agent" data-id="${escapeHtml(agent.id)}" data-status="${agent.status}">
    <header data-action="toggle" data-agent-id="${escapeHtml(agent.id)}"><strong>${escapeHtml(agent.description ?? agent.id)}</strong><span>${agent.status}</span></header>
    <button data-action="copy" data-agent-id="${escapeHtml(agent.id)}">Copy summary</button>
    <div class="meta">${escapeHtml(agent.currentTool ?? "idle")} · ${agent.tokens.toLocaleString()} tokens · $${agent.cost.toFixed(4)}</div>
    ${agent.recentOutput.length ? `<pre>${escapeHtml(agent.recentOutput.join("\n"))}</pre>` : ""}
    ${transcript}
  </article>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
```

- [ ] **Step 4: Run dashboard test to verify it passes**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/runtime-dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing runtime bridge test**

Create `extensions/subagent-preview/tests/runtime-bridge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeWebSocketUrl, installRuntime, type RuntimeSocketLike } from "../src/runtime/main.js";

class FakeSocket implements RuntimeSocketLike {
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  send(data: string): void { this.sent.push(data); }
  open(): void { this.readyState = 1; for (const fn of this.listeners.get("open") ?? []) fn({}); }
  message(value: unknown): void { for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(value) }); }
}

class FakeRoot {
  innerHTML = "";
  listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click(dataset: Record<string, string>): void {
    const target = { closest: () => ({ dataset }) };
    for (const fn of this.listeners.get("click") ?? []) fn({ target });
  }
}

describe("runtime bridge", () => {
  test("computes websocket url", () => {
    expect(computeWebSocketUrl(new URL("http://127.0.0.1:1234/subagent-preview/tok"))).toBe("ws://127.0.0.1:1234/ws/tok");
  });

  test("sends ready and renders snapshots", () => {
    const socket = new FakeSocket();
    const root = { innerHTML: "" };
    installRuntime({ socket, root });
    socket.open();
    expect(socket.sent.map(JSON.parse)).toEqual([{ type: "ready" }]);
    socket.message({ type: "snapshot", snapshot: { updatedAt: 1, counts: { pending: 0, running: 0, completed: 0, failed: 0, aborted: 0 }, subagents: [] } });
    expect(root.innerHTML).toContain("No subagents");
  });

  test("dashboard controls are local and do not send socket messages", async () => {
    const socket = new FakeSocket();
    const root = new FakeRoot();
    const copied: string[] = [];
    installRuntime({ socket, root, clipboard: { writeText: async text => { copied.push(text); } } });
    socket.open();
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 1, completed: 1, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "hello", truncated: false }], updatedAt: 2 },
          { id: "B", index: 1, agent: "task", agentSource: "bundled", status: "completed", description: "Done", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [], updatedAt: 1 },
        ],
      },
    });

    root.click({ action: "filter", status: "completed" });
    expect(root.innerHTML).toContain("Done");
    expect(root.innerHTML).not.toContain("Active");
    root.click({ action: "toggle", agentId: "B" });
    root.click({ action: "copy", agentId: "B" });
    root.click({ action: "follow-active" });

    expect(copied[0]).toContain("Done");
    expect(socket.sent.map(JSON.parse)).toEqual([{ type: "ready" }]);
  });
});
```

- [ ] **Step 6: Run runtime bridge test to verify it fails**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/runtime-bridge.test.ts
```

Expected: FAIL because `src/runtime/main.ts` does not exist.

- [ ] **Step 7: Implement browser runtime**

Create `extensions/subagent-preview/src/runtime/main.ts`:

```ts
import { renderDashboard, type DashboardFilter } from "./dashboard.js";
import type { PreviewSnapshot } from "../model.js";

const SOCKET_OPEN = 1;
export interface RuntimeSocketLike {
  readyState: number;
  send(data: string): void;
  addEventListener(type: string, fn: (event: unknown) => void): void;
}

export interface RuntimeInstallOptions { socket?: RuntimeSocketLike; root?: { innerHTML: string; addEventListener?: (type: string, fn: (event: unknown) => void) => void; querySelector?: (selector: string) => { scrollIntoView?: () => void } | null }; location?: URL; clipboard?: { writeText(text: string): Promise<void> } }

export function computeWebSocketUrl(url: URL): string {
  const token = url.pathname.split("/").filter(Boolean).at(-1);
  if (!token) throw new Error("subagent preview URL does not include a session token");
  const ws = new URL(url);
  ws.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  ws.pathname = `/ws/${token}`;
  ws.search = "";
  ws.hash = "";
  return ws.toString();
}

export function installRuntime(options: RuntimeInstallOptions = {}): void {
  const root = options.root ?? document.getElementById("root") ?? document.body;
  const socket = options.socket ?? new WebSocket(computeWebSocketUrl(options.location ?? new URL(globalThis.location.href)));
  let latest: PreviewSnapshot | undefined;
  let filter: DashboardFilter = "all";
  const expanded = new Set<string>();
  let followActive = true;
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;

  function render(): void {
    root.innerHTML = latest ? renderDashboard(latest, { filter, expanded }) : `<p class="empty">Waiting for subagents...</p>`;
    if (followActive) root.querySelector?.('[data-status="running"]')?.scrollIntoView?.();
  }

  root.addEventListener?.("click", event => {
    const actionEl = (event as { target?: { closest?: (selector: string) => { dataset?: Record<string, string> } | null } }).target?.closest?.("[data-action]");
    const data = actionEl?.dataset;
    if (!data?.action) return;
    if (data.action === "filter" && data.status) filter = data.status as DashboardFilter;
    if (data.action === "toggle" && data.agentId) {
      if (expanded.has(data.agentId)) expanded.delete(data.agentId);
      else expanded.add(data.agentId);
    }
    if (data.action === "copy" && data.agentId && latest) {
      const agent = latest.subagents.find(item => item.id === data.agentId);
      if (agent) void clipboard?.writeText(`${agent.description ?? agent.id}\n${agent.transcript.map(entry => entry.text).join("\n")}`);
    }
    if (data.action === "follow-active") followActive = !followActive;
    render();
  });

  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "ready" })));
  socket.addEventListener("message", event => {
    const data = typeof (event as { data?: unknown }).data === "string" ? JSON.parse((event as { data: string }).data) : undefined;
    if (data?.type === "snapshot") {
      latest = data.snapshot;
      render();
    }
  });

  render();
}

if (typeof document !== "undefined") installRuntime();
```

The runtime implementation above must include the local controls covered by the test:

- status filter buttons set `filter`
- click on agent headers toggles `expanded`
- follow-active scrolls first running card into view when enabled
- copy button uses `navigator.clipboard.writeText`
- these controls do not send any WebSocket/RPC messages after the initial `ready`

- [ ] **Step 8: Run runtime tests**

Run:

```sh
bun --cwd extensions/subagent-preview test tests/runtime-dashboard.test.ts tests/runtime-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 9: Replace temporary build script with runtime bundler**

Modify `extensions/subagent-preview/src/build.mjs` to build browser JS and write `runtime.bundle.ts`:

```js
import { createHash } from "node:crypto";

const result = await Bun.build({
  entrypoints: [new URL("./runtime/main.ts", import.meta.url).pathname],
  target: "browser",
  minify: true,
});
if (!result.success) throw new Error("runtime build failed");
const js = await result.outputs[0].text();
const hash = createHash("sha256").update(js).digest("hex").slice(0, 12);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Subagent Preview</title><style>${css()}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
await Bun.write(new URL("./runtime.bundle.ts", import.meta.url), `// AUTO-GENERATED by build.mjs — do not edit by hand.\nexport const RUNTIME_VERSION = ${JSON.stringify(hash)};\nexport const RUNTIME_HTML = ${JSON.stringify(html)};\n`);

function css() {
  return `:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:12px;font-family:system-ui,-apple-system,sans-serif;background:transparent;color:var(--color-text-primary,#111)}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}.summary div,.agent{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:10px}.summary span{font-size:22px;font-weight:600;display:block}.summary label,.meta,.empty{color:var(--color-text-secondary,#666);font-size:13px}.agents{display:grid;gap:8px}.agent header{display:flex;justify-content:space-between;gap:8px}.agent pre{white-space:pre-wrap;margin:8px 0 0;font-size:12px}.entry{font-size:13px;border-top:1px solid rgba(128,128,128,.2);padding-top:6px;margin-top:6px}`;
}
```

Run:

```sh
bun --cwd extensions/subagent-preview run build:runtime
```

Expected: `src/runtime.bundle.ts` is generated and exports `RUNTIME_HTML`.

- [ ] **Step 10: Run runtime and package tests**

Run:

```sh
bun --cwd extensions/subagent-preview test
```

Expected: PASS.

- [ ] **Step 11: Commit**

```sh
git add extensions/subagent-preview/src/runtime extensions/subagent-preview/src/build.mjs extensions/subagent-preview/src/runtime.bundle.ts extensions/subagent-preview/tests/runtime-dashboard.test.ts extensions/subagent-preview/tests/runtime-bridge.test.ts
git commit -m "feat: add subagent preview dashboard runtime"
```

---

### Task 8: Documentation, final checks, and cleanup

**Files:**
- Create: `extensions/subagent-preview/README.md`
- Modify: `README.md`
- Modify: `extensions/subagent-preview/package.json` if check/build scripts need final adjustment

- [ ] **Step 1: Write package README**

Create `extensions/subagent-preview/README.md`:

```md
# omp-subagent-preview

Live cmux browser dashboard for OMP task subagents.

## Behavior

The extension opens one cmux browser split when the first task subagent starts in an OMP session. It shows running subagents first, collapses completed subagents to summaries, and streams compact transcript summaries from subagent session files.

Closing the browser surface only dismisses the current pane. If later subagents spawn in the same OMP session, the extension opens a fresh browser split and sends the current snapshot. Use `/subagent-preview close` or `/subagent-preview disable` to stop auto-open for the session.

## Commands

- `/subagent-preview` or `/subagent-preview open` — open or reconnect the dashboard.
- `/subagent-preview close` — close the surface and disable future auto-open for this session.
- `/subagent-preview disable` — keep any existing surface open but suppress future auto-open.
- `/subagent-preview enable` — re-enable auto-open.

## Privacy defaults

The dashboard shows live transcript summaries, not full raw transcripts. Thinking blocks are hidden by default. Tool arguments and results are truncated with explicit markers.

## Development

```sh
bun --cwd extensions/subagent-preview test
bun --cwd extensions/subagent-preview check
```
```

- [ ] **Step 2: Update root README package list and commands**

Modify `README.md`:

- Add package section after `omp-dynamic-workflows`:

```md
### `omp-subagent-preview`

Path: `extensions/subagent-preview`

Adds a live cmux browser dashboard for OMP task subagents. The dashboard opens on first subagent spawn, streams compact progress and transcript summaries, and can be controlled with `/subagent-preview`.
```

- Add `bun --cwd extensions/subagent-preview check` to the one-extension check list.
- Add `bun --cwd extensions/subagent-preview test` to the one-extension tests examples.

- [ ] **Step 3: Run narrow package check**

Run:

```sh
bun --cwd extensions/subagent-preview check
```

Expected: PASS. This runs runtime build, tests, and Bun build for `src/index.ts`.

- [ ] **Step 4: Run root check**

Run:

```sh
bun run check
```

Expected: PASS, including `extensions/subagent-preview check` from the root script.

- [ ] **Step 5: Commit docs and final cleanup**

```sh
git add README.md extensions/subagent-preview/README.md extensions/subagent-preview/package.json package.json
git commit -m "docs: document subagent preview extension"
```

- [ ] **Step 6: Final review checkpoint**

Use `superpowers:requesting-code-review` or the repo's `reviewer` agent on the completed branch. The review prompt must include:

- Spec path: `docs/superpowers/specs/2026-06-21-subagent-preview-design.md`
- Plan path: `docs/superpowers/plans/2026-06-21-subagent-preview.md`
- Changed package: `extensions/subagent-preview`
- Required checks already run: `bun --cwd extensions/subagent-preview check`, `bun run check`

Expected: review approves or returns concrete fixes. Apply fixes with tests before declaring complete.
