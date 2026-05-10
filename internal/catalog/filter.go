package catalog

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/apache/arrow-go/v18/arrow/decimal128"
	"github.com/apache/iceberg-go"
)

// ErrFilter wraps any user-facing error from BuildRowFilter so MapError can
// surface the wrapped message verbatim.
var ErrFilter = errors.New("filter")

var epochUTC = time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)

// BuildRowFilter translates the UI filter list into an iceberg expression
// bound against schema. An empty list returns AlwaysTrue, which
// table.WithRowFilter no-ops on. Every error returned wraps ErrFilter.
func BuildRowFilter(schema *iceberg.Schema, filters []PreviewFilterDTO) (iceberg.BooleanExpression, error) {
	if len(filters) == 0 {
		return iceberg.AlwaysTrue{}, nil
	}
	exprs := make([]iceberg.BooleanExpression, 0, len(filters))
	for _, f := range filters {
		e, err := buildOne(schema, f)
		if err != nil {
			return nil, err
		}
		exprs = append(exprs, e)
	}
	var expr iceberg.BooleanExpression
	if len(exprs) == 1 {
		expr = exprs[0]
	} else {
		expr = iceberg.NewAnd(exprs[0], exprs[1], exprs[2:]...)
	}
	// Trial-bind for early validation, then return the unbound tree.
	// iceberg-go's scanner re-binds rowFilter unconditionally
	// (table/scanner.go:510) and panics on already-bound predicates
	// (visitors.go:183). Handing it bound input crashes the process under
	// Wails/WebKit, where the WebKit-installed SIGSEGV handler is not
	// SA_ONSTACK-safe and Go cannot route the panic through its signal stack.
	if _, err := iceberg.BindExpr(schema, expr, true); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrFilter, err)
	}
	return expr, nil
}

func buildOne(schema *iceberg.Schema, f PreviewFilterDTO) (iceberg.BooleanExpression, error) {
	nf, ok := schema.FindFieldByName(f.Field)
	if !ok {
		return nil, fmt.Errorf("%w: unknown column %q", ErrFilter, f.Field)
	}
	if _, ok := nf.Type.(iceberg.PrimitiveType); !ok {
		return nil, fmt.Errorf("%w: column %q is not a primitive", ErrFilter, f.Field)
	}
	ref := iceberg.Reference(f.Field)
	switch f.Op {
	case "isnull":
		return iceberg.IsNull(ref), nil
	case "notnull":
		return iceberg.NotNull(ref), nil
	case "starts":
		if _, ok := nf.Type.(iceberg.StringType); !ok {
			return nil, fmt.Errorf("%w: operator %q only supports string, got %s", ErrFilter, f.Op, nf.Type)
		}
		s, err := coerceString(f.Value)
		if err != nil {
			return nil, err
		}
		return iceberg.StartsWith(ref, s), nil
	case "eq", "neq", "lt", "lte", "gt", "gte":
		return buildOrdered(nf.Type, f, ref)
	default:
		return nil, fmt.Errorf("%w: unknown operator %q", ErrFilter, f.Op)
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
		return iceberg.Decimal{}, fmt.Errorf("%w: invalid decimal %q: %s", ErrFilter, s, err)
	}
	return iceberg.Decimal{Val: d, Scale: scale}, nil
}
