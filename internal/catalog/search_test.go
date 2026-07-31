package catalog

import (
	"context"
	"testing"
	"time"
)

func TestFoldKey(t *testing.T) {
	tests := []struct{ in, want string }{
		{"zákazníci", "zakaznici"},
		{"ZÁKAZNÍCI", "zakaznici"},
		{"sales.Customers", "sales.customers"},
		{"ěščřžýáíé", "escrzyaie"},
		{"plain", "plain"},
	}
	for _, tt := range tests {
		if got := foldKey(tt.in); got != tt.want {
			t.Errorf("foldKey(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestSubsequence(t *testing.T) {
	tests := []struct {
		q, target string
		want      bool
	}{
		{"", "anything", true},
		{"cust", "sales.customers", true},
		{"scust", "sales.customers", true},
		// Out of order must not match.
		{"tsuc", "sales.customers", false},
		{"salescustomers", "sales.customers", true},
		{"xyz", "sales.customers", false},
		// Longer than the target.
		{"sales.customers.extra", "sales.customers", false},
	}
	for _, tt := range tests {
		if got := subsequence(tt.q, tt.target); got != tt.want {
			t.Errorf("subsequence(%q, %q) = %v, want %v", tt.q, tt.target, got, tt.want)
		}
	}
}

func TestLabelOf(t *testing.T) {
	if got := labelOf(TableDTO{Namespace: []string{"a", "b"}, Name: "c"}); got != "a.b.c" {
		t.Errorf("got %q", got)
	}
	if got := labelOf(TableDTO{Name: "c"}); got != "c" {
		t.Errorf("got %q", got)
	}
}

// seed installs a ready-made index so Search can be exercised without a live
// catalog. Mirrors what TableSearcher.index builds after a crawl.
func seed(s *TableSearcher, connName string, complete bool, tables ...TableDTO) {
	idx := &tableIndex{
		tables:   tables,
		labels:   make([]string, len(tables)),
		complete: complete,
		built:    time.Now(),
	}
	for i, tbl := range tables {
		idx.labels[i] = foldKey(labelOf(tbl))
	}
	s.mu.Lock()
	s.idx[connName] = idx
	s.mu.Unlock()
}

func TestSearchMatchesAcrossNamespaces(t *testing.T) {
	s := NewTableSearcher()
	seed(s, "conn", true,
		TableDTO{Namespace: []string{"sales"}, Name: "customers"},
		TableDTO{Namespace: []string{"sales"}, Name: "orders"},
		TableDTO{Namespace: []string{"raw", "eu"}, Name: "zákazníci"},
	)

	got, err := s.Search(context.Background(), "conn", nil, "zakaz", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Matched != 1 || len(got.Tables) != 1 {
		t.Fatalf("matched=%d tables=%d, want 1/1", got.Matched, len(got.Tables))
	}
	if got.Tables[0].Name != "zákazníci" {
		t.Errorf("got %q", got.Tables[0].Name)
	}
	if got.Indexed != 3 || !got.Complete {
		t.Errorf("indexed=%d complete=%v, want 3/true", got.Indexed, got.Complete)
	}
}

func TestSearchEmptyQueryReturnsEverything(t *testing.T) {
	s := NewTableSearcher()
	seed(s, "conn", false,
		TableDTO{Namespace: []string{"a"}, Name: "one"},
		TableDTO{Namespace: []string{"a"}, Name: "two"},
	)

	got, err := s.Search(context.Background(), "conn", nil, "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Matched != 2 || len(got.Tables) != 2 {
		t.Fatalf("matched=%d tables=%d, want 2/2", got.Matched, len(got.Tables))
	}
	if got.Complete {
		t.Error("Complete should carry through from the index")
	}
}

// The limit truncates the returned rows but Matched still reports the real
// total, so the UI can tell the user to narrow the query.
func TestSearchLimitReportsFullMatchCount(t *testing.T) {
	s := NewTableSearcher()
	seed(s, "conn", true,
		TableDTO{Namespace: []string{"a"}, Name: "one"},
		TableDTO{Namespace: []string{"a"}, Name: "two"},
		TableDTO{Namespace: []string{"a"}, Name: "three"},
	)

	got, err := s.Search(context.Background(), "conn", nil, "", 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Tables) != 2 {
		t.Fatalf("tables=%d, want 2", len(got.Tables))
	}
	if got.Matched != 3 {
		t.Errorf("matched=%d, want 3", got.Matched)
	}
}

func TestInvalidateDropsIndex(t *testing.T) {
	s := NewTableSearcher()
	seed(s, "conn", true, TableDTO{Namespace: []string{"a"}, Name: "one"})
	s.Invalidate("conn")
	if idx := s.cached("conn"); idx != nil {
		t.Fatal("index survived Invalidate")
	}
}

func TestExpiredIndexIsDropped(t *testing.T) {
	s := NewTableSearcher()
	s.ttl = time.Nanosecond
	seed(s, "conn", true, TableDTO{Namespace: []string{"a"}, Name: "one"})
	time.Sleep(time.Millisecond)
	if idx := s.cached("conn"); idx != nil {
		t.Fatal("stale index was served")
	}
}

// A cancelled context must not be swallowed while waiting on the build gate:
// closing the palette mid-crawl has to fail fast rather than block.
func TestAcquireHonoursContext(t *testing.T) {
	s := NewTableSearcher()
	release, err := s.acquire(context.Background(), "conn")
	if err != nil {
		t.Fatalf("first acquire failed: %v", err)
	}
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.acquire(ctx, "conn"); err == nil {
		t.Fatal("expected acquire to fail on a cancelled context")
	}
}
