package catalog

import (
	"testing"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/decimal128"
	"github.com/apache/arrow-go/v18/arrow/memory"
)

func TestArrowValueToJSON_Coercions(t *testing.T) {
	mem := memory.NewGoAllocator()

	tsType := &arrow.TimestampType{Unit: arrow.Microsecond, TimeZone: "UTC"}
	tsNaive := &arrow.TimestampType{Unit: arrow.Microsecond, TimeZone: ""}
	decType := &arrow.Decimal128Type{Precision: 18, Scale: 4}
	listType := arrow.ListOf(arrow.PrimitiveTypes.Int64)
	structType := arrow.StructOf(
		arrow.Field{Name: "a", Type: arrow.PrimitiveTypes.Int32, Nullable: true},
		arrow.Field{Name: "b", Type: arrow.BinaryTypes.String, Nullable: true},
	)
	mapType := arrow.MapOf(arrow.BinaryTypes.String, arrow.PrimitiveTypes.Int32)

	schema := arrow.NewSchema([]arrow.Field{
		{Name: "i", Type: arrow.PrimitiveTypes.Int64, Nullable: true},
		{Name: "s", Type: arrow.BinaryTypes.String, Nullable: true},
		{Name: "dec", Type: decType, Nullable: true},
		{Name: "ts_utc", Type: tsType, Nullable: true},
		{Name: "ts_naive", Type: tsNaive, Nullable: true},
		{Name: "d", Type: arrow.FixedWidthTypes.Date32, Nullable: true},
		{Name: "b", Type: arrow.BinaryTypes.Binary, Nullable: true},
		{Name: "lst", Type: listType, Nullable: true},
		{Name: "st", Type: structType, Nullable: true},
		{Name: "mp", Type: mapType, Nullable: true},
	}, nil)

	rb := array.NewRecordBuilder(mem, schema)
	defer rb.Release()

	// Row 0: populated values.
	rb.Field(0).(*array.Int64Builder).Append(42)
	rb.Field(1).(*array.StringBuilder).Append("hello")
	rb.Field(2).(*array.Decimal128Builder).Append(decimal128.FromI64(12345)) // 1.2345 at scale 4
	// 2026-05-10T12:34:56.789Z in microseconds
	rb.Field(3).(*array.TimestampBuilder).Append(arrow.Timestamp(1778416496789000))
	// Same instant interpreted as naive (no zone offset attached).
	rb.Field(4).(*array.TimestampBuilder).Append(arrow.Timestamp(1778416496789000))
	rb.Field(5).(*array.Date32Builder).Append(arrow.Date32(20218)) // 2025-05-10
	rb.Field(6).(*array.BinaryBuilder).Append([]byte{0x01, 0x02, 0x03})

	listB := rb.Field(7).(*array.ListBuilder)
	listB.Append(true)
	listB.ValueBuilder().(*array.Int64Builder).AppendValues([]int64{10, 20, 30}, nil)

	structB := rb.Field(8).(*array.StructBuilder)
	structB.Append(true)
	structB.FieldBuilder(0).(*array.Int32Builder).Append(7)
	structB.FieldBuilder(1).(*array.StringBuilder).Append("x")

	mapB := rb.Field(9).(*array.MapBuilder)
	mapB.Append(true)
	mapB.KeyBuilder().(*array.StringBuilder).AppendValues([]string{"k"}, nil)
	mapB.ItemBuilder().(*array.Int32Builder).AppendValues([]int32{99}, nil)

	// Row 1: every field null.
	for i := range schema.NumFields() {
		rb.Field(i).AppendNull()
	}

	rec := rb.NewRecordBatch()
	defer rec.Release()

	// Row 0 assertions.
	cases := []struct {
		col  int
		want any
	}{
		{0, int64(42)},
		{1, "hello"},
		{2, "1.2345"},
		{3, "2026-05-10T12:34:56.789Z"},
		{4, "2026-05-10T12:34:56.789"},
		{5, "2025-05-10"},
		{6, "AQID"}, // base64 of {1,2,3}
	}
	for _, c := range cases {
		got := arrowValueToJSON(rec.Column(c.col), 0, schema.Field(c.col).Type)
		if got != c.want {
			t.Errorf("col %d: got %v (%T), want %v (%T)", c.col, got, got, c.want, c.want)
		}
	}

	// List
	lst, ok := arrowValueToJSON(rec.Column(7), 0, schema.Field(7).Type).([]any)
	if !ok {
		t.Fatalf("list cell wrong type: %T", arrowValueToJSON(rec.Column(7), 0, schema.Field(7).Type))
	}
	if len(lst) != 3 || lst[0] != int64(10) || lst[1] != int64(20) || lst[2] != int64(30) {
		t.Errorf("list cell: got %v", lst)
	}

	// Struct
	st, ok := arrowValueToJSON(rec.Column(8), 0, schema.Field(8).Type).(map[string]any)
	if !ok {
		t.Fatalf("struct cell wrong type: %T", arrowValueToJSON(rec.Column(8), 0, schema.Field(8).Type))
	}
	if st["a"] != int32(7) || st["b"] != "x" {
		t.Errorf("struct cell: got %v", st)
	}

	// Map
	mp, ok := arrowValueToJSON(rec.Column(9), 0, schema.Field(9).Type).(map[string]any)
	if !ok {
		t.Fatalf("map cell wrong type: %T", arrowValueToJSON(rec.Column(9), 0, schema.Field(9).Type))
	}
	if mp["k"] != int32(99) {
		t.Errorf("map cell: got %v", mp)
	}

	// Row 1: every cell null.
	for i := range schema.NumFields() {
		got := arrowValueToJSON(rec.Column(i), 1, schema.Field(i).Type)
		if got != nil {
			t.Errorf("col %d row 1: expected nil, got %v (%T)", i, got, got)
		}
	}
}
