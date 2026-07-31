package catalog

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/apache/iceberg-go/catalog/rest"
	"github.com/apache/iceberg-go/table"
	"golang.org/x/text/unicode/norm"
)

const (
	// crawlWorkers bounds concurrent REST calls while crawling. Catalogs are
	// often fronted by a single service instance, so this stays modest.
	crawlWorkers = 8
	// Safety caps. A crawl that trips either one still returns what it found,
	// with Complete=false so the UI can say the index is partial.
	maxCrawlNamespaces = 5_000
	maxCrawlTables     = 100_000
	// maxCrawlDepth guards against a catalog that reports a namespace as its
	// own descendant, which would otherwise loop forever.
	maxCrawlDepth = 16

	defaultSearchLimit = 500
	defaultIndexTTL    = 5 * time.Minute
)

// TableSearcher answers table-name queries against a cached, per-connection
// index of every table in a catalog. The index is built by crawling namespaces
// breadth-first on first use and reused until it expires or is invalidated.
//
// The crawl exists because the namespace tree loads children lazily: without it
// the command palette can only offer tables the user has already expanded.
type TableSearcher struct {
	mu    sync.Mutex
	idx   map[string]*tableIndex
	gates map[string]chan struct{}
	ttl   time.Duration
}

type tableIndex struct {
	tables []TableDTO
	// labels holds the case- and diacritic-folded dotted name of each table,
	// index-aligned with tables, so a query never refolds the whole catalog.
	labels   []string
	complete bool
	built    time.Time
}

func NewTableSearcher() *TableSearcher {
	return &TableSearcher{
		idx:   make(map[string]*tableIndex),
		gates: make(map[string]chan struct{}),
		ttl:   defaultIndexTTL,
	}
}

// Search returns the tables whose dotted name fuzzy-matches query, building the
// connection's index first if it is missing or stale. limit ≤ 0 defaults to
// 500; TableSearchDTO.Matched reports how many tables matched before the limit
// was applied, so the caller can tell the user to refine instead of silently
// truncating.
//
// Matching is a case- and diacritic-insensitive subsequence test — deliberately
// the same predicate as fuzzyMatch() on the frontend, but without its scoring.
// Ranking and match highlighting stay in one place (the frontend), and this
// side only narrows the candidate set.
func (s *TableSearcher) Search(ctx context.Context, connName string, cat *rest.Catalog, query string, limit int) (*TableSearchDTO, error) {
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	idx, err := s.index(ctx, connName, cat)
	if err != nil {
		return nil, err
	}

	q := foldKey(query)
	out := &TableSearchDTO{
		Tables:   make([]TableDTO, 0, min(limit, len(idx.tables))),
		Indexed:  len(idx.tables),
		Complete: idx.complete,
	}
	for i, label := range idx.labels {
		if !subsequence(q, label) {
			continue
		}
		out.Matched++
		if len(out.Tables) < limit {
			out.Tables = append(out.Tables, idx.tables[i])
		}
	}
	return out, nil
}

// Invalidate drops the cached index for a connection, forcing the next Search
// to re-crawl. Safe to call when no index exists.
func (s *TableSearcher) Invalidate(connName string) {
	s.mu.Lock()
	delete(s.idx, connName)
	s.mu.Unlock()
}

// index returns a fresh-enough cached index, or crawls to build one. Callers
// racing on the same connection queue behind a per-connection gate so a burst
// of keystrokes triggers exactly one crawl; the waiters then find the cache
// warm. Waiting is context-aware, so closing the palette mid-crawl doesn't
// leave a keystroke blocked on a 60s scan.
func (s *TableSearcher) index(ctx context.Context, connName string, cat *rest.Catalog) (*tableIndex, error) {
	if idx := s.cached(connName); idx != nil {
		return idx, nil
	}

	release, err := s.acquire(ctx, connName)
	if err != nil {
		return nil, err
	}
	defer release()

	// Whoever held the gate may have just built it.
	if idx := s.cached(connName); idx != nil {
		return idx, nil
	}

	tables, complete, err := crawlTables(ctx, cat)
	if err != nil {
		return nil, err
	}

	idx := &tableIndex{
		tables:   tables,
		labels:   make([]string, len(tables)),
		complete: complete,
		built:    time.Now(),
	}
	for i, t := range tables {
		idx.labels[i] = foldKey(labelOf(t))
	}

	s.mu.Lock()
	s.idx[connName] = idx
	s.mu.Unlock()
	return idx, nil
}

func (s *TableSearcher) cached(connName string) *tableIndex {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, ok := s.idx[connName]
	if !ok {
		return nil
	}
	if time.Since(idx.built) > s.ttl {
		delete(s.idx, connName)
		return nil
	}
	return idx
}

