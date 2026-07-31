# Implementation plan — Iceberg viewer desktop app

Four sequential milestones. Each is a shippable checkpoint:
- After **M2** you have a useful metadata browser even without data reading.
- After **M3** it's genuinely an MVP.

## Scope decisions (locked in)

- **Frontend stack:** Wails v2 + React + TypeScript (`react-ts` template).
- **Catalog backends:** REST only for the MVP. The `Connection` struct still carries a `catalog type` field so Glue/SQL/Hive can be slotted in later without reshaping persistence — but no work on those backends until after M4.
- **Auth:** Static bearer token *or* OAuth2 client credentials. No anonymous mode, no AWS SigV4. *(OAuth2 added during M1 implementation — original scope was bearer-only, but the test environment turned out to require Keycloak. Token refresh is reactive on our side because `iceberg-go` v0.5.0 caches the token forever — see `Registry.Do` and the gotcha in `CLAUDE.md`.)*
- **Delete files (M3):** Rely on whatever `iceberg-go`'s `Scan()` returns. Don't add custom positional/equality-delete handling. Document any observed gaps in the README rather than working around them in app code.

## Notes

- The hardest single task is the Arrow → JSON serialization in M3. `iceberg-go` returns Arrow record batches, and we need a representation for the frontend. A simple `[]map[string]any` is fine for v1 — just handle type coercions carefully: decimals as strings, timestamps as ISO strings, bytes as base64.
- The goroutine leak check in M3 is worth taking seriously: Wails frontend navigation doesn't automatically cancel in-flight Go calls. Wire a `context.WithCancel` pattern to a frontend "unmount" event.

---

## Milestone 1 — Wails scaffold + connection manager *(foundation)* — **shipped**

### What landed
- Wails v2 + React/TS scaffold integrated; production binary builds in ~25s on Linux (`-tags webkit2_41`).
- `internal/connections/` — `Connection`/`Auth` types with `Warehouse` field, mutex-guarded JSON store at `$XDG_CONFIG_HOME/fredfleet/connections.json` (0600, atomic writes), OS-keyring secret store via `zalando/go-keyring`.
- `internal/catalog/` — `Probe()` + `Args` struct that selects the right `rest.With*` options per auth kind. `MapError()` translates `rest.Err*`, `*url.Error`, DNS, and ECONNREFUSED into UI messages.
- Bound methods: `ListConnections`, `SaveConnection`, `DeleteConnection`, `TestConnection`, `TestSavedConnection`. Secrets always go through the keyring, never JSON.
- React UI: connection list (Test/Edit/Delete per row), modal form with auth-kind selector + conditional OAuth2 fields, delete confirmation, theme via `prefers-color-scheme`.

### Scope additions during M1
- **OAuth2 client credentials** — added when the user's test environment turned out to be Lakekeeper + Keycloak. Static bearer remained as the other option.
- **Warehouse field** — required by Lakekeeper (and Polaris when multiple warehouses exist) on the initial `/config` call. Plumbed through to `rest.WithWarehouseLocation`.

### Tasks (original)
- Init Wails project, confirm Go + frontend build pipeline works end-to-end
- Define `Connection` struct (name, catalog type, URL, auth config) and persist to a local JSON file via Go
- Connection manager UI: list, add, edit, delete connections
- Wire Wails bindings: frontend calls Go, Go talks to iceberg-go REST catalog, returns error or success
- OS dark/light mode forwarded to frontend via Wails system events

### Validation criteria
- ✅ App launches on Linux (Arch, webkit2gtk-4.1). macOS / Windows not yet smoke-tested.
- ✅ Can add a connection pointing at a real REST catalog — Lakekeeper + Keycloak, confirmed by every subsequent live check in M2/M3.
- ✅ Connection persists after app restart (atomic write + read on launch).
- ✅ Wrong URL or bad auth shows a clear error message — `MapError` covers auth, forbidden, timeouts, DNS, ECONNREFUSED.
- ⏳ Dark mode toggles correctly when OS preference changes — `theme.ts` follows `matchMedia` under the default "system" preference; M4 added a System/Light/Dark override. Needs visual confirmation by toggling the system setting with the app open.

