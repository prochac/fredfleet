package catalog

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/apache/arrow-go/v18/arrow/decimal128"
	"github.com/apache/iceberg-go"
)

// ErrFilter wraps any user-facing error from BuildRowFilter so MapError can
// surface the wrapped message verbatim.
var ErrFilter = errors.New("filter")

var epochUTC = time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)

// FilterPlan is what BuildRowFilter produces: the part of the filter list
// iceberg-go can evaluate during the scan, plus the part we have to evaluate
// ourselves over the returned Arrow batches.
//
// Pushdown is always non-nil — iceberg.AlwaysTrue when nothing could be pushed
// down, which table.WithRowFilter no-ops on. Residual is empty unless the list
// touches a nested field; see residual.go for why it exists and preview.go for
// how the two halves are combined.
type FilterPlan struct {
	Pushdown iceberg.BooleanExpression
	Residual ResidualFilter
}

// BuildRowFilter translates the UI filter list into a scan plan bound against
// schema. An empty list plans a bare AlwaysTrue with no residual. Every error
// returned wraps ErrFilter.
//
// Rows combine with the operator in each row's Join field: "and" (the default)
// or "or", with AND binding tighter than OR, exactly as in SQL. So
// `a AND b OR c` plans as `(a AND b) OR c`.
func BuildRowFilter(schema *iceberg.Schema, filters []PreviewFilterDTO) (FilterPlan, error) {
	empty := FilterPlan{Pushdown: iceberg.AlwaysTrue{}}
	if len(filters) == 0 {
		return empty, nil
	}

	groups, err := parseGroups(schema, filters)
	if err != nil {
		return empty, err
	}

	// A nested reference cannot be pushed down at all: iceberg-go rebuilds the
	// reference from the *leaf* name when it lowers the expression to substrait
	// (table/substrait/substrait.go:318), so `addr.city` is re-bound as `city`
	// and the scan dies mid-iteration with "could not bind reference". See
	// ResidualFilter.
	if !anyNested(groups) {
		expr, err := pushdownExpr(groups)
		if err != nil {
			return empty, err
		}
		if err := trialBind(schema, expr); err != nil {
			return empty, err
		}
		return FilterPlan{Pushdown: expr}, nil
	}

	// Mixed list. A single AND-run splits cleanly — every conjunct is
	// independently sound, so the top-level predicates still narrow the scan
	// and only the nested ones fall through to the residual pass. An OR
	// spanning more than one group cannot be split that way (dropping a
	// disjunct would *widen* the result), so the whole list goes residual.
	if len(groups) > 1 {
		residual, err := residualOf(groups)
		if err != nil {
			return empty, err
		}
		return FilterPlan{Pushdown: iceberg.AlwaysTrue{}, Residual: residual}, nil
	}

	var (
		pushable [][]parsedFilter
		nested   []parsedFilter
	)
	var conj []parsedFilter
	for _, p := range groups[0] {
		if p.nested {
			nested = append(nested, p)
		} else {
			conj = append(conj, p)
		}
	}
	if len(conj) > 0 {
		pushable = [][]parsedFilter{conj}
	}

	plan := FilterPlan{Pushdown: iceberg.AlwaysTrue{}}
	if len(pushable) > 0 {
		expr, err := pushdownExpr(pushable)
		if err != nil {
			return empty, err
		}
		if err := trialBind(schema, expr); err != nil {
			return empty, err
		}
		plan.Pushdown = expr
	}
	residual, err := residualOf([][]parsedFilter{nested})
	if err != nil {
		return empty, err
	}
	plan.Residual = residual
	return plan, nil
}

// trialBind validates the expression early, then throws the bound tree away.
// iceberg-go's scanner re-binds rowFilter unconditionally (table/scanner.go:510)
// and panics on already-bound predicates (visitors.go:183). Handing it bound
// input crashes the process under Wails/WebKit, where the WebKit-installed
// SIGSEGV handler is not SA_ONSTACK-safe and Go cannot route the panic through
// its signal stack.
func trialBind(schema *iceberg.Schema, expr iceberg.BooleanExpression) error {
	if _, err := iceberg.BindExpr(schema, expr, true); err != nil {
		return fmt.Errorf("%w: %w", ErrFilter, err)
	}
	return nil
}

