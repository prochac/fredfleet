package catalog

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/iceberg-go"
	"github.com/apache/iceberg-go/table"
)

const defaultPreviewLimit = 100

// BuildPreviewRows scans t and returns up to `limit` rows starting at offset
// `skip`, in JSON-friendly form. It uses ToArrowRecords (streaming) so memory
// stays bounded by batch size, not by full table size. The trailing probe row
// read past the requested limit is dropped from the result and flips HasMore
// to true so the caller knows another page is available.
//
// filters are combined per PreviewFilterDTO.Join and pushed down server-side;
// an empty list short-circuits to AlwaysTrue inside table.WithRowFilter. A
// filter on a nested field cannot be pushed down (see residual.go) and is
// applied here instead, which costs the scan its row limit: the loop keeps
// pulling batches until the page is full, bounded by ctx.
func BuildPreviewRows(ctx context.Context, t *table.Table, skip, limit int, filters []PreviewFilterDTO) (dto *PreviewRowsDTO, err error) {
	// iceberg-go's scanner contains paths that panic on edge cases
	// (e.g. visitors.go:183, evaluators.go:1035). In a Wails/WebKit
	// process those panics escalate to fatal signals because WebKit
	// installs SIGSEGV handlers without SA_ONSTACK. Convert any Go panic
	// to an ErrFilter-wrapped error so the UI can surface it.
	defer func() {
		if r := recover(); r != nil {
			dto = nil
			err = fmt.Errorf("%w: scan panic: %v", ErrFilter, r)
		}
	}()
	if limit <= 0 {
		limit = defaultPreviewLimit
	}
	if skip < 0 {
		skip = 0
	}

	var (
		rows      = make([]map[string]any, 0, limit)
		discarded int
		hasMore   bool
	)

	// One row past the page is read on purpose: it is what tells the caller a
	// Load-more would return something, without a second round trip.
	budget := int64(skip + limit + 1)
	arrowSchema, err := streamRows(ctx, t, filters, budget, nil, func(next rowFunc) bool {
		if discarded < skip {
			discarded++
			return true
		}
		if len(rows) >= limit {
			hasMore = true
			return false
		}
		rows = append(rows, next())
		return true
	})
	if err != nil {
		return nil, err
	}
	// Columns come from the scan's schema rather than from a batch, so an empty
	// result still carries them — otherwise the filter bar would have nothing
	// to offer and the user could not undo the filter that emptied the table.
	cols := buildPreviewColumns(t.Schema(), arrowSchema)

	return &PreviewRowsDTO{
		Columns:  cols,
		Rows:     rows,
		RowCount: len(rows),
		HasMore:  hasMore,
	}, nil
}

// rowFunc materialises the current row as JSON-friendly values. It is handed to
// the callback rather than called up front so a row that is only being counted
// (skipped, or the trailing probe row) costs nothing to convert.
type rowFunc func() map[string]any

