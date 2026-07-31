# fredfleet

Desktop app for browsing Apache Iceberg catalogs. Built with [Wails v2](https://wails.io) (Go backend + React/TypeScript frontend) on top of [`iceberg-go`](https://github.com/apache/iceberg-go).

Status: M4 — connection manager, namespace tree, schema viewer, row preview with filters and pagination, error toasts, and signed-by-omission release builds. See [`PLAN.md`](PLAN.md).

## Install

Download the latest binary from the [GitHub Releases page](https://github.com/prochac/fredfleet/releases/latest).

### macOS (Apple silicon and Intel)

The release ships a single universal binary. Releases are **unsigned**, so Gatekeeper will refuse to launch the app until you remove the quarantine attribute:

```bash
unzip fredfleet-*-darwin-universal.zip
mv fredfleet.app /Applications/
xattr -d com.apple.quarantine /Applications/fredfleet.app
open /Applications/fredfleet.app
```

### Linux (amd64)

```bash
tar xzf fredfleet-*-linux-amd64.tar.gz
chmod +x fredfleet
./fredfleet
```

Runtime requirements: WebKit2GTK 4.1, GTK 3, and a Secret Service implementation (GNOME Keyring, KWallet, KeePassXC, …) for token storage.

- Arch: `sudo pacman -S webkit2gtk-4.1 gtk3 libsecret`
- Debian/Ubuntu 24.04+: `sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libsecret-1-0 gnome-keyring`

### Windows (amd64)

Unzip and run `fredfleet.exe`. SmartScreen will warn the first time — click **More info → Run anyway**. WebView2 is preinstalled on Windows 11; on Windows 10 install the [Evergreen WebView2 runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

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

## Keyboard shortcuts

`Mod` is `⌘` on macOS and `Ctrl` on Linux and Windows. Press `?` in the app for
the same list, rendered for the platform you're on.

| Shortcut | Action |
|---|---|
| `Mod+K` | Command palette — jump to a table or run a command |
| `?` | Keyboard shortcuts |
| `Mod+,` | Manage connections |
| `Mod+N` | New connection |
| `Mod+0` | Focus the namespace tree |
| `Mod+1` … `Mod+4` | Preview / Schema / Partition spec / Properties |
| `Mod+L` | Focus the connection picker |
| `Mod+F` | Focus the preview filter bar |
| `Mod+R`, `F5` | Refresh the current view |
| `Mod+Shift+R` | Reload the namespace tree from the root |
| `Mod+Enter` | Apply filters now, skipping the 300 ms debounce |
| `Esc` | Close the current dialog |

Within the namespace tree: `↑`/`↓` move, `→` expands, `←` collapses, `Home`/`End`
jump to the ends, `Enter` opens a table. The tab bar takes `←`/`→` and
`Home`/`End`. `Tab` moves between the sidebar, the tab bar, and panel controls.

Notes:

- `Mod+F` deliberately shadows the webview's find-in-page — the filter bar is
  this app's find.
- The command palette searches the **whole catalog**, not just what the sidebar
  tree has loaded. Typing a table name starts a background crawl of every
  namespace; the result is cached for five minutes per connection, so the first
  query on a large catalog takes a moment and later ones are instant.
  `Mod+Shift+R` drops that cache along with the tree. Opening the palette without
  typing — or prefixing the query with `>` for commands — never triggers a crawl.
  The footer states what the results cover, including when a crawl came back
  partial because of permissions or a size cap. Table search is
  diacritic-insensitive, so `zakaznici` finds `zákazníci`.
- Jumping to a table from a namespace you never expanded opens it in the main
  panel; the sidebar tree is left as it was.
- Digit chords match the physical key, so `Mod+1` works on layouts whose number
  row needs `Shift` for digits (Czech, AZERTY).
- Window and clipboard shortcuts (`Mod+W`, `Mod+Q`, `Mod+C`/`V`/`X`/`A`) are
  left to the OS and are never intercepted.

## Row preview

Selecting a table loads the first page of rows alongside the schema and partition spec. The preview panel offers a filter bar, a page-size selector (100 / 250 / 500), client-side prev/next navigation over the loaded buffer, and a **Load more** button to append the next page.

Transient errors during refresh, filter changes, or **Load more** appear as toasts in the bottom-right corner — the previously-loaded rows stay visible so you can retry without losing the buffer. Errors on the first load (no data yet) show inline with a retry button.

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

## Build from source

### Prerequisites

- Go 1.26+ (matches `go.mod`)
- Node.js 20+ / npm
- [Wails CLI v2.12.0](https://wails.io/docs/gettingstarted/installation): `go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0`
- Platform deps for Wails (run `wails doctor` to check):
  - **Linux**: WebKit2GTK 4.1, GTK 3, libgcc, pkg-config — on Arch: `sudo pacman -S webkit2gtk-4.1 gtk3`; on Debian/Ubuntu 24.04+: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev pkg-config`
  - **macOS**: Xcode command-line tools
  - **Windows**: WebView2 runtime (preinstalled on Win11)

### First clone

The `frontend/wailsjs/` directory is gitignored because it's regenerated on every `wails dev` / `wails build`. After cloning, run `wails dev` once before TypeScript imports will resolve.

### Daily workflow

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
wails build -platform darwin/universal
wails build -platform windows/amd64
```

