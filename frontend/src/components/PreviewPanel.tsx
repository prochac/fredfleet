import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
    type ColumnDef,
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    useReactTable,
} from '@tanstack/react-table';
import {CancelPreview, PreviewTable} from '../../wailsjs/go/main/App';
import {catalog} from '../../wailsjs/go/models';
import {PRIORITY, useCommand, useRunCommand} from '../shortcuts/registry';
import {errorMessage, toastError} from '../toast';
import {Pending} from './Pending';

type Props = {
    connName: string;
    namespace: string[];
    name: string;
};

const PAGE_SIZE_OPTIONS = [100, 250, 500] as const;
const DEFAULT_PAGE_SIZE = 100;

type Row = Record<string, unknown>;
type FilterEntry = {id: string; field: string; op: string; value: string};

const ORDERED_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'isnull', 'notnull'] as const;
const OP_LABELS: Record<string, string> = {
    eq: '=',
    neq: '≠',
    lt: '<',
    lte: '≤',
    gt: '>',
    gte: '≥',
    isnull: 'is null',
    notnull: 'not null',
};

function opsForColumn(col: catalog.PreviewColumnDTO): string[] {
    if (col.kind !== 'primitive') return [];
    if (col.typeText === 'boolean') return ['eq', 'neq', 'isnull', 'notnull'];
    if (col.typeText === 'binary') return [];
    return [...ORDERED_OPS];
}

function placeholderFor(typeText: string): string {
    if (typeText === 'date') return 'YYYY-MM-DD';
    if (typeText === 'timestamp' || typeText === 'timestamptz') return 'YYYY-MM-DDTHH:MM:SS';
    if (typeText === 'boolean') return 'true / false';
    return 'value';
}

/** Returns the debounced value plus a flush that adopts the latest one now. */
function useDebounced<T>(value: T, ms: number): [T, () => void] {
    const [v, setV] = useState(value);
    const latest = useRef(value);
    latest.current = value;
    useEffect(() => {
        const id = setTimeout(() => setV(value), ms);
        return () => clearTimeout(id);
    }, [value, ms]);
    // The pending timeout still fires afterwards, but it sets the same value,
    // so React bails out of the re-render.
    const flush = useCallback(() => setV(latest.current), []);
    return [v, flush];
}

function isEffective(f: FilterEntry): boolean {
    if (f.field === '' || f.op === '') return false;
    if (f.op === 'isnull' || f.op === 'notnull') return true;
    return f.value !== '';
}

function newFilter(): FilterEntry {
    return {id: crypto.randomUUID(), field: '', op: '', value: ''};
}

function toFilterList(filters: FilterEntry[]): catalog.PreviewFilterDTO[] {
    return filters.filter(isEffective).map((f) => ({
        field: f.field,
        op: f.op,
        value: f.op === 'isnull' || f.op === 'notnull' ? null : f.value,
    } as catalog.PreviewFilterDTO));
}

