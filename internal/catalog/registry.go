package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

// Do runs fn against a connected catalog. If fn returns an auth-expired
// error, the cached catalog is dropped, rebuilt, and fn is retried once.
//
// Workaround for an iceberg-go v0.5.0 bug: Oauth2AuthManager fetches a token
// once on first use and caches it on the struct forever — expires_in is
// decoded but ignored, refresh_token is never used, and there is no 401
// re-auth path. Fixed upstream in apache/iceberg-go@6842055
// ("feat(catalog): refresh oauth tokens", PR #793) but not yet in any tagged
// release. Rebuilding the *rest.Catalog forces a fresh token fetch.
//
// For static bearer auth this still issues the (futile) retry once, then
// surfaces the same error — harmless.
func (r *Registry) Do(ctx context.Context, name string, args Args, fn func(*rest.Catalog) error) error {
	cat, err := r.Get(ctx, name, args)
	if err != nil {
		return err
	}
	err = fn(cat)
	if err == nil || !isAuthExpired(err) {
		return err
	}
	r.Invalidate(name)
	cat, err = r.Get(ctx, name, args)
	if err != nil {
		return err
	}
	return fn(cat)
}

func isAuthExpired(err error) bool {
	return errors.Is(err, rest.ErrUnauthorized) || errors.Is(err, rest.ErrAuthorizationExpired)
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
