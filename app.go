package main

import (
	"context"
	"errors"
	"time"

	"github.com/apache/iceberg-go/catalog/rest"
	"github.com/apache/iceberg-go/table"

	"github.com/prochac/fredfleet/internal/catalog"
	"github.com/prochac/fredfleet/internal/connections"
	"github.com/prochac/fredfleet/internal/desktopentry"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	probeTimeout   = 10 * time.Second
	listTimeout    = 10 * time.Second
	loadTimeout    = 30 * time.Second
	previewTimeout = 60 * time.Second
	// A cold SearchTables crawls every namespace in the catalog, so it gets
	// the same budget as a scan rather than the 10s a single list call gets.
	searchTimeout = 60 * time.Second
)

type App struct {
	ctx      context.Context
	store    *connections.Store
	keyring  *connections.Keyring
	registry *catalog.Registry
	requests *catalog.RequestRegistry
	searcher *catalog.TableSearcher
	icon     []byte
}

func NewApp(icon []byte) (*App, error) {
	store, err := connections.NewStore()
	if err != nil {
		return nil, err
	}
	return &App{
		store:    store,
		keyring:  connections.NewKeyring(),
		registry: catalog.NewRegistry(),
		requests: catalog.NewRequestRegistry(),
		searcher: catalog.NewTableSearcher(),
		icon:     icon,
	}, nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go desktopentry.Ensure(ctx, a.icon)
}

func (a *App) ListConnections() ([]connections.Connection, error) {
	return a.store.List()
}

// SaveConnection upserts a connection by name. Two secrets are passed
// separately and written to the OS keyring; the metadata file never sees
// either. Pass an empty string for any secret to keep the existing keyring
// entry untouched (useful when editing).
//
//   secret    — bearer token or OAuth2 client_secret, depending on Auth.Kind.
//   s3Secret  — optional S3 secret access key, only used when c.S3 is set.
func (a *App) SaveConnection(c connections.Connection, secret, s3Secret string) error {
	if err := a.store.Save(c); err != nil {
		wruntime.LogError(a.ctx, "save connection: "+err.Error())
		return errors.New("Failed to save connection: " + err.Error())
	}
	if secret != "" {
		if err := a.keyring.Set(c.Name, secret); err != nil {
			wruntime.LogError(a.ctx, "save secret: "+err.Error())
			return errors.New("Failed to save secret in OS keyring: " + err.Error())
		}
	}
	if s3Secret != "" {
		if err := a.keyring.SetS3(c.Name, s3Secret); err != nil {
			wruntime.LogError(a.ctx, "save s3 secret: "+err.Error())
			return errors.New("Failed to save S3 secret in OS keyring: " + err.Error())
		}
	}
	a.registry.Invalidate(c.Name)
	a.searcher.Invalidate(c.Name)
	return nil
}

func (a *App) DeleteConnection(name string) error {
	if err := a.store.Delete(name); err != nil {
		wruntime.LogError(a.ctx, "delete connection: "+err.Error())
		return errors.New("Failed to delete connection: " + err.Error())
	}
	if err := a.keyring.Delete(name); err != nil {
		wruntime.LogError(a.ctx, "delete secret: "+err.Error())
	}
	if err := a.keyring.DeleteS3(name); err != nil {
		wruntime.LogError(a.ctx, "delete s3 secret: "+err.Error())
	}
	a.registry.Invalidate(name)
	a.searcher.Invalidate(name)
	return nil
}

// TestConnection probes the catalog using the supplied connection metadata
// and secrets. The keyring is not consulted, so a user can test edits before
// saving.
func (a *App) TestConnection(c connections.Connection, secret, s3Secret string) error {
	ctx, cancel := context.WithTimeout(a.ctx, probeTimeout)
	defer cancel()
	if err := catalog.Probe(ctx, c.Name, argsFor(c, secret, s3Secret)); err != nil {
		wruntime.LogError(a.ctx, "probe catalog: "+err.Error())
		return errors.New(catalog.MapError(err))
	}
	return nil
}

