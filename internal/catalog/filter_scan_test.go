package catalog

import (
	"slices"
	"strings"
	"testing"

	"github.com/apache/iceberg-go"
	"github.com/apache/iceberg-go/table"
)

// The tests here run the *expanded* filter surface — IN/NOT IN, OR-combining
// and nested fields — against the same on-disk fixtures the rest of the
// preview tests use, because each one is a claim about what the scan returns
// rather than about the shape of an expression tree.

// --- set predicates -------------------------------------------------------

func TestInFilterMatchesAnyListedValue(t *testing.T) {
	// tag cycles a, b, c, so an "in [a, c]" filter must return exactly the
	// two-thirds of rows carrying those tags, in id order.
	tbl := newFixtureTable(t, 30, 30, func(i int) string {
		return string(rune('a' + i%3))
	})

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "tag", Op: "in", Values: []any{"a", "c"}},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	got := rowIDs(t, dto)
	want := []int64{}
	for i := range int64(30) {
		if i%3 == 0 || i%3 == 2 {
			want = append(want, i)
		}
	}
	assertIDs(t, got, want)
}

func TestNotInFilterExcludesEveryListedValue(t *testing.T) {
	tbl := newFixtureTable(t, 30, 30, func(i int) string {
		return string(rune('a' + i%3))
	})

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "tag", Op: "notin", Values: []any{"a", "c"}},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	want := []int64{}
	for i := range int64(30) {
		if i%3 == 1 {
			want = append(want, i)
		}
	}
	assertIDs(t, rowIDs(t, dto), want)
}

func TestInFilterOnNumericColumn(t *testing.T) {
	tbl := newFixtureTable(t, 30, 30, func(int) string { return "hay" })

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "id", Op: "in", Values: []any{"3", "17", "29"}},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	assertIDs(t, rowIDs(t, dto), []int64{3, 17, 29})
}

func TestInFilterWithNoValuesIsRejected(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "name", Op: "in", Values: []any{"  "}},
	})
	if err == nil || !strings.Contains(err.Error(), "at least one value") {
		t.Fatalf("expected an at-least-one-value error, got %v", err)
	}
}

// --- OR combining ---------------------------------------------------------

func TestOrCombinedFiltersUnionTheirMatches(t *testing.T) {
	tbl := newFixtureTable(t, 30, 30, func(int) string { return "hay" })

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "id", Op: "lt", Value: "3"},
		{Field: "id", Op: "gte", Value: "28", Join: "or"},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	assertIDs(t, rowIDs(t, dto), []int64{0, 1, 2, 28, 29})
}

// TestAndBindsTighterThanOr pins the precedence the DTO documents: the list
// `a, b, or c` is (a AND b) OR c, not a AND (b OR c). The two readings return
// different rows here, which is the point of the fixture.
func TestAndBindsTighterThanOr(t *testing.T) {
	tbl := newFixtureTable(t, 30, 30, func(i int) string {
		if i%2 == 0 {
			return "even"
		}
		return "odd"
	})

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "id", Op: "lt", Value: "10"},
		{Field: "tag", Op: "eq", Value: "even"},
		{Field: "id", Op: "eq", Value: "25", Join: "or"},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	// (id < 10 AND tag = even) OR id = 25.
	// Under the other reading — id < 10 AND (tag = even OR id = 25) — row 25
	// could not appear at all.
	assertIDs(t, rowIDs(t, dto), []int64{0, 2, 4, 6, 8, 25})
}

func TestUnknownJoinIsRejected(t *testing.T) {
	_, err := BuildRowFilter(testSchema(), []PreviewFilterDTO{
		{Field: "id", Op: "gt", Value: "1"},
		{Field: "id", Op: "lt", Value: "9", Join: "xor"},
	})
	if err == nil || !strings.Contains(err.Error(), "unknown join") {
		t.Fatalf("expected an unknown-join error, got %v", err)
	}
}

// --- nested fields --------------------------------------------------------

// TestNestedPushdownStillBrokenUpstream is the reason residual.go exists, and
// the signal to delete it.
//
// iceberg-go rebuilds a column reference from its *leaf* name when lowering an
// expression to substrait (table/substrait/substrait.go:318), so a predicate on
// `addr.city` is re-bound as `city` and the scan dies during iteration. If this
// test starts failing, upstream has fixed the reference rebuild and nested
// predicates can go back to being pushed down.
func TestNestedPushdownStillBrokenUpstream(t *testing.T) {
	tbl := newNestedFixtureTable(t, 20, 20)

	scan := tbl.Scan(
		table.WithLimit(100),
		table.WithRowFilter(iceberg.EqualTo(iceberg.Reference("addr.city"), "city-1")),
	)
	_, itr, err := scan.ToArrowRecords(t.Context())
	if err != nil {
		t.Fatalf("ToArrowRecords failed early (%v); the gap may have moved", err)
	}
	for batch, ierr := range itr {
		if batch != nil {
			batch.Release()
		}
		if ierr != nil {
			if strings.Contains(ierr.Error(), "could not bind reference") {
				return // still broken upstream, as expected
			}
			t.Fatalf("scan failed with an unexpected error: %v", ierr)
		}
	}
	t.Fatal("a nested-field filter now scans cleanly upstream — " +
		"drop the residual pass in residual.go and push nested predicates down again")
}

