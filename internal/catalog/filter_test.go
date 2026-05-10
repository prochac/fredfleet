package catalog

import (
	"errors"
	"strings"
	"testing"

	"github.com/apache/iceberg-go"
)

func testSchema() *iceberg.Schema {
	return iceberg.NewSchema(1,
		iceberg.NestedField{ID: 1, Name: "id", Type: iceberg.PrimitiveTypes.Int64, Required: true},
		iceberg.NestedField{ID: 2, Name: "name", Type: iceberg.PrimitiveTypes.String, Required: false},
		iceberg.NestedField{ID: 3, Name: "born", Type: iceberg.PrimitiveTypes.Date, Required: false},
		iceberg.NestedField{ID: 4, Name: "active", Type: iceberg.PrimitiveTypes.Bool, Required: false},
		iceberg.NestedField{ID: 5, Name: "tags", Required: false, Type: &iceberg.ListType{
			ElementID: 6, Element: iceberg.PrimitiveTypes.String, ElementRequired: true,
		}},
	)
}

func TestBuildRowFilter_Empty(t *testing.T) {
	expr, err := BuildRowFilter(testSchema(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := expr.(iceberg.AlwaysTrue); !ok {
		t.Fatalf("expected AlwaysTrue, got %T", expr)
	}
}

func TestBuildRowFilter_StartsOnIntRejected(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "id", Op: "starts", Value: "1"},
	})
	if !errors.Is(err, ErrFilter) {
		t.Fatalf("expected ErrFilter, got %v", err)
	}
	if !strings.Contains(err.Error(), "only supports string") {
		t.Fatalf("expected message about string-only, got %q", err.Error())
	}
}

func TestBuildRowFilter_NonPrimitiveRejected(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "tags", Op: "eq", Value: "x"},
	})
	if !errors.Is(err, ErrFilter) {
		t.Fatalf("expected ErrFilter, got %v", err)
	}
	if !strings.Contains(err.Error(), "not a primitive") {
		t.Fatalf("expected non-primitive message, got %q", err.Error())
	}
}

func TestBuildRowFilter_UnknownColumn(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "nope", Op: "eq", Value: "x"},
	})
	if !errors.Is(err, ErrFilter) {
		t.Fatalf("expected ErrFilter, got %v", err)
	}
}

func TestBuildRowFilter_UnknownOp(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "name", Op: "contains", Value: "x"},
	})
	if !errors.Is(err, ErrFilter) {
		t.Fatalf("expected ErrFilter, got %v", err)
	}
	if !strings.Contains(err.Error(), "unknown operator") {
		t.Fatalf("expected unknown operator message, got %q", err.Error())
	}
}

func TestBuildRowFilter_BoolOrderedRejected(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "active", Op: "lt", Value: "true"},
	})
	if !errors.Is(err, ErrFilter) {
		t.Fatalf("expected ErrFilter, got %v", err)
	}
}

func TestBuildRowFilter_AndCombined(t *testing.T) {
	expr, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "id", Op: "gt", Value: "100"},
		{Field: "name", Op: "starts", Value: "A"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if expr == nil {
		t.Fatal("expected non-nil expression")
	}
	if expr.Op() != iceberg.OpAnd {
		t.Fatalf("expected OpAnd, got %v", expr.Op())
	}
}

func TestBuildRowFilter_DateCoerced(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "born", Op: "eq", Value: "1990-01-01"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBuildRowFilter_DateBadFormat(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "born", Op: "eq", Value: "01/01/1990"},
	})
	if !errors.Is(err, ErrFilter) {
		t.Fatalf("expected ErrFilter, got %v", err)
	}
	if !strings.Contains(err.Error(), "invalid date") {
		t.Fatalf("expected invalid date message, got %q", err.Error())
	}
}

func TestBuildRowFilter_NullOps(t *testing.T) {
	for _, op := range []string{"isnull", "notnull"} {
		_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
			{Field: "name", Op: op},
		})
		if err != nil {
			t.Fatalf("op %q: unexpected error: %v", op, err)
		}
	}
}
