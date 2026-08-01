/**
 * Column ordering for the preview table.
 *
 * The sort is client-side and covers the rows currently loaded — Iceberg scans
 * come back in file order and there is no server-side ORDER BY to push into.
 * That is a real limit, not an oversight: sorting the 100 loaded rows of a
 * million-row table tells you about those 100 rows, and PreviewPanel says so
 * next to the control rather than letting the arrow imply otherwise.
 *
 * The comparator lives here, apart from the table, because what counts as
 * "in order" for a preview cell is the part worth pinning in tests.
 */

/**
 * Orders two cell values.
 *
 * Values are compared by what they are rather than by how they render:
 * numbers numerically, and numeric *strings* numerically too, because decimals
 * arrive as strings to keep their precision and "9" must not sort above "10".
 * ISO-8601 dates and timestamps compare correctly as plain text, which is why
 * they are deliberately not special-cased.
 *
 * Nulls are not handled here. They reach the table as `undefined` and the
 * column sets `sortUndefined: 'last'`, which TanStack applies before it
 * inverts for a descending sort — so nulls stay at the bottom whichever way
 * the column points, instead of filling the first screen on every desc sort.
 */
export function compareValues(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') return cmp(a, b);
    if (typeof a === 'boolean' && typeof b === 'boolean') return cmp(Number(a), Number(b));

    if (typeof a === 'string' && typeof b === 'string') {
        const na = numericValue(a);
        const nb = numericValue(b);
        if (na !== null && nb !== null) return cmp(na, nb);
        return a < b ? -1 : a > b ? 1 : 0;
    }

    if (a !== null && b !== null && (typeof a === 'object' || typeof b === 'object')) {
        // Structs, lists and maps have no meaningful order; keep it stable and
        // predictable rather than pretending otherwise.
        return cmpStr(JSON.stringify(a) ?? '', JSON.stringify(b) ?? '');
    }

    return cmpStr(String(a), String(b));
}

/**
 * Parses a string that is entirely a number, or returns null.
 *
 * Number('') is 0 and Number(' 12 ') is 12, neither of which is wanted, so the
 * shape is checked before the conversion.
 */
function numericValue(s: string): number | null {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function cmp(a: number, b: number): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function cmpStr(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A null cell has to reach the table as `undefined` for `sortUndefined` to see
 * it, but it still has to render as "null" rather than as a blank cell — which
 * renderCell handles by treating both the same way.
 */
export function sortableValue(v: unknown): unknown {
    return v === null ? undefined : v;
}

/** compareValues in the shape TanStack's `sortingFn` option expects. */
export function previewSortingFn(
    rowA: {getValue: (id: string) => unknown},
    rowB: {getValue: (id: string) => unknown},
    columnId: string,
): number {
    return compareValues(rowA.getValue(columnId), rowB.getValue(columnId));
}
