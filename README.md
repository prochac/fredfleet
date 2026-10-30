# fredfleet

Desktop app for browsing Apache Iceberg catalogs. Built with [Wails v2](https://wails.io) (Go backend + React/TypeScript frontend) on top of [`iceberg-go`](https://github.com/apache/iceberg-go).

Status: feature-complete, pre-1.0. Public v0.x builds are on the Releases page; there is no stable release yet. Features: connection manager, namespace tree, schema viewer, row preview with filters and pagination, command palette, error toasts, and unsigned release builds. See [`DESIGN.md`](DESIGN.md).

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

The app starts on **System**, following your OS dark/light preference and
switching live when you change it. The button in the sidebar header (or
`Mod+Shift+D`) cycles System → Light → Dark; a pinned choice ignores the OS and
is remembered across restarts.

Pinning is also the escape hatch when the OS preference can't be read: on Linux,
WebKit derives `prefers-color-scheme` from GTK, so a desktop that sets its dark
style without setting `gtk-application-prefer-dark-theme` (or a `*-dark` GTK
theme) leaves the app light. Setting it in `~/.config/gtk-3.0/settings.ini` fixes
detection for every GTK app; pinning fixes just this one.

## Keyboard shortcuts

`Mod` is `⌘` on macOS and `Ctrl` on Linux and Windows. Press `?` in the app for
the same list, rendered for the platform you're on.

| Shortcut          | Action                                             |
|-------------------|----------------------------------------------------|
| `Mod+K`           | Command palette — jump to a table or run a command |
| `?`               | Keyboard shortcuts                                 |
| `Mod+,`           | Manage connections                                 |
| `Mod+N`           | New connection                                     |
| `Mod+Shift+D`     | Switch theme (system → light → dark)               |
| `Mod+0`           | Focus the namespace tree                           |
| `Mod+1` … `Mod+4` | Preview / Schema / Partition spec / Properties     |
| `Mod+L`           | Focus the connection picker                        |
| `Mod+F`, `/`      | Focus the preview filter bar                       |
| `Mod+Shift+F`     | Add a filter row                                   |
| `Mod+R`, `F5`     | Refresh the current view                           |
| `Mod+Shift+R`     | Reload the namespace tree from the root            |
| `Mod+Enter`       | Apply filters now, skipping the 300 ms debounce    |
| `Esc`             | Close the current dialog                           |

Vim-style sequences — press the keys one after another, not together:

| Sequence      | Action                                         |
|---------------|------------------------------------------------|
| `g` `t`       | Focus the namespace tree                       |
| `g` `c`       | Focus the connection picker                    |
| `g` `1` … `4` | Preview / Schema / Partition spec / Properties |
| `g` `r`       | Reveal the open table in the tree              |

An unfinished sequence is dropped after 1.5 seconds or on `Esc`, and sequences
never fire while you are typing in a field.

Within the namespace tree: `↑`/`↓` or `j`/`k` move, `→`/`l` expands, `←`/`h`
collapses, `Home`/`End` or `gg`/`G` jump to the ends, `Enter` opens a table. The
tab bar takes `←`/`→` and `Home`/`End`. `Tab` moves between the sidebar, the tab
bar, and panel controls.

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
  panel and leaves the sidebar as it was. Press `g` `r` (or run *Reveal the open
  table in the tree*) to expand the tree down to it.
- While the tree has focus, `g` starts a tree motion (`gg`), so the `g`
  sequences above are for use elsewhere in the window.
- Digit chords match the physical key, so `Mod+1` works on layouts whose number
  row needs `Shift` for digits (Czech, AZERTY).
- Window and clipboard shortcuts (`Mod+W`, `Mod+Q`, `Mod+C`/`V`/`X`/`A`) are
  left to the OS and are never intercepted.

## Row preview

Selecting a table loads the first page of rows alongside the schema and partition spec. The preview panel offers a filter bar, sortable columns, a page-size selector (100 / 250 / 500), client-side prev/next navigation over the loaded buffer, a **Load more** button to append the next page, and CSV/JSON export.

Transient errors during refresh, filter changes, or **Load more** appear as toasts in the bottom-right corner — the previously-loaded rows stay visible so you can retry without losing the buffer. Errors on the first load (no data yet) show inline with a retry button.

### Filters

Filters are pushed down to the iceberg-go scan (server-side), so they apply to
the whole table rather than to the page on screen.

| Type                                | Supported operators                                                        |
|-------------------------------------|----------------------------------------------------------------------------|
| numeric / date / timestamp / string | `=`, `≠`, `<`, `≤`, `>`, `≥`, `in`, `not in`, `is null`, `not null`        |
| boolean                             | `=`, `≠`, `in`, `not in`, `is null`, `not null`                            |
| struct fields (`addr.city`)         | as for the field's own type                                                |
| binary, struct/list/map as a whole  | not filterable                                                             |

- **`in` / `not in`** take a comma-separated list; newlines work as separators
  too, and a trailing comma is ignored.
- **Null never matches a comparison.** `≠ x` and `not in (…)` skip rows where
  the value is null, as in SQL; use `is null` to find those.
- **Rows combine with `and` or `or`**, chosen per row. `and` binds tighter, as
  in SQL: `a`, `and b`, `or c` means `(a AND b) OR c`.
- **Nested fields** inside structs are offered by dotted path. Fields inside a
  *list* or a *map* are not — an Iceberg predicate cannot reference a field
  through a collection.
- Filters are **remembered per table** for as long as the app is running, so
  moving between tables and back keeps them. Any filter the new table cannot
  answer (missing column, or an operator its type does not support) is dropped,
  and you are told how many.

Two things to know about how nested filters run: fredfleet does not push a
nested predicate into the scan — on `iceberg-go` v0.7.0 two conditions on the
same nested field crash the scanner — so it evaluates those rows itself over the
returned data. Results are the
same, but a nested filter cannot skip files — one that matches very few rows
reads a lot of the table, bounded by the 60-second scan timeout.

Not supported:
- `starts with` / `CONTAINS` / `LIKE` / regex — `iceberg-go` builds the per-record filter via Arrow's substrait evaluator, which has no scalar mapping for `starts_with` (still true on v0.7.0). We surface it as a filter error and hide the operator from the UI; revisit when `arrow-go` ships the mapping.

### Sorting

Click a column header to sort ascending, again for descending, again to return
to scan order. Nulls sort last either way.

**The sort covers the rows you have loaded, not the whole table.** Iceberg scans
return rows in file order and there is no `ORDER BY` to push into one, so
sorting 100 loaded rows of a million-row table tells you about those 100 rows.
The status line says so whenever a sort is active, and **Load more** keeps
appending in scan order underneath it.

Tables over 150 rows render through a windowed list, so a 500-row page (or a
buffer grown by **Load more**) scrolls without laying out every row.

### Export

The **Export…** menu in the filter bar writes the rows matching your current
filters to a file you choose, as CSV or JSON — either just the rows loaded so
far, or every matching row in the table.

- The export **re-scans** rather than dumping what is on screen, so numbers keep
  their exact values and "all matching rows" really is all of them. A large
  export runs up to 10 minutes and can be cancelled.
- Rows come out in scan order; a column sort applied in the UI is **not**
  reflected in the file.
- CSV has no null, so a null and an empty string are both an empty field, and
  structs/lists/maps are written as JSON text inside the cell. Export JSON if
  either matters.

### Pagination model

Each fetch is **scan-and-discard**: the server iterates the Arrow stream from row 0, discards the first `skip` rows, and keeps the next `pageSize` rows (with one extra row probed to set `hasMore`). Cost is `O(skip + pageSize)` per call. This is fine for browsing; deep paging on large filtered scans gets linearly slower.

- The single hard upper bound is the per-call timeout (60 seconds). A scan that can't reach `skip + pageSize` rows in time will surface a timeout.
- Switching the page-size selector to a value that fits in the already-loaded buffer is purely client-side (no fetch). Switching to a larger value triggers a fresh fetch from `skip = 0`.
- Filter changes always reset the buffer and refetch from `skip = 0`.
- Paging works by rescanning and discarding, which only lines up if two scans agree on row order — they do not by default, so preview scans read data files one at a time. Tables spread over many files scan a little slower in exchange for **Load more** never repeating or skipping a row.

## Scope

- **Catalog backends:** REST only (Polaris, Lakekeeper). Glue/Hive/SQL are deferred.
- **Auth:** static bearer token, or OAuth2 client credentials (token re-fetched reactively on 401). AWS SigV4 deferred.
- **Delete files:** whatever `iceberg-go`'s `Scan()` returns. No custom positional/equality-delete handling.

## Build from source

### Prerequisites

- Go 1.26+ (matches `go.mod`)
- Node.js 22.12+ / npm (CI uses 24; Vitest 5 and Vite 8 need at least 22.12)
- [Wails CLI v2.17.0](https://wails.io/docs/gettingstarted/installation): `go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0`
- Platform deps for Wails (run `wails doctor` to check):
  - **Linux**: WebKit2GTK 4.1, GTK 3, libgcc, pkg-config — on Arch: `sudo pacman -S webkit2gtk-4.1 gtk3`; on Debian/Ubuntu 24.04+: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev pkg-config`
  - **macOS**: Xcode command-line tools
  - **Windows**: WebView2 runtime (preinstalled on Win11)

### First clone

Two generated directories are gitignored: `frontend/wailsjs/` (the Go bindings the TypeScript imports) and `frontend/dist/` (the built assets `main.go` embeds). Run a full build once after cloning — it produces both, in the right order:

```bash
wails build -tags webkit2_41    # drop the tag off Linux
```

Until then `go build`, `go test`, `golangci-lint` and `tsc` all fail on the missing halves — the Go side with `pattern all:frontend/dist: no matching files found`, the TS side with unresolved `../../wailsjs/...` imports.

### Daily workflow

```bash
wails dev      # hot-reload Go + Vite, opens devtools
wails build    # production binary in build/bin/
```

### Tests and lint

```bash
go test -race ./...
npm test --prefix frontend
golangci-lint run              # https://golangci-lint.run, config in .golangci.yml
```

CI runs all three plus a `wails build` on Linux, macOS and Windows for every push and pull request.

**On Linux (Arch and other distros that ship webkit2gtk-4.1):** add `-tags webkit2_41`. Wails 2.17 still defaults to the older 4.0 ABI.

```bash
wails dev   -tags webkit2_41
wails build -tags webkit2_41 -platform linux/amd64
```

Single-target build for other OSes:
```bash
wails build -platform darwin/universal
wails build -platform windows/amd64
```

## License

[Apache License 2.0](LICENSE)

