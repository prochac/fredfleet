package catalog

import (
	"context"
	"errors"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/apache/iceberg-go"
	icebergio "github.com/apache/iceberg-go/io"
	"github.com/apache/iceberg-go/table"
)

// The tests in this file prove the three preview behaviours that are easy to
// implement per spec and hard to verify by inspection: a filter reaching the
// whole table, a cancelled scan releasing its goroutines, and Load-more
// tiling pages without duplicates. Each exercises BuildPreviewRows — the
// function App.PreviewTable delegates to — against a real Iceberg table on
// local disk, so the proof covers the actual scan path rather than a stand-in.

// --- whole-table filter proof --------------------------------------------

// TestFilterMatchesRowPastFirstPage is the "whole-table filter proof": a filter
// must reach the scan, not just the loaded page.
//
// The fixture plants tag="needle" on exactly one row, id=250, and the preview
// limit is 100. If filtering were applied client-side to the first page, the
// match would be invisible; the row only surfaces because BuildRowFilter is
// pushed into table.Scan.
func TestFilterMatchesRowPastFirstPage(t *testing.T) {
	const (
		rows      = 300
		needleID  = 250
		pageLimit = 100
	)
	tbl := newFixtureTable(t, rows, rows, func(i int) string {
		if i == needleID {
			return "needle"
		}
		return "hay"
	})
	ctx := t.Context()

	// First establish the premise: the needle is genuinely past row 100, i.e.
	// an unfiltered first page cannot see it.
	firstPage, err := BuildPreviewRows(ctx, tbl, 0, pageLimit, nil)
	if err != nil {
		t.Fatalf("unfiltered preview: %v", err)
	}
	if got := firstPage.RowCount; got != pageLimit {
		t.Fatalf("unfiltered first page: got %d rows, want %d", got, pageLimit)
	}
	for _, id := range rowIDs(t, firstPage) {
		if id == needleID {
			t.Fatalf("id %d appeared in the first %d rows; the fixture no longer proves anything", needleID, pageLimit)
		}
	}

	// Now the actual claim.
	filtered, err := BuildPreviewRows(ctx, tbl, 0, pageLimit, []PreviewFilterDTO{
		{Field: "tag", Op: "eq", Value: "needle"},
	})
	if err != nil {
		t.Fatalf("filtered preview: %v", err)
	}
	ids := rowIDs(t, filtered)
	if len(ids) != 1 || ids[0] != needleID {
		t.Fatalf("filter tag=needle returned ids %v, want exactly [%d]", ids, needleID)
	}
	if filtered.HasMore {
		t.Errorf("HasMore = true for a single-match filter, want false")
	}
}

// TestFilterOnUnmatchedValueReturnsNoRows guards the other half of the same
// behaviour: a value that exists nowhere must come back empty rather than
// falling back to an unfiltered page.
func TestFilterOnUnmatchedValueReturnsNoRows(t *testing.T) {
	tbl := newFixtureTable(t, 300, 300, func(int) string { return "hay" })

	dto, err := BuildPreviewRows(t.Context(), tbl, 0, 100, []PreviewFilterDTO{
		{Field: "tag", Op: "eq", Value: "nothing-matches-this"},
	})
	if err != nil {
		t.Fatalf("filtered preview: %v", err)
	}
	if dto.RowCount != 0 {
		t.Fatalf("got %d rows, want 0", dto.RowCount)
	}
	if dto.HasMore {
		t.Errorf("HasMore = true on an empty result, want false")
	}
	// Columns must still be populated so the frontend can keep the filter bar
	// usable on an empty result (the "clear filters" recovery path).
	if len(dto.Columns) == 0 {
		t.Errorf("empty result dropped the column list; the filter bar would have nothing to render")
	}
}

// --- pagination has no duplicates ----------------------------------------

