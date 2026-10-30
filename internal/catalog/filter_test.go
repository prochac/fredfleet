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
	plan, err := BuildRowFilter(testSchema(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := plan.Pushdown.(iceberg.AlwaysTrue); !ok {
		t.Fatalf("expected AlwaysTrue, got %T", plan.Pushdown)
	}
	if !plan.Residual.Empty() {
		t.Fatal("empty filter list planned a residual pass")
	}
}

// `starts` is rejected for every column type, not just non-strings: Arrow's
// substrait evaluator has no starts_with mapping, so the scan would fail deep
// inside arrow_scanner.go. The UI hides the operator; this guards the backend
// message in case something else sends it. That the gap is still real on
// v0.7.0 is proven separately by TestStartsWithStillUnsupportedUpstream.
func TestBuildRowFilter_StartsRejected(t *testing.T) {
	for _, field := range []string{"id", "name"} {
		_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
			{Field: field, Op: "starts", Value: "A"},
		})
		if !errors.Is(err, ErrFilter) {
			t.Fatalf("field %q: expected ErrFilter, got %v", field, err)
		}
		if !strings.Contains(err.Error(), "not supported") {
			t.Fatalf("field %q: expected unsupported-operator message, got %q", field, err.Error())
		}
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
	plan, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "id", Op: "gt", Value: "100"},
		{Field: "name", Op: "eq", Value: "A"},
		{Field: "born", Op: "lte", Value: "1990-01-01"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Pushdown == nil {
		t.Fatal("expected non-nil expression")
	}
	if plan.Pushdown.Op() != iceberg.OpAnd {
		t.Fatalf("expected OpAnd, got %v", plan.Pushdown.Op())
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
