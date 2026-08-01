import {describe, expect, it} from 'vitest';
import {shouldVirtualize, VIRTUALIZE_THRESHOLD, windowRange} from './virtual';

const base = {scrollTop: 0, viewportHeight: 300, rowHeight: 30, rowCount: 1000, overscan: 5};

describe('windowRange', () => {
    it('renders from the top with no overscan above', () => {
        const w = windowRange(base);
        expect(w.start).toBe(0);
        expect(w.padTop).toBe(0);
        // 10 visible rows + 1 partial + 5 overscan.
        expect(w.end).toBe(16);
    });

    it('keeps total height constant so the scrollbar does not jump', () => {
        const total = base.rowCount * base.rowHeight;
        for (const scrollTop of [0, 137, 3000, 29970]) {
            const w = windowRange({...base, scrollTop});
            const rendered = (w.end - w.start) * base.rowHeight;
            expect(w.padTop + rendered + w.padBottom).toBe(total);
        }
    });

    it('covers the whole viewport at an offset that splits a row', () => {
        // scrollTop 137 puts row 4 partly above the fold; the window has to
        // start no later than row 4 or the first visible row is blank.
        const w = windowRange({...base, scrollTop: 137});
        expect(w.start).toBeLessThanOrEqual(4);
        const lastVisible = Math.floor((137 + 300) / 30);
        expect(w.end).toBeGreaterThan(lastVisible);
    });

    it('clamps at the bottom without running past the row count', () => {
        const w = windowRange({...base, scrollTop: 1000 * 30});
        expect(w.end).toBe(1000);
        expect(w.padBottom).toBe(0);
    });

    it('clamps a negative scrollTop, which WebKit produces during rubber-banding', () => {
        const w = windowRange({...base, scrollTop: -50});
        expect(w.start).toBe(0);
        expect(w.padTop).toBe(0);
    });

    it('renders something before the container has been measured', () => {
        // A viewport of 0 is the first paint or a hidden tab; rendering
        // nothing would flash an empty table.
        const w = windowRange({...base, viewportHeight: 0});
        expect(w.end).toBeGreaterThan(0);
    });

    it('handles an empty table', () => {
        expect(windowRange({...base, rowCount: 0})).toEqual({
            start: 0,
            end: 0,
            padTop: 0,
            padBottom: 0,
        });
    });

    it('renders every row when the table is shorter than the viewport', () => {
        const w = windowRange({...base, rowCount: 3});
        expect(w.start).toBe(0);
        expect(w.end).toBe(3);
        expect(w.padBottom).toBe(0);
    });
});

describe('shouldVirtualize', () => {
    it('leaves small tables as plain rows', () => {
        expect(shouldVirtualize(VIRTUALIZE_THRESHOLD)).toBe(false);
        expect(shouldVirtualize(VIRTUALIZE_THRESHOLD + 1)).toBe(true);
    });
});