// parsedFilter is one validated filter row: the DTO, the schema field it
// resolved to, and the split dotted path (len > 1 means nested).
type parsedFilter struct {
	dto    PreviewFilterDTO
	field  iceberg.NestedField
	path   []string
	nested bool
}

// parseGroups validates every row and splits the list into AND-runs, one per
// "or" join. The first row's Join is ignored — there is nothing to its left.
func parseGroups(schema *iceberg.Schema, filters []PreviewFilterDTO) ([][]parsedFilter, error) {
	groups := [][]parsedFilter{{}}
	for i, f := range filters {
		p, err := parseOne(schema, f)
		if err != nil {
			return nil, err
		}
		switch join := strings.ToLower(f.Join); {
		case i == 0 || join == "" || join == "and":
		case join == "or":
			groups = append(groups, []parsedFilter{})
		default:
			return nil, fmt.Errorf("%w: unknown join %q", ErrFilter, f.Join)
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], p)
	}
	return groups, nil
}

func parseOne(schema *iceberg.Schema, f PreviewFilterDTO) (parsedFilter, error) {
	nf, ok := schema.FindFieldByName(f.Field)
	if !ok {
		return parsedFilter{}, fmt.Errorf("%w: unknown column %q", ErrFilter, f.Field)
	}
	if _, ok := nf.Type.(iceberg.PrimitiveType); !ok {
		return parsedFilter{}, fmt.Errorf("%w: column %q is not a primitive", ErrFilter, f.Field)
	}
	path := strings.Split(f.Field, ".")
	p := parsedFilter{dto: f, field: nf, path: path, nested: len(path) > 1}

	switch f.Op {
	case "isnull", "notnull":
		return p, nil
	case "starts":
		// iceberg-go builds the per-record filter via Arrow's substrait
		// expression evaluator, which has no scalar mapping for
		// `starts_with`. The scan would fail with "not implemented:
		// starts_with" deep inside arrow_scanner.go. Still true on v0.6.0 —
		// verified by scanning a string column with iceberg.StartsWith
		// against the local fixture. The gap is in Arrow's evaluator, not in
		// iceberg-go's substrait mapping (table/substrait emits starts_with
		// fine), so revisit when arrow-go's exprs extension set implements
		// it.
		return parsedFilter{}, fmt.Errorf("%w: operator %q is not supported by iceberg-go v0.6.0", ErrFilter, f.Op)
	case "eq", "neq", "lt", "lte", "gt", "gte", "in", "notin":
		// Validate the operand(s) now so a bad value is reported against the
		// row that carries it, whichever half of the plan it ends up in.
		if _, err := residualLeafOf(p); err != nil {
			return parsedFilter{}, err
		}
		return p, nil
	default:
		return parsedFilter{}, fmt.Errorf("%w: unknown operator %q", ErrFilter, f.Op)
	}
}

func anyNested(groups [][]parsedFilter) bool {
	for _, g := range groups {
		for _, p := range g {
			if p.nested {
				return true
			}
		}
	}
	return false
}

// pushdownExpr folds AND-runs into an OR of ANDs.
func pushdownExpr(groups [][]parsedFilter) (iceberg.BooleanExpression, error) {
	ors := make([]iceberg.BooleanExpression, 0, len(groups))
	for _, g := range groups {
		ands := make([]iceberg.BooleanExpression, 0, len(g))
		for _, p := range g {
			e, err := buildOne(p)
			if err != nil {
				return nil, err
			}
			ands = append(ands, e)
		}
		ors = append(ors, foldAnd(ands))
	}
	return foldOr(ors), nil
}

func foldAnd(exprs []iceberg.BooleanExpression) iceberg.BooleanExpression {
	switch len(exprs) {
	case 0:
		return iceberg.AlwaysTrue{}
	case 1:
		return exprs[0]
	default:
		return iceberg.NewAnd(exprs[0], exprs[1], exprs[2:]...)
	}
}

func foldOr(exprs []iceberg.BooleanExpression) iceberg.BooleanExpression {
	switch len(exprs) {
	case 0:
		return iceberg.AlwaysTrue{}
	case 1:
		return exprs[0]
	default:
		return iceberg.NewOr(exprs[0], exprs[1], exprs[2:]...)
	}
}