---

## Milestone 2 — Namespace tree + schema viewer *(browsing)* — **shipped**

### What landed
- Backend: public `catalog.Open()` returning `*rest.Catalog`; `Probe()` now wraps it. Per-connection `catalog.Registry` cache keyed by connection name with sha256-of-secret fingerprint, auto-invalidating when args change and explicitly invalidated on `SaveConnection` / `DeleteConnection`.
- DTOs in `internal/catalog/{dto,types}.go`: `NamespaceDTO`, `TableDTO`, recursive `FieldDTO` (kind: primitive/struct/list/map), `SchemaDTO`, `PartitionSpecDTO`, `PropertyDTO`, `TableMetadataDTO`. Lists and maps emit synthetic `element`/`key`/`value` children so the frontend renders every level uniformly.
- New Wails bindings on `App`: `ListNamespaces(connName, parent)`, `ListTables(connName, namespace)`, `LoadTable(connName, namespace, name)` with 10s / 10s / 30s timeouts. Errors wrapped through `catalog.MapError`.
- Frontend layout shifted to a split-pane: sidebar (connection picker + lazy `NamespaceTree`) + main panel (stacked Schema / Partition spec / Properties sections). Connection manager moved behind a "Manage…" modal — all M1 components reused as-is.
- `state/treeStore.ts` — `useReducer` hook with separate `childNamespaces` / `childTables` slot arrays per node, ensuring collapse/re-expand never re-fetches.
- `<Pending>` component for loading/error/empty states, with retry callbacks for tree nodes and metadata panel.

### Scope decisions during M2
- **Stacked sections, not tabs** — schema, partition spec, and properties are simultaneously visible so partition fields can be cross-referenced against schema fields without clicking.
- **Sidebar always-visible** — connection list is no longer the home page; connection picker (`<select>`) lives at the top of the sidebar with a "Manage…" button opening the M1 connection management UI in a modal.
- **Cancel-on-unmount deferred to M3** — M2 calls are bounded by server-side timeouts; the metadata panel uses the standard React "ignore stale response" guard. Wails-level cancel tokens belong in M3 with Arrow scans.
- **Tree state resets via `key={selectedConnection}`** — switching connections fully remounts the sidebar tree, satisfying "switching connections clears the tree" without manual teardown logic.
- **`ResizeObserver` scroll clamp on `.main`** — added late in M2 after a WebKit quirk surfaced: when the main panel grew past content height (window maximize), `scrollTop` wasn't reclamped and content stayed visually scrolled with empty space at the bottom. Also resets scroll on table-change.

### Tasks (original)
- Sidebar tree: load namespaces lazily on expand, then tables within each namespace
- Select a table → main panel shows schema (field name, type, required/optional, field ID)
- Partition spec panel: spec ID, fields, transform (identity, bucket, truncate, etc.)
- Table properties panel: format version, location, current snapshot ID, property k/v pairs
- Loading states and error boundaries at every async boundary

### Validation criteria
- ✅ `wails build -tags webkit2_41` produces a working binary (~10s); `go vet` and `tsc --noEmit` clean.
- ✅ Namespace tree expands/collapses without re-fetching already loaded nodes — confirmed against the live Lakekeeper catalog.
- ✅ Schema renders correctly for primitive types and at least one nested type — confirmed via the test table (`id`, `first_name`, `last_name`, `date_of_birth`, `credit`).
- ✅ Partition spec shows the correct transform for each field — verified; "Unpartitioned" placeholder rendered for the test table.
- ✅ A table with 0 rows or 0 partitions doesn't crash the UI — empty `the_table` walked through; `PartitionPanel` shows "Unpartitioned", properties panel renders snapshot ID and Nessie metadata cleanly.
- ✅ Switching connections clears the tree and reloads cleanly — `key={selectedConnection}` remount confirmed.

---

## Milestone 3 — Row preview *(data reading)* — **shipped**

### What landed

All five sub-milestones shipped in order, one commit each:

