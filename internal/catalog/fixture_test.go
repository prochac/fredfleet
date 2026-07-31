package catalog

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/memory"
	"github.com/apache/iceberg-go"
	icebergio "github.com/apache/iceberg-go/io"
	"github.com/apache/iceberg-go/table"
)

// This file builds a *real* Iceberg table on the local filesystem so the
// preview tests run against the same code path the app uses
// (BuildPreviewRows), rather than against a mock.
//
// It deliberately avoids iceberg-go's SQL catalog: pulling that in drags bun +
// modernc.org/sqlite into go.mod and `go mod tidy` then bumps arrow-go, wails
// and grpc, which the project's dep-pinning rule forbids. table.CatalogIO is a
// two-method interface, so an in-memory implementation costs nothing.

// memCatalog is a minimal in-memory table.CatalogIO. It holds the current
// metadata and applies commits through table.UpdateTableMetadata, which is the
// same helper the real catalogs use.
type memCatalog struct {
	mu   sync.Mutex
	meta table.Metadata
	loc  string
	fsF  table.FSysF
	// ident is fixed for the single table a fixture owns.
	ident table.Identifier
}

func (c *memCatalog) LoadTable(_ context.Context, ident table.Identifier) (*table.Table, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return table.New(ident, c.meta, c.loc, c.fsF, c), nil
}

func (c *memCatalog) CommitTable(
	_ context.Context,
	_ table.Identifier,
	_ []table.Requirement,
	updates []table.Update,
) (table.Metadata, string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	next, err := table.UpdateTableMetadata(c.meta, updates, c.loc)
	if err != nil {
		return nil, "", err
	}
	c.meta = next
	return next, c.loc, nil
}

// fixtureSchema is shared by every fixture table: an id, a filler column, and
// a `tag` column used to plant a value deep in the table for the filter proof.
func fixtureSchema() (*iceberg.Schema, *arrow.Schema) {
	ice := iceberg.NewSchema(0,
		iceberg.NestedField{ID: 1, Name: "id", Type: iceberg.PrimitiveTypes.Int64, Required: true},
		iceberg.NestedField{ID: 2, Name: "name", Type: iceberg.PrimitiveTypes.String},
		iceberg.NestedField{ID: 3, Name: "tag", Type: iceberg.PrimitiveTypes.String},
	)
	arr := arrow.NewSchema([]arrow.Field{
		{Name: "id", Type: arrow.PrimitiveTypes.Int64, Nullable: false},
		{Name: "name", Type: arrow.BinaryTypes.String, Nullable: true},
		{Name: "tag", Type: arrow.BinaryTypes.String, Nullable: true},
	}, nil)
	return ice, arr
}

// newFixtureTable creates an unpartitioned Iceberg table under t.TempDir() and
// appends nrows rows in batches of batchRows (so the table gets several row
// groups / data files rather than one). Row i has id=i, name="row-<i>", and
// tag=tagFor(i).
func newFixtureTable(t *testing.T, nrows, batchRows int, tagFor func(i int) string) *table.Table {
	t.Helper()
	ctx := t.Context()

	dir := t.TempDir()
	loc := "file://" + filepath.ToSlash(dir)
	iceSchema, arrSchema := fixtureSchema()

	meta, err := table.NewMetadata(iceSchema, iceberg.UnpartitionedSpec, table.UnsortedSortOrder, loc, nil)
	if err != nil {
		t.Fatalf("new metadata: %v", err)
	}

	fsF := icebergio.LoadFSFunc(nil, loc)
	metaLoc := filepath.Join(dir, "metadata", "v1.metadata.json")
	ident := table.Identifier{"ns", "fixture"}
	cat := &memCatalog{meta: meta, loc: metaLoc, fsF: fsF, ident: ident}

	tbl := table.New(ident, meta, metaLoc, fsF, cat)

	mem := memory.NewGoAllocator()
	for start := 0; start < nrows; start += batchRows {
		end := min(start+batchRows, nrows)

		rb := array.NewRecordBuilder(mem, arrSchema)
		ids := rb.Field(0).(*array.Int64Builder)
		names := rb.Field(1).(*array.StringBuilder)
		tags := rb.Field(2).(*array.StringBuilder)
		for i := start; i < end; i++ {
			ids.Append(int64(i))
			names.Append(fmt.Sprintf("row-%d", i))
			tags.Append(tagFor(i))
		}
		rec := rb.NewRecordBatch()
		at := array.NewTableFromRecords(arrSchema, []arrow.RecordBatch{rec})

		tbl, err = tbl.AppendTable(ctx, at, int64(end-start), nil)

		at.Release()
		rec.Release()
		rb.Release()
		if err != nil {
			t.Fatalf("append rows [%d,%d): %v", start, end, err)
		}
	}
	return tbl
}

// rowIDs pulls the id column out of a preview result, failing the test if any
// row is missing it or carries an unexpected type.
func rowIDs(t *testing.T, dto *PreviewRowsDTO) []int64 {
	t.Helper()
	out := make([]int64, 0, len(dto.Rows))
	for i, r := range dto.Rows {
		v, ok := r["id"]
		if !ok {
			t.Fatalf("row %d has no id column: %v", i, r)
		}
		n, ok := v.(int64)
		if !ok {
			t.Fatalf("row %d id is %T (%v), want int64", i, v, v)
		}
		out = append(out, n)
	}
	return out
}
