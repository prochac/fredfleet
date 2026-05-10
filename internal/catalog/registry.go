package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"

	"github.com/apache/iceberg-go/catalog/rest"
)

// Registry caches per-connection *rest.Catalog instances so we don't redo the
// OAuth2 token dance on every UI interaction. A cached catalog is invalidated
// either explicitly (Invalidate, called from Save/Delete on App) or implicitly
// when the connection's args fingerprint changes.
type Registry struct {
	mu   sync.Mutex
	cats map[string]*entry
}

type entry struct {
	cat *rest.Catalog
	fp  string
}

func NewRegistry() *Registry {
	return &Registry{cats: make(map[string]*entry)}
}

// Get returns a cached catalog if the args fingerprint matches the cached
// entry, otherwise builds a new one and caches it.
func (r *Registry) Get(ctx context.Context, name string, args Args) (*rest.Catalog, error) {
	fp := fingerprint(args)
	r.mu.Lock()
	if e, ok := r.cats[name]; ok && e.fp == fp {
		r.mu.Unlock()
		return e.cat, nil
	}
	r.mu.Unlock()

	cat, err := Open(ctx, name, args)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	r.cats[name] = &entry{cat: cat, fp: fp}
	r.mu.Unlock()
	return cat, nil
}

// Invalidate drops the cached catalog for name. Safe to call when no entry
// exists.
func (r *Registry) Invalidate(name string) {
	r.mu.Lock()
	delete(r.cats, name)
	r.mu.Unlock()
}

func fingerprint(a Args) string {
	parts := []string{
		a.URI,
		a.Warehouse,
		a.AuthKind,
		a.AuthURL,
		a.ClientID,
		a.Scope,
		a.S3AccessKeyID,
		a.S3Region,
		a.S3Endpoint,
	}
	sum := sha256.Sum256([]byte(a.Secret + "\x00" + a.S3SecretAccessKey))
	parts = append(parts, hex.EncodeToString(sum[:]))
	return strings.Join(parts, "|")
}