export function PreviewPanel({connName, namespace, name}: Props) {
    const [data, setData] = useState<catalog.PreviewRowsDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [filters, setFilters] = useState<FilterEntry[]>([]);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [pageIndex, setPageIndex] = useState(0);
    const [debouncedFilters, flushFilters] = useDebounced(filters, 300);
    const runCommand = useRunCommand();

    // Refs let onPageSizeChange-without-refetch and loadMore use the latest
    // values without making them part of the reset-effect dependency list.
    const inFlightReqIDRef = useRef<string | null>(null);
    const pageSizeRef = useRef(pageSize);
    pageSizeRef.current = pageSize;
    const filterListRef = useRef<catalog.PreviewFilterDTO[]>([]);
    const dataRef = useRef<catalog.PreviewRowsDTO | null>(null);
    dataRef.current = data;
    // Tracks the table the current `data` belongs to. We only null `data`
    // when the table identity actually changes — filter or page-size driven
    // refetches keep the previous rows visible so the filter UI stays usable
    // and an error doesn't strand the user with no way to recover.
    const lastTableKeyRef = useRef<string | null>(null);
    const filterBarRef = useRef<HTMLDivElement>(null);
    // Set when Mod+F had to create a filter row first; the row only exists in
    // the DOM after the next render, so the focus is deferred to an effect.
    const wantFilterFocusRef = useRef(false);

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

    // Reset-and-fetch: runs on table/connection/filter/manual-retry change, and
    // on page-size change that requires a refetch (signaled via reloadKey bump
    // in onPageSizeChange). Page-size itself is not in the deps so a shrink
    // doesn't fire a refetch.
    useEffect(() => {
        const reqID = crypto.randomUUID();
        const tableKey = `${connName}\x01${namespace.join('\x00')}\x01${name}`;
        const tableChanged = lastTableKeyRef.current !== tableKey;
        lastTableKeyRef.current = tableKey;
        const filterList = toFilterList(debouncedFilters);
        filterListRef.current = filterList;
        inFlightReqIDRef.current = reqID;
        setLoading(true);
        setError(null);
        if (tableChanged) {
            setData(null);
        }
        setPageIndex(0);
        const limit = pageSizeRef.current;
        let cancelled = false;
        PreviewTable(reqID, connName, namespace, name, 0, limit, filterList)
            .then((result) => {
                if (cancelled || inFlightReqIDRef.current !== reqID) return;
                inFlightReqIDRef.current = null;
                setData(result);
                setLoading(false);
            })
            .catch((e) => {
                if (cancelled || inFlightReqIDRef.current !== reqID) return;
                inFlightReqIDRef.current = null;
                if (tableChanged) {
                    setError(errorMessage(e));
                } else {
                    toastError(e, 'Failed to refresh preview');
                }
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
        JSON.stringify(toFilterList(debouncedFilters)),
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
        state: {pagination: {pageIndex, pageSize}},
        onPaginationChange: (updater) => {
            const next = typeof updater === 'function'
                ? updater({pageIndex, pageSize})
                : updater;
            setPageIndex(next.pageIndex);
            // pageSize changes flow through onPageSizeChange — ignore here.
        },
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
    });

    function onPageSizeChange(newSize: number) {
        if (newSize === pageSize) return;
        const buffered = dataRef.current?.rows.length ?? 0;
        if (dataRef.current && newSize <= buffered) {
            // Buffer already covers the new page size — re-paginate client-side.
            pageSizeRef.current = newSize;
            setPageSize(newSize);
            setPageIndex(0);
            return;
        }
        // Need more rows than the buffer holds: cancel any in-flight call and
        // re-issue with skip=0, limit=newSize. The reset effect picks up
        // pageSizeRef.current set below.
        if (inFlightReqIDRef.current) {
            CancelPreview(inFlightReqIDRef.current);
            inFlightReqIDRef.current = null;
        }
        pageSizeRef.current = newSize;
        setPageSize(newSize);
        setReloadKey((k) => k + 1);
    }

    async function loadMore() {
        const current = dataRef.current;
        if (!current || !current.hasMore || loadingMore) return;
        const reqID = crypto.randomUUID();
        inFlightReqIDRef.current = reqID;
        setLoadingMore(true);
        setError(null);
        try {
            const more = await PreviewTable(
                reqID,
                connName,
                namespace,
                name,
                current.rows.length,
                pageSizeRef.current,
                filterListRef.current,
            );
            if (inFlightReqIDRef.current !== reqID) return;
            inFlightReqIDRef.current = null;
            setData((prev) => {
                if (!prev) return more;
                const combinedRows = [...prev.rows, ...more.rows];
                return new catalog.PreviewRowsDTO({
                    columns: prev.columns,
                    rows: combinedRows,
                    rowCount: combinedRows.length,
                    // If the server returned zero new rows, treat as exhausted
                    // regardless of the reported flag (defensive against races).
                    hasMore: more.rows.length === 0 ? false : more.hasMore,
                });
            });
        } catch (e) {
            if (inFlightReqIDRef.current !== reqID) return;
            inFlightReqIDRef.current = null;
            toastError(e, 'Failed to load more rows');
        } finally {
            setLoadingMore(false);
        }
    }

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

    function focusFilterControl(which: 'first' | 'last') {
        const bar = filterBarRef.current;
        if (!bar) return;
        // The value <input> only exists once an op is chosen, so the field
        // <select> is always the right entry point into a row.
        const row = which === 'last' ? ':last-of-type' : ':first-of-type';
        bar.querySelector<HTMLSelectElement>(`.filter-bar-row${row} select.field`)?.focus();
    }

    useCommand(
        'focus.filter',
        () => {
            // This panel stays mounted but `hidden` on the other tabs, and
            // nothing inside a hidden subtree can take focus — switch first.
            runCommand('tab.preview');
            if (filters.length === 0) {
                addFilter();
                wantFilterFocusRef.current = true;
                return;
            }
            requestAnimationFrame(() => focusFilterControl('first'));
        },
        !!data,
    );

    useEffect(() => {
        if (!wantFilterFocusRef.current) return;
        wantFilterFocusRef.current = false;
        focusFilterControl('last');
    }, [filters.length]);

    useCommand(
        'refresh.scope',
        () => {
            if (inFlightReqIDRef.current) CancelPreview(inFlightReqIDRef.current);
            setReloadKey((k) => k + 1);
        },
        !!data,
        PRIORITY.TABLE,
    );
    useCommand('filters.applyNow', flushFilters, !!data);
    useCommand('filters.clear', clearFilters, !!data && filters.length > 0);

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

    const totalPages = table.getPageCount();
    const showPager = rows.length > 0;

    return (
        <div className="preview-panel">
            <div className="filter-bar" ref={filterBarRef}>
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
            {showPager && (
                <div className="pagination-bar">
                    <label className="page-size">
                        Rows
                        <select
                            value={pageSize}
                            onChange={(e) => onPageSizeChange(Number(e.target.value))}
                        >
                            {PAGE_SIZE_OPTIONS.map((n) => (
                                <option key={n} value={n}>{n}</option>
                            ))}
                        </select>
                    </label>
                    <div className="pager">
                        <button
                            type="button"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            ‹ Prev
                        </button>
                        <span className="page-indicator">
                            Page {pageIndex + 1} of {Math.max(1, totalPages)}
                        </span>
                        <button
                            type="button"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            Next ›
                        </button>
                    </div>
                    <span className="loaded-count">
                        Loaded {rows.length}{data.hasMore ? '+' : ''} rows
                    </span>
                    {data.hasMore && (
                        <button
                            type="button"
                            className="load-more"
                            onClick={loadMore}
                            disabled={loadingMore}
                        >
                            {loadingMore ? 'Loading…' : 'Load more'}
                        </button>
                    )}
                </div>
            )}
            {(loading || activeCount > 0) && (
                <div className="preview-status">
                    {activeCount > 0 && (
                        <span>
                            {activeCount} filter{activeCount === 1 ? '' : 's'} active
                        </span>
                    )}
                    {loading && <span className="muted">Loading…</span>}
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

