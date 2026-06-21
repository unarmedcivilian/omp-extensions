# Subagent preview extension design

## Goal

Build a standalone OMP extension that shows a live browser dashboard for subagent trajectories when OMP task subagents spawn. The dashboard opens in a cmux browser split on first subagent spawn, reuses the surface for the current OMP session, collapses completed runs to summaries, and reopens automatically if the user closes the browser surface and later spawns more subagents.

## Decisions

- Package name: `omp-subagent-preview` under `extensions/subagent-preview`.
- Runtime form: standalone OMP extension; no OMP core patch for MVP.
- Preview target: cmux browser dashboard split.
- Open behavior: auto-open on first subagent lifecycle/progress event.
- Close behavior: browser/user close detaches the current surface only; it does not disable future auto-open. Host/session shutdown closes host-owned resources.
- Default trajectory depth: live transcript summary, not full transcript.
- Interactivity: dashboard-local controls only: filter, follow active, expand/collapse, copy. No pause, abort, retry, or agent mutation controls in MVP.
- Privacy/performance default: hide thinking blocks, truncate tool arguments/results, coalesce UI updates.

## Package and workspace integration

- `extensions/subagent-preview/package.json` must declare:
  - `name: "omp-subagent-preview"`
  - `type: "module"`
  - `exports["."].import` and `types` pointing at `./src/index.ts`
  - `omp.extensions: ["./src/index.ts"]`
  - `files` covering `src`, `README.md`, and any built runtime assets
  - peer dependencies on `@oh-my-pi/pi-coding-agent` and any OMP UI/runtime packages used by the extension
  - local `test` and `check` scripts
- The root `package.json` already includes `extensions/*` as workspaces, but its `test` and `check` scripts enumerate packages. Add `extensions/subagent-preview` to both scripts so `bun run check` covers the new extension.


## OMP API basis

The extension uses the current public extension APIs documented in `reference/oh-my-pi/docs/extensions.md` and `reference/oh-my-pi/docs/skills/authoring-extensions.md`:

- export a default factory that receives `ExtensionAPI`
- register handlers during factory execution
- do runtime work only inside event handlers or commands
- clean long-lived resources from `session_shutdown`
- use `pi.events` for extension communication

Subagent data comes from public task exports in `@oh-my-pi/pi-coding-agent/task`:

- `TASK_SUBAGENT_LIFECYCLE_CHANNEL`
- `TASK_SUBAGENT_PROGRESS_CHANNEL`
- `TASK_SUBAGENT_EVENT_CHANNEL` if useful as a secondary enrichment stream
- `SubagentLifecyclePayload`, `SubagentProgressPayload`, `AgentProgress`, `TaskToolDetails`

Primary identity must come from lifecycle/progress payloads. Raw subagent events are not primary because their channel payload does not carry the stable task id.

## Architecture

### `src/index.ts`

Owns OMP integration.

Responsibilities:

- install idempotently with a `WeakSet<ExtensionAPI>`
- register `session_start`, `session_switch`, `session_branch`, `session_tree`, task event-bus subscriptions, `/subagent-preview`, and `session_shutdown`
- defer all runtime action until session events or command handlers
- create one `PreviewController` per active OMP session
- clean up subscriptions, file tailers, WebSocket server, and cmux surface on shutdown
- reset or replace the controller on session switch/branch/tree so old subagent state, tailers, and surfaces do not bleed into the new active session

### `src/controller.ts`

Coordinates collector, transcript tailers, server, and cmux surface.

Responsibilities:

- receive normalized collector updates
- open the dashboard surface on first subagent spawn when auto-open is enabled
- reopen a new browser surface if a previous browser surface was user-closed and later subagents spawn
- push current snapshot immediately to any newly connected browser
- collapse completed subagents while expanding/following active subagents
- implement `/subagent-preview` subcommands:
  - no args: open or focus dashboard
  - `close`: close surface and disable auto-open for this session
  - `enable`: re-enable auto-open
  - `disable`: disable auto-open without closing existing surface

### `src/model.ts`

Holds normalized in-memory state.

Core entities:

- `PreviewSnapshot`
  - ordered subagent sessions grouped by active versus terminal status
  - aggregate counts: pending/running/completed/failed/aborted
  - updated timestamp
- `PreviewSubagent`
  - `id`
  - `agent`
  - `agentSource`
  - `description`
  - `assignment`/task preview
  - `status`
  - `sessionFile`
  - `currentTool`, short args, recent tools
  - `recentOutput`
  - token/context/cost/duration fields
  - nested task summary
  - transcript summary entries
- `TranscriptEntry`
  - kind: assistant text, tool call, tool result, user prompt
  - timestamp/order
  - summary text
  - truncation flags

### `src/collector.ts`

Subscribes to OMP task event channels through `pi.events`.

Responsibilities:

- create subagent records on lifecycle start or first progress event
- update terminal status from lifecycle completed/failed/aborted
- update live fields from `AgentProgress`
- group active versus terminal subagents by status and recency only; do not infer exact batch ids from spawn timing
- notify controller with coalesced updates, target 100-200 ms
- treat progress/lifecycle as authoritative

