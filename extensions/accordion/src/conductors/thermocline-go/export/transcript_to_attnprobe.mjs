#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

const DEFAULT_PROTECT_TOKENS = 20_000;
const PROTECT_OVERFLOW_CAP = 1.25;
const TAIL_CHAR_CAP = 12_000;
const BLOCK_OVERHEAD = 4;
const CHARS_PER_TOKEN = 4;

function estTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function safeId(value, fallback) {
  const s = String(value || fallback || "id");
  return s.replace(/[^A-Za-z0-9_.:|+-]+/g, "_");
}

function stableJson(value) {
  if (value === undefined) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function imagePlaceholder(part) {
  const mime = part.mimeType || part.mediaType || part.mime || "image";
  const detail = part.detail ? ` detail=${part.detail}` : "";
  const bytes = typeof part.data === "string" ? part.data.length : 0;
  return `[image ${mime}${detail}${bytes ? ` bytes=${bytes}` : ""}]`;
}

function partText(part) {
  if (part == null) return "";
  if (typeof part === "string") return part;
  if (typeof part !== "object") return String(part);

  const type = part.type || part.kind;
  switch (type) {
    case "text":
    case "input_text":
    case "output_text":
      return typeof part.text === "string" ? part.text : "";
    case "thinking":
    case "reasoning":
      return typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
    case "image":
    case "input_image":
      return imagePlaceholder(part);
    case "toolCall":
    case "tool_use": {
      const name = part.name || part.toolName || "tool";
      const args = part.arguments ?? part.input ?? part.args ?? {};
      return `${name} ${stableJson(args)}`;
    }
    case "tool_result":
    case "toolResult":
      return contentText(part.content ?? part.text ?? "");
    default:
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string" || Array.isArray(part.content)) return contentText(part.content);
      return "";
  }
}

function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content !== undefined) return contentText(content.content);
  }
  return String(content);
}

function parseJsonl(raw) {
  const entries = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    entries.push(JSON.parse(t));
  }
  return entries;
}

export function parseTranscriptInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { inputFormat: "json-array", messages: parsed };
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
      return { inputFormat: "omp-request", request: parsed, messages: parsed.messages };
    }
    if (parsed && typeof parsed === "object" && typeof parsed.tail === "string" && Array.isArray(parsed.blocks)) {
      return { inputFormat: "attnprobe", probeInput: parsed };
    }
    return { inputFormat: "json-object", request: parsed, messages: [] };
  } catch {
    const messages = parseJsonl(raw);
    return { inputFormat: "jsonl-messages", messages };
  }
}

export function extractRequestMessages(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.probeInput) return [];
  if (Array.isArray(parsed?.messages)) return parsed.messages;
  if (Array.isArray(parsed?.request?.messages)) return parsed.request.messages;
  return [];
}

function makeBlock(id, kind, turn, order, text, extra = {}) {
  return {
    id,
    kind,
    turn,
    order,
    text,
    tokens: estTokens(text) + BLOCK_OVERHEAD,
    ...extra,
  };
}

function blocksFromMessages(messages) {
  const blocks = [];
  const toolNames = new Map();
  let turn = 0;
  let order = 0;

  const push = (id, kind, text, extra = {}) => {
    if (!text && kind !== "tool_result") return;
    blocks.push(makeBlock(id, kind, turn, order++, text, extra));
  };

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi] || {};
    const role = msg.role || msg.type || "message";
    const content = msg.content ?? msg.message?.content ?? "";

    if (role === "assistant") {
      const parts = Array.isArray(content) ? content : [{ type: "text", text: contentText(content) }];
      let pi = 0;
      for (const part of parts) {
        if (!part || typeof part !== "object") {
          push(`m${mi}:p${pi++}`, "text", partText(part), { model: msg.model });
          continue;
        }
        const type = part.type || part.kind;
        if (type === "thinking" || type === "reasoning") {
          push(`m${mi}:p${pi++}`, "thinking", partText(part), { model: msg.model });
        } else if (type === "toolCall" || type === "tool_use") {
          const callId = part.id || part.toolCallId || `m${mi}:call${pi}`;
          if (part.name) toolNames.set(callId, part.name);
          push(`tc:${safeId(callId)}`, "tool_call", partText(part), {
            toolName: part.name || part.toolName || "tool",
            callId,
            model: msg.model,
          });
          pi++;
        } else {
          push(`m${mi}:p${pi++}`, "text", partText(part), { model: msg.model });
        }
      }
      continue;
    }

    if (role === "toolResult" || role === "tool_result") {
      const callId = msg.toolCallId || msg.tool_use_id || msg.callId || `m${mi}:result`;
      push(`r:${safeId(callId)}`, "tool_result", contentText(content), {
        toolName: msg.toolName || toolNames.get(callId) || "tool",
        callId,
        isError: !!(msg.isError || msg.is_error),
      });
      continue;
    }

    if (role === "user") {
      const parts = Array.isArray(content) ? content : [{ type: "text", text: contentText(content) }];
      const userParts = [];
      let resultIndex = 0;
      for (const part of parts) {
        const type = part && typeof part === "object" ? part.type || part.kind : undefined;
        if (type === "tool_result" || type === "toolResult") {
          const callId = part.tool_use_id || part.toolCallId || part.callId || `m${mi}:result${resultIndex}`;
          push(`r:${safeId(callId)}`, "tool_result", partText(part), {
            toolName: toolNames.get(callId) || "tool",
            callId,
            isError: !!(part.is_error || part.isError),
          });
          resultIndex++;
        } else {
          const text = partText(part);
          if (text) userParts.push(text);
        }
      }
      const userText = userParts.join("\n");
      if (userText.trim()) {
        turn += 1;
        push(`m${mi}:u`, "user", userText);
      }
      continue;
    }

    const text = contentText(content);
    if (text.trim()) {
      const label = role === "developer" || role === "system" ? `[${role}]\n${text}` : text;
      push(`m${mi}:${safeId(role)}`, "text", label);
    }
  }

  return blocks;
}