// TestLoadMoreProducesNoDuplicates walks the exact sequence the frontend's
// loadMore performs — skip = len(rows loaded so far), limit = page size — and
// asserts the pages tile the table with no repeats and no gaps.
func TestLoadMoreProducesNoDuplicates(t *testing.T) {
	const (
		rows     = 300
		pageSize = 100
	)
	tbl := newFixtureTable(t, rows, rows, func(int) string { return "hay" })
	ctx := t.Context()

	var (
		loaded []int64
		seen   = map[int64]int{} // id -> page it first appeared on
		page   int
	)
	for {
		dto, err := BuildPreviewRows(ctx, tbl, len(loaded), pageSize, nil)
		if err != nil {
			t.Fatalf("page %d (skip=%d): %v", page, len(loaded), err)
		}
		for _, id := range rowIDs(t, dto) {
			if prev, dup := seen[id]; dup {
				t.Fatalf("id %d returned on page %d and again on page %d", id, prev, page)
			}
			seen[id] = page
			loaded = append(loaded, id)
		}
		if !dto.HasMore {
			break
		}
		page++
		if page > 10 {
			t.Fatalf("HasMore never went false after %d pages (%d rows loaded)", page, len(loaded))
		}
	}

	if len(loaded) != rows {
		t.Fatalf("loaded %d rows across %d pages, want %d", len(loaded), page+1, rows)
	}
	for i, id := range loaded {
		if id != int64(i) {
			t.Fatalf("row %d has id %d; pages did not tile the table in order", i, id)
		}
	}
}

// TestScanOrderIsStableAcrossCalls is the premise every other pagination test
// here rests on, and it does not hold for free.
//
// The fixtures above are written in a single append, so they are a single data
// file and their order is trivially stable. This one is written in small
// batches — many data files — which is where iceberg-go's default fan-out
// (GOMAXPROCS workers emitting batches as they finish) makes the row order
// differ from one scan to the next. Under that order, "Load more" with
// skip=len(loaded) repeats rows and drops others. BuildPreviewRows pins the
// scan to one worker to prevent it; this test fails if that option is removed.
func TestScanOrderIsStableAcrossCalls(t *testing.T) {
	tbl := newNestedFixtureTable(t, 60, 7)
	ctx := t.Context()

	var first []int64
	for run := range 4 {
		dto, err := BuildPreviewRows(ctx, tbl, 0, 100, nil)
		if err != nil {
			t.Fatalf("run %d: %v", run, err)
		}
		ids := rowIDs(t, dto)
		if run == 0 {
			first = ids
			continue
		}
		if !slices.Equal(ids, first) {
			t.Fatalf("scan order changed between calls, so page N+1 cannot be "+
				"trusted to continue page N:\n first = %v\n run %d = %v", first, run, ids)
		}
	}
}

// TestLoadMoreAcrossManyDataFiles is TestLoadMoreProducesNoDuplicates on a
// table that is many data files rather than one — the case that actually
// exercises scan ordering.
func TestLoadMoreAcrossManyDataFiles(t *testing.T) {
	const (
		rows     = 120
		pageSize = 17 // deliberately not a divisor of the batch or row count
	)
	tbl := newNestedFixtureTable(t, rows, 11)
	ctx := t.Context()

	seen := map[int64]int{}
	loaded := 0
	for page := 0; ; page++ {
		dto, err := BuildPreviewRows(ctx, tbl, loaded, pageSize, nil)
		if err != nil {
			t.Fatalf("page %d (skip=%d): %v", page, loaded, err)
		}
		for _, id := range rowIDs(t, dto) {
			if prev, dup := seen[id]; dup {
				t.Fatalf("id %d returned on page %d and again on page %d", id, prev, page)
			}
			seen[id] = page
			loaded++
		}
		if !dto.HasMore {
			break
		}
		if page > 20 {
			t.Fatalf("pagination did not terminate (%d rows loaded)", loaded)
		}
	}
	if loaded != rows {
		t.Fatalf("pages covered %d rows, want all %d", loaded, rows)
	}
}

