package catalog

import (
	"context"
	"sync"
)

// RequestRegistry tracks in-flight cancellable Wails operations keyed by a
// frontend-supplied request ID. The UI uses it to cancel a long-running scan
// when the user navigates away mid-flight.
//
// Empty reqID is allowed: Register returns an unregistered context so callers
// don't need to special-case it. Cancel is idempotent and a no-op on unknown
// IDs (the request may have already completed and unregistered).
type RequestRegistry struct {
	m sync.Map // reqID string -> context.CancelFunc
}

func NewRequestRegistry() *RequestRegistry { return &RequestRegistry{} }

// Register derives a cancellable child of parent. The returned release must
// always be called (defer) to remove the entry; release also cancels, so it's
// safe to call after a successful operation.
func (r *RequestRegistry) Register(parent context.Context, reqID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	if reqID == "" {
		return ctx, cancel
	}
	r.m.Store(reqID, cancel)
	release := func() {
		r.m.Delete(reqID)
		cancel()
	}
	return ctx, release
}

// Cancel cancels the request with the given ID if it's still registered.
// Returns true if a cancel was triggered, false on unknown ID.
func (r *RequestRegistry) Cancel(reqID string) bool {
	if reqID == "" {
		return false
	}
	v, ok := r.m.LoadAndDelete(reqID)
	if !ok {
		return false
	}
	v.(context.CancelFunc)()
	return true
}
