import {RefObject, useEffect, useState} from 'react';
import {windowRange, type RowWindow} from '../state/virtual';

/**
 * Tracks a scroll container and reports which rows are worth rendering.
 *
 * When `enabled` is false it reports the whole range, so a caller can render
 * the same way either side of the virtualization threshold and only the window
 * changes.
 */
export function useVirtualRows(
    ref: RefObject<HTMLElement | null>,
    rowCount: number,
    rowHeight: number,
    enabled: boolean,
): RowWindow {
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);

    useEffect(() => {
        const el = ref.current;
        if (!el || !enabled) return;

        // Seed from the element rather than waiting for the first event:
        // switching tabs or tables can leave the container already scrolled.
        setScrollTop(el.scrollTop);
        setViewportHeight(el.clientHeight);

        const onScroll = () => setScrollTop(el.scrollTop);
        el.addEventListener('scroll', onScroll, {passive: true});

        const ro = new ResizeObserver(() => {
            setViewportHeight(el.clientHeight);
            // A resize can shrink the content below the current offset; WebKit
            // does not always reclamp scrollTop, and a stale offset would
            // window rows that are no longer reachable.
            setScrollTop(el.scrollTop);
        });
        ro.observe(el);

        return () => {
            el.removeEventListener('scroll', onScroll);
            ro.disconnect();
        };
    }, [ref, enabled, rowCount]);

    if (!enabled) {
        return {start: 0, end: rowCount, padTop: 0, padBottom: 0};
    }
    return windowRange({scrollTop, viewportHeight, rowHeight, rowCount});
}
