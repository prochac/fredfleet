# fredfleet

Desktop app for browsing Apache Iceberg catalogs. Built with [Wails v2](https://wails.io) (Go backend + React/TypeScript frontend) on top of [`iceberg-go`](https://github.com/apache/iceberg-go).

Status: M3 — connection manager, namespace tree, schema viewer, and row preview with filters and pagination. See [`PLAN.md`](PLAN.md).

## Prerequisites

- Go 1.26+
- Node.js / npm
- [Wails CLI v2](https://wails.io/docs/gettingstarted/installation): `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- Platform deps for Wails (run `wails doctor` to check):
  - **Linux**: WebKit2GTK 4.1, GTK 3, libgcc, pkg-config — on Arch: `sudo pacman -S webkit2gtk-4.1 gtk3`
  - **macOS**: Xcode command-line tools
  - **Windows**: WebView2 runtime (preinstalled on Win11)
- Token storage backend (Linux only): a Secret Service implementation must be running. GNOME Keyring, KWallet, or KeePassXC all work.

## First clone

The `frontend/wailsjs/` directory is gitignored because it's regenerated on every `wails dev`/`wails build`. After cloning, run `wails dev` once before TypeScript imports will resolve.

## Daily workflow

```bash
wails dev      # hot-reload Go + Vite, opens devtools
wails build    # production binary in build/bin/
```

**On Linux (Arch and other distros that ship webkit2gtk-4.1):** add `-tags webkit2_41`. Wails 2.12 defaults to the older 4.0 ABI.

```bash
wails dev   -tags webkit2_41
wails build -tags webkit2_41 -platform linux/amd64
```

Single-target build for other OSes:
```bash
wails build -platform darwin/arm64
wails build -platform windows/amd64
```

## Configure a connection

The app supports two auth modes for REST catalogs:

- **Bearer token** — paste a static token. Useful for catalogs without an auth server, or for short-lived manual testing.
- **OAuth2 client credentials** — the app fetches a token from your auth server (e.g. Keycloak) on first use and re-fetches it after expiry. Recommended for any real environment.

### Quickstart: bearer token

1. Spin up a local catalog without auth:
   ```bash
   docker run --rm -p 8181:8181 quay.io/lakekeeper/catalog:latest
   ```
2. Launch the app, click **Add connection**:
   - Name: any label
   - Catalog URL: `http://localhost:8181/catalog`
   - Authentication: **Bearer token (static)**
   - Bearer token: any non-empty string for catalogs without auth
3. Click **Test** → expect green. Then **Save**.

### Quickstart: OAuth2 (Keycloak / Lakekeeper)

1. Add connection:
   - Catalog URL: `https://lakekeeper.example.com/catalog/`
   - Authentication: **OAuth2 client credentials**
   - Auth URL (token endpoint): `https://keycloak.example.com/realms/iceberg/protocol/openid-connect/token`
   - Client ID: your client (e.g. `client1`)
   - Scope: leave blank unless your server requires a non-default scope
   - Client secret: paste the secret
2. Click **Test** — the app exchanges the credentials for a token and lists namespaces. Then **Save**.

### Where things are stored

Connection metadata: `$XDG_CONFIG_HOME/fredfleet/connections.json` (Linux), `~/Library/Application Support/fredfleet/connections.json` (macOS), `%APPDATA%\fredfleet\connections.json` (Windows).

Secrets (bearer tokens or OAuth2 client secrets) are stored in your OS keyring under service `fredfleet`, account = connection name. They never touch the JSON file.

Inspect on Linux: `secret-tool lookup service fredfleet account <connection-name>`.

## Theme

The app follows your OS dark/light preference automatically via `prefers-color-scheme`. No user setting.

## Row preview

Selecting a table loads the first page of rows alongside the schema and partition spec. The preview panel offers a filter bar, a page-size selector (100 / 250 / 500), client-side prev/next navigation over the loaded buffer, and a **Load more** button to append the next page.

### Filters

Filters are pushed down to the iceberg-go scan (server-side). Multiple filters are AND-combined.

| Type | Supported operators |
|---|---|
| numeric / date / timestamp / string | `=`, `≠`, `<`, `≤`, `>`, `≥`, `is null`, `not null` |
| boolean | `=`, `≠`, `is null`, `not null` |
| binary, struct, list, map | not filterable |

Not supported:
- `starts with` / `CONTAINS` / `LIKE` / regex — `iceberg-go` v0.5.0 builds the per-record filter via Arrow's substrait evaluator, which has no scalar mapping for `starts_with`. We surface it as a filter error and hide the operator from the UI; revisit when an upstream release ships the mapping.
- `IN` / `NOT IN`, OR-combining, filtering on nested fields, sorting — out of scope for M3.

### Pagination model

Each fetch is **scan-and-discard**: the server iterates the Arrow stream from row 0, discards the first `skip` rows, and keeps the next `pageSize` rows (with one extra row probed to set `hasMore`). Cost is `O(skip + pageSize)` per call. This is fine for browsing; deep paging on large filtered scans gets linearly slower.

- The single hard upper bound is the per-call timeout (60 seconds). A scan that can't reach `skip + pageSize` rows in time will surface a timeout.
- Switching the page-size selector to a value that fits in the already-loaded buffer is purely client-side (no fetch). Switching to a larger value triggers a fresh fetch from `skip = 0`.
- Filter changes always reset the buffer and refetch from `skip = 0`.

## Scope

- **Catalog backends:** REST only (Polaris, Lakekeeper). Glue/Hive/SQL are deferred until after M4.
- **Auth:** static bearer token, or OAuth2 client credentials (token re-fetched reactively on 401). AWS SigV4 deferred.
- **Delete files:** whatever `iceberg-go`'s `Scan()` returns. No custom positional/equality-delete handling.
