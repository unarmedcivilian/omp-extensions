# omp-subagent-preview

Live cmux browser dashboard for OMP task subagents.

## Behavior

The extension opens one cmux browser split when the first task subagent starts in an OMP session. It lists agent transcript cards newest-first by launch order, keeps opened transcripts readable as agents complete, and streams compact transcript summaries from subagent session files with newest transcript lines first.
The dashboard preserves each transcript pane's scroll position and focused control across live snapshot updates. Manual transcript scrolling turns off `follow active`; use that local control only when you want the browser to jump to the first running or pending agent card.

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