function protectedFromIndex(blocks, target) {
  if (!blocks.length) return 0;
  if (!Number.isFinite(target) || target <= 0) return blocks.length;

  const cap = target * PROTECT_OVERFLOW_CAP;
  let sum = blocks[blocks.length - 1].tokens;
  if (sum >= target) return blocks.length - 1;

  for (let i = blocks.length - 2; i >= 0; i--) {
    const next = sum + blocks[i].tokens;
    if (next > cap) return i + 1;
    sum = next;
    if (sum >= target) return i;
  }
  return 0;
}

function viewBlocksFromBlocks(blocks, protectTokens) {
  const protectedFrom = protectedFromIndex(blocks, protectTokens);
  return {
    protectedFrom,
    blocks: blocks.map((b, i) => ({
      ...b,
      foldedTokens: b.tokens,
      held: false,
      folded: false,
      protected: i >= protectedFrom,
      grouped: false,
    })),
  };
}

function buildUnits(blocks) {
  const resultByCall = new Map();
  for (const b of blocks) {
    if (b.kind === "tool_result" && b.callId) resultByCall.set(b.callId, b);
  }

  const pairedResultIds = new Set();
  for (const b of blocks) {
    if (b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)) {
      pairedResultIds.add(resultByCall.get(b.callId).id);
    }
  }

  const units = [];
  for (const b of blocks) {
    if (b.kind === "tool_result" && pairedResultIds.has(b.id)) continue;
    const members = b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)
      ? [b, resultByCall.get(b.callId)]
      : [b];
    const result = members.find((m) => m.kind === "tool_result");
    units.push({
      id: members[0].id,
      temperatureKey: result ? result.id : members[0].id,
      blocks: members,
      protected: members.some((m) => m.protected),
      held: members.some((m) => m.held),
    });
  }
  return units;
}

function tailTextFromView(blocks) {
  let text = "";
  for (let i = blocks.length - 1; i >= 0 && text.length < TAIL_CHAR_CAP; i--) {
    const b = blocks[i];
    if (!b.protected) break;
    if (b.text !== undefined) text = `${b.text}\n${text}`;
  }
  return text;
}

export function convertToProbeInput(input, options = {}) {
  const protectTokens = Number(options.protectTokens ?? DEFAULT_PROTECT_TOKENS);
  const parsed = typeof input === "string" ? parseTranscriptInput(input) : input;

  if (parsed?.probeInput) {
    return {
      tail: parsed.probeInput.tail,
      blocks: parsed.probeInput.blocks,
      meta: { inputFormat: parsed.inputFormat, alreadyProbeInput: true },
    };
  }

  const messages = extractRequestMessages(parsed);
  if (!messages.length) throw new Error("input does not contain a messages array or attnprobe {tail,blocks}");

  const sourceBlocks = blocksFromMessages(messages);
  const { blocks, protectedFrom } = viewBlocksFromBlocks(sourceBlocks, protectTokens);
  const units = buildUnits(blocks);
  const candidates = units
    .filter((u) => !u.protected && !u.held)
    .map((u) => ({
      id: u.temperatureKey,
      text: u.blocks.map((b) => b.text ?? "").filter(Boolean).join("\n"),
    }))
    .filter((c) => c.text.trim());

  return {
    tail: tailTextFromView(blocks),
    blocks: candidates,
    meta: {
      inputFormat: parsed.inputFormat ?? "messages",
      messageCount: messages.length,
      sourceBlockCount: sourceBlocks.length,
      protectedFromIndex: protectedFrom,
      protectTokens,
      candidateCount: candidates.length,
    },
  };
}

function parseCli(argv) {
  const args = [...argv];
  const opts = { protectTokens: DEFAULT_PROTECT_TOKENS, pretty: true };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--protect-tokens") opts.protectTokens = Number(args[++i]);
    else if (a === "--compact") opts.pretty = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else positional.push(a);
  }
  return { inputPath: positional[0], outputPath: positional[1], opts };
}

function usage() {
  return `usage: transcript_to_attnprobe.mjs <request.json|messages.jsonl> [out.json] [--protect-tokens N] [--compact]\n\nConverts an OMP LLM request / message transcript into the Go attnprobe input shape:\n  { "tail": string, "blocks": [{ "id": string, "text": string }] }\n\nDefaults: --protect-tokens ${DEFAULT_PROTECT_TOKENS}; pretty JSON output. Omit out.json to write to stdout.`;
}

export function main(argv = process.argv.slice(2)) {
  const { inputPath, outputPath, opts } = parseCli(argv);
  if (opts.help || !inputPath) {
    const text = usage();
    if (opts.help) console.log(text);
    else console.error(text);
    return opts.help ? 0 : 2;
  }

  const raw = readFileSync(inputPath, "utf8");
  const converted = convertToProbeInput(parseTranscriptInput(raw), opts);
  const json = JSON.stringify(converted, null, opts.pretty ? 2 : 0);
  if (outputPath) writeFileSync(outputPath, `${json}\n`);
  else process.stdout.write(`${json}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
