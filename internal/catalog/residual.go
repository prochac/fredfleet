package catalog

import (
	"fmt"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/decimal128"
	"github.com/apache/iceberg-go"
)

// A residual filter is the part of the user's filter list that iceberg-go
// cannot evaluate during the scan, so we evaluate it here, row by row, over the
// Arrow batches the scan hands back.
//
// Only one thing lands here today: a predicate on a *nested* field. Up to
// iceberg-go v0.6.0 no nested predicate could be pushed down at all — lowering
// to substrait rebuilt the column reference from the leaf name, so `addr.city`
// was re-bound as `city` and the scan died with "could not bind reference".
//
// v0.7.0 fixed that, and a lone nested predicate now scans correctly. But two
// predicates on the *same* nested field — a range, `!= a AND != b`, even
// `NotNull OR = x` — panic inside arrow-go's struct take kernel ("string offset
// buffer must have at least N values", or an index out of range for ints).
// The panic is on an arrow-go worker goroutine, so no recover reaches it: in
// the app it is a crash, not an error. Pushing down only the shapes that
// survive would need a third planning rule whose every mistake is fatal, for a
// gain that is only performance, so every nested predicate stays here.
// TestNestedPushdownStillBrokenUpstream pins the crash and will start failing
// the day upstream fixes it.
//
// The cost of evaluating here rather than in the scan is that a nested
// predicate no longer prunes files or row groups: BuildPreviewRows has to keep
// pulling batches until it has filled the page. A nested filter that matches
// nothing therefore reads the whole table, bounded only by the caller's
// context — the same 60 s timeout and CancelRequest path that already bounds
// any slow scan.

// ResidualFilter is an OR of AND-runs of leaf predicates, mirroring the group
// structure BuildRowFilter parses out of the filter list. The zero value is
// empty and matches everything.
type ResidualFilter struct {
	groups [][]residualLeaf
}

// Empty reports whether there is nothing to evaluate, in which case
// BuildPreviewRows keeps the cheap fixed-limit scan path.
func (r ResidualFilter) Empty() bool { return len(r.groups) == 0 }

// residualLeaf is one predicate with its operand already coerced to a
// canonical Go value, so the per-row hot path does no parsing.
type residualLeaf struct {
	path []string
	op   string
	typ  iceberg.Type
	// Exactly one of these is populated, per litKind. Set predicates
	// ("in"/"notin") fill the slice; everything else fills the single value.
	vals []residualLit
}

// residualLit is a filter operand reduced to the one Go type the matching code
// compares against. Which field is live follows from the column's Iceberg type,
// not from the JSON the frontend sent.
type residualLit struct {
	b   bool
	i   int64 // ints, dates (days), timestamps (µs)
	f   float64
	s   string
	dec decimal128.Num
}

func residualOf(groups [][]parsedFilter) (ResidualFilter, error) {
	out := ResidualFilter{}
	for _, g := range groups {
		if len(g) == 0 {
			continue
		}
		leaves := make([]residualLeaf, 0, len(g))
		for _, p := range g {
			leaf, err := residualLeafOf(p)
			if err != nil {
				return ResidualFilter{}, err
			}
			leaves = append(leaves, leaf)
		}
		out.groups = append(out.groups, leaves)
	}
	return out, nil
}

// residualLeafOf coerces a parsed filter's operand(s) once. It is also called
// during parsing purely for validation, so a bad value is rejected before any
// scan starts even when the row ends up being pushed down instead.
func residualLeafOf(p parsedFilter) (residualLeaf, error) {
	leaf := residualLeaf{path: p.path, op: p.dto.Op, typ: p.field.Type}
	switch p.dto.Op {
	case "isnull", "notnull":
		return leaf, nil
	}

	raw := []any{p.dto.Value}
	if p.dto.Op == "in" || p.dto.Op == "notin" {
		var err error
		if raw, err = setValues(p.dto); err != nil {
			return residualLeaf{}, err
		}
	}

	for _, v := range raw {
		lit, err := coerceResidual(p, v)
		if err != nil {
			return residualLeaf{}, err
		}
		leaf.vals = append(leaf.vals, lit)
	}
	return leaf, nil
}

func coerceResidual(p parsedFilter, v any) (residualLit, error) {
	switch tt := p.field.Type.(type) {
	case iceberg.BooleanType:
		if p.dto.Op != "eq" && p.dto.Op != "neq" && p.dto.Op != "in" && p.dto.Op != "notin" {
			return residualLit{}, fmt.Errorf("%w: operator %q not supported for boolean", ErrFilter, p.dto.Op)
		}
		b, err := coerceBool(v)
		return residualLit{b: b}, err
	case iceberg.Int32Type:
		n, err := coerceInt32(v)
		return residualLit{i: int64(n)}, err
	case iceberg.Int64Type:
		n, err := coerceInt64(v)
		return residualLit{i: n}, err
	case iceberg.Float32Type:
		f, err := coerceFloat32(v)
		return residualLit{f: float64(f)}, err
	case iceberg.Float64Type:
		f, err := coerceFloat64(v)
		return residualLit{f: f}, err
	case iceberg.StringType:
		s, err := coerceString(v)
		return residualLit{s: s}, err
	case iceberg.DateType:
		d, err := coerceDate(v)
		return residualLit{i: int64(d)}, err
	case iceberg.TimestampType, iceberg.TimestampTzType:
		ts, err := coerceTimestamp(v)
		return residualLit{i: int64(ts)}, err
	case iceberg.DecimalType:
		d, err := coerceDecimal(v, tt.Precision(), tt.Scale())
		return residualLit{dec: d.Val}, err
	default:
		return residualLit{}, fmt.Errorf("%w: filter on type %s not supported", ErrFilter, p.field.Type)
	}
}

