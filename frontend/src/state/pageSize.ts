// Page-size change semantics for the row preview, kept separate from
// PreviewPanel so the rule can be tested without mounting a component.
//
// The rule: if the new size fits inside the rows already loaded, re-paginate
// the buffer client-side. Otherwise the buffer can't fill a page, so re-scan
// from skip=0 with the new limit.

export type PageSizePlan =
    /** Buffer already covers the new size — slice it, issue no request. */
    | {kind: 'slice'}
    /** Buffer is too small — cancel anything in flight and refetch from row 0. */
    | {kind: 'refetch'};

/**
 * Decide what a page-size change should do.
 *
 * @param newSize     the size the user picked
 * @param currentSize the size currently in effect
 * @param buffered    how many rows are loaded right now
 * @returns null when nothing should happen (the size didn't actually change)
 */
export function pageSizePlan(
    newSize: number,
    currentSize: number,
    buffered: number,
): PageSizePlan | null {
    if (newSize === currentSize) return null;
    // `<=` and not `<`: a buffer of exactly newSize rows fills the first page
    // completely, and Load-more still governs whether there's a second one.
    return newSize <= buffered ? {kind: 'slice'} : {kind: 'refetch'};
}