- **M3a** (`974b605`) — `internal/catalog/preview.go`: Arrow record-batch → `[]map[string]any` with the CLAUDE.md coercions (decimal → string, timestamp/timestamptz → ISO-8601, date → `YYYY-MM-DD`, bytes/fixed → base64, nested → `[]any`/`map[string]any`, null → JSON `null`). `PreviewRowsDTO`/`PreviewColumnDTO`, `PreviewTable` binding, `previewTimeout = 60s`, streaming `Scan(WithLimit).ToArrowRecords`. `arrow-go/v18` promoted to a direct dep.
- **M3b** (`661aeb3`) — `PreviewPanel.tsx` on `@tanstack/react-table` v8; auto-loads the first page, nulls render italic/muted, nested cells as single-line JSON.
- **M3c** (`037dc4f`) — `internal/catalog/cancel.go`: `RequestRegistry` over `sync.Map`; frontend mints a UUID per fetch and cancels from the `useEffect` cleanup.
- **M3d** (`486b771`) — `internal/catalog/filter.go`: `BuildRowFilter` with per-type literal coercion and an `ErrFilter` sentinel surfaced verbatim through `MapError`; standalone filter bar (one row per filter, multiple filters per column), 300 ms debounce + reqID cancel.
- **M3e** (`a1289ca`) — `skip` offset scanning `skip+limit+1` so the trailing probe row sets `HasMore`; page-size selector, client-side prev/next, Load-more that appends without duplicates.

### Scope deviations during M3

- **`starts` dropped, not shipped** — the operator table below lists `iceberg.StartsWith`, but iceberg-go v0.5.0 builds the per-record filter through Arrow's substrait evaluator, which has no scalar mapping for `starts_with`; the scan died with `not implemented: starts_with` inside `arrow_scanner.go`. Removed from the UI and rejected at the boundary with a message naming the upstream gap. Documented in the README.
- **Tabbed metadata panel, not a 4th stacked section** — M3b slotted Preview under Properties as planned, then M3d replaced the stack with a tab bar (Preview / Schema / Partition spec / Properties, default Preview). The preview table needs the full panel width, and the M2 "cross-reference partition against schema without clicking" argument doesn't extend to rows. All panels stay mounted via `hidden`, so Preview keeps its rows and filter state across tab switches.
- **`BuildRowFilter` returns an *unbound* expression** — it trial-binds for early validation and throws the result away. iceberg-go's scanner re-binds `rowFilter` unconditionally (`table/scanner.go:510`) and panics on already-bound predicates (`visitors.go:183`); under Wails/WebKit that panic kills the process, because the WebKit-installed SIGSEGV handler isn't `SA_ONSTACK`-safe. `BuildPreviewRows` also carries a `defer recover()` net.
- **Object-store IO was the real prerequisite** — reading data files (not just metadata) forced three unplanned fixes mid-milestone: registering iceberg-go's S3/GCS/Azure IO factories (`a4315b5`), optional explicit S3 credentials per connection (`7083eb7`), and the `Registry.Do` auth-expired retry that works around iceberg-go's forever-cached OAuth token (`684a008`).
- **`CancelPreview` → `CancelRequest`** — renamed in M4 (`1f83bae`) once `SearchTables` began sharing the same `RequestRegistry`.

### Validation status

