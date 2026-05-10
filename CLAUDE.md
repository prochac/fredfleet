# fredfleet

Desktop app for browsing Apache Iceberg catalogs. Built with [Wails v2](https://wails.io) (Go backend + web frontend) on top of [`iceberg-go`](https://github.com/apache/iceberg-go).

- Module: `github.com/prochac/fredfleet` (Go 1.26)
- Frontend: React + TypeScript (Wails `react-ts` template). Chosen over Vue for ecosystem strength around virtualized tables (TanStack Table) and grid layouts.

## Status

Early scaffolding. The plan lives in [`PLAN.md`](PLAN.md) — four sequential milestones, each shippable on its own. When taking on a task, locate it in `PLAN.md` first; treat the validation criteria there as the definition of done.

## Architecture intent

- **Backend (Go):** owns all catalog I/O via `iceberg-go`. Exposes a small set of methods to the frontend through Wails bindings. Persists connection definitions to a local JSON file.
- **Frontend (web):** browsing UI — connection manager, namespace tree, schema/partition/properties panels, row preview. Calls into Go via Wails bindings; never makes catalog requests directly.
- **Connections:** REST catalogs only for the MVP (Polaris, Lakekeeper). The `Connection` struct carries a `catalog type` field so Glue/SQL/Hive can be added later without reshaping storage — but those backends are out of scope until after M4.
- **Auth:** Static bearer token, or OAuth2 client credentials with auto-refresh via `iceberg-go` (`rest.WithCredential` + `rest.WithAuthURI` + optional `rest.WithScope`). No anonymous mode, no AWS SigV4.
- **Delete files:** Rely on `iceberg-go`'s `Scan()` output as-is. Don't add custom positional or equality-delete handling; document gaps in the README instead.

## Gotchas worth remembering

- **Cancel in-flight scans on unmount.** Wails frontend navigation does not automatically cancel Go calls. Wire `context.WithCancel` to a frontend "unmount" event so a user navigating away from a slow `table.Scan` doesn't leak a goroutine.
- **Arrow → JSON for row preview.** `iceberg-go` returns Arrow record batches. For v1, serialize to `[]map[string]any`. Coerce explicitly: decimals → string, timestamps → ISO-8601 string, bytes → base64. Don't rely on default `encoding/json` behavior for these.
- **Null is not empty.** Null cells must render visually distinct from empty strings in the preview table.
- **Lazy tree, no re-fetch.** The namespace tree loads children on expand and must not re-fetch already-loaded nodes when collapsed/re-expanded.

## Layout

## Build (Linux)

Pass `-tags webkit2_41` to `wails dev`/`wails build` on Arch and any distro that ships only webkit2gtk-4.1. Wails 2.12 defaults to the 4.0 ABI; without the tag, `wails doctor` reports "libwebkit Not Found" even when 4.1 is installed.

```bash
wails dev   -tags webkit2_41
wails build -tags webkit2_41 -platform linux/amd64
```

## Layout

- `main.go` — `wails.Run` config, theme defaults
- `app.go` — `App` struct + Wails-bound methods (`ListConnections`, `SaveConnection`, `DeleteConnection`, `TestConnection`, `TestSavedConnection`)
- `internal/connections/` — `Connection` type, JSON metadata store, OS keyring wrapper
- `internal/catalog/` — `iceberg-go` REST probe + error→user-message mapping
- `frontend/src/` — React/TS UI; `frontend/wailsjs/` is regenerated and gitignored
