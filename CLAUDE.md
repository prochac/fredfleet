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
- **`go mod tidy` breaks this build — don't run it casually.** Tidying resolves `arrow-go` up to v18.7.0, which requires `substrait-protobuf/go` v0.85.0. But `iceberg-go` v0.5.0 pulls `substrait-go/v7` v7.4.0, which is only compatible with `substrait-protobuf` v0.81.0 — so MVS picks v0.85.0 and `substrait-go/v7` stops compiling (`undefined: extensions.SimpleExtensionURI`). The whole module fails to build, not just the tests. `arrow-go` must stay pinned at `v18.5.2-0.20260220015023-a886a5722b87` and `substrait-protobuf/go` at `v0.81.0` until `iceberg-go` ships a release that moves to `substrait-go/v8`. This is the concrete reason behind the "pin to tagged releases, don't bump" rule.
- **Data race inside `iceberg-go`'s scan planner (v0.5.0).** `go test -race ./internal/catalog/` reports one race, entirely upstream: `Scan.collectManifestEntries` (`table/scanner.go:397`) hands the *same* cached partition evaluator to every errgroup worker, and `exprEvaluator.Eval` (`visitors.go:203`) writes `e.st = st` on that shared struct before visiting. Any table scanned with more than one manifest file trips it. For **unpartitioned** tables the expression is `AlwaysTrue` and the visitor never reads `st`, so it's benign — which is why it has not bitten us yet. For **partitioned** tables it is a correctness bug: concurrent workers can read another goroutine's partition record and prune the wrong data files. Not worked around in app code (we don't control the fan-out); revisit when upstream fixes it. Keep `-race` off the default test command or expect this one report.
- **OAuth2 token refresh is on us, not iceberg-go.** `iceberg-go` v0.5.0's `Oauth2AuthManager` fetches a token once and caches it on the struct forever — `expires_in` is decoded but ignored, refresh tokens are never used, and there is no 401 re-auth path. After the access token expires, every cached `*rest.Catalog` keeps sending the stale bearer until the app restarts. Fixed upstream in `apache/iceberg-go@6842055` (PR #793, "feat(catalog): refresh oauth tokens") but **not** in any tagged release as of v0.5.0. We work around it reactively in `Registry.Do` (`internal/catalog/registry.go`): on `rest.ErrUnauthorized` / `rest.ErrAuthorizationExpired` we invalidate the cached catalog and retry once, which forces a fresh token fetch. We are intentionally **not** maintaining a fork of `iceberg-go` for this project (different org). Revisit when an upstream release ships the fix and the workaround can be removed.

## Layout

## Build (Linux)

Pass `-tags webkit2_41` to `wails dev`/`wails build` on Arch and any distro that ships only webkit2gtk-4.1. Wails 2.12 defaults to the 4.0 ABI; without the tag, `wails doctor` reports "libwebkit Not Found" even when 4.1 is installed.

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

`internal/catalog/fixture_test.go` creates an unpartitioned Iceberg table under `t.TempDir()` via an in-memory `table.CatalogIO`, so the preview/filter/pagination tests run through the same `BuildPreviewRows` the app calls. It avoids iceberg-go's SQL catalog on purpose — that import pulls in `bun` + `modernc.org/sqlite` and forces a `go mod tidy` that breaks the build (see the substrait gotcha above).

Skip `-race` on `./internal/catalog/` unless you want the known upstream iceberg-go report.