func buildOne(p parsedFilter) (iceberg.BooleanExpression, error) {
	ref := iceberg.Reference(p.dto.Field)
	switch p.dto.Op {
	case "isnull":
		return iceberg.IsNull(ref), nil
	case "notnull":
		return iceberg.NotNull(ref), nil
	case "in", "notin":
		return buildSet(p, ref)
	default:
		return buildOrdered(p.field.Type, p.dto, ref)
	}
}

func buildOrdered(t iceberg.Type, f PreviewFilterDTO, ref iceberg.Reference) (iceberg.BooleanExpression, error) {
	switch tt := t.(type) {
	case iceberg.BooleanType:
		if f.Op != "eq" && f.Op != "neq" {
			return nil, fmt.Errorf("%w: operator %q not supported for boolean", ErrFilter, f.Op)
		}
		v, err := coerceBool(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.Int32Type:
		v, err := coerceInt32(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.Int64Type:
		v, err := coerceInt64(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.Float32Type:
		v, err := coerceFloat32(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.Float64Type:
		v, err := coerceFloat64(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.StringType:
		v, err := coerceString(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.DateType:
		v, err := coerceDate(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.TimestampType, iceberg.TimestampTzType:
		v, err := coerceTimestamp(f.Value)
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	case iceberg.DecimalType:
		v, err := coerceDecimal(f.Value, tt.Precision(), tt.Scale())
		if err != nil {
			return nil, err
		}
		return orderedPredicate(f.Op, ref, v)
	default:
		return nil, fmt.Errorf("%w: filter on type %s not supported", ErrFilter, t)
	}
}

// buildSet builds IsIn / NotIn. iceberg-go reduces a one-element set to
// EqualTo / NotEqualTo and an empty one to AlwaysFalse / AlwaysTrue; we reject
// the empty case in setValues instead, so "in" with nothing typed is an error
// the user can see rather than a filter that silently matches nothing.
func buildSet(p parsedFilter, ref iceberg.Reference) (iceberg.BooleanExpression, error) {
	raw, err := setValues(p.dto)
	if err != nil {
		return nil, err
	}
	notIn := p.dto.Op == "notin"
	switch tt := p.field.Type.(type) {
	case iceberg.BooleanType:
		return setPredicate(notIn, ref, raw, coerceBool)
	case iceberg.Int32Type:
		return setPredicate(notIn, ref, raw, coerceInt32)
	case iceberg.Int64Type:
		return setPredicate(notIn, ref, raw, coerceInt64)
	case iceberg.Float32Type:
		return setPredicate(notIn, ref, raw, coerceFloat32)
	case iceberg.Float64Type:
		return setPredicate(notIn, ref, raw, coerceFloat64)
	case iceberg.StringType:
		return setPredicate(notIn, ref, raw, coerceString)
	case iceberg.DateType:
		return setPredicate(notIn, ref, raw, coerceDate)
	case iceberg.TimestampType, iceberg.TimestampTzType:
		return setPredicate(notIn, ref, raw, coerceTimestamp)
	case iceberg.DecimalType:
		return setPredicate(notIn, ref, raw, func(v any) (iceberg.Decimal, error) {
			return coerceDecimal(v, tt.Precision(), tt.Scale())
		})
	default:
		return nil, fmt.Errorf("%w: filter on type %s not supported", ErrFilter, p.field.Type)
	}
}

func setPredicate[T iceberg.LiteralType](
	notIn bool,
	ref iceberg.Reference,
	raw []any,
	coerce func(any) (T, error),
) (iceberg.BooleanExpression, error) {
	vals := make([]T, 0, len(raw))
	for _, r := range raw {
		v, err := coerce(r)
		if err != nil {
			return nil, err
		}
		vals = append(vals, v)
	}
	if notIn {
		return iceberg.NotIn(ref, vals...), nil
	}
	return iceberg.IsIn(ref, vals...), nil
}

// setValues normalises the operand of an "in"/"notin" row. The UI sends a list
// in Values; a bare Value is accepted as a one-element list so a hand-built
// request still works.
func setValues(f PreviewFilterDTO) ([]any, error) {
	vals := f.Values
	if len(vals) == 0 && f.Value != nil {
		vals = []any{f.Value}
	}
	out := make([]any, 0, len(vals))
	for _, v := range vals {
		if s, ok := v.(string); ok && strings.TrimSpace(s) == "" {
			continue
		}
		out = append(out, v)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: operator %q needs at least one value", ErrFilter, f.Op)
	}
	return out, nil
}

func orderedPredicate[T iceberg.LiteralType](op string, ref iceberg.UnboundTerm, v T) (iceberg.BooleanExpression, error) {
	switch op {
	case "eq":
		return iceberg.EqualTo(ref, v), nil
	case "neq":
		return iceberg.NotEqualTo(ref, v), nil
	case "lt":
		return iceberg.LessThan(ref, v), nil
	case "lte":
		return iceberg.LessThanEqual(ref, v), nil
	case "gt":
		return iceberg.GreaterThan(ref, v), nil
	case "gte":
		return iceberg.GreaterThanEqual(ref, v), nil
	}
	return nil, fmt.Errorf("%w: unknown operator %q", ErrFilter, op)
}

func coerceString(v any) (string, error) {
	if v == nil {
		return "", fmt.Errorf("%w: value required", ErrFilter)
	}
	if s, ok := v.(string); ok {
		return s, nil
	}
	return fmt.Sprint(v), nil
}

func coerceBool(v any) (bool, error) {
	switch x := v.(type) {
	case bool:
		return x, nil
	case string:
		b, err := strconv.ParseBool(x)
		if err != nil {
			return false, fmt.Errorf("%w: invalid boolean %q", ErrFilter, x)
		}
		return b, nil
	}
	return false, fmt.Errorf("%w: invalid boolean %v", ErrFilter, v)
}

func coerceInt32(v any) (int32, error) {
	switch x := v.(type) {
	case string:
		n, err := strconv.ParseInt(x, 10, 32)
		if err != nil {
			return 0, fmt.Errorf("%w: invalid int %q", ErrFilter, x)
		}
		return int32(n), nil
	case float64:
		if x < -(1<<31) || x > (1<<31)-1 {
			return 0, fmt.Errorf("%w: int out of range %v", ErrFilter, x)
		}
		return int32(x), nil
	}
	return 0, fmt.Errorf("%w: invalid int %v", ErrFilter, v)
}

func coerceInt64(v any) (int64, error) {
	switch x := v.(type) {
	case string:
		n, err := strconv.ParseInt(x, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%w: invalid int %q", ErrFilter, x)
		}
		return n, nil
	case float64:
		return int64(x), nil
	}
	return 0, fmt.Errorf("%w: invalid int %v", ErrFilter, v)
}

func coerceFloat32(v any) (float32, error) {
	switch x := v.(type) {
	case string:
		n, err := strconv.ParseFloat(x, 32)
		if err != nil {
			return 0, fmt.Errorf("%w: invalid float %q", ErrFilter, x)
		}
		return float32(n), nil
	case float64:
		return float32(x), nil
	}
	return 0, fmt.Errorf("%w: invalid float %v", ErrFilter, v)
}

func coerceFloat64(v any) (float64, error) {
	switch x := v.(type) {
	case string:
		n, err := strconv.ParseFloat(x, 64)
		if err != nil {
			return 0, fmt.Errorf("%w: invalid float %q", ErrFilter, x)
		}
		return n, nil
	case float64:
		return x, nil
	}
	return 0, fmt.Errorf("%w: invalid float %v", ErrFilter, v)
}

func coerceDate(v any) (iceberg.Date, error) {
	s, err := coerceString(v)
	if err != nil {
		return 0, err
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return 0, fmt.Errorf("%w: invalid date %q (expected YYYY-MM-DD)", ErrFilter, s)
	}
	days := int32(t.Sub(epochUTC).Hours() / 24)
	return iceberg.Date(days), nil
}

func coerceTimestamp(v any) (iceberg.Timestamp, error) {
	s, err := coerceString(v)
	if err != nil {
		return 0, err
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return iceberg.Timestamp(t.UTC().UnixMicro()), nil
		}
	}
	return 0, fmt.Errorf("%w: invalid timestamp %q", ErrFilter, s)
}

func coerceDecimal(v any, precision, scale int) (iceberg.Decimal, error) {
	s, err := coerceString(v)
	if err != nil {
		return iceberg.Decimal{}, err
	}
	d, err := decimal128.FromString(s, int32(precision), int32(scale))
	if err != nil {
		return iceberg.Decimal{}, fmt.Errorf("%w: invalid decimal %q: %w", ErrFilter, s, err)
	}
	return iceberg.Decimal{Val: d, Scale: scale}, nil
}