// residualMatcher is a ResidualFilter compiled against one Arrow batch: every
// column reference is resolved to a concrete array up front, so evaluating a
// row is a slice index and a compare.
type residualMatcher struct {
	groups [][]func(row int) bool
}

// compile resolves every leaf against the batch's schema. An error here means
// the batch cannot answer the filter at all (a path that isn't a struct chain,
// or an Arrow type that doesn't match the Iceberg type we coerced against), and
// the preview fails rather than silently dropping the predicate.
func (r ResidualFilter) compile(batch arrow.RecordBatch) (*residualMatcher, error) {
	m := &residualMatcher{}
	for _, g := range r.groups {
		fns := make([]func(int) bool, 0, len(g))
		for _, leaf := range g {
			fn, err := leaf.compile(batch)
			if err != nil {
				return nil, err
			}
			fns = append(fns, fn)
		}
		m.groups = append(m.groups, fns)
	}
	return m, nil
}

// match reports whether the row satisfies the OR of AND-runs.
func (m *residualMatcher) match(row int) bool {
	if len(m.groups) == 0 {
		return true
	}
	for _, g := range m.groups {
		all := true
		for _, fn := range g {
			if !fn(row) {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}

func (leaf residualLeaf) compile(batch arrow.RecordBatch) (func(int) bool, error) {
	arr, parents, err := resolvePath(batch, leaf.path)
	if err != nil {
		return nil, err
	}

	// A value is null when its own slot is null *or* any struct on the way to
	// it is — `addr.city` is null for a row whose whole `addr` is null.
	isNull := func(row int) bool {
		for _, p := range parents {
			if p.IsNull(row) {
				return true
			}
		}
		return arr.IsNull(row)
	}

	switch leaf.op {
	case "isnull":
		return isNull, nil
	case "notnull":
		return func(row int) bool { return !isNull(row) }, nil
	}

	cmp, err := comparatorFor(arr, leaf)
	if err != nil {
		return nil, err
	}

	// Every remaining operator is false on null, matching Iceberg's own
	// three-valued semantics: only isnull/notnull can be true for a null cell.
	switch leaf.op {
	case "eq":
		return func(row int) bool { return !isNull(row) && cmp(row, 0) == 0 }, nil
	case "neq":
		return func(row int) bool { return !isNull(row) && cmp(row, 0) != 0 }, nil
	case "lt":
		return func(row int) bool { return !isNull(row) && cmp(row, 0) < 0 }, nil
	case "lte":
		return func(row int) bool { return !isNull(row) && cmp(row, 0) <= 0 }, nil
	case "gt":
		return func(row int) bool { return !isNull(row) && cmp(row, 0) > 0 }, nil
	case "gte":
		return func(row int) bool { return !isNull(row) && cmp(row, 0) >= 0 }, nil
	case "in", "notin":
		n := len(leaf.vals)
		want := leaf.op == "in"
		return func(row int) bool {
			if isNull(row) {
				return false
			}
			for i := range n {
				if cmp(row, i) == 0 {
					return want
				}
			}
			return !want
		}, nil
	}
	return nil, fmt.Errorf("%w: unknown operator %q", ErrFilter, leaf.op)
}

// resolvePath walks a dotted path down through struct columns, returning the
// leaf array plus every struct on the way to it (whose null slots make the leaf
// null). Only struct traversal is supported — Iceberg predicates cannot
// reference a field inside a list or a map either.
func resolvePath(batch arrow.RecordBatch, path []string) (arrow.Array, []arrow.Array, error) {
	schema := batch.Schema()
	idx := schema.FieldIndices(path[0])
	if len(idx) == 0 {
		return nil, nil, fmt.Errorf("%w: column %q is not in the scan result", ErrFilter, path[0])
	}
	cur := batch.Column(idx[0])

	var parents []arrow.Array
	for i, seg := range path[1:] {
		st, ok := cur.(*array.Struct)
		if !ok {
			return nil, nil, fmt.Errorf("%w: %q is not a struct, cannot read %q",
				ErrFilter, joinPath(path[:i+1]), joinPath(path))
		}
		stType, ok := st.DataType().(*arrow.StructType)
		if !ok {
			return nil, nil, fmt.Errorf("%w: %q has no struct type", ErrFilter, joinPath(path[:i+1]))
		}
		child, ok := stType.FieldIdx(seg)
		if !ok {
			return nil, nil, fmt.Errorf("%w: %q has no field %q", ErrFilter, joinPath(path[:i+1]), seg)
		}
		parents = append(parents, st)
		cur = st.Field(child)
	}
	return cur, parents, nil
}

func joinPath(path []string) string {
	out := ""
	for i, p := range path {
		if i > 0 {
			out += "."
		}
		out += p
	}
	return out
}

// comparatorFor returns cmp(row, litIndex) → -1/0/+1, comparing the cell at
// `row` against the leaf's litIndex-th operand. The Arrow type is matched
// against the Iceberg type the operand was coerced for; a mismatch is an error
// rather than a silent false, because a filter that quietly matches nothing is
// worse than one that reports it cannot run.
func comparatorFor(arr arrow.Array, leaf residualLeaf) (func(row, lit int) int, error) {
	switch a := arr.(type) {
	case *array.Boolean:
		return func(row, lit int) int {
			return cmpBool(a.Value(row), leaf.vals[lit].b)
		}, nil
	case *array.Int8:
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Int16:
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Int32:
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Int64:
		return func(row, lit int) int { return cmpInt(a.Value(row), leaf.vals[lit].i) }, nil
	case *array.Uint8:
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Uint16:
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Uint32:
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Uint64:
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Float32:
		return func(row, lit int) int { return cmpFloat(float64(a.Value(row)), leaf.vals[lit].f) }, nil
	case *array.Float64:
		return func(row, lit int) int { return cmpFloat(a.Value(row), leaf.vals[lit].f) }, nil
	case *array.String:
		return func(row, lit int) int { return cmpString(a.Value(row), leaf.vals[lit].s) }, nil
	case *array.LargeString:
		return func(row, lit int) int { return cmpString(a.Value(row), leaf.vals[lit].s) }, nil
	case *array.Date32:
		// Date32 counts days, which is exactly what coerceDate produced.
		return func(row, lit int) int { return cmpInt(int64(a.Value(row)), leaf.vals[lit].i) }, nil
	case *array.Date64:
		// Date64 counts milliseconds; the operand is in days.
		return func(row, lit int) int {
			return cmpInt(int64(a.Value(row)), leaf.vals[lit].i*millisPerDay)
		}, nil
	case *array.Timestamp:
		tt, ok := a.DataType().(*arrow.TimestampType)
		if !ok {
			return nil, fmt.Errorf("%w: timestamp column has no timestamp type", ErrFilter)
		}
		// The operand is in microseconds; scale it into the column's unit so
		// the comparison stays integral in both directions.
		mul, div := timestampScale(tt.Unit)
		return func(row, lit int) int {
			want := leaf.vals[lit].i
			if mul > 1 {
				want *= mul
			} else if div > 1 {
				want /= div
			}
			return cmpInt(int64(a.Value(row)), want)
		}, nil
	case *array.Decimal128:
		dt, ok := a.DataType().(*arrow.Decimal128Type)
		if !ok {
			return nil, fmt.Errorf("%w: decimal column has no decimal type", ErrFilter)
		}
		it, ok := leaf.typ.(iceberg.DecimalType)
		if !ok {
			return nil, fmt.Errorf("%w: decimal column %q is not a decimal in the table schema",
				ErrFilter, joinPath(leaf.path))
		}
		// Operands were coerced at the *schema's* scale. If the file's scale
		// differs, rescale the operand rather than the column.
		scaled := make([]decimal128.Num, len(leaf.vals))
		for i, v := range leaf.vals {
			n := v.dec
			if int32(it.Scale()) != dt.Scale {
				out, err := n.Rescale(int32(it.Scale()), dt.Scale)
				if err != nil {
					return nil, fmt.Errorf("%w: cannot compare decimal at scale %d with column scale %d: %w",
						ErrFilter, it.Scale(), dt.Scale, err)
				}
				n = out
			}
			scaled[i] = n
		}
		return func(row, lit int) int { return a.Value(row).Cmp(scaled[lit]) }, nil
	default:
		return nil, fmt.Errorf("%w: cannot filter %q of Arrow type %s",
			ErrFilter, joinPath(leaf.path), arr.DataType())
	}
}

const millisPerDay = 24 * 60 * 60 * 1000

// timestampScale returns the multiplier or divisor that converts microseconds
// into unit. Exactly one of the two is > 1.
func timestampScale(unit arrow.TimeUnit) (mul, div int64) {
	switch unit {
	case arrow.Second:
		return 1, 1_000_000
	case arrow.Millisecond:
		return 1, 1_000
	case arrow.Microsecond:
		return 1, 1
	case arrow.Nanosecond:
		return 1_000, 1
	}
	return 1, 1
}

func cmpBool(a, b bool) int {
	if a == b {
		return 0
	}
	if !a {
		return -1
	}
	return 1
}

func cmpInt(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func cmpFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func cmpString(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
