import {describe, expect, it} from 'vitest';
import {type SortingState, constructTable} from '@tanstack/react-table';
// useTable supplies React's reactivity; outside React, constructTable needs the
// store-based one. table-core comes in with react-table at the exact same
// version, so it is not a separate dependency.
import {storeReactivityBindings} from '@tanstack/table-core/store-reactivity-bindings';
import {type PreviewRow, previewColumn, previewFeatures} from './previewTable';

function tableOf(rows: PreviewRow[], sorting: SortingState = []) {
    const names = Object.keys(rows.find((r) => Object.keys(r).length) ?? {});
    return constructTable({
        features: {...previewFeatures, coreReactivityFeature: storeReactivityBindings()} as typeof previewFeatures,
        data: rows,
        columns: names.map((n) => previewColumn(n, (info) => info.getValue())),
        state: {sorting, pagination: {pageIndex: 0, pageSize: 100}},
        onSortingChange: () => {},
        onPaginationChange: () => {},
    });
}

function column(rows: PreviewRow[], sorting: SortingState): unknown[] {
    const id = sorting[0].id;
    return tableOf(rows, sorting)
        .getSortedRowModel()
        .rows.map((r) => r.original[id]);
}

describe('previewColumn', () => {
    it('sorts decimal strings numerically, so the custom sortFn is wired', () => {
        // TanStack's own text sort would put "10" before "9".
        const rows = [{d: '10'}, {d: '9'}, {d: '100.5'}];
        expect(column(rows, [{id: 'd', desc: false}])).toEqual(['9', '10', '100.5']);
    });

    it('keeps nulls last in both directions', () => {
        const rows = [{n: null}, {n: 2}, {n: 1}, {n: null}, {n: 3}];
        expect(column(rows, [{id: 'n', desc: false}])).toEqual([1, 2, 3, null, null]);
        expect(column(rows, [{id: 'n', desc: true}])).toEqual([3, 2, 1, null, null]);
    });

    it('sorts ascending on the first click whatever the values are', () => {
        // Left to itself TanStack starts numbers descending and strings
        // ascending, judged from the first non-null rows.
        const rows = [{n: null, s: null}, {n: 1, s: 'b'}, {n: 2, s: 'a'}];
        const t = tableOf(rows);
        expect(t.getColumn('n')?.getFirstSortDir()).toBe('asc');
        expect(t.getColumn('s')?.getFirstSortDir()).toBe('asc');
    });
});
