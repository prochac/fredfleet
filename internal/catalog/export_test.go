package catalog

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"strings"
	"testing"
)

func TestExportCSVWritesHeaderAndRowsInScanOrder(t *testing.T) {
	tbl := newFixtureTable(t, 5, 5, func(int) string { return "hay" })

	var buf bytes.Buffer
	n, err := ExportRows(t.Context(), tbl, &buf, ExportFormatCSV, nil, 0)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if n != 5 {
		t.Fatalf("exported %d rows, want 5", n)
	}

	recs, err := csv.NewReader(&buf).ReadAll()
	if err != nil {
		t.Fatalf("the export is not valid CSV: %v", err)
	}
	if len(recs) != 6 {
		t.Fatalf("got %d CSV records (header + rows), want 6", len(recs))
	}
	// Column order is the table's, not the map's — a row map has no order and
	// Go randomises its iteration.
	if got := strings.Join(recs[0], ","); got != "id,name,tag" {
		t.Errorf("header = %q, want %q", got, "id,name,tag")
	}
	for i, rec := range recs[1:] {
		if rec[0] != itoa(i) {
			t.Errorf("row %d: id = %q, want %q", i, rec[0], itoa(i))
		}
		if rec[1] != "row-"+itoa(i) {
			t.Errorf("row %d: name = %q", i, rec[1])
		}
	}
}

// TestExportCSVOfEmptyResultKeepsHeader: a filter that matches nothing must
// still produce a readable file rather than zero bytes.
func TestExportCSVOfEmptyResultKeepsHeader(t *testing.T) {
	tbl := newFixtureTable(t, 5, 5, func(int) string { return "hay" })

	var buf bytes.Buffer
	n, err := ExportRows(t.Context(), tbl, &buf, ExportFormatCSV, []PreviewFilterDTO{
		{Field: "tag", Op: "eq", Value: "nothing-matches"},
	}, 0)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if n != 0 {
		t.Fatalf("exported %d rows, want 0", n)
	}
	if got := strings.TrimSpace(buf.String()); got != "id,name,tag" {
		t.Errorf("empty export = %q, want just the header", got)
	}
}

func TestExportRespectsMaxRows(t *testing.T) {
	tbl := newFixtureTable(t, 500, 500, func(int) string { return "hay" })

	var buf bytes.Buffer
	n, err := ExportRows(t.Context(), tbl, &buf, ExportFormatCSV, nil, 10)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if n != 10 {
		t.Fatalf("exported %d rows, want the 10 asked for", n)
	}
	recs, err := csv.NewReader(&buf).ReadAll()
	if err != nil {
		t.Fatalf("invalid CSV: %v", err)
	}
	if len(recs) != 11 {
		t.Fatalf("got %d records, want 10 rows + header", len(recs))
	}
}

func TestExportRespectsFilters(t *testing.T) {
	tbl := newFixtureTable(t, 30, 30, func(i int) string {
		if i%3 == 0 {
			return "match"
		}
		return "other"
	})

	var buf bytes.Buffer
	n, err := ExportRows(t.Context(), tbl, &buf, ExportFormatCSV, []PreviewFilterDTO{
		{Field: "tag", Op: "eq", Value: "match"},
	}, 0)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if n != 10 {
		t.Fatalf("exported %d rows, want 10", n)
	}
	if strings.Contains(buf.String(), "other") {
		t.Error("the export contains rows the filter excludes")
	}
}

// TestExportJSONIsValidAndOrdered pins the two things a hand-rolled JSON
// writer can get wrong: the document has to parse, and keys have to come out
// in table order rather than encoding/json's alphabetical map order.
func TestExportJSONIsValidAndOrdered(t *testing.T) {
	tbl := newFixtureTable(t, 3, 3, func(int) string { return "hay" })

	var buf bytes.Buffer
	if _, err := ExportRows(t.Context(), tbl, &buf, ExportFormatJSON, nil, 0); err != nil {
		t.Fatalf("export: %v", err)
	}

	var rows []map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rows); err != nil {
		t.Fatalf("the export is not valid JSON: %v\n%s", err, buf.String())
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	if rows[0]["name"] != "row-0" {
		t.Errorf("row 0 name = %v, want row-0", rows[0]["name"])
	}
	if i := strings.Index(buf.String(), `"id"`); i < 0 || i > strings.Index(buf.String(), `"tag"`) {
		t.Error("keys are not in table order")
	}
}

