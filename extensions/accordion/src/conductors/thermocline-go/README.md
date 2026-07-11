# thermocline-go — attention probe without Python

Go port of the Thermocline/attention-folder **attention probe**
(`../attention-folder/probe/probe.py`), built on a one-time ONNX export.
The probe recipe — Qwen2.5-0.5B layers 18–23, last-token attention row, VATP
correction, sink zeroing — is baked into a static `attn_probe.onnx` graph by
`export/export_probe.py` (Python runs **once**, on the machine doing the
export). At runtime it's a single Go binary + onnxruntime: no Python, no
PyTorch, no llama.cpp graph-name coupling.

```
export/export_probe.py   one-time exporter: attn_probe.onnx + tokenizer.json + affixes.json
attnprobe/               pure-Go core: window assembly, token spans, anchor calibration
                         (hermetic tests — no model needed: go test ./attnprobe)
hftok/                   Tokenizer impl — HF tokenizers via daulet/tokenizers (cgo)
ortrun/                  Runner impl — onnxruntime via yalue/onnxruntime_go
cmd/attnprobe/           CLI, drop-in replacement for probe.py (same --in/--out JSON)
```

## 1. Export the model (one-time, Python)

```bash
cd export
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python export_probe.py            # writes export/dist/{attn_probe.onnx,tokenizer.json,affixes.json}
```

The script traces the probe, then **verifies parity**: it runs the exported
graph through onnxruntime against the PyTorch wrapper on two window sizes and
fails loudly if scores diverge beyond 1e-4. If the default (legacy tracer)
export errors on your transformers version, retry with `--dynamo`.

For a stronger end-to-end check, run the original `probe.py` and the Go binary
on the same `in.json` and diff the score maps — they should agree to ~3
decimals (the original defaults to bf16 on GPU; the export is fp32).

## 2. Native dependencies (runtime)

Two shared/static libraries, both prebuilt downloads:

- **onnxruntime** (shared lib, needed at runtime):
  `brew install onnxruntime` (macOS) or grab a release from
  github.com/microsoft/onnxruntime/releases. Point `--ort-lib` /
  `ATTNPROBE_ORT_LIB` at `libonnxruntime.dylib|.so` if it isn't on the default
  loader path.
- **libtokenizers.a** (static lib, needed at build time by the cgo tokenizer
  binding): download the artifact matching your platform from
  github.com/daulet/tokenizers releases (or `cargo build` it from that repo).

## 3. Build & test

```bash
go mod tidy
go test ./attnprobe                      # hermetic — no model, no cgo libs needed
CGO_LDFLAGS="-L/path/to/libtokenizers-dir" go build ./cmd/attnprobe
```

## 4. Run

```bash
# assets next to the binary (or use flags / ATTNPROBE_* env vars)
cp export/dist/{attn_probe.onnx,tokenizer.json,affixes.json} .
./attnprobe --in in.json --out out.json
```

Same JSON contract as probe.py:

```jsonc
// in.json
{ "tail": "current work text", "blocks": [{ "id": "b1", "text": "…" }] }
// out.json
{ "scores": { "b1": 1.42 }, "meta": { "wallMs": 812, "...": "..." } }
```

### Drop-in for the existing Node conductors

`scorer.mjs` spawns `<python> <probe.py> --in … --out … --batch N --attn-impl sdpa`.
The Go binary tolerates exactly that argv shape (leading script path and the
extra flags are ignored), so the JS thermocline/attention-folder pick it up
with no code change:

```bash
export ATTN_PROBE_PYTHON=/path/to/attnprobe   # binary replaces "python"
```

## Porting notes / caveats

- **Score parity:** token ids match the Python probe exactly (same HF
  tokenizer via `tokenizer.json`); the graph math is fp32, verified against
  the fp32 PyTorch wrapper at export time. Differences vs a bf16 GPU run of
  probe.py are ~1e-3 — irrelevant at `coldThreshold: 0.35`.
- **The layernorm trap:** probe.py hooks `self_attn`, which sees hidden states
  *after* `input_layernorm`; HF's `output_hidden_states` yields them *before*.
  The exporter re-applies the norm — if you ever re-derive the wrapper, keep
  that line or scores will be plausible but wrong.
- **No batched path:** probe.py's `--batch` fast path is replaced by one
  `session.Run` per window. For thermocline-sized workloads (a handful of
  2048-token windows on a 0.5B fp32 model) CPU wall time is a few seconds; add
  an onnxruntime execution provider (CoreML/CUDA) via `ortrun` SessionOptions
  if that ever matters.
- **Model size:** fp32 export is ~2 GB on disk. `onnxruntime.transformers` or
  `onnxconverter-common` can fp16-quantize it to ~1 GB if needed — re-run the
  parity check afterwards.
- The OOM ladders in probe.py (CUDA-specific) have no equivalent here; CPU
  inference degrades in time, not memory spikes.