- ✅ `go vet ./...`, `go test ./...`, and `tsc --noEmit` clean; `preview_test.go` + `filter_test.go` cover the coercions and the filter translation.
- ✅ Preview renders decimals/timestamps/dates/bytes readably against the live Lakekeeper test catalog; nulls visually distinct.
- ✅ Filters execute server-side against the live catalog — the `starts_with` failure and the "bad filter stranded the user with no way to edit it back" fix both came out of real runtime use, not review.
- ✅ **M3d whole-table filter proof** — `TestFilterMatchesRowPastFirstPage`. A 300-row fixture carries `tag="needle"` on exactly one row, id=250; the test first asserts the needle is absent from an unfiltered 100-row page (so the premise holds), then that `tag = needle` at `limit=100` returns exactly `[250]`. `TestFilterOnUnmatchedValueReturnsNoRows` covers the inverse and checks the column list survives an empty result, which is what keeps the "Clear filters" recovery path renderable.
- ✅ **M3c goroutine measurement** — `TestCancelledScanReleasesGoroutines`. Takes a baseline after a warmup scan, starts a scan against a deliberately slow IO wrapper, asserts the count actually rose (so a vacuous pass is impossible), cancels through `RequestRegistry`, and requires `context.Canceled` back in under 1 s and `runtime.NumGoroutine()` at or below baseline within 5 s. Passes; ~1.1 s.
- ✅ **M3e Load-more has no duplicates** — `TestLoadMoreProducesNoDuplicates` walks the exact `skip = len(loaded)` sequence the frontend issues and asserts the pages tile 0..299 with no repeat and no gap. `TestPaginationUnderFilterHasNoDuplicates` repeats it under an active filter (every third row matches), which is the case the criterion actually names. `TestHasMoreAtExactPageBoundary` pins the trailing-probe-row rule: a 200-row table must not offer a Load-more that would return zero rows.
- ✅ **M3e page-size semantics** (100 → 500 re-fetches at a 200-row buffer; 500 → 100 slices client-side) — the decision was extracted out of `PreviewPanel.onPageSizeChange` into a pure `pageSizePlan()` in `frontend/src/state/pageSize.ts`, and `pageSize.test.ts` asserts both named cases plus the boundary (`buffered === newSize` slices, one row short re-fetches), the no-op case, and the cold-buffer case. `vitest` added as the frontend test runner: `npm test` in `frontend/`.

#### Validation fixtures

`internal/catalog/fixture_test.go` builds a **real** Iceberg table on local disk and runs the assertions through `BuildPreviewRows`, the same function `App.PreviewTable` delegates to — so these are end-to-end proofs of the scan path, not mock-level ones.

It deliberately does **not** use iceberg-go's SQL catalog. Importing `catalog/sql` drags in `bun` + `modernc.org/sqlite`, and the `go mod tidy` that follows bumps `arrow-go`, `wails` and `grpc` — which the dep-pinning rule forbids, and which in practice breaks the build (see the substrait note in `CLAUDE.md`). `table.CatalogIO` is a two-method interface, so the fixture implements an in-memory one and costs zero new dependencies.

### Scope decisions (locked in for M3)

- **Table library:** `@tanstack/react-table` v8. Justifies the React-over-Vue choice in CLAUDE.md.
- **Default page size:** 100 rows. User selector for 100 / 250 / 500.
- **Filter scope:** server-side via `table.Scan(iceberg.WithRowFilter(...))`, debounced ~300 ms. Filters apply to the whole table, not just the loaded page. Multiple filters AND-combined.
- **Operators:** `=`, `!=`, `<`, `<=`, `>`, `>=`, `IS NULL`, `IS NOT NULL`, ~~`StartsWith` (strings only)~~ *(dropped in M3e — see deviations)*. **No CONTAINS** — iceberg-go v0.5.0 has no LIKE/regex; document in README.
- **Pagination after filter:** "Load more" button (scan-and-discard; iceberg-go has no `OFFSET`).
- **Auto-load** first page once `LoadTable` returns; **cancel in-flight scan** on unmount or re-fetch.
- **No virtualization in M3.**

### Execution model

M3 is split into 5 sub-milestones, each scoped to one Claude Code plan-mode session (explore → `ExitPlanMode` → execute → ship). Each is independently shippable; if any one needs more than a session, split it further rather than swelling the scope.

Dependencies (not strict order — M3a and M3b can run in parallel against the agreed `PreviewRowsDTO` contract; M3b can mock the binding until M3a lands):

```
M3a ─┐
     ├─► M3c ─► M3d ─► M3e
M3b ─┘
```

### M3a — Arrow → JSON serializer + minimal `PreviewTable` binding *(backend only)*