func TestNestedFilterMatchesAcrossBatches(t *testing.T) {
	const rows = 60
	// Several batches on purpose: the residual matcher is compiled per batch.
	tbl := newNestedFixtureTable(t, rows, 7)

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "addr.city", Op: "eq", Value: "city-1"},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	want := []int64{}
	for i := range rows {
		if !nestedAddrIsNull(i) && !nestedCityIsNull(i) && nestedCityOf(i) == "city-1" {
			want = append(want, int64(i))
		}
	}
	if len(want) == 0 {
		t.Fatal("fixture produced no matching rows; the test proves nothing")
	}
	assertIDs(t, rowIDs(t, dto), want)
}

func TestNestedFilterOnIntegerField(t *testing.T) {
	const rows = 40
	tbl := newNestedFixtureTable(t, rows, 40)

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "addr.zip", Op: "gte", Value: "10030"},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	want := []int64{}
	for i := range rows {
		if !nestedAddrIsNull(i) && 10000+i >= 10030 {
			want = append(want, int64(i))
		}
	}
	assertIDs(t, rowIDs(t, dto), want)
}

// TestNestedNullSemantics covers the two ways a nested value goes missing: the
// leaf is null, or the struct holding it is. Both must count as null, and a
// comparison against a null must be false rather than a match.
func TestNestedNullSemantics(t *testing.T) {
	const rows = 40
	tbl := newNestedFixtureTable(t, rows, 40)
	ctx := t.Context()

	wantNull := []int64{}
	wantNotNull := []int64{}
	for i := range rows {
		if nestedAddrIsNull(i) || nestedCityIsNull(i) {
			wantNull = append(wantNull, int64(i))
		} else {
			wantNotNull = append(wantNotNull, int64(i))
		}
	}
	if len(wantNull) == 0 {
		t.Fatal("fixture has no null cities; the test proves nothing")
	}

	isNull, err := BuildPreviewRows(ctx, tbl, 0, 100, []PreviewFilterDTO{
		{Field: "addr.city", Op: "isnull"},
	})
	if err != nil {
		t.Fatalf("isnull preview: %v", err)
	}
	assertIDs(t, rowIDs(t, isNull), wantNull)

	notNull, err := BuildPreviewRows(ctx, tbl, 0, 100, []PreviewFilterDTO{
		{Field: "addr.city", Op: "notnull"},
	})
	if err != nil {
		t.Fatalf("notnull preview: %v", err)
	}
	assertIDs(t, rowIDs(t, notNull), wantNotNull)

	// A null city must not satisfy "!= city-0" either — SQL's three-valued
	// logic, and Iceberg's.
	neq, err := BuildPreviewRows(ctx, tbl, 0, 100, []PreviewFilterDTO{
		{Field: "addr.city", Op: "neq", Value: "city-0"},
	})
	if err != nil {
		t.Fatalf("neq preview: %v", err)
	}
	for _, id := range rowIDs(t, neq) {
		if nestedAddrIsNull(int(id)) || nestedCityIsNull(int(id)) {
			t.Fatalf("row %d has a null city but matched `city != city-0`", id)
		}
	}
}

func TestNestedInFilter(t *testing.T) {
	const rows = 30
	tbl := newNestedFixtureTable(t, rows, 30)

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "addr.city", Op: "in", Values: []any{"city-0", "city-2"}},
	})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	want := []int64{}
	for i := range rows {
		if nestedAddrIsNull(i) || nestedCityIsNull(i) {
			continue
		}
		if c := nestedCityOf(i); c == "city-0" || c == "city-2" {
			want = append(want, int64(i))
		}
	}
	assertIDs(t, rowIDs(t, dto), want)
}

