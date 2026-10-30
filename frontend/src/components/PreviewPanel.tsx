import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {type SortingState, flexRender, useTable} from '@tanstack/react-table';
import {CancelRequest, ExportPreview, PreviewTable} from '../../wailsjs/go/main/App';
import {catalog} from '../../wailsjs/go/models';
import {useDebounced} from '../hooks/useDebounced';
import {useVirtualRows} from '../hooks/useVirtualRows';
import {pageSizePlan} from '../state/pageSize';
import {
    flattenFilterableColumns,
    isNullOp,
    isSetOp,
    JOIN_LABELS,
    newFilter,
    OP_LABELS,
    opsForColumn,
    isEffective,
    pruneFilters,
    recallFilters,
    rememberFilters,
    tableKey,
    toFilterList,
    type FilterEntry,
    type FilterJoin,
} from '../state/filters';
import {type PreviewColumnDef, type PreviewRow as Row, previewColumn, previewFeatures} from '../state/previewTable';
import {shouldVirtualize} from '../state/virtual';
import {PRIORITY, useCommand, useRunCommand} from '../shortcuts/registry';
import {errorMessage, toastError, toastInfo} from '../toast';
import {Pending} from './Pending';

type Props = {
    connName: string;
    namespace: string[];
    name: string;
    /**
     * The table's schema, which is where nested columns come from — the scan's
     * own column list only describes the top level.
     */
    schema?: catalog.SchemaDTO;
};

const PAGE_SIZE_OPTIONS = [100, 250, 500] as const;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Row height, in px, applied inline so the windowing maths and the rendered
 * rows cannot drift apart the way a JS constant and a CSS rule would.
 */
const ROW_HEIGHT = 29;

function placeholderFor(typeText: string, op: string): string {
    if (isSetOp(op)) return 'comma-separated values';
    if (typeText === 'date') return 'YYYY-MM-DD';
    if (typeText === 'timestamp' || typeText === 'timestamptz') return 'YYYY-MM-DDTHH:MM:SS';
    if (typeText === 'boolean') return 'true / false';
    return 'value';
}