// TestSavedConnection probes a previously-saved connection by name, fetching
// its secrets from the OS keyring.
func (a *App) TestSavedConnection(name string) error {
	conn, secret, s3Secret, err := a.resolveSecret(name)
	if err != nil {
		return err
	}
	return a.TestConnection(conn, secret, s3Secret)
}

// ListNamespaces lists child namespaces of parent for the given saved
// connection. parent may be nil or empty for top-level namespaces.
func (a *App) ListNamespaces(connName string, parent []string) ([]catalog.NamespaceDTO, error) {
	var out []catalog.NamespaceDTO
	err := a.withCatalog(connName, "list namespaces", func(cat *rest.Catalog) error {
		ctx, cancel := context.WithTimeout(a.ctx, listTimeout)
		defer cancel()
		idents, err := cat.ListNamespaces(ctx, table.Identifier(parent))
		if err != nil {
			return err
		}
		out = make([]catalog.NamespaceDTO, 0, len(idents))
		for _, id := range idents {
			path := append([]string(nil), id...)
			name := ""
			if n := len(path); n > 0 {
				name = path[n-1]
			}
			out = append(out, catalog.NamespaceDTO{Path: path, Name: name})
		}
		return nil
	})
	return out, err
}

// ListTables lists tables in a namespace for the given saved connection.
func (a *App) ListTables(connName string, namespace []string) ([]catalog.TableDTO, error) {
	var out []catalog.TableDTO
	err := a.withCatalog(connName, "list tables", func(cat *rest.Catalog) error {
		ctx, cancel := context.WithTimeout(a.ctx, listTimeout)
		defer cancel()
		out = []catalog.TableDTO{}
		for ident, iterErr := range cat.ListTables(ctx, table.Identifier(namespace)) {
			if iterErr != nil {
				return iterErr
			}
			if len(ident) == 0 {
				continue
			}
			ns := append([]string(nil), ident[:len(ident)-1]...)
			out = append(out, catalog.TableDTO{Namespace: ns, Name: ident[len(ident)-1]})
		}
		return nil
	})
	return out, err
}

// LoadTable loads a single table's metadata, partition spec, and properties.
func (a *App) LoadTable(connName string, namespace []string, name string) (*catalog.TableMetadataDTO, error) {
	var dto *catalog.TableMetadataDTO
	err := a.withCatalog(connName, "load table", func(cat *rest.Catalog) error {
		ctx, cancel := context.WithTimeout(a.ctx, loadTimeout)
		defer cancel()
		ident := append(table.Identifier(append([]string(nil), namespace...)), name)
		tbl, err := cat.LoadTable(ctx, ident)
		if err != nil {
			return err
		}
		out := catalog.BuildTableMetadataDTO(namespace, name, tbl)
		dto = &out
		return nil
	})
	return dto, err
}

// PreviewTable scans the table and returns up to limit rows starting at
// offset skip, as JSON-friendly values. limit ≤ 0 defaults to 100 rows;
// negative skip is clamped to 0. reqID lets the frontend cancel an in-flight
// scan via CancelPreview on unmount; pass "" to opt out. filters are
// AND-combined and pushed down to the iceberg-go scan; an empty list returns
// the unfiltered preview. Pagination is scan-and-discard: every call rescans
// from row 0 and drops the first skip rows, so cost is O(skip+limit) per call.
// PreviewRowsDTO.HasMore is true when the iterator still had rows beyond
// skip+limit, meaning the caller can fetch the next page.
func (a *App) PreviewTable(reqID, connName string, namespace []string, name string, skip, limit int, filters []catalog.PreviewFilterDTO) (*catalog.PreviewRowsDTO, error) {
	var dto *catalog.PreviewRowsDTO
	err := a.withCatalog(connName, "preview table", func(cat *rest.Catalog) error {
		reqCtx, release := a.requests.Register(a.ctx, reqID)
		defer release()
		ctx, cancel := context.WithTimeout(reqCtx, previewTimeout)
		defer cancel()
		ident := append(table.Identifier(append([]string(nil), namespace...)), name)
		tbl, err := cat.LoadTable(ctx, ident)
		if err != nil {
			return err
		}
		dto, err = catalog.BuildPreviewRows(ctx, tbl, skip, limit, filters)
		return err
	})
	return dto, err
}