// TestNestedFilterFillsFullPage is the pagination claim for the residual path.
// The scan can no longer be capped at skip+limit+1 rows (that limit counts
// scanned rows, not matching ones), so this checks a page comes back full and
// correctly offset even though matches are sparse.
func TestNestedFilterFillsFullPage(t *testing.T) {
	const (
		rows  = 200
		limit = 10
	)
	tbl := newNestedFixtureTable(t, rows, 13)
	ctx := t.Context()

	all := []int64{}
	for i := range rows {
		if !nestedAddrIsNull(i) && !nestedCityIsNull(i) && nestedCityOf(i) == "city-1" {
			all = append(all, int64(i))
		}
	}
	if len(all) < 3*limit {
		t.Fatalf("fixture has only %d matches, need at least %d", len(all), 3*limit)
	}

	matches := make(map[int64]bool, len(all))
	for _, id := range all {
		matches[id] = true
	}
	filters := []PreviewFilterDTO{{Field: "addr.city", Op: "eq", Value: "city-1"}}

	first, err := BuildPreviewRows(ctx, tbl, 0, limit, filters)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if first.RowCount != limit {
		t.Errorf("first page came back with %d rows, want a full page of %d", first.RowCount, limit)
	}
	if !first.HasMore {
		t.Error("HasMore = false on a full page with matches left")
	}

	second, err := BuildPreviewRows(ctx, tbl, limit, limit, filters)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if second.RowCount != limit {
		t.Errorf("second page came back with %d rows, want a full page of %d", second.RowCount, limit)
	}

	// Every returned row is a real match, and the pages tile rather than
	// overlap — the skip is counted in matching rows, not scanned ones.
	seen := map[int64]bool{}
	for _, page := range [][]int64{rowIDs(t, first), rowIDs(t, second)} {
		for _, id := range page {
			if !matches[id] {
				t.Errorf("row %d came back but does not match the filter", id)
			}
			if seen[id] {
				t.Errorf("row %d appeared on both pages", id)
			}
			seen[id] = true
		}
	}
}

// TestNestedAndTopLevelFilterSplits is the mixed case: the top-level half is
// pushed into the scan and the nested half runs residually, and the result is
// the intersection either way.
func TestNestedAndTopLevelFilterSplits(t *testing.T) {
	const rows = 60
	tbl := newNestedFixtureTable(t, rows, 60)

	filters := []PreviewFilterDTO{
		{Field: "id", Op: "gte", Value: "30"},
		{Field: "addr.city", Op: "eq", Value: "city-1"},
	}

	plan, err := BuildRowFilter(tbl.Schema(), filters)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if _, isAll := plan.Pushdown.(iceberg.AlwaysTrue); isAll {
		t.Error("the top-level half of a mixed AND was not pushed down")
	}
	if plan.Residual.Empty() {
		t.Error("the nested half of a mixed AND was not planned as residual")
	}

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, filters)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	want := []int64{}
	for i := 30; i < rows; i++ {
		if !nestedAddrIsNull(i) && !nestedCityIsNull(i) && nestedCityOf(i) == "city-1" {
			want = append(want, int64(i))
		}
	}
	assertIDs(t, rowIDs(t, dto), want)
}

// TestNestedInsideOrGoesFullyResidual guards the soundness rule: an OR cannot
// be split, because pushing down only one disjunct would drop rows the other
// would have matched. The whole list must fall back to the residual pass.
func TestNestedInsideOrGoesFullyResidual(t *testing.T) {
	const rows = 40
	tbl := newNestedFixtureTable(t, rows, 40)

	filters := []PreviewFilterDTO{
		{Field: "id", Op: "lt", Value: "5"},
		{Field: "addr.city", Op: "eq", Value: "city-2", Join: "or"},
	}

	plan, err := BuildRowFilter(tbl.Schema(), filters)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if _, isAll := plan.Pushdown.(iceberg.AlwaysTrue); !isAll {
		t.Fatalf("an OR spanning a nested field pushed down %v; that would drop rows", plan.Pushdown)
	}

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, filters)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	want := []int64{}
	for i := range rows {
		cityMatches := !nestedAddrIsNull(i) && !nestedCityIsNull(i) && nestedCityOf(i) == "city-2"
		if i < 5 || cityMatches {
			want = append(want, int64(i))
		}
	}
	assertIDs(t, rowIDs(t, dto), want)
}

// assertIDs compares the ids a preview returned against the expected set.
//
// It sorts both sides first: a table written in several appends is several
// data files, and a scan visits them in manifest order rather than in id
// order, so which rows come back is a claim worth making and in what order is
// not.
func assertIDs(t *testing.T, got, want []int64) {
	t.Helper()
	gotSorted := append([]int64(nil), got...)
	wantSorted := append([]int64(nil), want...)
	slices.Sort(gotSorted)
	slices.Sort(wantSorted)
	if !slices.Equal(gotSorted, wantSorted) {
		t.Fatalf("got ids %v, want %v", gotSorted, wantSorted)
	}
}