### `src/transcript.ts`

Tails each known `sessionFile` best-effort.

Responsibilities:

- read only appended bytes after initial load
- parse JSONL entries incrementally and tolerate partial trailing lines
- summarize persisted entries into compact `TranscriptEntry` values
- hide thinking blocks by default
- truncate tool arguments/results with explicit markers
- stop tailing when the subagent reaches a terminal state
- tolerate missing/unreadable session files without affecting subagent execution

Transcript rendering should prefer small, stable summaries over full raw content. Full transcript viewing remains OMP's built-in session observer concern.

### `src/server.ts` and `src/surface.ts`

Provide a local browser runtime and cmux surface lifecycle.

Responsibilities:

- start a local Bun HTTP/WebSocket server on `127.0.0.1` when needed
- register browser sessions by token
- send latest snapshot on browser `ready`
- queue or drop updates while no browser is attached according to controller state
- distinguish host close from browser close
- browser close detaches only; it must not call cmux `surface.close`
- host close unregisters and closes the cmux surface if still host-owned

cmux transport should follow existing extension conventions:

- prefer Unix socket requests for latency
- fallback to CLI when socket is unavailable
- pass current workspace/surface context when available

### `src/runtime/`

Browser-side dashboard.

Default UI:

- aggregate status header
- running subagent cards first, then completed summaries
- per-agent current tool/recent output/tokens/cost/duration
- compact live transcript summary
- nested task count/tree summary
- local controls: filter status, follow active, expand/collapse, copy
- reconnect support: render latest snapshot on `ready`

The runtime must not expose agent mutation actions in MVP.

## Data flow

```text
task executor
  -> pi.events lifecycle/progress
  -> collector model update
  -> transcript tailer enriches summaries
  -> controller coalesces snapshot
  -> WebSocket broadcast
  -> cmux browser dashboard
```

Lifecycle/progress events drive identity and status. Session JSONL tailing enriches trajectories. Raw subagent event payloads may enrich per-turn live state only when safely correlated, but are not required for MVP correctness.

## Browser close and reopen behavior

If the user closes the browser surface after subagents finish:

1. `browserClosed()` marks the surface detached.
2. Controller keeps in-memory state for the OMP session.
3. Auto-open remains enabled unless the user explicitly ran `/subagent-preview close` or `disable`.
4. When a later subagent spawn arrives, controller opens a fresh cmux browser split.
5. The fresh browser receives the current snapshot immediately:
   - previous completed subagents collapsed
   - new active subagents expanded/followed
6. The closed `surfaceRef` is never reused.

This makes ordinary browser close a dismissal, not a permanent opt-out.

## Error handling

- cmux socket unavailable: fallback to CLI.
- cmux open fails after fallback: notify/status/log; do not block subagents.
- browser runtime disconnects: keep state and continue collecting.
- transcript read fails: mark transcript unavailable for that subagent; keep progress view.
- malformed or partial JSONL: keep trailing partial buffer and continue.
- extension handler errors: avoid throwing from task event handlers; log and fail open.
- shutdown: cancel timers/tailers, close WebSocket server, close host-owned cmux surface.

## Performance limits

- Coalesce dashboard updates to avoid token-level browser churn.
- Keep bounded transcript summaries per subagent.
- Keep bounded recent output/tool history from progress payloads.
- Do not reconstruct full session history on every tick.
- Stop tailers for terminal subagents after final refresh.

## Testing plan

Unit tests:

- collector creates/updates sessions from lifecycle/progress payloads
- terminal lifecycle states override live progress state correctly
- browser close detaches without disabling future auto-open
- later subagent spawn reopens and receives existing snapshot
- `/subagent-preview close` closes the surface and disables future auto-open
- `/subagent-preview disable` suppresses future auto-open without closing an existing surface
- `/subagent-preview enable` re-enables auto-open
- `/subagent-preview` with no args opens or focuses without changing enable/disable state
- completed subagents collapse while active subagents expand
- transcript tailer parses appended JSONL incrementally
- transcript summarizer truncates tool args/results and hides thinking blocks
- shutdown closes host-owned resources and stops tailers

Surface/cmux tests:

- socket transport preferred
- CLI fallback on socket unavailable
- host close calls cmux close
- browser close does not call cmux close

Runtime tests:

- empty/running/completed/error dashboard states render
- filters, follow active, expand/collapse, and copy are local-only
- reconnect receives latest snapshot

Verification commands:

```sh
bun --cwd extensions/subagent-preview test
bun --cwd extensions/subagent-preview check
bun run check
```

## Documentation updates

- Add `extensions/subagent-preview/README.md` covering loading, auto-open behavior, browser-close/reopen behavior, commands, and privacy defaults.
- Update root `README.md` package list and development command list, and update root `package.json` scripts so repo-level checks include the new package.
- Keep API guidance aligned with `reference/oh-my-pi/docs`; do not document guessed OMP behavior.

## Out of scope for MVP

- Native terminal split renderer.
- Agent mutation controls: abort, retry, pause, edit prompts.
- Full thinking transcript display by default.
- Persistent dashboard history across OMP process restarts.
- OMP core API changes.