func (s *TableSearcher) acquire(ctx context.Context, connName string) (func(), error) {
	s.mu.Lock()
	gate, ok := s.gates[connName]
	if !ok {
		gate = make(chan struct{}, 1)
		s.gates[connName] = gate
	}
	s.mu.Unlock()

	select {
	case gate <- struct{}{}:
		return func() { <-gate }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// crawlTables walks every namespace breadth-first and collects the tables in
// each. The second return value is false when the walk was cut short by a
// safety cap or by a namespace that failed to list — the result is still usable,
// just incomplete.
//
// Errors listing the root, expired auth, and context cancellation abort the
// whole crawl: the first two mean nothing below will work either, and expired
// auth has to propagate so Registry.Do can retry with a fresh catalog.
func crawlTables(ctx context.Context, cat *rest.Catalog) ([]TableDTO, bool, error) {
	var (
		tables   []TableDTO
		complete = true
		seenNS   int
	)

	// The root pseudo-namespace only yields children; tables live under a
	// named namespace.
	level := []table.Identifier{nil}

	for depth := 0; len(level) > 0; depth++ {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		if depth >= maxCrawlDepth {
			complete = false
			break
		}

		next, found, partial, err := crawlLevel(ctx, cat, level, depth == 0)
		if err != nil {
			return nil, false, err
		}
		if partial {
			complete = false
		}
		tables = append(tables, found...)

		if len(tables) >= maxCrawlTables {
			tables = tables[:maxCrawlTables]
			complete = false
			break
		}
		seenNS += len(next)
		if seenNS >= maxCrawlNamespaces {
			complete = false
			break
		}
		level = next
	}

	slices.SortFunc(tables, func(a, b TableDTO) int {
		return strings.Compare(labelOf(a), labelOf(b))
	})
	return tables, complete, nil
}

// crawlLevel lists every namespace at one level of the tree concurrently,
// returning their child namespaces and their tables.
func crawlLevel(ctx context.Context, cat *rest.Catalog, parents []table.Identifier, isRoot bool) (children []table.Identifier, tables []TableDTO, partial bool, err error) {
	var (
		mu       sync.Mutex
		wg       sync.WaitGroup
		sem      = make(chan struct{}, crawlWorkers)
		firstErr error
	)

	for _, parent := range parents {
		wg.Add(1)
		go func(parent table.Identifier) {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				mu.Lock()
				if firstErr == nil {
					firstErr = ctx.Err()
				}
				mu.Unlock()
				return
			}
			defer func() { <-sem }()

			kids, found, lerr := listNamespace(ctx, cat, parent)

			mu.Lock()
			defer mu.Unlock()
			if lerr != nil {
				if isRoot || isAuthExpired(lerr) || ctx.Err() != nil {
					if firstErr == nil {
						firstErr = lerr
					}
					return
				}
				// One unreadable namespace (revoked grant, race with a drop)
				// shouldn't cost the user the whole index.
				partial = true
				return
			}
			children = append(children, kids...)
			tables = append(tables, found...)
		}(parent)
	}

	wg.Wait()
	if firstErr != nil {
		return nil, nil, false, firstErr
	}
	return children, tables, partial, nil
}

func listNamespace(ctx context.Context, cat *rest.Catalog, parent table.Identifier) ([]table.Identifier, []TableDTO, error) {
	kids, err := cat.ListNamespaces(ctx, parent)
	if err != nil {
		return nil, nil, err
	}
	if len(parent) == 0 {
		return kids, nil, nil
	}

	var tables []TableDTO
	for ident, iterErr := range cat.ListTables(ctx, parent) {
		if iterErr != nil {
			return nil, nil, iterErr
		}
		if len(ident) == 0 {
			continue
		}
		tables = append(tables, TableDTO{
			Namespace: append([]string(nil), ident[:len(ident)-1]...),
			Name:      ident[len(ident)-1],
		})
	}
	return kids, tables, nil
}

func labelOf(t TableDTO) string {
	if len(t.Namespace) == 0 {
		return t.Name
	}
	return strings.Join(t.Namespace, ".") + "." + t.Name
}

// foldKey strips diacritics and case so `zakaznici` matches `zákazníci` and
// vice versa. Mirrors normalize() in frontend/src/shortcuts/fuzzy.ts; the two
// only diverge on a lone combining mark, which the frontend preserves and this
// drops — not a shape any catalog produces a table name in.
func foldKey(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range norm.NFD.String(s) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// subsequence reports whether every rune of q appears in t in order. Both are
// expected to be folded already. An empty query matches everything.
func subsequence(q, t string) bool {
	if q == "" {
		return true
	}
	qr := []rune(q)
	i := 0
	for _, r := range t {
		if r != qr[i] {
			continue
		}
		i++
		if i == len(qr) {
			return true
		}
	}
	return false
}