- **Touches:** `internal/catalog/preview.go` *(new)*, `internal/catalog/dto.go`, `app.go`.
- **Outcome:** `PreviewTable(connName, namespace, name, limit) (*PreviewRowsDTO, error)` returns the first `limit` rows. No filter, no skip, no cancellation yet.
- **Implementation notes:**
  - Use `Scan(iceberg.WithLimit(limit)).ToArrowRecords(ctx)` (streaming). Stop iterating once `limit` rows are accumulated. Do **not** call `ToArrowTable` (loads everything).
  - Reuse the existing `catalog.Registry` for the cached `*rest.Catalog`.
  - Add `previewTimeout = 60 * time.Second` constant in `app.go`.
  - DTOs: `PreviewRowsDTO { Columns []PreviewColumnDTO; Rows []map[string]any; RowCount int; HasMore bool }`, `PreviewColumnDTO { Name, TypeText, Kind string }`. (`HasMore` stays unused until M3e.)
  - Coercions per CLAUDE.md: decimals → string; timestamps/timestamptz → ISO-8601 string; dates → `YYYY-MM-DD`; bytes/fixed → base64; lists/structs/maps → nested `[]any` / `map[string]any`; null → JSON `null` (must round-trip).
- **Validation:** `go vet` clean; manual call from a smoke test (or `wails dev` + a tiny temporary frontend trigger) returns the expected JSON shape from a known table.

### M3b — TanStack panel renders first page *(frontend only)*

- **Touches:** `frontend/package.json` (add `@tanstack/react-table` v8), `frontend/src/components/PreviewPanel.tsx` *(new)*, `frontend/src/components/TableMetadataPanel.tsx` (slot a 4th stacked `<section>` after Properties), `frontend/src/style.css` (`.preview-table` sticky `<thead>` + monospace cells; `.preview-table .null` italic + `var(--fg-muted)`).
- **Outcome:** selecting a table auto-loads the first 100 rows; nulls visually distinct; decimals/timestamps/dates/bytes readable; "no data files" empty state.
- **Implementation notes:**
  - Mirror `TableMetadataPanel`'s existing `useEffect` + cancel-flag fetch pattern. Wrap in `<Pending>` with retry.
  - Column defs derived from `PreviewRowsDTO.columns` (one column per top-level field; nested fields render as JSON in the cell).
  - Slot:
    ```tsx
    <section className="metadata-section">
        <h2>Preview</h2>
        <PreviewPanel connName={connName} namespace={namespace} name={name} schema={data.schema} />
    </section>
    ```
- **Validation:** `wails build -tags webkit2_41` + `tsc --noEmit` clean. Manual end-to-end against the M2 Lakekeeper test environment.

### M3c — Cancel-on-unmount *(the M3 gotcha)*

- **Touches:** `internal/catalog/cancel.go` *(new)* — `RequestRegistry` backed by `sync.Map[reqID]context.CancelFunc`. `app.go` (extend `PreviewTable` with `reqID string`; bind `CancelPreview(reqID) error`). `frontend/src/components/PreviewPanel.tsx` (generate `crypto.randomUUID()` per fetch; `useEffect` cleanup calls `CancelPreview(reqID)` on unmount or before re-fetch).
- **Outcome:** navigating away from a slow scan cancels the Go call within ~1 s. No goroutine leak.
- **Why now (before filtering):** doing this before M3d means filter re-fetches inherit cancellation for free. The binding signature change is isolated and easy to verify on its own.
- **Validation:** open a slow table, click away mid-scan; Go log shows `context canceled` within 1 s; `runtime.NumGoroutine()` returns to baseline within 5 s.

### M3d — Server-side filtering

- **Touches:** `internal/catalog/filter.go` *(new)* — translate `[]PreviewFilterDTO` → `iceberg.BooleanExpression` (empty list → `iceberg.AlwaysTrue()`; type literal coercion uses table schema). `internal/catalog/dto.go` (add `PreviewFilterDTO { Field, Op string; Value any }`). `app.go` (extend `PreviewTable` to accept `filters []PreviewFilterDTO`). `frontend/src/components/PreviewPanel.tsx` (per-column filter input in TanStack header; 300 ms debounce; on filter change cancel previous reqID and issue a fresh one).
- **Outcome:** filters apply to the whole table, not just the loaded buffer. Unsupported ops surface a clean error through `MapError`.
- **Operator → iceberg-go mapping:**

  | UI op                       | iceberg-go constructor                                                                |
  |-----------------------------|---------------------------------------------------------------------------------------|
  | `eq`                        | `iceberg.EqualTo[T](ref, v)`                                                          |
  | `neq`                       | `iceberg.NotEqualTo[T](ref, v)`                                                       |
  | `lt` / `lte` / `gt` / `gte` | `iceberg.LessThan[T]` / `LessThanEqual[T]` / `GreaterThan[T]` / `GreaterThanEqual[T]` |
  | `isnull`                    | `iceberg.IsNull(ref)`                                                                 |
  | `notnull`                   | `iceberg.NotNull(ref)`                                                                |
  | ~~`starts`~~                | ~~`iceberg.StartsWith(ref, v)` (strings only)~~ — **not shipped**, no substrait mapping |
  | (multiple filters)          | `iceberg.NewAnd(...)` over the list                                                   |

  `ref = iceberg.Reference(fieldName)`. Coercion (string → int64, decimal, date, etc.) lives in `filter.go`.
