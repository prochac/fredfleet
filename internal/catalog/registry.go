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
//
// ctx is retained for the lifetime of the cached catalog: since iceberg-go
// v0.6.0 the OAuth2 manager wraps a clientcredentials token source built with
// this exact context, and every later token refresh runs on it. Pass an
// app-lifetime context, never a request-scoped one — a cancelled ctx would
// make refreshes fail with "context canceled" long after the request that
// created the entry is gone.
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
// Expiry-driven refresh is no longer our problem: iceberg-go v0.6.0 replaced
// the forever-cached token of v0.5.0 with an oauth2 clientcredentials token
// source, which refreshes on expiry by itself. The retry stays for the cases
// that a token source cannot see — a token revoked or invalidated server-side
// before its stated expiry, or credentials rotated at the IdP. There the
// cached source keeps handing out a token it still believes is valid, and only
// rebuilding the *rest.Catalog forces a fresh fetch.
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
