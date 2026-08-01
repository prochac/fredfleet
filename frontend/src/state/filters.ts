import {catalog} from '../../wailsjs/go/models';

/**
 * Filter-bar state, and the rules for turning it into what the backend wants.
 *
 * This lives outside PreviewPanel because three separate things need it: the
 * panel that renders the bar, the per-table store that keeps filters alive
 * across table switches, and the tests that pin the rules.
 */

export type FilterJoin = 'and' | 'or';

export type FilterEntry = {
    id: string;
    field: string;
    op: string;
    /** Raw text. For `in`/`notin` it is the comma-separated list. */
    value: string;
    /** How this row combines with the one above it. Ignored on the first row. */
    join: FilterJoin;
};

/** A column the filter bar can offer, including fields nested inside structs. */
export type FilterColumn = {
    /** Dotted path, e.g. "addr.city". This is what the backend binds against. */
    name: string;
    typeText: string;
    /** True for anything below the top level — the UI marks these. */
    nested: boolean;
};

const ORDERED_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const;
const SET_OPS = ['in', 'notin'] as const;
const NULL_OPS = ['isnull', 'notnull'] as const;

export const OP_LABELS: Record<string, string> = {
    eq: '=',
    neq: '≠',
    lt: '<',
    lte: '≤',
    gt: '>',
    gte: '≥',
    in: 'in',
    notin: 'not in',
    isnull: 'is null',
    notnull: 'not null',
};

export const JOIN_LABELS: Record<FilterJoin, string> = {and: 'and', or: 'or'};

/** Operators that take a comma-separated list rather than a single value. */
export function isSetOp(op: string): boolean {
    return op === 'in' || op === 'notin';
}

/** Operators that take no operand at all. */
export function isNullOp(op: string): boolean {
    return op === 'isnull' || op === 'notnull';
}

export function opsForColumn(col: FilterColumn | undefined): string[] {
    if (!col) return [];
    // Binary columns have no useful comparison in the UI, and `starts` is
    // rejected by the backend on every type (arrow-go has no starts_with
    // evaluator), so neither is offered.
    if (col.typeText === 'binary') return [];
    if (col.typeText === 'boolean') return ['eq', 'neq', ...SET_OPS, ...NULL_OPS];
    return [...ORDERED_OPS, ...SET_OPS, ...NULL_OPS];
}

/**
 * Flattens a table schema into the columns the filter bar can target.
 *
 * Struct fields are walked into and exposed under their dotted path, which is
 * what Iceberg binds against. Lists and maps are not: a predicate cannot
 * reference a field *through* a collection, and the schema DTO's synthetic
 * "element" / "key" / "value" children would be nonsense as filter targets.
 */
export function flattenFilterableColumns(schema: catalog.SchemaDTO | undefined): FilterColumn[] {
    const out: FilterColumn[] = [];
    const walk = (fields: catalog.FieldDTO[] | undefined, prefix: string[]) => {
        for (const f of fields ?? []) {
            const path = [...prefix, f.name];
            if (f.kind === 'primitive') {
                if (f.typeText === 'binary') continue;
                out.push({name: path.join('.'), typeText: f.typeText, nested: path.length > 1});
            } else if (f.kind === 'struct') {
                walk(f.children, path);
            }
            // list / map: not addressable by a predicate, so not offered.
        }
    };
    walk(schema?.fields, []);
    return out;
}

/**
 * Splits the operand of an `in`/`notin` row.
 *
 * Commas and newlines both separate, surrounding space is trimmed, and empty
 * entries are dropped — so a trailing comma while typing does not make the
 * filter invalid and refetch against a broken list.
 */
export function parseSetValues(raw: string): string[] {
    return raw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
}

/** Whether a row is complete enough to send. Incomplete rows are ignored. */
export function isEffective(f: FilterEntry): boolean {
    if (f.field === '' || f.op === '') return false;
    if (isNullOp(f.op)) return true;
    if (isSetOp(f.op)) return parseSetValues(f.value).length > 0;
    return f.value !== '';
}

export function newFilter(join: FilterJoin = 'and'): FilterEntry {
    return {id: crypto.randomUUID(), field: '', op: '', value: '', join};
}

/**
 * Converts the bar into the backend's filter list.
 *
 * Only effective rows are sent, and `join` is relative to the previous *sent*
 * row — an incomplete row between two others must not silently turn an OR into
 * an AND while the user is still typing it.
 */
export function toFilterList(filters: FilterEntry[]): catalog.PreviewFilterDTO[] {
    return filters.filter(isEffective).map((f, i) => {
        const dto: Record<string, unknown> = {field: f.field, op: f.op};
        if (i > 0) dto.join = f.join;
        if (isSetOp(f.op)) {
            dto.values = parseSetValues(f.value);
        } else if (!isNullOp(f.op)) {
            dto.value = f.value;
        }
        return dto as unknown as catalog.PreviewFilterDTO;
    });
}

/**
 * Drops rows a different table cannot answer.
 *
 * Filters persist across table switches, so they arrive at a table whose
 * schema may not have the column at all, or may have it at another type where
 * the chosen operator makes no sense. Both would come back from the backend as
 * an error the user did not ask for, so they are dropped here instead — and
 * the caller reports how many, rather than losing them silently.
 */
export function pruneFilters(
    filters: FilterEntry[],
    columns: FilterColumn[],
): {kept: FilterEntry[]; dropped: number} {
    const byName = new Map(columns.map((c) => [c.name, c]));
    const kept = filters.filter((f) => {
        if (f.field === '') return true; // still being filled in
        const col = byName.get(f.field);
        if (!col) return false;
        if (f.op === '') return true;
        return opsForColumn(col).includes(f.op);
    });
    // A surviving first row must not carry an "or" that now joins nothing.
    if (kept.length > 0 && kept[0].join === 'or') {
        kept[0] = {...kept[0], join: 'and'};
    }
    return {kept, dropped: filters.length - kept.length};
}

// --- persistence across table switches -------------------------------------

/**
 * Filters are remembered per table for the life of the session.
 *
 * A module-level map rather than localStorage on purpose: a filter is written
 * against a schema, and a schema can change between runs of the app, so
 * restoring one from a previous session risks handing the user a filter that
 * silently no longer means what they wrote. Within a session the schema is
 * whatever the catalog just served.
 */
const remembered = new Map<string, FilterEntry[]>();

export function tableKey(connName: string, namespace: string[], name: string): string {
    return [connName, namespace.join('\x00'), name].join('\x01');
}

export function rememberFilters(key: string, filters: FilterEntry[]): void {
    const effective = filters.filter((f) => f.field !== '' || f.op !== '' || f.value !== '');
    if (effective.length === 0) {
        remembered.delete(key);
        return;
    }
    remembered.set(key, effective);
}

export function recallFilters(key: string): FilterEntry[] {
    return remembered.get(key) ?? [];
}

/** Forgets every remembered filter for a connection. */
export function forgetConnectionFilters(connName: string): void {
    const prefix = connName + '\x01';
    for (const key of Array.from(remembered.keys())) {
        if (key.startsWith(prefix)) remembered.delete(key);
    }
}

/** Test seam — the store is module state and would otherwise leak between tests. */
export function clearRememberedFilters(): void {
    remembered.clear();
}
