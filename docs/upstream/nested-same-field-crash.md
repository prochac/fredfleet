# Upstream crash: two predicates on the same nested field

**Status:** open, not yet reported upstream. Found 2026-10-31 while bumping to
`iceberg-go` v0.7.0. This is the only thing still keeping
`internal/catalog/residual.go` alive.

## Summary

A scan whose row filter has **two predicates on the same nested field** panics
inside arrow-go's struct `take` kernel. The panic is on an arrow-go worker
goroutine (`compute.execInternal` spawns it), so no `recover()` in the caller
can catch it and the process dies.

## Versions

| Module                          | Version  |
| ------------------------------- | -------- |
| `github.com/apache/iceberg-go`  | v0.7.0   |
| `github.com/apache/arrow-go/v18`| v18.8.0  |
| Go                              | 1.27.3 (module says `go 1.26`) |

## What crashes and what doesn't

Probed against the nested fixture (`newNestedFixtureTable`: `id int64`,
`addr struct<city string, zip int32>`, with null `addr` structs and null
`city` values), on both a single-file and a many-file table. The file count
makes no difference.

| Row filter                                         | Result |
| -------------------------------------------------- | ------ |
| `addr.city = x` (any single op, IN, NOT IN, null checks) | ✅ correct rows (matches the residual pass) |
| `addr.city = x AND addr.zip > n`                    | ✅ |
| `addr.zip IS NOT NULL AND addr.city = x`            | ✅ |
| `addr.city IS NULL AND addr.zip < n`                | ✅ |
| `addr.city = x OR addr.zip IS NULL`                 | ✅ |
| `addr.city >= a AND addr.city < c`                  | 💥 `string offset buffer must have at least N values` |
| `addr.city != a AND addr.city != b`                 | 💥 same |
| `addr.city NOT IN (…) AND addr.city IS NOT NULL`    | 💥 same |
| `addr.city = x AND addr.city IS NOT NULL`           | 💥 same |
| `addr.city IS NOT NULL OR addr.city = x`            | 💥 same |
| `addr.zip > a AND addr.zip < b`                     | 💥 `runtime error: index out of range [0] with length 0` |
| `addr.zip IS NOT NULL AND addr.zip > a`             | 💥 index out of range |
| top-level `tag >= a AND tag < c` (and the others)   | ✅ |

The pattern is the same nested leaf referenced twice in one expression. An
`IS NULL` paired with a predicate on a *different* field survived; a same-field
`IS NULL` pairing was not probed.

## Stack (string case)

```
panic: arrow/array: string offset buffer must have at least 21 values

goroutine 91 [running]:
github.com/apache/arrow-go/v18/arrow/array.(*String).setData
github.com/apache/arrow-go/v18/arrow/array.NewStringData(...)
github.com/apache/arrow-go/v18/arrow/array.MakeFromData
github.com/apache/arrow-go/v18/arrow/array.(*Struct).setData
github.com/apache/arrow-go/v18/arrow/array.NewStructData(...)
github.com/apache/arrow-go/v18/arrow/array.MakeFromData
github.com/apache/arrow-go/v18/arrow/compute/exec.(*ArraySpan).MakeArray
github.com/apache/arrow-go/v18/arrow/compute.structTake          (selection.go:578)
github.com/apache/arrow-go/v18/arrow/compute/exec.(*VectorKernel).Exec
github.com/apache/arrow-go/v18/arrow/compute.(*vectorExecutor).exec
github.com/apache/arrow-go/v18/arrow/compute.(*vectorExecutor).Execute
github.com/apache/arrow-go/v18/arrow/compute.execInternal.func3()
created by github.com/apache/arrow-go/v18/arrow/compute.execInternal
```

## Reproduce

In this repo, run the sentinel's child half directly. It crashes:

```bash
FREDFLEET_NESTED_PUSHDOWN_PROBE=1 go test -count=1 \
  -run '^TestNestedPushdownStillBrokenUpstream$' ./internal/catalog/
```

The core of it, for an upstream report:

```go
city := iceberg.Reference("addr.city")
scan := tbl.Scan(table.WithRowFilter(iceberg.NewAnd(
    iceberg.GreaterThanEqual(city, "city-0"),
    iceberg.LessThan(city, "city-2"),
)))
_, itr, _ := scan.ToArrowRecords(ctx)
for batch, err := range itr { … } // panics during iteration
```

## Not yet known

- **Which project owns it.** The panic is in arrow-go (`structTake`), but the
  input may be built wrong by iceberg-go, for example a struct array whose child
  is sliced or projected twice when the same leaf appears twice in the
  substrait plan. Before filing, reproduce with an arrow-go compute call alone
  (a filter or take on a struct column with nulls) to tell the two apart. If
  that doesn't crash, file against `apache/iceberg-go` with the snippet above.
- Whether nulls in the parent struct are required. The fixture always has some;
  a struct with no nulls was not tried.

## When it's fixed

`TestNestedPushdownStillBrokenUpstream` starts failing. Then delete
`residual.go`, push every predicate down from `BuildRowFilter`, and keep
`TestNotInExcludesNulls`: `buildSet`'s `NotIn AND NotNull` would then also reach
nested fields, and it is one of the shapes in the table above. DESIGN.md's
"Nested-field filters, and the residual pass" section has the rest.
