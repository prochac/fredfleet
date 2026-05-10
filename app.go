package main

import (
	"context"
	"errors"
	"time"

	"github.com/apache/iceberg-go/catalog/rest"
	"github.com/apache/iceberg-go/table"

	"github.com/prochac/fredfleet/internal/catalog"
	"github.com/prochac/fredfleet/internal/connections"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	probeTimeout   = 10 * time.Second
	listTimeout    = 10 * time.Second
	loadTimeout    = 30 * time.Second
	previewTimeout = 60 * time.Second
)

type App struct {
	ctx      context.Context
	store    *connections.Store
	keyring  *connections.Keyring
	registry *catalog.Registry
}

func NewApp() (*App, error) {
	store, err := connections.NewStore()
	if err != nil {
		return nil, err
	}
	return &App{
		store:    store,
		keyring:  connections.NewKeyring(),
		registry: catalog.NewRegistry(),
	}, nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
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
	cat, err := a.getCatalog(connName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, listTimeout)
	defer cancel()
	idents, err := cat.ListNamespaces(ctx, table.Identifier(parent))
	if err != nil {
		wruntime.LogError(a.ctx, "list namespaces: "+err.Error())
		return nil, errors.New(catalog.MapError(err))
	}
	out := make([]catalog.NamespaceDTO, 0, len(idents))
	for _, id := range idents {
		path := append([]string(nil), id...)
		name := ""
		if n := len(path); n > 0 {
			name = path[n-1]
		}
		out = append(out, catalog.NamespaceDTO{Path: path, Name: name})
	}
	return out, nil
}

// ListTables lists tables in a namespace for the given saved connection.
func (a *App) ListTables(connName string, namespace []string) ([]catalog.TableDTO, error) {
	cat, err := a.getCatalog(connName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, listTimeout)
	defer cancel()
	out := []catalog.TableDTO{}
	for ident, iterErr := range cat.ListTables(ctx, table.Identifier(namespace)) {
		if iterErr != nil {
			wruntime.LogError(a.ctx, "list tables: "+iterErr.Error())
			return nil, errors.New(catalog.MapError(iterErr))
		}
		if len(ident) == 0 {
			continue
		}
		ns := append([]string(nil), ident[:len(ident)-1]...)
		out = append(out, catalog.TableDTO{Namespace: ns, Name: ident[len(ident)-1]})
	}
	return out, nil
}

// LoadTable loads a single table's metadata, partition spec, and properties.
func (a *App) LoadTable(connName string, namespace []string, name string) (*catalog.TableMetadataDTO, error) {
	cat, err := a.getCatalog(connName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, loadTimeout)
	defer cancel()
	ident := append(table.Identifier(append([]string(nil), namespace...)), name)
	tbl, err := cat.LoadTable(ctx, ident)
	if err != nil {
		wruntime.LogError(a.ctx, "load table: "+err.Error())
		return nil, errors.New(catalog.MapError(err))
	}
	dto := catalog.BuildTableMetadataDTO(namespace, name, tbl)
	return &dto, nil
}

// PreviewTable scans the table and returns up to limit rows as JSON-friendly
// values. M3a baseline: no filter, no skip, no cancellation. limit ≤ 0
// defaults to 100 rows.
func (a *App) PreviewTable(connName string, namespace []string, name string, limit int) (*catalog.PreviewRowsDTO, error) {
	cat, err := a.getCatalog(connName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, previewTimeout)
	defer cancel()
	ident := append(table.Identifier(append([]string(nil), namespace...)), name)
	tbl, err := cat.LoadTable(ctx, ident)
	if err != nil {
		wruntime.LogError(a.ctx, "preview table: "+err.Error())
		return nil, errors.New(catalog.MapError(err))
	}
	dto, err := catalog.BuildPreviewRows(ctx, tbl, limit)
	if err != nil {
		wruntime.LogError(a.ctx, "preview rows: "+err.Error())
		return nil, errors.New(catalog.MapError(err))
	}
	return dto, nil
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

// getCatalog resolves the connection by name and returns a (possibly cached)
// connected REST catalog. Errors come back already wrapped for UI display.
func (a *App) getCatalog(connName string) (*rest.Catalog, error) {
	conn, secret, s3Secret, err := a.resolveSecret(connName)
	if err != nil {
		return nil, err
	}
	cat, err := a.registry.Get(a.ctx, conn.Name, argsFor(conn, secret, s3Secret))
	if err != nil {
		wruntime.LogError(a.ctx, "open catalog: "+err.Error())
		return nil, errors.New(catalog.MapError(err))
	}
	return cat, nil
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