export function PreviewPanel({connName, namespace, name, schema}: Props) {
    const [data, setData] = useState<catalog.PreviewRowsDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [sorting, setSorting] = useState<SortingState>([]);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [pageIndex, setPageIndex] = useState(0);
    const runCommand = useRunCommand();

    const currentKey = tableKey(connName, namespace, name);

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
    const scrollRef = useRef<HTMLDivElement>(null);
    // Set when Mod+F had to create a filter row first; the row only exists in
    // the DOM after the next render, so the focus is deferred to an effect.
    const wantFilterFocusRef = useRef(false);

    const filterableColumns = useMemo(() => flattenFilterableColumns(schema), [schema]);
    const columnsByName = useMemo(
        () => new Map(filterableColumns.map((c) => [c.name, c])),
        [filterableColumns],
    );

    /**
     * Filters follow the user from table to table, minus the ones the new
     * schema cannot answer.
     *
     * Restoring happens during render rather than in an effect because the
     * fetch effect below runs in the same commit: restoring afterwards would
     * fire one request carrying the *previous* table's filters, which the new
     * table would reject.
     */
    const [filterState, setFilterState] = useState(() => restoreFor(currentKey, filterableColumns));
    if (filterState.key !== currentKey) {
        setFilterState(restoreFor(currentKey, filterableColumns));
    }
    const filters = filterState.entries;
    const setFilters = useCallback(
        (update: FilterEntry[] | ((prev: FilterEntry[]) => FilterEntry[])) => {
            setFilterState((s) => ({
                key: s.key,
                dropped: 0, // an edit supersedes whatever the restore reported
                entries: typeof update === 'function' ? update(s.entries) : update,
            }));
        },
        [],
    );

    const [debouncedFilters, flushFilters] = useDebounced(filters, 300, currentKey);

    // Reporting the drop is a side effect, so it waits for the commit.
    useEffect(() => {
        const n = filterState.dropped;
        if (n === 0) return;
        toastInfo(
            `${n} filter${n === 1 ? '' : 's'} dropped — ` +
                `${n === 1 ? 'its column is' : 'their columns are'} not in this table`,
        );
    }, [filterState.key, filterState.dropped]);

    useEffect(() => {
        rememberFilters(currentKey, filters);
    }, [currentKey, filters]);

    // Reset-and-fetch: runs on table/connection/filter/manual-retry change, and
    // on page-size change that requires a refetch (signaled via reloadKey bump
    // in onPageSizeChange). Page-size itself is not in the deps so a shrink
    // doesn't fire a refetch.
    useEffect(() => {
        const reqID = crypto.randomUUID();
        const tableChanged = lastTableKeyRef.current !== currentKey;
        lastTableKeyRef.current = currentKey;
        const filterList = toFilterList(debouncedFilters);
        filterListRef.current = filterList;
        inFlightReqIDRef.current = reqID;
        setLoading(true);
        setError(null);
        if (tableChanged) {
            setData(null);
            setSorting([]);
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
            CancelRequest(reqID);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        connName,
        namespace.join('\x00'),
        name,
        reloadKey,
        JSON.stringify(toFilterList(debouncedFilters)),
    ]);

    const allRows = useMemo<Row[]>(() => (data?.rows ?? []) as Row[], [data?.rows]);

    const columns = useMemo<PreviewColumnDef[]>(
        () => (data?.columns ?? []).map((c) => previewColumn(c.name, (info) => renderCell(info.getValue()))),
        [data?.columns],
    );

    const table = useTable({
        features: previewFeatures,
        data: allRows,
        columns,
        state: {sorting, pagination: {pageIndex, pageSize}},
        onSortingChange: (updater) => {
            setSorting(typeof updater === 'function' ? updater(sorting) : updater);
            // A re-sort reorders the whole buffer, so the page the user was on
            // no longer holds the rows they were looking at. Start over.
            setPageIndex(0);
        },
        onPaginationChange: (updater) => {
            const next =
                typeof updater === 'function' ? updater({pageIndex, pageSize}) : updater;
            setPageIndex(next.pageIndex);
            // pageSize changes flow through onPageSizeChange — ignore here.
        },
    });

    const pageRows = table.getRowModel().rows;
    const virtualize = shouldVirtualize(pageRows.length);
    const win = useVirtualRows(scrollRef, pageRows.length, ROW_HEIGHT, virtualize);

    function onPageSizeChange(newSize: number) {
        const buffered = dataRef.current?.rows.length ?? 0;
        const plan = pageSizePlan(newSize, pageSize, buffered);
        if (plan === null) return;
        if (plan.kind === 'slice') {
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
            CancelRequest(inFlightReqIDRef.current);
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

    /**
     * Exports rows matching the active filters. The backend re-scans rather
     * than serialising what is loaded here, so `all` is not limited to the
     * pages already fetched — and neither export reflects the client-side
     * sort, which only orders the loaded buffer.
     */
    async function exportRows(format: 'csv' | 'json', scope: 'loaded' | 'all') {
        if (exporting) return;
        const reqID = crypto.randomUUID();
        setExporting(true);
        try {
            const maxRows = scope === 'loaded' ? (dataRef.current?.rows.length ?? 0) : 0;
            const path = await ExportPreview(
                reqID,
                connName,
                namespace,
                name,
                format,
                filterListRef.current,
                maxRows,
            );
            // An empty path means the user dismissed the save dialog, which is
            // not something to report back at them.
            if (path) toastInfo(`Exported to ${path}`);
        } catch (e) {
            toastError(e, 'Export failed');
        } finally {
            setExporting(false);
        }
    }

    const activeCount = filters.filter(isEffective).length;
    const clearFilters = useCallback(() => setFilters([]), []);

    function patchFilter(id: string, patch: Partial<FilterEntry>) {
        setFilters((prev) => prev.map((f) => (f.id === id ? {...f, ...patch} : f)));
    }
    function removeFilter(id: string) {
        setFilters((prev) => {
            const next = prev.filter((f) => f.id !== id);
            // The row that is now first must not lead with "or".
            if (next.length > 0 && next[0].join === 'or') {
                next[0] = {...next[0], join: 'and'};
            }
            return next;
        });
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
            if (inFlightReqIDRef.current) CancelRequest(inFlightReqIDRef.current);
            setReloadKey((k) => k + 1);
        },
        !!data,
        PRIORITY.TABLE,
    );
    useCommand('filters.applyNow', flushFilters, !!data);
    useCommand('filters.clear', clearFilters, !!data && filters.length > 0);
    useCommand('filters.add', addFilter, !!data);
    useCommand('sort.clear', () => setSorting([]), !!data && sorting.length > 0);
    useCommand('export.csv', () => exportRows('csv', 'loaded'), !!data);
    useCommand('export.json', () => exportRows('json', 'loaded'), !!data);

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

    const showPager = allRows.length > 0;
    const loadedCount = allRows.length;
    const totalPages = Math.max(1, table.getPageCount());
    const activeSort = sorting[0];

    return (
        <div className="preview-panel">
            <div className="filter-bar" ref={filterBarRef}>
                {filters.map((f, i) => {
                    const col = f.field ? columnsByName.get(f.field) : undefined;
                    const ops = opsForColumn(col);
                    const showValue = f.op !== '' && !isNullOp(f.op);
                    return (
                        <div key={f.id} className="filter-bar-row">
                            {i === 0 ? (
                                <span className="filter-join-lead">Where</span>
                            ) : (
                                <select
                                    className="join"
                                    aria-label="Combine with the filter above"
                                    value={f.join}
                                    onChange={(e) =>
                                        patchFilter(f.id, {join: e.target.value as FilterJoin})
                                    }
                                >
                                    {(['and', 'or'] as FilterJoin[]).map((j) => (
                                        <option key={j} value={j}>
                                            {JOIN_LABELS[j]}
                                        </option>
                                    ))}
                                </select>
                            )}
                            <select
                                className="field"
                                value={f.field}
                                onChange={(e) =>
                                    patchFilter(f.id, {field: e.target.value, op: '', value: ''})
                                }
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
                                    placeholder={
                                        col ? placeholderFor(col.typeText, f.op) : 'value'
                                    }
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
                    <span className="filter-bar-spacer" />
                    <ExportMenu
                        disabled={exporting}
                        loadedCount={loadedCount}
                        hasMore={data.hasMore}
                        onExport={exportRows}
                    />
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
                            Page {pageIndex + 1} of {totalPages}
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
                        Loaded {loadedCount}{data.hasMore ? '+' : ''} rows
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
            {(loading || activeCount > 0 || activeSort) && (
                <div className="preview-status">
                    {activeCount > 0 && (
                        <span>
                            {activeCount} filter{activeCount === 1 ? '' : 's'} active
                        </span>
                    )}
                    {activeSort && (
                        // Say plainly what the sort covers. Ordering only the
                        // rows fetched so far is the honest limit of a
                        // client-side sort over a paged scan, and an arrow in
                        // a header would otherwise imply the whole table.
                        <span className="sort-note">
                            Sorted by {activeSort.id} ({activeSort.desc ? 'desc' : 'asc'}) —{' '}
                            {data.hasMore
                                ? `within the ${loadedCount} rows loaded so far`
                                : 'all rows'}
                            <button
                                type="button"
                                className="linkish"
                                onClick={() => setSorting([])}
                            >
                                clear
                            </button>
                        </span>
                    )}
                    {loading && <span className="muted">Loading…</span>}
                </div>
            )}
            <div className="preview-table-wrap" ref={scrollRef}>
                <table className="preview-table">
                    <thead>
                        {table.getHeaderGroups().map((hg) => (
                            <tr key={hg.id}>
                                {hg.headers.map((h) => {
                                    const dir = h.column.getIsSorted();
                                    return (
                                        <th
                                            key={h.id}
                                            aria-sort={
                                                dir === 'asc'
                                                    ? 'ascending'
                                                    : dir === 'desc'
                                                      ? 'descending'
                                                      : 'none'
                                            }
                                        >
                                            {h.isPlaceholder ? null : (
                                                <button
                                                    type="button"
                                                    className={
                                                        'sort-header' + (dir ? ' active' : '')
                                                    }
                                                    onClick={h.column.getToggleSortingHandler()}
                                                    title={`Sort by ${h.column.id} (loaded rows only)`}
                                                >
                                                    {flexRender(
                                                        h.column.columnDef.header,
                                                        h.getContext(),
                                                    )}
                                                    <span className="sort-arrow" aria-hidden="true">
                                                        {dir === 'asc'
                                                            ? '▲'
                                                            : dir === 'desc'
                                                              ? '▼'
                                                              : '↕'}
                                                    </span>
                                                </button>
                                            )}
                                        </th>
                                    );
                                })}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {win.padTop > 0 && (
                            <tr aria-hidden="true" className="virtual-spacer">
                                <td colSpan={data.columns.length} style={{height: win.padTop}} />
                            </tr>
                        )}
                        {pageRows.slice(win.start, win.end).map((r) => (
                            <tr key={r.id} style={{height: ROW_HEIGHT}}>
                                {r.getAllCells().map((cell) => (
                                    <td key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        ))}
                        {win.padBottom > 0 && (
                            <tr aria-hidden="true" className="virtual-spacer">
                                <td colSpan={data.columns.length} style={{height: win.padBottom}} />
                            </tr>
                        )}
                    </tbody>
                </table>
                {!loading && !error && allRows.length === 0 && (
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

/**
 * Export controls. Four combinations of format and scope would be four
 * buttons, so they collapse into a <select> that fires on choice and resets —
 * it is an action list, not a setting, and nothing should look "selected"
 * afterwards.
 */
function ExportMenu({
    disabled,
    loadedCount,
    hasMore,
    onExport,
}: {
    disabled: boolean;
    loadedCount: number;
    hasMore: boolean;
    onExport: (format: 'csv' | 'json', scope: 'loaded' | 'all') => void;
}) {
    return (
        <label className="export-menu">
            <select
                value=""
                disabled={disabled || loadedCount === 0}
                aria-label="Export rows"
                onChange={(e) => {
                    const v = e.target.value;
                    e.target.value = '';
                    if (!v) return;
                    const [format, scope] = v.split(':') as ['csv' | 'json', 'loaded' | 'all'];
                    onExport(format, scope);
                }}
            >
                <option value="">{disabled ? 'Exporting…' : 'Export…'}</option>
                <option value="csv:loaded">CSV — {loadedCount} loaded rows</option>
                <option value="json:loaded">JSON — {loadedCount} loaded rows</option>
                {hasMore && <option value="csv:all">CSV — all matching rows</option>}
                {hasMore && <option value="json:all">JSON — all matching rows</option>}
            </select>
        </label>
    );
}

/**
 * The remembered filters for a table, minus any the table cannot answer, plus
 * how many were dropped so the user is told rather than left wondering.
 */
function restoreFor(
    key: string,
    columns: ReturnType<typeof flattenFilterableColumns>,
): {key: string; entries: FilterEntry[]; dropped: number} {
    const recalled = recallFilters(key);
    if (recalled.length === 0) return {key, entries: [], dropped: 0};
    const {kept, dropped} = pruneFilters(recalled, columns);
    return {key, entries: kept, dropped};
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