- Empty state: filter returned 0 rows → "No rows match the current filters." with a "Clear filters" button.
- **Validation:** filter on a value that only exists past row 100 still surfaces the match (whole-table proof). Unsupported op returns `"filter: operator '<op>' not supported"`.

### M3e — Page size selector + Load-more pagination

- **Touches:** `app.go` (extend `PreviewTable` with `skip int`; set `HasMore` true when the iterator still has rows after `skip + limit`). `frontend/src/components/PreviewPanel.tsx` (page-size `<select>`; client-side prev/next over the loaded buffer; "Load more" button that calls `PreviewTable(..., skip = loaded.length)` and appends; preserve scroll position on append).
- **Outcome:** under an active filter, "Load more" appends the next batch with no duplicates and previous rows stay in place. Page-size switching is buffer-aware.
- **Pagination model:** scan-and-discard. Server iterates the Arrow stream, throws away the first `skip` rows, keeps the next `limit`. Cost is `O(skip + limit)` per call — acceptable for browsing; documented in README.
- **Page-size change semantics:** if the new size ≤ already-loaded buffer length, slice client-side (no fetch); otherwise re-fetch from `skip = 0` with the new limit.
- **Validation:** no duplicate rows on Load more; 100 → 500 with a 200-row buffer re-fetches; 500 → 100 slices client-side without re-fetch.

### Out of scope for M3 (parking lot)

- `IN` / `NOT IN` filter operators
- OR-combining filters
- Filtering on nested struct/list/map fields
- Sorting (TanStack supports it; defer push-down vs client-side decision)
- Row virtualization
- Persisting filter state across table switches
- CSV / JSON export of the preview

---

## Milestone 4 — Polish + release *(mvp)*

### Tasks
- ✅ **Keyboard navigation** (`355add2`) — roving-tabIndex arrow nav in the tree (Up/Down/Left/Right, Home/End, Enter/Space, focus state in `treeStore`), arrow-cycling metadata tab bar, shared `Modal` wrapper with Escape dismiss + focus trap + focus restore (`useEscapeKey`, `useFocusTrap`), `:focus-visible` rings in both themes, and `?` help discoverability.
- ✅ **Cross-platform keyboard shortcuts** — shipped, including a `Mod+K` command palette that searches the whole catalog. See the two follow-ups below.
- ✅ **Error toasts** (`de81af1`) — `sonner` toasts for refetch/save/load-more failures; first load stays inline via `<Pending>` so a failed initial fetch doesn't leave an empty panel plus a toast.
- ✅ **App icon + dynamic window title** (`de81af1`) — `WindowSetTitle` and `document.title` follow the active connection; `internal/desktopentry/` self-installs `~/.local/share/applications/fredfleet.desktop` on Linux first launch (idempotent, skipped in packaged contexts), fixing Wayland window-icon resolution via `StartupWMClass`.
- ✅ **Theme control** — `theme.ts` became a store: preference `system | light | dark` persisted in localStorage, `system` (the default) tracks `prefers-color-scheme` live. Sidebar button + `Mod+Shift+D` cycle it, `color-scheme` on `<html>` pulls native scrollbars and `<select>` popups into the theme, and sonner reads the resolved value instead of re-sniffing the media query. `mac.NSAppearanceNameAqua` in `main.go` was pinning macOS to light — and with it the webview's `prefers-color-scheme` — so it's now `mac.DefaultAppearance`.
- ⏳ **Build and package for macOS + Linux** — `.github/workflows/release.yml` builds linux/amd64, darwin/universal and windows/amd64 and drafts a release on a `v*` tag (`de81af1`). **Never executed — no tag has been cut**, so the macOS/Windows legs, artifact naming and the release step are all unverified.
- ✅ **README quickstart** (`de81af1`) — install per platform, bearer and OAuth2 connection walkthroughs, storage locations, shortcut table, filter/pagination semantics, build-from-source.

