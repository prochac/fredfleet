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
- ⏳ Can add a connection pointing at a real REST catalog — in progress against Lakekeeper + Keycloak (warehouse field landing, awaiting user confirmation).
- ✅ Connection persists after app restart (atomic write + read on launch).
- ✅ Wrong URL or bad auth shows a clear error message — `MapError` covers auth, forbidden, timeouts, DNS, ECONNREFUSED.
- ⏳ Dark mode toggles correctly when OS preference changes — implementation in `theme.ts` via `matchMedia` listener; needs visual confirmation by toggling the system setting with the app open.

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

## Milestone 3 — Row preview *(data reading)*

### Scope decisions (locked in for M3)

- **Table library:** `@tanstack/react-table` v8. Justifies the React-over-Vue choice in CLAUDE.md.
- **Default page size:** 100 rows. User selector for 100 / 250 / 500.
- **Filter scope:** server-side via `table.Scan(iceberg.WithRowFilter(...))`, debounced ~300 ms. Filters apply to the whole table, not just the loaded page. Multiple filters AND-combined.
- **Operators:** `=`, `!=`, `<`, `<=`, `>`, `>=`, `IS NULL`, `IS NOT NULL`, `StartsWith` (strings only). **No CONTAINS** — iceberg-go v0.5.0 has no LIKE/regex; document in README.
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

  | UI op | iceberg-go constructor |
  |---|---|
  | `eq` | `iceberg.EqualTo[T](ref, v)` |
  | `neq` | `iceberg.NotEqualTo[T](ref, v)` |
  | `lt` / `lte` / `gt` / `gte` | `iceberg.LessThan[T]` / `LessThanEqual[T]` / `GreaterThan[T]` / `GreaterThanEqual[T]` |
  | `isnull` | `iceberg.IsNull(ref)` |
  | `notnull` | `iceberg.NotNull(ref)` |
  | `starts` | `iceberg.StartsWith(ref, v)` (strings only) |
  | (multiple filters) | `iceberg.NewAnd(...)` over the list |

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
- Keyboard navigation: arrow keys in tree, Tab between panels, Escape to close dialogs *(basics landed)*
- **Cross-platform keyboard shortcuts** — beyond Tab travel and arrow keys. See follow-up below.
- Error toasts for transient errors (network blip, credential expiry) without losing UI state
- App icon, window title reflects active connection name
- Build and package for macOS (arm64 + amd64) and Linux
- README with quickstart: install, configure a connection, run

### Follow-up: richer keyboard shortcuts (cross-platform)

The first keyboard pass covered the bare minimum (tree arrow keys, tablist arrows, Esc on dialogs, a `?` help dialog, Tab travel between panels). What's still missing: chorded shortcuts for the actions a power user reaches for. Must work consistently on macOS (`⌘`), Linux, and Windows (`Ctrl`) — wire through a single `isModifierPressed(e)` helper that picks `metaKey` on macOS and `ctrlKey` elsewhere; don't hard-code `Ctrl`.

Candidate shortcuts (pick the right subset; not all need to ship):

| Shortcut | Action |
|---|---|
| `Mod+K` | Command palette / quick switch (open connection / jump to table by fuzzy name) |
| `Mod+1`…`Mod+4` | Jump to Preview / Schema / Partition / Properties tab |
| `Mod+R` | Refresh current scope (re-fetch namespace children, re-run preview scan) |
| `Mod+F` | Focus the preview filter bar |
| `Mod+,` | Open connection manager ("Manage…") |
| `Mod+N` | New connection |
| `Mod+W` / `Mod+Q` | Close window / quit (defer to Wails defaults when they exist) |
| `Slash` (`/`) | Focus connection picker or quick-search (Gmail/GitHub-style) |
| `g` then `t` | Vim-style: go to tables (focus tree). Two-key sequences need a small dispatcher. |

Implementation notes for next session:

- Centralise the keymap. A `useGlobalShortcuts` hook in `frontend/src/hooks/` registering one `keydown` listener on `document`, dispatching by `(modifier, key)`. Avoid scattering listeners.
- Per-platform display. The existing `KeyboardHelpModal` should render `⌘K` on mac and `Ctrl+K` elsewhere. Add a `formatShortcut(spec)` helper driven by `navigator.platform` (or `navigator.userAgentData.platform` where available).
- Don't fight native shortcuts. WebKitGTK passes most modifiers through unless we `preventDefault()`. Cmd+W / Cmd+Q must remain native window controls — don't override.
- Input-aware suppression. Reuse the same guard as the global `?` handler: skip when focus is inside an `<input>`, `<textarea>`, `<select>`, or contentEditable region — except for `Esc` and `Mod+Enter` (submit) which should still fire.
- Surface every binding in `KeyboardHelpModal` so it stays discoverable.

Out of scope for this follow-up: app-defined chord macros, user-customisable bindings, recording/exporting shortcut prefs. Park if asked.

### Validation criteria
- Full tree → schema → preview flow works with keyboard only
- Network error during row preview shows a toast and keeps the schema panel intact
- Packaged binary runs on a clean machine without any Go toolchain installed
- README quickstart works for someone who has never used the app