// SearchTables returns tables whose fully-qualified name fuzzy-matches query,
// across the *whole* catalog rather than only the namespaces the tree has
// expanded. The first call for a connection crawls every namespace and caches
// the result; later calls hit the cache until it expires (5 min) or is
// invalidated by SaveConnection / DeleteConnection / RefreshTableIndex.
//
// limit ≤ 0 defaults to 500. The returned DTO reports the total match count
// and whether the crawl covered the whole catalog. reqID cancels an in-flight
// crawl via CancelRequest; pass "" to opt out.
func (a *App) SearchTables(reqID, connName, query string, limit int) (*catalog.TableSearchDTO, error) {
	var dto *catalog.TableSearchDTO
	err := a.withCatalog(connName, "search tables", func(cat *rest.Catalog) error {
		reqCtx, release := a.requests.Register(a.ctx, reqID)
		defer release()
		ctx, cancel := context.WithTimeout(reqCtx, searchTimeout)
		defer cancel()
		var err error
		dto, err = a.searcher.Search(ctx, connName, cat, query, limit)
		return err
	})
	return dto, err
}

// RefreshTableIndex drops the cached table index for a connection so the next
// SearchTables re-crawls. Wired to the frontend's "reload the tree from the
// root" gesture — the app's single "forget what you know about this catalog"
// action.
func (a *App) RefreshTableIndex(connName string) error {
	a.searcher.Invalidate(connName)
	return nil
}

// CancelRequest cancels an in-flight cancellable call (PreviewTable,
// SearchTables) by its reqID. Idempotent and safe to call on an unknown ID —
// returns nil either way.
func (a *App) CancelRequest(reqID string) error {
	a.requests.Cancel(reqID)
	return nil
}

// resolveSecret looks up a saved connection by name and pulls both its
// catalog secret and (if configured) S3 secret access key from the OS keyring.
func (a *App) resolveSecret(name string) (connections.Connection, string, string, error) {
	conns, err := a.store.List()
	if err != nil {
		return connections.Connection{}, "", "", errors.New("Failed to read connections: " + err.Error())
	}
	for i := range conns {
		if conns[i].Name != name {
			continue
		}
		secret, err := a.keyring.Get(name)
		if err != nil {
			wruntime.LogError(a.ctx, "read secret: "+err.Error())
			return connections.Connection{}, "", "", errors.New("Failed to read secret from keyring: " + err.Error())
		}
		s3Secret, err := a.keyring.GetS3(name)
		if err != nil {
			wruntime.LogError(a.ctx, "read s3 secret: "+err.Error())
			return connections.Connection{}, "", "", errors.New("Failed to read S3 secret from keyring: " + err.Error())
		}
		return conns[i], secret, s3Secret, nil
	}
	return connections.Connection{}, "", "", errors.New("Connection not found: " + name)
}

// withCatalog resolves the connection by name, runs fn against the cached
// REST catalog, and on auth-expired errors invalidates and retries once. The
// op string is used for log prefixing only. Errors are wrapped for UI display.
func (a *App) withCatalog(connName, op string, fn func(*rest.Catalog) error) error {
	conn, secret, s3Secret, err := a.resolveSecret(connName)
	if err != nil {
		return err
	}
	if err := a.registry.Do(a.ctx, conn.Name, argsFor(conn, secret, s3Secret), fn); err != nil {
		if !errors.Is(err, context.Canceled) {
			wruntime.LogError(a.ctx, op+": "+err.Error())
		}
		return errors.New(catalog.MapError(err))
	}
	return nil
}

func argsFor(c connections.Connection, secret, s3Secret string) catalog.Args {
	args := catalog.Args{
		URI:       c.URL,
		Warehouse: c.Warehouse,
		AuthKind:  c.Auth.Kind,
		Secret:    secret,
		AuthURL:   c.Auth.AuthURL,
		ClientID:  c.Auth.ClientID,
		Scope:     c.Auth.Scope,
	}
	if c.S3 != nil {
		args.S3AccessKeyID = c.S3.AccessKeyID
		args.S3SecretAccessKey = s3Secret
		args.S3Region = c.S3.Region
		args.S3Endpoint = c.S3.Endpoint
	}
	return args
}