// TestHasMoreAtExactPageBoundary pins the trailing-probe-row behaviour
// documented on BuildPreviewRows: a table whose row count is an exact multiple
// of the page size must not offer a Load-more that would return nothing.
func TestHasMoreAtExactPageBoundary(t *testing.T) {
	const pageSize = 100
	tbl := newFixtureTable(t, 200, 200, func(int) string { return "hay" })
	ctx := t.Context()

	first, err := BuildPreviewRows(ctx, tbl, 0, pageSize, nil)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if !first.HasMore {
		t.Fatalf("first page of a 200-row table: HasMore = false, want true")
	}

	second, err := BuildPreviewRows(ctx, tbl, pageSize, pageSize, nil)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if second.RowCount != pageSize {
		t.Fatalf("second page: got %d rows, want %d", second.RowCount, pageSize)
	}
	if second.HasMore {
		t.Errorf("second page of a 200-row table: HasMore = true, want false (Load more would fetch 0 rows)")
	}
}

// TestPaginationUnderFilterHasNoDuplicates covers the combination the criterion
// actually names: Load more *under an active filter*.
// Every third row matches, so skip has to count filtered rows, not table rows.
func TestPaginationUnderFilterHasNoDuplicates(t *testing.T) {
	const (
		rows     = 300
		pageSize = 25
	)
	tbl := newFixtureTable(t, rows, rows, func(i int) string {
		if i%3 == 0 {
			return "match"
		}
		return "other"
	})
	ctx := t.Context()
	filters := []PreviewFilterDTO{{Field: "tag", Op: "eq", Value: "match"}}

	var loaded []int64
	seen := map[int64]bool{}
	for page := 0; ; page++ {
		dto, err := BuildPreviewRows(ctx, tbl, len(loaded), pageSize, filters)
		if err != nil {
			t.Fatalf("filtered page %d: %v", page, err)
		}
		for _, id := range rowIDs(t, dto) {
			if id%3 != 0 {
				t.Fatalf("id %d does not match the filter but was returned", id)
			}
			if seen[id] {
				t.Fatalf("id %d returned twice across filtered pages", id)
			}
			seen[id] = true
			loaded = append(loaded, id)
		}
		if !dto.HasMore {
			break
		}
		if page > 20 {
			t.Fatalf("filtered pagination did not terminate (%d rows)", len(loaded))
		}
	}

	if want := (rows + 2) / 3; len(loaded) != want {
		t.Fatalf("filtered pagination loaded %d rows, want %d", len(loaded), want)
	}
}

// --- cancelling a scan releases its goroutines -----------------------------

// slowIO wraps a real IO but makes every Open block, modelling a slow object
// store. The delay is cancellable through the context the FSysF was called
// with, which is exactly how a real IO backend behaves.
type slowIO struct {
	inner icebergio.IO
	ctx   context.Context
	delay time.Duration
}

