// Package ortrun runs the exported probe graph (attn_probe.onnx) through
// onnxruntime via github.com/yalue/onnxruntime_go. It implements
// attnprobe.Runner: input_ids [1, n] int64 → per_pos [n] float32.
//
// Requires the onnxruntime SHARED LIBRARY at runtime (not vendored):
// libonnxruntime.dylib / .so / onnxruntime.dll — see the README for install
// options. Pass its path to New, or "" to let onnxruntime_go try defaults.
package ortrun

import (
	"fmt"
	"sync"

	ort "github.com/yalue/onnxruntime_go"
)

var initOnce sync.Once
var initErr error

// Runner is a live onnxruntime session over the probe graph. Not safe for
// concurrent PerPosition calls (thermocline scores one batch at a time anyway).
type Runner struct {
	session *ort.DynamicAdvancedSession
}

// New initializes the onnxruntime environment (once per process) and opens a
// session on the exported model. ortLibPath may be "" if the shared library is
// on the default search path.
func New(modelPath, ortLibPath string) (*Runner, error) {
	initOnce.Do(func() {
		if ortLibPath != "" {
			ort.SetSharedLibraryPath(ortLibPath)
		}
		initErr = ort.InitializeEnvironment()
	})
	if initErr != nil {
		return nil, fmt.Errorf("onnxruntime init: %w", initErr)
	}
	session, err := ort.NewDynamicAdvancedSession(
		modelPath,
		[]string{"input_ids"},
		[]string{"per_pos"},
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", modelPath, err)
	}
	return &Runner{session: session}, nil
}

// PerPosition implements attnprobe.Runner.
func (r *Runner) PerPosition(ids []int64) ([]float32, error) {
	n := int64(len(ids))
	if n == 0 {
		return nil, fmt.Errorf("empty window")
	}

	input, err := ort.NewTensor(ort.NewShape(1, n), ids)
	if err != nil {
		return nil, fmt.Errorf("input tensor: %w", err)
	}
	defer input.Destroy()

	// Output length == input length (the graph's per_pos axis is "seq"), so we
	// can preallocate instead of relying on auto-allocation.
	output, err := ort.NewEmptyTensor[float32](ort.NewShape(n))
	if err != nil {
		return nil, fmt.Errorf("output tensor: %w", err)
	}
	defer output.Destroy()

	if err := r.session.Run([]ort.Value{input}, []ort.Value{output}); err != nil {
		return nil, fmt.Errorf("run (%d tokens): %w", n, err)
	}

	// GetData is backed by ORT-owned memory freed on Destroy — copy out.
	data := output.GetData()
	out := make([]float32, len(data))
	copy(out, data)
	return out, nil
}

// Close releases the session. The process-wide environment stays up (cheap,
// and other Runners may share it).
func (r *Runner) Close() error {
	return r.session.Destroy()
}
