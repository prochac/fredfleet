# fredfleet

Desktop app for browsing Apache Iceberg catalogs. Built with [Wails v2](https://wails.io) (Go backend + React/TypeScript frontend) on top of [`iceberg-go`](https://github.com/apache/iceberg-go).

Status: M1 — connection manager. Subsequent milestones add namespace browsing, schema viewer, and row preview. See [`PLAN.md`](PLAN.md).

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
- **OAuth2 client credentials** — the app fetches and refreshes tokens automatically via your auth server (e.g. Keycloak). Recommended for any real environment.

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

## Scope (M1)

- REST catalog only (Polaris/Lakekeeper). Glue/Hive/SQL backends are deferred.
- Auth: static bearer token, or OAuth2 client credentials with auto-refresh. AWS SigV4 deferred.
- Row preview, schema browsing, etc. land in later milestones.
