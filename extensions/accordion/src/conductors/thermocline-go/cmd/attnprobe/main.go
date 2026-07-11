// attnprobe — Go drop-in replacement for attention-folder/probe/probe.py.
//
// Same file contract as the Python probe:
//
//	attnprobe --in <input.json> --out <output.json>
//	  Input  JSON: { "tail": "<query text>", "blocks": [{"id","text"}, ...] }
//	  Output JSON: { "scores": {"<blockId>": <float>}, "meta": {...} }
//
// Drop-in compatibility with scorer.mjs's spawn: scorer.mjs execs
// `<python> <probe.py> --in … --out … --batch N --attn-impl sdpa`. Point
// ATTN_PROBE_PYTHON at this binary and the probe.py path arrives as a leading
// positional argument — it is detected and ignored, as are --batch /
// --attn-impl / --device (batching and attention backend live inside the ONNX
// graph now).
//
// Model assets resolve, in order: flag > env > next to this executable.
//
//	--model      ATTNPROBE_MODEL      attn_probe.onnx
//	--tokenizer  ATTNPROBE_TOKENIZER  tokenizer.json
//	--affixes    ATTNPROBE_AFFIXES    affixes.json
//	--ort-lib    ATTNPROBE_ORT_LIB    (onnxruntime shared library; optional if
//	                                   it is on the default loader path)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"thermocline-go/attnprobe"
	"thermocline-go/hftok"
	"thermocline-go/ortrun"
)

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

type probeInput struct {
	Tail   string                `json:"tail"`
	Blocks []attnprobe.Candidate `json:"blocks"`
}

type probeOutput struct {
	Scores map[string]float64 `json:"scores"`
	Meta   map[string]any     `json:"meta"`
}

// resolveAsset: flag value > env var > file next to the executable.
func resolveAsset(flagVal, envVar, defaultName string) string {
	if flagVal != "" {
		return flagVal
	}
	if v := os.Getenv(envVar); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err != nil {
		return defaultName
	}
	return filepath.Join(filepath.Dir(exe), defaultName)
}

func run() error {
	// scorer.mjs compat: `<python> <script> --in …` puts the probe.py path in
	// front of the flags; the flag package stops at the first non-flag arg, so
	// strip a single leading positional before parsing.
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		args = args[1:]
	}

	fs := flag.NewFlagSet("attnprobe", flag.ContinueOnError)
	inPath := fs.String("in", "", "input JSON path (required)")
	outPath := fs.String("out", "", "output JSON path (required)")
	modelFlag := fs.String("model", "", "attn_probe.onnx path")
	tokFlag := fs.String("tokenizer", "", "tokenizer.json path")
	affFlag := fs.String("affixes", "", "affixes.json path")
	ortLibFlag := fs.String("ort-lib", "", "onnxruntime shared library path")
	window := fs.Int("window", attnprobe.DefaultWindow, "per-window token budget")
	// Accepted-and-ignored probe.py flags (batching/backend are baked into the graph).
	_ = fs.Int("batch", 1, "ignored (probe.py compat)")
	_ = fs.String("attn-impl", "", "ignored (probe.py compat)")
	_ = fs.String("device", "", "ignored (probe.py compat)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *inPath == "" || *outPath == "" {
		return fmt.Errorf("--in and --out are required")
	}

	modelPath := resolveAsset(*modelFlag, "ATTNPROBE_MODEL", "attn_probe.onnx")
	tokPath := resolveAsset(*tokFlag, "ATTNPROBE_TOKENIZER", "tokenizer.json")
	affPath := resolveAsset(*affFlag, "ATTNPROBE_AFFIXES", "affixes.json")
	ortLib := *ortLibFlag
	if ortLib == "" {
		ortLib = os.Getenv("ATTNPROBE_ORT_LIB")
	}

	t0 := time.Now()

	raw, err := os.ReadFile(*inPath)
	if err != nil {
		return err
	}
	var input probeInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return fmt.Errorf("parse %s: %w", *inPath, err)
	}

	aff, err := attnprobe.LoadAffixes(affPath)
	if err != nil {
		return err
	}
	tk, err := hftok.FromFile(tokPath)
	if err != nil {
		return err
	}
	defer tk.Close()

	logf("[attn] loading %s (onnxruntime)", modelPath)
	runner, err := ortrun.New(modelPath, ortLib)
	if err != nil {
		return err
	}
	defer runner.Close()

	scores, err := attnprobe.ScoreCandidates(
		tk, runner, aff, input.Tail, input.Blocks, *window, logf,
	)
	if err != nil {
		return err
	}

	wallMs := time.Since(t0).Milliseconds()
	out := probeOutput{
		Scores: scores,
		Meta: map[string]any{
			"model":  "Qwen/Qwen2.5-0.5B-Instruct (onnx export)",
			"device": "onnxruntime-cpu",
			"wallMs": wallMs,
			"params": map[string]any{
				"window":  *window,
				"runtime": "go/onnxruntime",
				// The probe recipe (layers 18-23, VATP, sink zeroing) is baked
				// into the exported graph — see export/export_probe.py.
				"readout": "baked-into-onnx-graph",
			},
		},
	}
	data, err := json.Marshal(out)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*outPath, data, 0o644); err != nil {
		return err
	}
	logf("[attn] done: %d block scores in %dms", len(scores), wallMs)
	return nil
}

func main() {
	if err := run(); err != nil {
		logf("[attn] error: %v", err)
		os.Exit(1)
	}
}
