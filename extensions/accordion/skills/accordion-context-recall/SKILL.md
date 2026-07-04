---
name: accordion-context-recall
description: Read when you need to inspect a folded Accordion block once without keeping it open in future turns.
---

# Accordion Context Recall

Accordion folded blocks appear as markers like `{#<code> FOLDED}` followed by a summary. The original content remains available in the browser session.

Use the `accordion_recall` tool with one or more copied codes when you need the full content in the current tool result only. Recall does not change the standing context or permanently open the block.

Rules:
- Copy only the code portion from `{#<code> FOLDED}`.
- Prefer `accordion_recall` for one-off checks, exact values, or confirming a detail.
- Use `accordion_unfold` instead when you will repeatedly reference the block across turns.
- Do not ask the user to paste folded content; Accordion already has it.