func (s *slowIO) Open(name string) (icebergio.File, error) {
	select {
	case <-time.After(s.delay):
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
	return s.inner.Open(name)
}

func (s *slowIO) Remove(name string) error { return s.inner.Remove(name) }

// slowFS returns an FSysF whose files take delay to open.
func slowFS(delay time.Duration) table.FSysF {
	return func(ctx context.Context) (icebergio.IO, error) {
		return &slowIO{inner: icebergio.LocalFS{}, ctx: ctx, delay: delay}, nil
	}
}

// TestCancelledScanReleasesGoroutines is the cancellation proof: after
// cancelling an in-flight scan, runtime.NumGoroutine() returns to baseline
// within 5 s.
//
// The scan is made slow by an IO wrapper rather than by a huge table, so the
// test stays fast and deterministic while still having real scanner goroutines
// (iceberg-go fans out over data files with an errgroup) parked in flight at
// the moment of cancellation.
func TestCancelledScanReleasesGoroutines(t *testing.T) {
	// Several data files so the scanner actually spawns a worker fan-out.
	fast := newFixtureTable(t, 200, 20, func(int) string { return "hay" })

	// Warm up on the fast filesystem: the first scan lazily creates pools and
	// background goroutines that must not be counted as a leak.
	if _, err := BuildPreviewRows(t.Context(), fast, 0, 10, nil); err != nil {
		t.Fatalf("warmup scan: %v", err)
	}

	slow := table.New(
		fast.Identifier(),
		fast.Metadata(),
		fast.MetadataLocation(),
		slowFS(30*time.Second),
		nil, // CatalogIO is only needed for commits; a read-only scan never uses it.
	)

	registry := NewRequestRegistry()
	const reqID = "m3c-cancel-probe"

	settle(t)
	baseline := runtime.NumGoroutine()

	reqCtx, release := registry.Register(context.Background(), reqID)
	defer release()

	done := make(chan error, 1)
	go func() {
		_, err := BuildPreviewRows(reqCtx, slow, 0, 100, nil)
		done <- err
	}()

	// Let the scan get properly under way and park inside slowIO.Open.
	time.Sleep(500 * time.Millisecond)
	if inFlight := runtime.NumGoroutine(); inFlight <= baseline {
		t.Fatalf("goroutine count %d did not rise above baseline %d; the scan never got in flight, so cancellation proves nothing", inFlight, baseline)
	}

	cancelledAt := time.Now()
	if !registry.Cancel(reqID) {
		t.Fatal("Cancel returned false; the request was not registered")
	}

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled scan returned %v, want context.Canceled", err)
		}
		if elapsed := time.Since(cancelledAt); elapsed > time.Second {
			t.Errorf("scan took %s to return after cancel, want under 1s", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled scan did not return within 5s")
	}

	// The criterion: back to baseline within 5 s of the cancel.
	deadline := cancelledAt.Add(5 * time.Second)
	var last int
	for time.Now().Before(deadline) {
		settle(t)
		if last = runtime.NumGoroutine(); last <= baseline {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("goroutines still at %d 5s after cancel, baseline %d", last, baseline)
}

// settle gives goroutines that are already unblocked a chance to finish
// before their count is read, so the assertion measures leaks rather than
// scheduling latency.
func settle(t *testing.T) {
	t.Helper()
	for range 3 {
		runtime.GC()
		runtime.Gosched()
		time.Sleep(20 * time.Millisecond)
	}
}

// --- upstream starts_with gap ---------------------------------------------

// TestStartsWithStillUnsupportedUpstream pins the reason `starts` is rejected
// in BuildRowFilter. filter_test.go proves we reject it; this proves we are
// still right to. It goes around BuildRowFilter deliberately, handing
// iceberg.StartsWith straight to a real scan, so the assertion is about
// upstream behaviour rather than about our own guard.
//
// The failure surfaces during iteration, not at ToArrowRecords: planning
// succeeds and Arrow's substrait evaluator only gives up once it has to
// evaluate the expression against a record batch.
//
// When this test starts failing because the scan *succeeded*, arrow-go has
// shipped the scalar mapping — drop the `starts` rejection in filter.go, its
// test in filter_test.go, and unhide the operator in the UI.
func TestStartsWithStillUnsupportedUpstream(t *testing.T) {
	const rows = 20
	tbl := newFixtureTable(t, rows, rows, func(i int) string {
		if i%2 == 0 {
			return "alpha-x"
		}
		return "beta-y"
	})

	scan := tbl.Scan(
		table.WithLimit(rows),
		table.WithRowFilter(iceberg.StartsWith(iceberg.Reference("tag"), "alph")),
	)
	_, itr, err := scan.ToArrowRecords(t.Context())
	if err != nil {
		// A plan-time failure is still an upstream gap, just a different one;
		// the guard's job is to notice either way.
		if strings.Contains(err.Error(), "starts_with") {
			return
		}
		t.Fatalf("scan planning failed for an unrelated reason: %v", err)
	}

	matched := 0
	for batch, ierr := range itr {
		if ierr != nil {
			if batch != nil {
				batch.Release()
			}
			if strings.Contains(ierr.Error(), "starts_with") {
				return
			}
			t.Fatalf("scan failed for an unrelated reason: %v", ierr)
		}
		matched += int(batch.NumRows())
		batch.Release()
	}
	t.Fatalf("starts_with scan succeeded and returned %d rows: arrow-go now "+
		"implements the mapping, so the `starts` rejection in filter.go is "+
		"obsolete", matched)
}