### Follow-up: richer keyboard shortcuts (cross-platform) — **shipped**

#### What landed

- `frontend/src/shortcuts/` — `keys.ts` (platform detection, `KeySpec`, `matches`, `formatShortcut`), `commands.ts` (the `COMMANDS` catalogue), `registry.tsx` (`ShortcutProvider`, `useCommand`, priority tiers), `useGlobalShortcuts.ts` (the single `document` keydown dispatcher), `fuzzy.ts` (diacritic-insensitive scorer).
- `frontend/src/components/CommandPalette.tsx` + `frontend/src/state/tableIndex.tsx` — `Mod+K` fuzzy jump over loaded tables and live commands.
- Bindings shipped: `Mod+K`, `Mod+,`, `Mod+N`, `Mod+0`, `Mod+1..4`, `Mod+L`, `Mod+F`, `Mod+R`/`F5`, `Mod+Shift+R`, `Mod+Enter`. `?` and `Esc` carried over.
- `KeyboardHelpModal` now renders from `COMMANDS`, so the dialog cannot drift from the dispatcher. Shortcut table added to the README.

#### Design decisions

- **Command registry, not lifted state.** Components subscribe handlers by id (`useCommand`); the dispatcher looks them up. Chosen over lifting tab/filter/tree state into `App` (which would have fought the `key={selectedConnection}` remount idiom) and over per-panel imperative handles. One catalogue feeds the dispatcher, the help dialog, and the palette.
- **An unregistered command is inert** — the dispatcher skips `preventDefault()` so the key stays native. Exception: `alwaysPreventDefault` for chords that shadow a destructive browser default (`Mod+R`/`F5` reload the webview and wipe all state; `Mod+F` opens find-in-page).
- **Priority tiers** resolve `Mod+R`: preview and metadata panels register at `PRIORITY.TABLE` and both fire; the tree registers at `PRIORITY.TREE` and is only reached when no table is open.
- **Overlay scoping** (`'none' | 'palette' | 'modal'`) replaces an ad-hoc modal check. Nothing fires over a dialog; only `palette.open` fires over the palette, which is what lets `Mod+K` toggle it shut. This also fixed a live bug where `?` inside the manage modal replaced it with the help dialog.

#### Keyboard-layout correctness (the non-obvious part)

- Digits and punctuation match on `e.code` (`Digit1`, `Comma`): the Czech number row is `ěščřžýáíé` and digits need `Shift`, so `e.key === '1'` would leave `Mod+1` dead. Letters match on `e.key`.
- **AltGr reports as `ctrlKey + altKey`** on Windows and Linux, and AltGr is how a Czech layout types `[ ] { } @ \ |` — `AltGr+F` is `[`. Every chord requires `!altKey`, otherwise typing a bracket into a filter value would fire (and swallow) `Mod+F`.
- Dead-key composition (`ˇ` then `s` = `š`) is skipped via `isComposing` / `keyCode === 229`; `e.repeat` is ignored so holding `Mod+R` can't queue dozens of scans.
- Platform comes from Wails' `Environment()`, not the deprecated `navigator.platform`, with a user-agent seed for first paint.

#### Deliberately not done

- `Slash` (`/`) focus and `g`-then-`t` vim chords — a two-key dispatcher isn't a convention desktop users expect here; `Mod+K` covers the same ground.
- App-defined chord macros, user-customisable bindings, exporting shortcut prefs. Park if asked.

### Follow-up: full-catalog table search — **shipped**

The palette used to index only already-expanded namespaces, because the tree loads children lazily and nothing crawled the catalog. Closed in two commits: a backend crawler, then the frontend wiring.