func TestExportJSONOfEmptyResultIsAnEmptyArray(t *testing.T) {
	tbl := newFixtureTable(t, 5, 5, func(int) string { return "hay" })

	var buf bytes.Buffer
	if _, err := ExportRows(t.Context(), tbl, &buf, ExportFormatJSON, []PreviewFilterDTO{
		{Field: "tag", Op: "eq", Value: "nope"},
	}, 0); err != nil {
		t.Fatalf("export: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rows); err != nil {
		t.Fatalf("empty export is not valid JSON: %v (%q)", err, buf.String())
	}
	if len(rows) != 0 {
		t.Fatalf("got %d rows, want none", len(rows))
	}
}

// TestExportJSONPreservesNullAndNestedValues is the reason JSON is offered
// next to CSV: a null stays a null instead of collapsing into an empty field,
// and a struct stays a structure.
func TestExportJSONPreservesNullAndNestedValues(t *testing.T) {
	tbl := newNestedFixtureTable(t, 10, 10)

	var buf bytes.Buffer
	if _, err := ExportRows(t.Context(), tbl, &buf, ExportFormatJSON, nil, 0); err != nil {
		t.Fatalf("export: %v", err)
	}

	var rows []map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rows); err != nil {
		t.Fatalf("not valid JSON: %v\n%s", err, buf.String())
	}

	sawNull, sawNested := false, false
	for _, r := range rows {
		addr, present := r["addr"]
		if !present {
			t.Fatal("the addr column is missing from the export")
		}
		if addr == nil {
			sawNull = true
			continue
		}
		m, ok := addr.(map[string]any)
		if !ok {
			t.Fatalf("addr came out as %T, want a nested object", addr)
		}
		if _, ok := m["city"]; !ok {
			t.Fatal("the nested struct lost its city field")
		}
		sawNested = true
	}
	if !sawNull {
		t.Error("no null addr in the export; the fixture should contain some")
	}
	if !sawNested {
		t.Error("no nested addr object in the export")
	}
}

func TestExportCSVFlattensNestedValuesAsJSON(t *testing.T) {
	tbl := newNestedFixtureTable(t, 4, 4)

	var buf bytes.Buffer
	if _, err := ExportRows(t.Context(), tbl, &buf, ExportFormatCSV, nil, 0); err != nil {
		t.Fatalf("export: %v", err)
	}
	recs, err := csv.NewReader(&buf).ReadAll()
	if err != nil {
		t.Fatalf("invalid CSV: %v", err)
	}
	// Row 0 has a populated addr; it must be a JSON object, not Go's map
	// printing (which would come out as `map[city:city-0 zip:10000]`).
	cell := recs[1][indexOf(recs[0], "addr")]
	var decoded map[string]any
	if err := json.Unmarshal([]byte(cell), &decoded); err != nil {
		t.Fatalf("nested CSV cell %q is not JSON: %v", cell, err)
	}
	if decoded["city"] != "city-0" {
		t.Errorf("nested cell decoded to %v", decoded)
	}
}

func TestExportRejectsUnknownFormat(t *testing.T) {
	tbl := newFixtureTable(t, 1, 1, func(int) string { return "hay" })

	var buf bytes.Buffer
	if _, err := ExportRows(t.Context(), tbl, &buf, "parquet", nil, 0); err == nil {
		t.Fatal("expected an error for an unsupported format")
	} else if !strings.Contains(err.Error(), "unknown export format") {
		t.Fatalf("got %v", err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func indexOf(hay []string, needle string) int {
	for i, h := range hay {
		if h == needle {
			return i
		}
	}
	return -1
}
