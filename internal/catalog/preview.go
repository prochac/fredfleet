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

// BuildPreviewRows scans t and returns the first `limit` rows in
// JSON-friendly form. It uses ToArrowRecords (streaming) so memory stays
// bounded by batch size, not by full table size.
func BuildPreviewRows(ctx context.Context, t *table.Table, limit int) (*PreviewRowsDTO, error) {
	if limit <= 0 {
		limit = defaultPreviewLimit
	}

	scan := t.Scan(table.WithLimit(int64(limit)))
	arrowSchema, itr, err := scan.ToArrowRecords(ctx)
	if err != nil {
		return nil, err
	}

	cols := buildPreviewColumns(t.Schema(), arrowSchema)
	rows := make([]map[string]any, 0, limit)

	for batch, ierr := range itr {
		if ierr != nil {
			if batch != nil {
				batch.Release()
			}
			return nil, ierr
		}
		schema := batch.Schema()
		for r := 0; r < int(batch.NumRows()) && len(rows) < limit; r++ {
			row := make(map[string]any, batch.NumCols())
			for c := 0; c < int(batch.NumCols()); c++ {
				name := schema.Field(c).Name
				row[name] = arrowValueToJSON(batch.Column(c), r, schema.Field(c).Type)
			}
			rows = append(rows, row)
		}
		batch.Release()
		if len(rows) >= limit {
			break
		}
	}

	return &PreviewRowsDTO{
		Columns:  cols,
		Rows:     rows,
		RowCount: len(rows),
		HasMore:  false,
	}, nil
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