#### What landed

- `internal/catalog/search.go` — `TableSearcher` walks every namespace breadth-first through a bounded worker pool (8 workers, caps at 5k namespaces / 100k tables / depth 16) and caches the result per connection for 5 minutes. Callers racing on a cold index queue behind a context-aware gate, so a burst of keystrokes triggers one crawl, not one per keystroke.
- Bindings `SearchTables(reqID, connName, query, limit)` and `RefreshTableIndex(connName)`; `CancelPreview` renamed `CancelRequest` since the underlying `RequestRegistry` was never preview-specific.
- `frontend/src/state/tableSearch.ts` — `useTableSearch(connName, term, enabled)`, the palette's half. `frontend/src/hooks/useDebounced.ts` extracted from `PreviewPanel` so both share one debounce.
- The palette merges the tree index (instant) with backend hits (deduped by dotted label), and its footer reports which reach the results came from — including a crawl that came back partial.
- `Mod+Shift+R` now drops the backend index as well as the tree.

#### Design decisions

- **Crawl on first keystroke, not on palette open.** A bare `Mod+K`, or a `>` command query, costs nothing. Opening the palette to run a command shouldn't crawl a catalog.
- **Superseded queries are not cancelled, and neither is closing the palette.** Cancelling a cold crawl discards the partial index, so an `Esc` a few seconds in would leave the user re-crawling from zero on the next open — and under fast typing the index would never finish at all. Instead one request is in flight at a time and the next is issued when it settles. The only cancel is a connection switch. This is a deliberate divergence from the M3c cancel-on-unmount rule: there, the work was a scan whose result the user had navigated away from; here it's a cache that the next open will want.
- **Backend narrows, frontend ranks.** `search.go`'s matcher is the same diacritic-folded subsequence predicate as `fuzzy.ts` minus the scoring, so ranking and `<mark>` highlighting stay in one place instead of being reimplemented and left to drift.
- **Search errors don't toast.** A dead catalog would fire one per keystroke; the palette footer says "Catalog search unavailable" and tree-loaded tables stay searchable.

#### Deliberately not done

- **Reveal-in-tree.** Jumping to a table in an unexpanded namespace opens it in the main panel and leaves the sidebar alone. Revealing would need a cascade action in `treeStore` plus a route from `App` into `NamespaceTree`'s store, which is deliberately not lifted (`key={selectedConnection}` remount idiom).
- Persisting search state across palette opens — the backend cache already makes a reopen instant.

### Validation criteria
- ⏳ Full tree → schema → preview flow works with keyboard only — implemented, never walked end to end.
- ⏳ Network error during row preview shows a toast and keeps the schema panel intact — toast path wired for refetch/load-more; not exercised against a killed catalog.
- ⏳ Packaged binary runs on a clean machine without any Go toolchain installed — blocked on cutting the first tag.
- ⏳ README quickstart works for someone who has never used the app — not walked through literally.

### Carried-over validation debt (from M1 / M3)

These were left ⏳ in their own milestones and are still open; M4 is the natural place to clear them.

- ⏳ **M1** — dark mode toggles correctly when the OS preference changes (flip the system setting with the app open, preference left on "system"), and the Light/Dark pin survives a restart.
- ✅ **M3d** — whole-table filter proof. Covered by `TestFilterMatchesRowPastFirstPage`.
- ✅ **M3c** — `runtime.NumGoroutine()` back to baseline within 5 s after cancelling a slow scan. Covered by `TestCancelledScanReleasesGoroutines`.
- ✅ **M3e (backend half)** — no duplicate rows on Load more, plain and under an active filter. Covered by `TestLoadMoreProducesNoDuplicates`, `TestPaginationUnderFilterHasNoDuplicates`, `TestHasMoreAtExactPageBoundary`.
- ✅ **M3e (frontend half)** — 100 → 500 re-fetches with a 200-row buffer, 500 → 100 slices client-side. Covered by `frontend/src/state/pageSize.test.ts`.

**M3 validation debt is now clear.** Only the M1 dark-mode check remains, and it is inherently manual (flip the OS setting with the app open).