// streamRows scans t with filters applied and calls fn once per matching row,
// in scan order, until fn returns false or the scan is exhausted. It is the
// single scan path behind both the preview and the export.
//
// budget caps how many rows the *scan* itself produces; pass 0 for no cap. The
// cap can only be applied when the whole filter list was pushed down, because
// a residual pass rejects rows after the scan has already counted them — with
// residuals in play the loop has to keep pulling batches until fn says stop.
// It returns the scan's Arrow schema, which is available even when no row
// matched. prepare, if non-nil, is called with that schema before the first
// row — the column order an export writes its header in comes from there,
// since a row is a map and has no order of its own.
func streamRows(
	ctx context.Context,
	t *table.Table,
	filters []PreviewFilterDTO,
	budget int64,
	prepare func(*arrow.Schema) error,
	fn func(next rowFunc) bool,
) (*arrow.Schema, error) {
	plan, err := BuildRowFilter(t.Schema(), filters)
	if err != nil {
		return nil, err
	}

	opts := []table.ScanOption{
		table.WithRowFilter(plan.Pushdown),
		// Pagination is scan-and-discard: page N rescans from row 0 and drops
		// the first `skip` rows. That is only sound if two scans of the same
		// snapshot hand back rows in the same order — and by default they do
		// not. iceberg-go fans file reads out across GOMAXPROCS workers and
		// emits batches in completion order (table/arrow_scanner.go:833), so on
		// a table of more than one data file the order varies from call to
		// call, and "Load more" can repeat rows the previous page already
		// showed while skipping others outright. One worker costs file-level
		// parallelism and buys a stable order.
		//
		// (`Wit` is upstream's spelling, not a typo here.)
		table.WitMaxConcurrency(1),
	}
	if budget > 0 && plan.Residual.Empty() {
		opts = append(opts, table.WithLimit(budget))
	}

	arrowSchema, itr, err := t.Scan(opts...).ToArrowRecords(ctx)
	if err != nil {
		return nil, err
	}
	if prepare != nil {
		if err := prepare(arrowSchema); err != nil {
			return nil, err
		}
	}

	for batch, ierr := range itr {
		if ierr != nil {
			if batch != nil {
				batch.Release()
			}
			return nil, ierr
		}
		matcher, merr := plan.Residual.compile(batch)
		if merr != nil {
			batch.Release()
			return nil, merr
		}
		schema := batch.Schema()
		ncols := int(batch.NumCols())
		for r := range int(batch.NumRows()) {
			if !matcher.match(r) {
				continue
			}
			if !fn(func() map[string]any {
				row := make(map[string]any, ncols)
				for c := range ncols {
					f := schema.Field(c)
					row[f.Name] = arrowValueToJSON(batch.Column(c), r, f.Type)
				}
				return row
			}) {
				batch.Release()
				return arrowSchema, nil
			}
		}
		batch.Release()
		// A residual scan is the one path here that can run for minutes on a
		// table where nothing matches; give the caller's cancellation a chance
		// to land between batches rather than only inside the scan.
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	return arrowSchema, nil
}

func buildPreviewColumns(iceSchema *iceberg.Schema, arrowSchema *arrow.Schema) []PreviewColumnDTO {
	n := arrowSchema.NumFields()
	cols := make([]PreviewColumnDTO, 0, n)
	for i := range n {
		f := arrowSchema.Field(i)
		kind := FieldKindPrimitive
		text := f.Type.String()
		if iceSchema != nil {
			if nf, ok := iceSchema.FindFieldByName(f.Name); ok {
				kind = kindForIcebergType(nf.Type)
				text = typeText(nf.Type)
			}
		}
		cols = append(cols, PreviewColumnDTO{
			Name:     f.Name,
			TypeText: text,
			Kind:     kind,
		})
	}
	return cols
}

func kindForIcebergType(t iceberg.Type) string {
	switch t.(type) {
	case *iceberg.StructType:
		return FieldKindStruct
	case *iceberg.ListType:
		return FieldKindList
	case *iceberg.MapType:
		return FieldKindMap
	default:
		return FieldKindPrimitive
	}
}

func arrowValueToJSON(col arrow.Array, r int, t arrow.DataType) any {
	if col.IsNull(r) {
		return nil
	}
	switch tt := t.(type) {
	case *arrow.BooleanType:
		return col.(*array.Boolean).Value(r)
	case *arrow.Int8Type:
		return col.(*array.Int8).Value(r)
	case *arrow.Int16Type:
		return col.(*array.Int16).Value(r)
	case *arrow.Int32Type:
		return col.(*array.Int32).Value(r)
	case *arrow.Int64Type:
		return col.(*array.Int64).Value(r)
	case *arrow.Uint8Type:
		return col.(*array.Uint8).Value(r)
	case *arrow.Uint16Type:
		return col.(*array.Uint16).Value(r)
	case *arrow.Uint32Type:
		return col.(*array.Uint32).Value(r)
	case *arrow.Uint64Type:
		return col.(*array.Uint64).Value(r)
	case *arrow.Float32Type:
		return col.(*array.Float32).Value(r)
	case *arrow.Float64Type:
		return col.(*array.Float64).Value(r)
	case *arrow.StringType:
		return col.(*array.String).Value(r)
	case *arrow.LargeStringType:
		return col.(*array.LargeString).Value(r)
	case *arrow.Decimal128Type:
		return col.(*array.Decimal128).Value(r).ToString(tt.Scale)
	case *arrow.Decimal256Type:
		return col.(*array.Decimal256).Value(r).ToString(tt.Scale)
	case *arrow.TimestampType:
		toTime, err := tt.GetToTimeFunc()
		if err != nil {
			return fmt.Sprint(col.(*array.Timestamp).Value(r))
		}
		tm := toTime(col.(*array.Timestamp).Value(r))
		if tt.TimeZone == "" {
			// timestamp without zone — emit ISO-8601 without offset.
			return tm.UTC().Format("2006-01-02T15:04:05.999999999")
		}
		return tm.UTC().Format(time.RFC3339Nano)
	case *arrow.Date32Type:
		return col.(*array.Date32).Value(r).ToTime().Format("2006-01-02")
	case *arrow.Date64Type:
		return col.(*array.Date64).Value(r).ToTime().Format("2006-01-02")
	case *arrow.BinaryType:
		return base64.StdEncoding.EncodeToString(col.(*array.Binary).Value(r))
	case *arrow.LargeBinaryType:
		return base64.StdEncoding.EncodeToString(col.(*array.LargeBinary).Value(r))
	case *arrow.FixedSizeBinaryType:
		return base64.StdEncoding.EncodeToString(col.(*array.FixedSizeBinary).Value(r))
	case *arrow.StructType:
		sa := col.(*array.Struct)
		out := make(map[string]any, tt.NumFields())
		for i := 0; i < tt.NumFields(); i++ {
			sf := tt.Field(i)
			out[sf.Name] = arrowValueToJSON(sa.Field(i), r, sf.Type)
		}
		return out
	case *arrow.ListType:
		la := col.(*array.List)
		start, end := la.ValueOffsets(r)
		elemType := tt.ElemField().Type
		items := make([]any, 0, end-start)
		for i := start; i < end; i++ {
			items = append(items, arrowValueToJSON(la.ListValues(), int(i), elemType))
		}
		return items
	case *arrow.LargeListType:
		la := col.(*array.LargeList)
		start, end := la.ValueOffsets(r)
		elemType := tt.ElemField().Type
		items := make([]any, 0, end-start)
		for i := start; i < end; i++ {
			items = append(items, arrowValueToJSON(la.ListValues(), int(i), elemType))
		}
		return items
	case *arrow.MapType:
		ma := col.(*array.Map)
		start, end := ma.ValueOffsets(r)
		keys := ma.Keys()
		vals := ma.Items()
		keyType := tt.KeyType()
		valType := tt.ItemType()
		out := make(map[string]any, end-start)
		for i := start; i < end; i++ {
			kv := arrowValueToJSON(keys, int(i), keyType)
			out[fmt.Sprint(kv)] = arrowValueToJSON(vals, int(i), valType)
		}
		return out
	default:
		// Unknown / unsupported type: stringify so the UI keeps rendering
		// instead of crashing. Document gaps in README per CLAUDE.md.
		return fmt.Sprint(col.GetOneForMarshal(r))
	}
}
