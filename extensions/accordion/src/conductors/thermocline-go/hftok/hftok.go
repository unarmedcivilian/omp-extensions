// Package hftok adapts github.com/daulet/tokenizers (Go bindings to
// HuggingFace's Rust tokenizers — the same library the Python side uses, so
// token ids match the original probe exactly) to attnprobe.Tokenizer.
//
// BUILD NOTE: daulet/tokenizers is a cgo binding — it links against a
// prebuilt libtokenizers.a. Download it from the daulet/tokenizers release
// matching the module version (or build it with cargo) and point the linker
// at it:
//
//	CGO_LDFLAGS="-L/path/to/dir/containing/libtokenizers.a" go build ./cmd/attnprobe
package hftok

import (
	"fmt"

	"github.com/daulet/tokenizers"
)

// Tokenizer wraps a HF fast tokenizer loaded from tokenizer.json (exported
// next to the model by export_probe.py). Encode/Decode never add special
// tokens — the chat affixes come precomputed in affixes.json.
type Tokenizer struct {
	tk *tokenizers.Tokenizer
}

// FromFile loads tokenizer.json.
func FromFile(path string) (*Tokenizer, error) {
	tk, err := tokenizers.FromFile(path)
	if err != nil {
		return nil, fmt.Errorf("load tokenizer %s: %w", path, err)
	}
	return &Tokenizer{tk: tk}, nil
}

// Encode implements attnprobe.Tokenizer (add_special_tokens=false).
func (t *Tokenizer) Encode(text string) []int64 {
	ids, _ := t.tk.Encode(text, false)
	out := make([]int64, len(ids))
	for i, id := range ids {
		out[i] = int64(id)
	}
	return out
}

// Decode implements attnprobe.Tokenizer.
func (t *Tokenizer) Decode(ids []int64) string {
	u := make([]uint32, len(ids))
	for i, id := range ids {
		u[i] = uint32(id)
	}
	return t.tk.Decode(u, false)
}

// Close frees the underlying Rust tokenizer.
func (t *Tokenizer) Close() error {
	return t.tk.Close()
}
