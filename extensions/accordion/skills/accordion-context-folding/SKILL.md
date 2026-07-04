---
name: accordion-context-folding
description: Read when you see `{#<code> FOLDED}` markers in your context and need the full content to stay available on later turns.
---

# Accordion Context Folding

Accordion may replace large context blocks with markers like `{#<code> FOLDED}` followed by a short summary. The original content is preserved by the Accordion browser session.

Use the `accordion_unfold` tool with one or more copied codes when you need to keep the full content in your standing context on the next turn.

Rules:
- Copy only the code portion from `{#<code> FOLDED}`.
- Unfold only blocks relevant to the current task.
- If you need a one-time lookup instead of a persistent restore, use the Accordion recall skill and `accordion_recall`.
- Do not ask the user to paste folded content; Accordion already has it.
