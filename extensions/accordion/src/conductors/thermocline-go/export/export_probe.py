#!/usr/bin/env python
"""
export_probe.py — ONE-TIME export of the attention probe to ONNX.

Bakes the whole probe recipe from ../../attention-folder/probe/probe.py into a
static graph: Qwen2.5-0.5B trunk → capture the INPUT hidden states of layers
18..23 → re-apply each layer's input_layernorm + q/k/v projections + RoPE →
last-token attention row → VATP correction (attn × value L1 norm) → zero the
attention sinks → renormalize → mean over heads, then layers. What was a set of
PyTorch forward hooks becomes the graph's declared output, so any ONNX runtime
(here: onnxruntime from Go) can run it — no Python at inference time.

What stays OUTSIDE the graph (done by the Go side, attnprobe package):
window assembly, per-block token spans, span means, anchor calibration.
Those depend on per-call data (which blocks, where) — the graph only maps
input_ids [1, seq] → per_pos [seq] relevance mass.

Usage:
    python export_probe.py [--out-dir dist] [--skip-verify] [--dynamo]

Outputs (in --out-dir):
    attn_probe.onnx  — the traced probe graph (fp32)
    tokenizer.json   — HF fast-tokenizer definition, consumed by the Go side
    affixes.json     — chat-template prefix/suffix token ids (sentinel-split,
                       same trick as probe.py's chat_prefix_suffix)

If the default (legacy tracer) export fails on your transformers version, retry
with --dynamo: transformers 5.x models sometimes trace better through the
torch.export/dynamo path than through torch.jit tracing.
"""
from __future__ import annotations

import argparse
import inspect
import json
import sys
from pathlib import Path

import torch
import torch.nn as nn

