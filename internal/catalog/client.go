package catalog

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	"github.com/apache/iceberg-go/catalog/rest"
	"github.com/apache/iceberg-go/table"
)

const (
	AuthBearer = "bearer"
	AuthOAuth2 = "oauth2_client_credentials"
)

type Args struct {
	URI       string
	Warehouse string
	AuthKind  string
	Secret    string

	// OAuth2 client_credentials only.
	AuthURL  string
	ClientID string
	Scope    string
}

// Open builds a connected *rest.Catalog using the supplied args. The caller
// owns the catalog and may keep it alive across multiple calls; rebuilding
// triggers an OAuth2 token refresh, so cache when feasible.
func Open(ctx context.Context, name string, args Args) (*rest.Catalog, error) {
	opts, err := buildOptions(args)
	if err != nil {
		return nil, err
	}
	cat, err := rest.NewCatalog(ctx, name, args.URI, opts...)
	if err != nil {
		return nil, fmt.Errorf("create REST catalog: %w", err)
	}
	return cat, nil
}

// Probe opens a REST catalog connection using the supplied args and verifies
// it by listing top-level namespaces. The catalog is discarded after the
// check.
func Probe(ctx context.Context, name string, args Args) error {
	cat, err := Open(ctx, name, args)
	if err != nil {
		return err
	}
	if _, err := cat.ListNamespaces(ctx, table.Identifier{}); err != nil {
		return fmt.Errorf("list namespaces: %w", err)
	}
	return nil
}

func buildOptions(args Args) ([]rest.Option, error) {
	var opts []rest.Option
	if args.Warehouse != "" {
		opts = append(opts, rest.WithWarehouseLocation(args.Warehouse))
	}
	switch args.AuthKind {
	case AuthBearer:
		if args.Secret != "" {
			opts = append(opts, rest.WithOAuthToken(args.Secret))
		}
		return opts, nil
	case AuthOAuth2:
		if args.AuthURL == "" {
			return nil, errors.New("auth URL is required for OAuth2 client credentials")
		}
		if args.ClientID == "" {
			return nil, errors.New("client ID is required for OAuth2 client credentials")
		}
		if args.Secret == "" {
			return nil, errors.New("client secret is required for OAuth2 client credentials")
		}
		u, err := url.Parse(args.AuthURL)
		if err != nil {
			return nil, fmt.Errorf("parse auth URL: %w", err)
		}
		opts = append(opts,
			rest.WithCredential(args.ClientID+":"+args.Secret),
			rest.WithAuthURI(u),
		)
		if args.Scope != "" {
			opts = append(opts, rest.WithScope(args.Scope))
		}
		return opts, nil
	default:
		return nil, fmt.Errorf("unsupported auth kind: %q", args.AuthKind)
	}
}
