import {
    type CellContext,
    type ColumnDef,
    createPaginatedRowModel,
    createSortedRowModel,
    rowPaginationFeature,
    rowSortingFeature,
    tableFeatures,
} from '@tanstack/react-table';
import {previewSortingFn, sortableValue} from './sort';

/**
 * TanStack wiring for the preview table, apart from the component so the
 * column options can be tested without a DOM.
 */

export type PreviewRow = Record<string, unknown>;

// Module-level on purpose: TanStack v9 wants the features object stable across
// renders. Sorting and pagination are client-side over the loaded buffer; the
// core row model is built in.
export const previewFeatures = tableFeatures({
    rowSortingFeature,
    rowPaginationFeature,
    sortedRowModel: createSortedRowModel(),
    paginatedRowModel: createPaginatedRowModel(),
});

export type PreviewColumnDef = ColumnDef<typeof previewFeatures, PreviewRow>;

/**
 * One preview column.
 *
 * The return type is annotated so the object literal gets an excess-property
 * check: a misspelt or renamed option (v8's `sortingFn`) is a type error
 * rather than an option TanStack silently ignores.
 */
export function previewColumn(
    name: string,
    cell: (info: CellContext<typeof previewFeatures, PreviewRow, unknown>) => unknown,
): PreviewColumnDef {
    return {
        id: name,
        header: name,
        // A null arrives as `undefined` so the column's sortUndefined can keep
        // nulls last in both directions; renderCell shows both the same way.
        accessorFn: (row) => sortableValue(row[name]),
        cell,
        sortFn: previewSortingFn,
        sortUndefined: 'last',
        // The README promises ascending first. Without this TanStack guesses
        // from the first non-null values: strings ascending, anything else
        // descending.
        sortDescFirst: false,
    };
}