# ── Constants copied from probe.py — keep in lockstep. ─────────────────────────
MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
NUM_LAYERS = 24
PROBE_LAYERS = list(range(18, 24))   # decoder layers 18..23 (last quarter)
NUM_Q_HEADS = 14
NUM_KV_HEADS = 2
GQA_GROUP = NUM_Q_HEADS // NUM_KV_HEADS
HEAD_DIM = 64
SINK_POSITIONS = 2


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class AttnProbe(nn.Module):
    """The probe's readout as a plain forward pass over the decoder trunk.

    Mirrors probe.py's last_token_block_attention EXACTLY, with one structural
    difference: probe.py hooks self_attn's inputs at runtime; here we take the
    layer-boundary hidden states (output_hidden_states=True) and re-apply the
    layer's input_layernorm ourselves — hidden_states[i] is the tensor BEFORE
    the norm, but the hooked self_attn saw it AFTER. Skipping the norm would
    produce plausible-looking but wrong scores.

    Wraps model.model (the trunk), never the lm_head — the 151k-vocab logits
    projection is the single most expensive dead op and is simply absent here.

    TRACER-SAFETY. The legacy ONNX exporter records Python-int shape math as
    CONSTANTS (freezing the traced seq length into the graph) and cannot export
    transformers' own mask construction (masking_utils uses aten::diff for
    packed-sequence detection — no ONNX symbolic). So this forward:
      • derives positions/masks from TENSOR ops (cumsum/ones_like), never
        torch.arange(python_int) or view(1, n, …);
      • passes an explicit 4D float causal mask + position_ids/cache_position,
        which masking_utils early-returns untouched (the custom-4D-mask escape
        hatch) — bypassing the aten::diff path entirely;
      • replaces transformers' repeat_kv (shape-int expand/reshape) with
        grouped broadcasting — identical 14-head math, dynamic-shape clean.
    The parity check at two window sizes ≠ trace length proves all of this.
    """

    def __init__(self, model):
        super().__init__()
        self.trunk = model.model
        self.scaling = HEAD_DIM ** -0.5

    def forward(self, input_ids):  # [1, n] int64 → [n] float32
        ones = torch.ones_like(input_ids)          # [1, n]
        pos = torch.cumsum(ones, dim=1) - 1        # [1, n] = 0..n-1, dynamic

        # Explicit 4D causal mask [1, 1, n, n]: 0 on/below the diagonal,
        # dtype-min above. Built from a dynamic [n, n] ones via outer product.
        onesf = ones.to(torch.float32)
        square = onesf.transpose(0, 1) @ onesf     # [n, n]
        neg = torch.finfo(torch.float32).min
        mask4d = (torch.triu(square, diagonal=1) * neg).unsqueeze(0).unsqueeze(0)

        out = self.trunk(
            input_ids=input_ids,
            attention_mask=mask4d,
            position_ids=pos,
            cache_position=pos[0],
            output_hidden_states=True,
            use_cache=False,
        )
        hs_all = out.hidden_states  # hs_all[i] = INPUT to layer i (pre-norm)

        cos, sin = self.trunk.rotary_emb(hs_all[0], pos)

        from transformers.models.qwen2.modeling_qwen2 import apply_rotary_pos_emb

        # Sink keep-mask: 0 for positions 0..1, 1 elsewhere (multiplicative —
        # no slice-assignment, so no ScatterND dependence).
        sink_keep = (pos[0] >= SINK_POSITIONS).to(torch.float32)  # [n]

        rows = []
        for il in PROBE_LAYERS:  # constant bounds — unrolls at trace time
            layer = self.trunk.layers[il]
            hs = layer.input_layernorm(hs_all[il])  # what the hook saw
            attn = layer.self_attn

            # reshape(1, -1, H, 64): -1 resolves per-run, keeping seq dynamic.
            q = attn.q_proj(hs).reshape(1, -1, NUM_Q_HEADS, HEAD_DIM).transpose(1, 2)
            k = attn.k_proj(hs).reshape(1, -1, NUM_KV_HEADS, HEAD_DIM).transpose(1, 2)
            v = attn.v_proj(hs).reshape(1, -1, NUM_KV_HEADS, HEAD_DIM).transpose(1, 2)
            q, k = apply_rotary_pos_emb(q, k, cos, sin)

            # VATP value norms per KV head: L1 norm of each position's value.
            vnorm = v[0].abs().sum(dim=-1)  # [2, n]

            # GQA without repeat_kv: group the 14 query heads as [2 KV, 7] and
            # broadcast against the 2 KV heads. Head g*7+j pairs with KV g —
            # the same mapping as repeat_kv + kv_index (0..6→KV0, 7..13→KV1).
            q_last = q[:, :, -1:, :]                                      # [1,14,1,64]
            qg = q_last.reshape(1, NUM_KV_HEADS, GQA_GROUP, 1, HEAD_DIM)  # [1,2,7,1,64]
            kg = k.unsqueeze(2)                                           # [1,2,1,n,64]
            scores = torch.matmul(qg, kg.transpose(-1, -2)) * self.scaling
            a = torch.softmax(scores[0, :, :, 0, :].float(), dim=-1)      # [2,7,n]

            # VATP correction, per KV group (broadcasts over the 7 q heads).
            a = a * vnorm.unsqueeze(1).float()

            # Zero the attention sinks (positions 0..1), renormalize the rest.
            a = a * sink_keep
            denom = a.sum(dim=-1, keepdim=True).clamp(min=1e-12)
            a = a / denom

            rows.append(a.mean(dim=(0, 1)))  # mean over all 14 query heads → [n]

        return torch.stack(rows, dim=0).mean(dim=0)  # mean over layers → [n]


