import {useEffect, useMemo, useState} from 'react';
import {
    type ColumnDef,
    flexRender,
    getCoreRowModel,
    useReactTable,
} from '@tanstack/react-table';
import {CancelPreview, PreviewTable} from '../../wailsjs/go/main/App';
import {catalog} from '../../wailsjs/go/models';
import {Pending} from './Pending';

type Props = {
    connName: string;
    namespace: string[];
    name: string;
};

const PAGE_SIZE = 100;

type Row = Record<string, unknown>;
type FilterEntry = {id: string; field: string; op: string; value: string};

const TEXT_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'isnull', 'notnull'] as const;
const OP_LABELS: Record<string, string> = {
    eq: '=',
    neq: '≠',
    lt: '<',
    lte: '≤',
    gt: '>',
    gte: '≥',
    isnull: 'is null',
    notnull: 'not null',
    starts: 'starts with',
};

function opsForColumn(col: catalog.PreviewColumnDTO): string[] {
    if (col.kind !== 'primitive') return [];
    if (col.typeText === 'string') return [...TEXT_OPS, 'starts'];
    if (col.typeText === 'boolean') return ['eq', 'neq', 'isnull', 'notnull'];
    if (col.typeText === 'binary') return [];
    return [...TEXT_OPS];
}

function placeholderFor(typeText: string): string {
    if (typeText === 'date') return 'YYYY-MM-DD';
    if (typeText === 'timestamp' || typeText === 'timestamptz') return 'YYYY-MM-DDTHH:MM:SS';
    if (typeText === 'boolean') return 'true / false';
    return 'value';
}

function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const id = setTimeout(() => setV(value), ms);
        return () => clearTimeout(id);
    }, [value, ms]);
    return v;
}

function isEffective(f: FilterEntry): boolean {
    if (f.field === '' || f.op === '') return false;
    if (f.op === 'isnull' || f.op === 'notnull') return true;
    return f.value !== '';
}

function newFilter(): FilterEntry {
    return {id: crypto.randomUUID(), field: '', op: '', value: ''};
}

