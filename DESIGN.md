# fredfleet — design

Desktop app for browsing Apache Iceberg catalogs: connect to a REST catalog,
walk its namespaces, read a table's schema, partition spec and properties, and
page through actual rows with server-side filters.

This document describes the system as it stands — what it does, how it is put
together, and why each non-obvious choice was made.

**Status:** feature-complete against the MVP scope. Everything described below
is in the tree and green (`go vet ./...`, `golangci-lint run`,
`go test -race ./...`, `tsc --noEmit`, `vitest`), and [CI](#ci) runs all of it
plus a three-platform build on every push. What remains is the first release
tag and the manual checks that nothing but a human at a keyboard can make — see
[Open items](#open-items).

---

## Scope

Locked in, and deliberately narrow:

- **Frontend stack** — Wails v2 + React + TypeScript (`react-ts` template).
  React over the author's preferred Vue purely for the table/grid ecosystem;
  `@tanstack/react-table` is what makes that trade pay off.
- **Catalog backends** — REST only (Polaris, Lakekeeper). `Connection` carries a
  catalog-type field so Glue/SQL/Hive can be slotted in without reshaping
  persistence, but no work happens on those backends before a 1.0.
- **Auth** — static bearer token *or* OAuth2 client credentials. No anonymous
  mode, no AWS SigV4. (OAuth2 was not in the original scope; it arrived when the
  test environment turned out to be Lakekeeper + Keycloak.)
- **Delete files** — whatever `iceberg-go`'s `Scan()` returns. No custom
  positional or equality-delete handling; gaps are documented in the README
  rather than worked around in app code.
- **Read-only** — no writes, no DDL, no snapshot management.

---

## Architecture

### Process shape

Two halves in one process. The Go side owns *all* catalog I/O through
`iceberg-go`; the webview frontend never issues a catalog request of its own and
holds no credentials. They meet at the Wails binding surface, which is the only
contract between them.

```
  React/TS  ──Wails bindings──►  App (app.go)  ──►  catalog.Registry  ──►  iceberg-go REST
   (webview)                        │                    │                      │
                                    │                    └─ cached *rest.Catalog│
                                    └──► connections.Store (JSON) + Keyring     └─ object store IO
```

### Binding surface

Every method on `App` is exposed to the frontend. Catalog-touching calls run
through `withCatalog` → `Registry.Do`, and every error is flattened by
`catalog.MapError` before it crosses the boundary, so the frontend renders
strings and never inspects Go error types.

| Binding                                                                | Timeout | Notes                                                              |
|------------------------------------------------------------------------|---------|--------------------------------------------------------------------|
| `ListConnections`, `SaveConnection`, `DeleteConnection`                | —       | Save/Delete also invalidate the catalog cache and the search index |
| `TestConnection`, `TestSavedConnection`                                | 10 s    | `Probe()` against an unsaved form or a stored connection           |
| `ListNamespaces(connName, parent)`                                     | 10 s    | one tree level                                                     |
| `ListTables(connName, namespace)`                                      | 10 s    | one tree level                                                     |
| `LoadTable(connName, namespace, name)`                                 | 30 s    | schema + partition spec + properties                               |
| `PreviewTable(reqID, connName, namespace, name, skip, limit, filters)` | 60 s    | the scan path                                                      |
| `SearchTables(reqID, connName, query, limit)`                          | 60 s    | may trigger a full catalog crawl                                   |
| `RefreshTableIndex(connName)`                                          | —       | drops the search cache                                             |
| `CancelRequest(reqID)`                                                 | —       | cancels a `PreviewTable` or `SearchTables` in flight               |

`reqID` is a frontend-minted UUID. It exists because Wails does not cancel a Go
call when the caller unmounts — see [Cancellation](#cancellation).

---

## Backend

### `internal/connections` — persistence and secrets

`Connection` (name, catalog type, URL, warehouse, `Auth`, optional `S3`) is
stored as JSON at `$XDG_CONFIG_HOME/fredfleet/connections.json` (and the
platform equivalents), mode 0600, written atomically through a temp file and
rename, guarded by a mutex.

**Secrets never enter that file.** Bearer tokens, OAuth2 client secrets and
optional S3 secret keys live in the OS keyring (`zalando/go-keyring`, service
`fredfleet`, account = connection name, with an `-s3` suffix for the S3 key).
The store and the keyring are separate types precisely so that no code path can
serialize a secret by accident.

The `Warehouse` field is required by Lakekeeper — and by Polaris when a catalog
exposes more than one warehouse — on the initial `/config` call, and is plumbed
through to `rest.WithWarehouseLocation`.

### `internal/catalog` — everything Iceberg

| File                 | Responsibility                                                   |
|----------------------|------------------------------------------------------------------|
| `client.go`          | `Args` → `rest.With*` options; `Open()` / `Probe()`              |
| `registry.go`        | per-connection `*rest.Catalog` cache, fingerprinting, auth retry |
| `dto.go`, `types.go` | the wire types the frontend sees, and the conversions into them  |
| `preview.go`         | Arrow record batches → `[]map[string]any`                        |
| `filter.go`          | filter DTOs → `iceberg.BooleanExpression`                        |
| `cancel.go`          | `RequestRegistry` — reqID → `context.CancelFunc`                 |
| `search.go`          | `TableSearcher` — the whole-catalog crawler and its cache        |
| `io.go`              | side-effect import registering S3/GCS/Azure IO factories         |
| `errors.go`          | `MapError` — every failure mode into one user-facing sentence    |

#### Catalog caching

`Registry` keys cached `*rest.Catalog` values by connection name, alongside a
fingerprint that is a sha256 over the effective `Args` *including* the resolved
secret. A changed URL, warehouse, auth mode or rotated secret therefore
invalidates itself with no explicit bookkeeping; `SaveConnection` and
`DeleteConnection` invalidate explicitly on top of that.

`Registry.Do` also carries a reactive auth retry: on `rest.ErrUnauthorized` or
`rest.ErrAuthorizationExpired` it drops the cached catalog and retries the
operation exactly once, which forces a fresh token fetch. Expiry-driven refresh
is `iceberg-go`'s job since v0.6.0; the retry now covers revoked or rotated
credentials, which no token source can anticipate. See
[iceberg-go constraints](#constraints-imposed-by-iceberg-go-v060).

#### DTOs

`NamespaceDTO`, `TableDTO`, `SchemaDTO`, `PartitionSpecDTO`, `PropertyDTO`,
`TableMetadataDTO`, `PreviewRowsDTO` / `PreviewColumnDTO` / `PreviewFilterDTO`,
`TableSearchDTO`.

`FieldDTO` is recursive and tagged by kind (primitive / struct / list / map).
Lists and maps emit synthetic `element` / `key` / `value` children, so the
frontend renders every nesting level with one uniform code path instead of
special-casing container types.

#### Row preview

`BuildPreviewRows(ctx, table, skip, limit, filters)` is the single entry point;
`App.PreviewTable` is a thin wrapper around it, which is what makes the tests
end-to-end proofs of the real path rather than of a stand-in.

It streams — `Scan(...).ToArrowRecords(ctx)`, stopping as soon as enough rows
are accumulated. `ToArrowTable` would materialize the whole table and is never
called.

Type coercions are explicit, because `encoding/json`'s defaults are wrong for
half of these:

| Iceberg type            | JSON representation                                       |
|-------------------------|-----------------------------------------------------------|
| decimal                 | string (never a float)                                    |
| timestamp / timestamptz | ISO-8601 string                                           |
| date                    | `YYYY-MM-DD`                                              |
| binary / fixed          | base64                                                    |
| struct / list / map     | nested `map[string]any` / `[]any`                         |
| null                    | JSON `null` — and it must round-trip as null, not as `""` |

The last row matters in the UI too: a null cell renders italic and muted so it
is never confused with an empty string.

`BuildPreviewRows` carries a `defer recover()`. That is not defensive
programming for its own sake — under Wails/WebKit a panic in a scanner goroutine
kills the process, because the SIGSEGV handler WebKit installs is not
`SA_ONSTACK`-safe.

#### Filters

Filters are pushed into the scan (`table.Scan(iceberg.WithRowFilter(...))`), so
they apply to the whole table and not to the loaded page. Multiple filters are
AND-combined. Literal coercion per field type (string → int64, date, decimal, …)
lives in `filter.go`.

| UI op                       | iceberg-go constructor                                                        |
|-----------------------------|-------------------------------------------------------------------------------|
| `eq` / `neq`                | `EqualTo[T]` / `NotEqualTo[T]`                                                |
| `lt` / `lte` / `gt` / `gte` | `LessThan[T]` / `LessThanEqual[T]` / `GreaterThan[T]` / `GreaterThanEqual[T]` |
| `isnull` / `notnull`        | `IsNull` / `NotNull`                                                          |
| (several filters)           | `NewAnd(...)` over the list                                                   |

Two decisions worth keeping:

- **`BuildRowFilter` returns an *unbound* expression.** It trial-binds against
  the schema to reject a bad filter early with a useful message, then throws the
  bound result away. iceberg-go's scanner re-binds `rowFilter` unconditionally
  and panics on an already-bound predicate.
- **Errors are a sentinel, not a string.** `ErrFilter` is surfaced verbatim
  through `MapError`, so an unsupported operator reads as
  `filter: operator '<op>' not supported` instead of a generic failure. An empty
  result keeps the column list, which is what leaves the "Clear filters"
  recovery path renderable — an early version stranded the user with a filter
  they could no longer edit.

#### Pagination

Scan-and-discard, because iceberg-go has no `OFFSET`. The server iterates from
row 0, drops the first `skip` rows, keeps the next `limit`, and probes one extra
row to decide `HasMore` — that trailing probe is what stops the UI offering a
"Load more" that would return nothing.

Cost is `O(skip + limit)` per call. Acceptable for browsing; deep paging on a
large filtered scan degrades linearly, and the only hard ceiling is the 60 s
call timeout.

#### Cancellation

Wails does not cancel a Go call when the frontend navigates away, so a user
clicking off a slow scan would otherwise leak the goroutines iceberg-go fanned
out over data files.

`RequestRegistry` (a `sync.Map` over reqID → `context.CancelFunc`) closes that.
The frontend mints a UUID per fetch and calls `CancelRequest` from the
`useEffect` cleanup — on unmount *and* before every re-fetch, so filter changes
and page-size changes inherit cancellation for free.

#### Catalog-wide table search

`TableSearcher` walks every namespace breadth-first through a bounded worker
pool (8 workers; caps at 5k namespaces, 100k tables, depth 16) and caches the
result per connection for five minutes. Callers racing on a cold index queue
behind a context-aware gate, so a burst of keystrokes triggers one crawl rather
than one per keystroke. A crawl that hits a permission wall or a cap returns
what it has plus a `partial` flag.

- **Crawl on first keystroke, not on palette open.** A bare `Mod+K`, or a `>`
  command query, costs nothing; opening the palette to run a command should not
  crawl a catalog.
- **Superseded queries are not cancelled, and neither is closing the palette.**
  This is a deliberate divergence from the cancel-on-unmount rule above.
  Cancelling a cold crawl discards the partial index, so an `Esc` a few seconds
  in would leave the user re-crawling from zero next time, and under fast typing
  the index would never finish at all. One request is in flight at a time and
  the next is issued when it settles. The only cancel is a connection switch —
  there, the work is a scan whose result the user navigated away from; here it
  is a cache the next open will want.
- **Backend narrows, frontend ranks.** `search.go`'s matcher is the same
  diacritic-folded subsequence predicate as `fuzzy.ts` minus the scoring, so
  ranking and `<mark>` highlighting stay in one place instead of being
  reimplemented twice and left to drift.

#### Object-store IO

`io.go` is a bare side-effect import of `iceberg-go/io/gocloud`, registering the
`s3`, `s3a`, `s3n`, `gs`, `abfs`, `abfss`, `wasb`, `wasbs` and `mem` schemes.
Without it every non-local data file fails with `io scheme not registered` —
metadata browsing works, reading rows does not. Vended credentials (Lakekeeper,
Polaris) are read from table properties by the factory; explicit per-connection
S3 credentials exist as a fallback for catalogs that do not vend.

### `internal/desktopentry`

On Linux, first launch self-installs `~/.local/share/applications/fredfleet.desktop`
(idempotent, skipped when running from a packaged context). This exists for one
reason: Wayland resolves a window's icon through `StartupWMClass`, so without a
desktop entry the app shows a generic placeholder in the taskbar.

---

## Frontend

### Layout

A split pane. Sidebar: connection picker (`<select>`) + a "Manage…" button that
opens the connection manager in a modal, over a lazily-loaded namespace tree.
Main panel: a tab bar — **Preview** (default), Schema, Partition spec,
Properties.

- **Tabs, not stacked sections.** The metadata panels started stacked, so a
  partition field could be cross-referenced against a schema field without
  clicking. The preview table needs the full panel width, and that
  cross-reference argument does not extend to rows — so the stack became tabs
  when the preview landed.
- **All panels stay mounted** (`hidden`, not unmounted), so Preview keeps its
  rows, buffer and filter state across tab switches.
- **Tree state resets by remount.** `key={selectedConnection}` on the sidebar
  means switching connections clears the tree with no manual teardown. This
  idiom is load-bearing — it is the reason tree state is deliberately *not*
  lifted into `App`, and it shapes several decisions further down.

### State

- `state/treeStore.ts` — `useReducer` with separate `childNamespaces` /
  `childTables` slots per node, so collapse and re-expand never re-fetch. Also
  holds the focused-node id for roving-tabIndex keyboard navigation.
- `state/tableIndex.tsx` — tables the tree has already loaded; the palette's
  instant half.
- `state/tableSearch.ts` — `useTableSearch(connName, term, enabled)`; the
  palette's backend half. The palette merges the two, dedupes by dotted label,
  and its footer reports which reach the results came from, including a crawl
  that came back partial.
- `state/pageSize.ts` — `pageSizePlan()`, extracted out of `PreviewPanel` so the
  rule is testable without mounting a component: if the new page size fits in
  the rows already loaded, re-paginate client-side; otherwise re-scan from
  `skip = 0`.
- `hooks/useDebounced.ts` — one 300 ms debounce shared by the filter bar and the
  palette.

`<Pending>` wraps every async boundary with loading / error / empty states and a
retry callback.

### Errors

Transient failures — refetch, filter change, Load more, save — raise a `sonner`
toast and leave the loaded rows in place. A failure on the *first* load stays
inline via `<Pending>`, so a cold failure never leaves an empty panel plus a
toast the user has to interpret. Search errors never toast at all: a dead
catalog would fire one per keystroke, so the palette footer says "Catalog search
unavailable" and tree-loaded tables stay searchable.

### Keyboard shortcuts

`frontend/src/shortcuts/` — `keys.ts` (platform detection, `KeySpec`, `matches`,
`formatShortcut`), `commands.ts` (the `COMMANDS` catalogue), `registry.tsx`
(`ShortcutProvider`, `useCommand`, priority tiers), `useGlobalShortcuts.ts` (a
single `document` keydown dispatcher), `fuzzy.ts` (diacritic-insensitive
scorer).

Shipped bindings: `Mod+K`, `Mod+,`, `Mod+N`, `Mod+0`, `Mod+1..4`, `Mod+L`,
`Mod+F`, `Mod+R`/`F5`, `Mod+Shift+R`, `Mod+Shift+D`, `Mod+Enter`, `?`, `Esc`.
Arrow navigation inside the tree and the tab bar. The README carries the full
table; `KeyboardHelpModal` renders from `COMMANDS`, so the dialog cannot drift
from the dispatcher.

- **A command registry, not lifted state.** Components subscribe handlers by id
  (`useCommand`) and the dispatcher looks them up. Chosen over lifting tab,
  filter and tree state into `App` — which would have fought the
  `key={selectedConnection}` remount idiom — and over per-panel imperative
  handles. One catalogue feeds the dispatcher, the help dialog and the palette.
- **An unregistered command is inert** — the dispatcher skips `preventDefault()`
  so the key stays native. The exception is `alwaysPreventDefault`, for chords
  shadowing a destructive browser default: `Mod+R`/`F5` would reload the webview
  and wipe all state, `Mod+F` would open find-in-page.
- **Priority tiers** resolve conflicts: preview and metadata panels register
  `Mod+R` at `PRIORITY.TABLE` and both fire; the tree registers at
  `PRIORITY.TREE` and is only reached when no table is open.
- **Overlay scoping** (`'none' | 'palette' | 'modal'`) replaces an ad-hoc modal
  check. Nothing fires over a dialog; only palette commands fire over the
  palette, which is what lets `Mod+K` toggle it shut. It also fixed a live bug
  where `?` inside the manage modal replaced it with the help dialog.

**Keyboard-layout correctness** — the non-obvious part, and the reason this is
not fifteen lines of `e.key === 'k'`:

- Digits and punctuation match on `e.code` (`Digit1`, `Comma`). The Czech number
  row is `ěščřžýáíé` and digits need `Shift`, so `e.key === '1'` would leave
  `Mod+1` dead. Letters match on `e.key`.
- **AltGr reports as `ctrlKey + altKey`** on Windows and Linux, and AltGr is how
  a Czech layout types `[ ] { } @ \ |` — `AltGr+F` *is* `[`. Every chord
  requires `!altKey`, or typing a bracket into a filter value would fire and
  swallow `Mod+F`.
- Dead-key composition (`ˇ` then `s` = `š`) is skipped via `isComposing` /
  `keyCode === 229`. `e.repeat` is ignored, so holding `Mod+R` cannot queue
  dozens of scans.
- Platform comes from Wails' `Environment()`, not the deprecated
  `navigator.platform`, with a user-agent seed for first paint.

### Theme

`theme.ts` is a store: preference `system | light | dark`, persisted in
localStorage, defaulting to `system`, which tracks `prefers-color-scheme` live.
A sidebar button and `Mod+Shift+D` cycle it. `color-scheme` on `<html>` pulls
native scrollbars and `<select>` popups into the theme, and sonner reads the
resolved value instead of re-sniffing the media query.

`main.go` uses `mac.DefaultAppearance`; `mac.NSAppearanceNameAqua` had been
pinning macOS to light, and with it the webview's `prefers-color-scheme`.

Pinning is also the escape hatch on Linux, where WebKit derives
`prefers-color-scheme` from GTK: a desktop that goes dark without setting
`gtk-application-prefer-dark-theme` leaves every GTK app light, this one
included.

---

## Constraints imposed by `iceberg-go` v0.6.0

These shape the design more than any internal decision does. All of them are
upstream; none is worked around by forking, because this project deliberately
does not maintain an `iceberg-go` fork.

- **No `starts_with`.** The scan builds its per-record filter through Arrow's
  substrait evaluator, which has no scalar mapping for `starts_with`; the scan
  dies with `not implemented: starts_with` inside `arrow_scanner.go`. The
  operator was cut from the UI and is rejected at the boundary with a message
  naming the upstream gap. No LIKE, CONTAINS or regex either. The gap is on
  Arrow's side, not `iceberg-go`'s — `table/substrait` emits the `starts_with`
  extension reference fine, and always did; nothing consumes it. Re-verified
  against v0.6.0 by `TestStartsWithStillUnsupportedUpstream`, which scans a
  string column with a real `iceberg.StartsWith` filter and asserts the
  failure, so the day `arrow-go` implements the mapping the test fails and
  tells us to delete the rejection.
- **No `OFFSET`** — hence scan-and-discard pagination.
- **The scanner re-binds `rowFilter` unconditionally** and panics on an
  already-bound predicate — hence the unbound expression from `BuildRowFilter`,
  and the `recover()` in `BuildPreviewRows`.
- **`PartitionField.SourceID()` collapses multi-argument transforms.** v0.6.0
  changed `SourceID` from a field to a method over a new `SourceIDs []int`
  slice, so transforms can take several source columns. `PartitionFieldDTO`
  carries the single id that `SourceID()` returns, which is the first element.
  Correct for every transform the Iceberg spec defines today (all take exactly
  one source column); a multi-argument transform would render incompletely.
  Widening the DTO is a frontend change too, so it waits until such a transform
  actually exists.

### Resolved upstream in v0.6.0

Three constraints that shaped earlier decisions are gone. Recorded here because
the code they justified is still in place, in reduced form, and would otherwise
look unmotivated.

- **OAuth2 token refresh.** v0.5.0's `Oauth2AuthManager` fetched a token once
  and kept it on the struct forever — `expires_in` decoded and ignored, refresh
  tokens unused, no 401 re-auth path — so a cached `*rest.Catalog` kept sending
  a stale bearer until restart. v0.6.0 wraps an `oauth2.TokenSource` built from
  `clientcredentials.Config`, which handles expiry and refresh itself. The
  reactive retry in `Registry.Do` stays, but it now covers only what a token
  source cannot see: a token revoked server-side or credentials rotated at the
  IdP before the stated expiry, where the cached source keeps vending a token it
  still believes is good. **New invariant:** the context passed to
  `Registry.Get` is captured by that token source and used for every later
  refresh, so it must be app-lifetime — a request-scoped context would make
  refreshes fail with `context canceled` long after the request ended.
  `App.withCatalog` passes `a.ctx`, which is correct.
- **The data race in the scan planner.** `Scan.collectManifestEntries` handed
  the *same* cached partition evaluator to every errgroup worker, and
  `exprEvaluator.Eval` wrote `e.st` on it before visiting — benign for
  unpartitioned tables, a pruning-correctness bug for partitioned ones. v0.6.0's
  `Eval` copies the evaluator per call. `go test -race ./...` is clean; the
  carve-out that kept `-race` off the default test command is gone.
- **Dependency pinning around substrait.** v0.5.0 pulled `substrait-go/v7`,
  which only compiled against `substrait-protobuf` v0.81.0, while `arrow-go`
  v18.7.0 wanted v0.85.0 — MVS picked the newer one and the module stopped
  building, so `arrow-go` and `substrait-protobuf` were pinned by hand and
  `go mod tidy` was off-limits. v0.6.0 moved to `substrait-go/v8` v8.1.1 on
  `substrait-protobuf` v0.85.0, `arrow-go` is unpinned at v18.7.0, and
  `go mod tidy -diff` is clean. The general rule that deps track tagged
  releases rather than pseudo-versions still stands; this specific conflict
  does not.

---

## Testing

```bash
go test -race ./...          # backend
npm test --prefix frontend   # vitest
golangci-lint run            # .golangci.yml; CI pins the same version
```

Every Go tool here needs `frontend/dist` to exist, because `main.go` embeds it
and it is gitignored — on a fresh clone they all fail with
`pattern all:frontend/dist: no matching files found` before compiling a line.
Build the frontend once, or drop a placeholder `index.html` there, which is
what CI does.

`internal/catalog/fixture_test.go` builds a **real** Iceberg table on local disk
via an in-memory `table.CatalogIO` and runs assertions through
`BuildPreviewRows` — the same function `App.PreviewTable` delegates to. These
are end-to-end proofs of the scan path, not mock-level ones.

It deliberately avoids iceberg-go's SQL catalog: importing `catalog/sql` drags
in `bun` + `modernc.org/sqlite` — originally fatal, because the `go mod tidy`
that followed tripped the substrait conflict; now merely a cgo-adjacent
dependency tree pulled into a shipped binary to serve a test. `table.CatalogIO`
is a two-method interface, so an in-memory implementation costs zero new
dependencies.

What the executable proofs cover:

| Test                                       | Proves                                                                                                                                                                                                                                                     |
|--------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `TestFilterMatchesRowPastFirstPage`        | A filter reaches the scan, not the page. 300-row fixture, `tag="needle"` on id=250 only; asserts the needle is absent from an unfiltered 100-row page (so the premise holds), then that `tag = needle` at `limit=100` returns exactly `[250]`              |
| `TestFilterOnUnmatchedValueReturnsNoRows`  | The inverse, and that the column list survives an empty result — what keeps "Clear filters" renderable                                                                                                                                                     |
| `TestCancelledScanReleasesGoroutines`      | Baseline after warmup, scan against a deliberately slow IO wrapper, asserts the goroutine count actually *rose* (no vacuous pass), cancels via `RequestRegistry`, requires `context.Canceled` in <1 s and `NumGoroutine()` at or below baseline within 5 s |
| `TestLoadMoreProducesNoDuplicates`         | The exact `skip = len(loaded)` sequence the frontend issues tiles 0..299 with no repeat and no gap                                                                                                                                                         |
| `TestPaginationUnderFilterHasNoDuplicates` | The same under an active filter (every third row matches)                                                                                                                                                                                                  |
| `TestHasMoreAtExactPageBoundary`           | The trailing-probe rule: a 200-row table must not offer a Load-more that returns zero rows                                                                                                                                                                 |
| `TestStartsWithStillUnsupportedUpstream`   | The `starts` rejection is still warranted: a real `iceberg.StartsWith` scan against a string column still dies with `not implemented: starts_with`. Fails loudly if `arrow-go` ever ships the mapping                                                       |
| `preview_test.go`, `filter_test.go`        | Type coercions and filter translation                                                                                                                                                                                                                      |
| `search_test.go`                           | Crawl, cache and matcher behaviour                                                                                                                                                                                                                         |
| `connections/store_test.go`                | Upsert-by-name, stable order, no-op delete, 0600 + atomic rename with no stray `.tmp`, a corrupt file refusing to be clobbered, concurrent saves losing nothing, and — structurally — that no secret-shaped field can reach `connections.json`             |
| `connections/keyring_test.go`              | Round-trip, missing entry as `""` rather than an error, idempotent delete, the `:s3` suffix keeping the two secrets apart, and a broken backend surfacing instead of yielding an empty secret. Runs against `keyring.MockInit()`, so CI needs no keychain    |
| `frontend/src/state/pageSize.test.ts`      | 100 → 500 re-fetches at a 200-row buffer; 500 → 100 slices client-side; plus the boundary, no-op and cold-buffer cases                                                                                                                                     |
| `frontend/src/state/treeStore.test.ts`     | Collapse and re-expand keeps loaded children and their `loaded` status — the no-re-fetch invariant; the two child slots fill independently; a parent reload does not replace a known child node; `flattenVisible` / `parentKey` ordering and dangling keys  |
| `frontend/src/shortcuts/keys.test.ts`      | The layout rules: Ctrl vs Cmd per platform, the other modifier locking a chord out, AltGr (`ctrl+alt`) never firing, `Mod+R` vs `Mod+Shift+R`, `shift: 'any'`, digits by `e.code` on a Czech row, letters by `e.key`, and an empty `code` matching nothing  |
| `frontend/src/shortcuts/fuzzy.test.ts`     | Diacritic folding both directions, positions indexing the *original* accented string, and the ranking rules (word start, tight run, separator acronym, shorter target)                                                                                     |

---

## CI

`.github/workflows/ci.yml` runs on push to `master`, on pull requests and on
demand:

- **go** — `go mod tidy -diff`, `go vet`, `golangci-lint`, `go test -race`.
- **frontend** — `wails generate module` (the TS sources import the generated
  bindings, which are gitignored), then `npm ci`, `vitest`, and `npm run build`
  — the same `tsc && vite build` that `wails build` shells out to, so a type
  error fails here instead of at release time.
- **build** — `wails build` on `ubuntu-24.04`, `macos-14` and `windows-2022`,
  gated on the two above. This is the only continuous evidence that the macOS
  and Windows legs compile, since the app has only ever been *run* on Linux.

Both Go jobs write a placeholder `frontend/dist/index.html` first, for the
embed reason described under [Testing](#testing).

Dependabot (`.github/dependabot.yml`) tracks gomod, npm and the actions
themselves, weekly, with minor/patch grouped. `typescript` and `@types/node`
are ignored outright — they are pinned together and unpin together — and minor
or major bumps of `iceberg-go` and `wails/v2` are held back for a human,
because both carry the constraints this document records.

## Release and packaging

`.github/workflows/release.yml` builds `linux/amd64`, `darwin/universal` and
`windows/amd64`, and drafts a GitHub release on a `v*` tag. The three build
legs are gated on a `test` job (`go test -race` + `vitest`), so a tag cannot
ship a binary whose tests are red. It also accepts `workflow_dispatch`, which
runs the build legs and uploads artifacts without drafting a release (the
release job is gated on `refs/tags/v`) — that is the way to smoke-test the
pipeline before spending a tag.

`wails build` has no version flag: it reads `info.productVersion` out of
`wails.json` and templates it into `CFBundleVersion` /
`CFBundleShortVersionString` and the Windows VERSIONINFO resource. Each build
leg therefore runs `.github/scripts/stamp-version.sh`, which rewrites that
field from the tag; the checked-in value stays `0.0.0` so a local build is
never mistaken for a release. A prerelease tag is stamped as its numeric core
(`v1.2.0-rc1` → `1.2.0`), because the Windows resource only accepts `X.Y.Z` —
asset filenames still carry the full tag.

GoReleaser was considered and does not fit: it cannot produce a macOS `.app`
bundle or drive Wails' resource templating, and the hard part here is
cgo-linked WebKit/WebView2, which wants a native runner per platform anyway.
Three `wails build` legs on three runners is both simpler and closer to what
`wails build` does locally.

Releases are **unsigned**: macOS needs the quarantine attribute removed, Windows
shows a SmartScreen warning. Documented in the README rather than solved; code
signing needs certificates this project does not have.

Linux builds pass `-tags webkit2_41`. Wails still defaults to the webkit2gtk-4.0
ABI as of 2.13, and distros that ship only 4.1 report "libwebkit Not Found"
without it.

`WAILS_VERSION` in the workflow pins the CLI that generates bindings and drives
the build; `go.mod` pins the library it links against. They are separate knobs
and must be bumped together — a mismatch produces bindings from one version
against a runtime from another.

---

## Open items

Nothing here is code work. Everything left is a release action or a check that
only a human can perform.

- ⏳ **Publish.** The `origin` remote is empty — no branch has ever been pushed
  and no tag cut, so neither workflow has ever run. Push `master`, let CI go
  green, smoke the release pipeline via `workflow_dispatch`, then tag. The
  macOS and Windows legs, artifact naming and the release step are all
  unverified until then. GitHub's repo default branch must also be set to
  `master`, or the CI push trigger never fires.
- ⏳ **Packaged binary runs on a clean machine** with no Go toolchain — blocked
  on the tag above.
- ⏳ **Dark mode follows a live OS change.** Flip the system setting with the app
  open and the preference on "system"; confirm a Light/Dark pin survives a
  restart. Inherently manual.
- ⏳ **Keyboard-only walk** of tree → schema → preview, end to end. Implemented
  and unit-covered in pieces, never walked in one go.
- ⏳ **Network error during preview** shows a toast and leaves the schema panel
  intact. The toast path is wired for refetch and Load-more but has not been
  exercised against a catalog killed mid-scan.
- ⏳ **README quickstart** read literally by someone who has never used the app.
- ⏳ **OAuth2 refresh against a live catalog.** The refresh path moved from our
  `Registry.Do` retry into `iceberg-go`'s token source in v0.6.0, and no test
  here covers it — the fixture uses no catalog server. Connect to a catalog
  issuing short-lived tokens, leave the app idle past expiry, and confirm the
  next click works without a restart.

Also unverified: the app has only ever been launched on Linux (Arch,
webkit2gtk-4.1). macOS and Windows are built but never smoke-tested.

---

## Deliberately not done

Parked, with the reasoning that parked them:

- **`IN` / `NOT IN`, OR-combined filters, filters on nested fields, sorting, row
  virtualization, CSV/JSON export, filter state persisted across table
  switches** — all straightforward extensions of the preview; none needed for a
  browser.
- **Reveal-in-tree.** Jumping to a table from an unexpanded namespace opens it
  in the main panel and leaves the sidebar alone. Revealing would need a cascade
  action in `treeStore` plus a route from `App` into `NamespaceTree`'s store,
  which is deliberately not lifted (`key={selectedConnection}` remount idiom).
- **`/` focus and `g`-then-`t` vim chords** — a two-key dispatcher is not a
  convention desktop users expect here, and `Mod+K` covers the same ground.
- **User-customisable keybindings, chord macros, exporting shortcut prefs.**
- **Persisting palette search state** — the five-minute backend cache already
  makes a reopen instant.