def export(out_dir: Path, use_dynamo: bool, skip_verify: bool) -> int:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "attn_probe.onnx"

    log(f"[export] loading {MODEL_ID} (fp32, eager attention)")
    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID, torch_dtype=torch.float32, attn_implementation="eager"
    ).eval()

    # Guard against silent architecture drift — the constants above are baked in.
    cfg = model.config
    assert cfg.num_hidden_layers == NUM_LAYERS, cfg.num_hidden_layers
    assert cfg.num_attention_heads == NUM_Q_HEADS, cfg.num_attention_heads
    assert cfg.num_key_value_heads == NUM_KV_HEADS, cfg.num_key_value_heads
    assert cfg.hidden_size // cfg.num_attention_heads == HEAD_DIM

    probe = AttnProbe(model).eval()
    dummy = torch.randint(1, 100_000, (1, 512), dtype=torch.long)

    log(f"[export] tracing → {onnx_path}")
    kwargs = {}
    if "dynamo" in inspect.signature(torch.onnx.export).parameters:
        kwargs["dynamo"] = use_dynamo
    elif use_dynamo:
        log("[export] --dynamo requested but this torch has no dynamo kwarg")
        return 1
    with torch.no_grad():
        torch.onnx.export(
            probe,
            (dummy,),
            str(onnx_path),
            input_names=["input_ids"],
            output_names=["per_pos"],
            dynamic_axes={"input_ids": {1: "seq"}, "per_pos": {0: "seq"}},
            opset_version=17,
            **kwargs,
        )

    # tokenizer.json — the Go side loads this with HF tokenizers bindings.
    tok.backend_tokenizer.save(str(out_dir / "tokenizer.json"))
    log(f"[export] wrote {out_dir / 'tokenizer.json'}")

    # affixes.json — the chat-template wrapper, precomputed so Go needs no
    # template engine. Same sentinel-split as probe.py's chat_prefix_suffix.
    sentinel = "SENTINEL"
    rendered = tok.apply_chat_template(
        [{"role": "user", "content": sentinel}],
        tokenize=False,
        add_generation_prompt=True,
    )
    pre_text, post_text = rendered.split(sentinel)
    affixes = {
        "pre_ids": tok.encode(pre_text, add_special_tokens=False),
        "post_ids": tok.encode(post_text, add_special_tokens=False),
    }
    with open(out_dir / "affixes.json", "w", encoding="utf-8") as f:
        json.dump(affixes, f)
    log(
        f"[export] wrote affixes.json "
        f"(pre={len(affixes['pre_ids'])} post={len(affixes['post_ids'])} ids)"
    )

    if skip_verify:
        return 0

    # ── Parity check: exported graph vs the wrapper it was traced from. ──────
    log("[verify] onnxruntime vs torch on two window sizes…")
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    for seq in (317, 1024):  # ≠ trace length, to prove the dynamic axis works
        ids = torch.randint(1, 100_000, (1, seq), dtype=torch.long)
        with torch.no_grad():
            want = probe(ids).numpy()
        got = sess.run(None, {"input_ids": ids.numpy()})[0]
        if got.shape != want.shape:
            log(f"[verify] FAIL seq={seq}: shape {got.shape} vs {want.shape}")
            return 1
        max_abs = float(np.max(np.abs(got - want)))
        if not np.allclose(got, want, atol=1e-4):
            log(f"[verify] FAIL seq={seq}: max |Δ| = {max_abs:.2e} (atol 1e-4)")
            return 1
        log(f"[verify] ok seq={seq}: max |Δ| = {max_abs:.2e}")

    log("[export] done — ship attn_probe.onnx + tokenizer.json + affixes.json")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--out-dir", default=str(Path(__file__).parent / "dist"),
        help="output directory for attn_probe.onnx / tokenizer.json / affixes.json",
    )
    ap.add_argument(
        "--dynamo", action="store_true",
        help="use the torch.export/dynamo ONNX exporter instead of the legacy tracer",
    )
    ap.add_argument("--skip-verify", action="store_true")
    a = ap.parse_args()
    return export(Path(a.out_dir), a.dynamo, a.skip_verify)


if __name__ == "__main__":
    sys.exit(main())