export function PreviewPanel({connName, namespace, name}: Props) {
    const [data, setData] = useState<catalog.PreviewRowsDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [filters, setFilters] = useState<FilterEntry[]>([]);
    const debouncedFilters = useDebounced(filters, 300);

    const columnsByName = useMemo(() => {
        const out: Record<string, catalog.PreviewColumnDTO> = {};
        for (const c of data?.columns ?? []) out[c.name] = c;
        return out;
    }, [data?.columns]);

    const filterableColumns = useMemo(
        () =>
            (data?.columns ?? []).filter(
                (c) => c.kind === 'primitive' && c.typeText !== 'binary',
            ),
        [data?.columns],
    );

    useEffect(() => {
        const reqID = crypto.randomUUID();
        let cancelled = false;
        setLoading(true);
        setError(null);
        const filterList: catalog.PreviewFilterDTO[] = debouncedFilters
            .filter(isEffective)
            .map((f) => ({
                field: f.field,
                op: f.op,
                value: f.op === 'isnull' || f.op === 'notnull' ? null : f.value,
            } as catalog.PreviewFilterDTO));
        PreviewTable(reqID, connName, namespace, name, PAGE_SIZE, filterList)
            .then((result) => {
                if (cancelled) return;
                setData(result);
                setLoading(false);
            })
            .catch((e) => {
                if (cancelled) return;
                setError(errorMessage(e));
                setLoading(false);
            });
        return () => {
            cancelled = true;
            CancelPreview(reqID);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        connName,
        namespace.join('\x00'),
        name,
        reloadKey,
        JSON.stringify(debouncedFilters.filter(isEffective)),
    ]);

    const columns = useMemo<ColumnDef<Row>[]>(
        () =>
            (data?.columns ?? []).map((c) => ({
                id: c.name,
                header: c.name,
                accessorFn: (row) => row[c.name],
                cell: (info) => renderCell(info.getValue()),
            })),
        [data?.columns],
    );

    const rows = useMemo<Row[]>(() => (data?.rows ?? []) as Row[], [data?.rows]);

    const table = useReactTable({
        data: rows,
        columns,
        getCoreRowModel: getCoreRowModel(),
    });

    const activeCount = filters.filter(isEffective).length;
    const clearFilters = () => setFilters([]);

    function patchFilter(id: string, patch: Partial<FilterEntry>) {
        setFilters((prev) => prev.map((f) => (f.id === id ? {...f, ...patch} : f)));
    }
    function removeFilter(id: string) {
        setFilters((prev) => prev.filter((f) => f.id !== id));
    }
    function addFilter() {
        setFilters((prev) => [...prev, newFilter()]);
    }

    if (!data) {
        return (
            <Pending
                loading={loading}
                error={error}
                onRetry={() => setReloadKey((k) => k + 1)}
            >
                {null}
            </Pending>
        );
    }

    return (
        <div className="preview-panel">
            <div className="filter-bar">
                {filters.map((f) => {
                    const col = f.field ? columnsByName[f.field] : undefined;
                    const ops = col ? opsForColumn(col) : [];
                    const showValue = f.op !== '' && f.op !== 'isnull' && f.op !== 'notnull';
                    return (
                        <div key={f.id} className="filter-bar-row">
                            <select
                                className="field"
                                value={f.field}
                                onChange={(e) => patchFilter(f.id, {field: e.target.value, op: '', value: ''})}
                            >
                                <option value="">Pick column…</option>
                                {filterableColumns.map((c) => (
                                    <option key={c.name} value={c.name}>
                                        {c.name} ({c.typeText})
                                    </option>
                                ))}
                            </select>
                            <select
                                className="op"
                                value={f.op}
                                disabled={!col}
                                onChange={(e) => patchFilter(f.id, {op: e.target.value})}
                            >
                                <option value="">{col ? 'Pick op…' : '—'}</option>
                                {ops.map((op) => (
                                    <option key={op} value={op}>
                                        {OP_LABELS[op] ?? op}
                                    </option>
                                ))}
                            </select>
                            {showValue ? (
                                <input
                                    className="value"
                                    value={f.value}
                                    placeholder={col ? placeholderFor(col.typeText) : 'value'}
                                    onChange={(e) => patchFilter(f.id, {value: e.target.value})}
                                    autoFocus
                                />
                            ) : (
                                <span className="value-placeholder" />
                            )}
                            <button
                                type="button"
                                className="remove"
                                aria-label="Remove filter"
                                onClick={() => removeFilter(f.id)}
                            >
                                ×
                            </button>
                        </div>
                    );
                })}
                <div className="filter-bar-actions">
                    <button type="button" onClick={addFilter}>
                        + Add filter
                    </button>
                    {filters.length > 0 && (
                        <button type="button" onClick={clearFilters}>
                            Clear all
                        </button>
                    )}
                </div>
            </div>
            {(loading || error || activeCount > 0) && (
                <div className="preview-status">
                    {activeCount > 0 && (
                        <span>
                            {activeCount} filter{activeCount === 1 ? '' : 's'} active
                        </span>
                    )}
                    {loading && <span className="muted">Loading…</span>}
                    {error && <span className="error-inline" role="alert">{error}</span>}
                </div>
            )}
            <div className="preview-table-wrap">
                <table className="preview-table">
                    <thead>
                        {table.getHeaderGroups().map((hg) => (
                            <tr key={hg.id}>
                                {hg.headers.map((h) => (
                                    <th key={h.id}>
                                        {h.isPlaceholder
                                            ? null
                                            : flexRender(h.column.columnDef.header, h.getContext())}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {table.getRowModel().rows.map((r) => (
                            <tr key={r.id}>
                                {r.getVisibleCells().map((cell) => (
                                    <td key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
                {!loading && !error && rows.length === 0 && (
                    <div className="preview-empty">
                        {activeCount > 0 ? (
                            <>
                                <p>No rows match the current filters.</p>
                                <button type="button" onClick={clearFilters}>
                                    Clear all
                                </button>
                            </>
                        ) : (
                            <p>No data files in this table.</p>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function renderCell(value: unknown) {
    if (value === null || value === undefined) {
        return <span className="null">null</span>;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}
