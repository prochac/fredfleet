/**
 * Row virtualization for the preview table.
 *
 * Hand-rolled rather than pulled from a library: the table is a fixed-row-height
 * list in a single scroller, which is the one case windowing is trivial for,
 * and the project's TypeScript is pinned at 4.6 (see CLAUDE.md), which cannot
 * parse the .d.ts files shipped by current virtualizer packages.
 *
 * The maths lives here, apart from React, so it can be tested directly — every
 * off-by-one in a windowed list shows up as rows that flicker or go missing
 * while scrolling, which is miserable to catch by eye.
 */

export type RowWindow = {
    /** First rendered row, inclusive. */
    start: number;
    /** Last rendered row, exclusive. */
    end: number;
    /** Filler height standing in for the rows above `start`. */
    padTop: number;
    /** Filler height standing in for the rows below `end`. */
    padBottom: number;
};

export type WindowInput = {
    scrollTop: number;
    viewportHeight: number;
    rowHeight: number;
    rowCount: number;
    /** Rows rendered beyond each edge, so a fast scroll doesn't show gaps. */
    overscan?: number;
};

const DEFAULT_OVERSCAN = 8;

export function windowRange({
    scrollTop,
    viewportHeight,
    rowHeight,
    rowCount,
    overscan = DEFAULT_OVERSCAN,
}: WindowInput): RowWindow {
    if (rowCount <= 0 || rowHeight <= 0) {
        return {start: 0, end: 0, padTop: 0, padBottom: 0};
    }

    // A viewport height of 0 means the container has not been measured yet
    // (first paint, or a hidden tab). Render the overscan rather than nothing,
    // so the table is never briefly empty.
    const usableHeight = viewportHeight > 0 ? viewportHeight : 0;
    const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
    const visibleCount = Math.ceil(usableHeight / rowHeight) + 1;

    const start = Math.max(0, firstVisible - overscan);
    const end = Math.min(rowCount, firstVisible + visibleCount + overscan);

    return {
        start,
        end,
        padTop: start * rowHeight,
        padBottom: Math.max(0, (rowCount - end) * rowHeight),
    };
}

/**
 * Whether a list is worth windowing at all.
 *
 * Below the threshold the spacer rows and scroll bookkeeping cost more than
 * they save, and plain rows keep find-in-page and text selection working
 * across the whole table.
 */
export const VIRTUALIZE_THRESHOLD = 150;

export function shouldVirtualize(rowCount: number): boolean {
    return rowCount > VIRTUALIZE_THRESHOLD;
}
