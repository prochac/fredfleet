# fredfleet

Desktop app for browsing Apache Iceberg catalogs. Built with [Wails v2](https://wails.io) (Go backend + web frontend) on top of [`iceberg-go`](https://github.com/apache/iceberg-go).

- Module: `github.com/prochac/fredfleet` (Go 1.26)
- Frontend: React + TypeScript (Wails `react-ts` template). Chosen over Vue for ecosystem strength around virtualized tables (TanStack Table) and grid layouts.

## Status

Feature-complete against the MVP scope; unreleased. [`DESIGN.md`](DESIGN.md) describes the system as it stands — subsystem by subsystem, with the reasoning behind each non-obvious choice — and its "Open items" section is the remaining work (all of it release actions or manual checks). Read the relevant section there before changing a subsystem; the decisions it records are the ones most likely to be undone by accident.

## Architecture intent

- **Backend (Go):** owns all catalog I/O via `iceberg-go`. Exposes a small set of methods to the frontend through Wails bindings. Persists connection definitions to a local JSON file.
- **Frontend (web):** browsing UI — connection manager, namespace tree, schema/partition/properties panels, row preview. Calls into Go via Wails bindings; never makes catalog requests directly.
- **Connections:** REST catalogs only for the MVP (Polaris, Lakekeeper). The `Connection` struct carries a `catalog type` field so Glue/SQL/Hive can be added later without reshaping storage — but those backends are out of scope for now.
- **Auth:** Static bearer token, or OAuth2 client credentials via `iceberg-go` (`rest.WithCredential` + `rest.WithAuthURI` + optional `rest.WithScope`). No anonymous mode, no AWS SigV4.
- **Delete files:** Rely on `iceberg-go`'s `Scan()` output as-is. Don't add custom positional or equality-delete handling; document gaps in the README instead.

## Gotchas worth remembering

- **Cancel in-flight scans on unmount.** Wails frontend navigation does not automatically cancel Go calls. Wire `context.WithCancel` to a frontend "unmount" event so a user navigating away from a slow `table.Scan` doesn't leak a goroutine.
- **Arrow → JSON for row preview.** `iceberg-go` returns Arrow record batches. For v1, serialize to `[]map[string]any`. Coerce explicitly: decimals → string, timestamps → ISO-8601 string, bytes → base64. Don't rely on default `encoding/json` behavior for these.
- **Null is not empty.** Null cells must render visually distinct from empty strings in the preview table.
- **Lazy tree, no re-fetch.** The namespace tree loads children on expand and must not re-fetch already-loaded nodes when collapsed/re-expanded.
- **`@types/node` must stay on v18.** TypeScript is pinned at 4.6, which cannot *parse* the `.d.ts` files shipped by recent `@types/node` (`ffi.d.ts` fails with TS1005/TS1139). Nothing imported it until `vitest` arrived and pulled it in transitively, at which point `npm run build` — i.e. `tsc && vite build`, i.e. every `wails build` — started failing. The devDependency is pinned to `^18.19.0` to hold it back. Unpin only together with a TypeScript upgrade.
- **`starts_with` still doesn't work on v0.6.0 — the gap is Arrow's, not iceberg-go's.** A scan filtered with `iceberg.StartsWith` dies with `not implemented: starts_with` during *iteration* (not at `ToArrowRecords`): `iceberg-go`'s `table/substrait` emits the extension reference correctly, but Arrow's expression evaluator has no scalar implementation to consume it. `BuildRowFilter` rejects the `starts` operator up front and the UI hides it. `TestStartsWithStillUnsupportedUpstream` (`internal/catalog/preview_validation_test.go`) proves the gap is still real against a live fixture scan, and will fail the day `arrow-go` ships the mapping — that's the signal to delete the rejection.
- **OAuth2 refresh is upstream's job now; `Registry.Do`'s retry is not.** v0.5.0's `Oauth2AuthManager` cached one token forever (`expires_in` decoded and ignored, no 401 re-auth path), so we invalidated and retried in `Registry.Do`. v0.6.0 wraps an `oauth2.TokenSource` from `clientcredentials.Config`, which does expiry and refresh itself. **Keep the retry anyway** — it now covers what a token source structurally cannot see: a token revoked server-side, or credentials rotated at the IdP, before the stated expiry. Deleting it would trade a one-line retry for a mandatory app restart in those cases. Consequence of the new design: the `context` handed to `Registry.Get` is captured by the token source and used for every later refresh, so it **must be app-lifetime** — a request-scoped context makes refreshes fail with `context canceled` long after that request ended. `App.withCatalog` passes `a.ctx`; keep it that way.
- **We do not fork `iceberg-go`.** Different org from the Dataddo fork; upstream gaps get worked around at our boundary or documented, never patched in a fork.

Fixed in `iceberg-go` v0.6.0 — recorded so they don't get re-added from memory:

- ~~`go mod tidy` breaks the build (substrait v7/v8 conflict).~~ v0.6.0 moved to `substrait-go/v8` v8.1.1 + `substrait-protobuf` v0.85.0; `arrow-go` is unpinned at v18.7.0 and `go mod tidy -diff` is clean. The general "pin to tagged releases, don't chase `main`" preference stands on its own; this specific hazard is gone.
- ~~Data race in the scan planner.~~ `exprEvaluator.Eval` now copies the evaluator per call instead of writing `e.st` on a struct shared across errgroup workers. `go test -race ./...` is clean — the "keep `-race` off the default test command" carve-out is retired.

## Layout

## Build (Linux)

Pass `-tags webkit2_41` to `wails dev`/`wails build` on Arch and any distro that ships only webkit2gtk-4.1. Wails still defaults to the 4.0 ABI as of 2.13 (`#cgo !webkit2_41 pkg-config: webkit2gtk-4.0`); without the tag, `wails doctor` reports "libwebkit Not Found" even when 4.1 is installed. Keep the CLI version (`WAILS_VERSION` in `release.yml`, and the install line in the README) in step with the `wails/v2` version in `go.mod`.

```bash
wails dev   -tags webkit2_41
wails build -tags webkit2_41 -platform linux/amd64
```

## Layout

- `main.go` — `wails.Run` config, theme defaults
- `app.go` — `App` struct + Wails-bound methods (`ListConnections`, `SaveConnection`, `DeleteConnection`, `TestConnection`, `TestSavedConnection`, `ListNamespaces`, `ListTables`, `LoadTable`, `PreviewTable`); `withCatalog` helper threads requests through `Registry.Do`
- `internal/connections/` — `Connection` type, JSON metadata store, OS keyring wrapper
- `internal/catalog/` — `iceberg-go` REST probe + error→user-message mapping
- `frontend/src/` — React/TS UI; `frontend/wailsjs/` is regenerated and gitignored

## Tests

```bash
go test ./...          # backend; internal/catalog builds a real local Iceberg table as a fixture
npm test --prefix frontend   # vitest
```

`internal/catalog/fixture_test.go` creates an unpartitioned Iceberg table under `t.TempDir()` via an in-memory `table.CatalogIO`, so the preview/filter/pagination tests run through the same `BuildPreviewRows` the app calls. It avoids iceberg-go's SQL catalog on purpose — that import pulls in `bun` + `modernc.org/sqlite`, which was fatal under v0.5.0 (the forced tidy tripped the substrait conflict) and is merely unwanted weight in a shipped binary now. `table.CatalogIO` is two methods; the in-memory version costs no dependencies.

`-race` is clean as of iceberg-go v0.6.0 and worth running.

Skip `-race` on `./internal/catalog/` unless you want the known upstream iceberg-go report.
