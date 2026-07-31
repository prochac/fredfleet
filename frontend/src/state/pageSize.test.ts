import {describe, expect, it} from 'vitest';
import {pageSizePlan} from './pageSize';

// The two cases that motivated splitting this rule out of PreviewPanel:
// 100 → 500 must re-fetch at a 200-row buffer, 500 → 100 must slice
// client-side without touching the network.

describe('pageSizePlan', () => {
    it('re-fetches when growing past the buffer (100 → 500 at a 200-row buffer)', () => {
        expect(pageSizePlan(500, 100, 200)).toEqual({kind: 'refetch'});
    });

    it('slices client-side when shrinking (500 → 100 with 500 rows loaded)', () => {
        expect(pageSizePlan(100, 500, 500)).toEqual({kind: 'slice'});
    });

    it('does nothing when the size did not change', () => {
        expect(pageSizePlan(100, 100, 200)).toBeNull();
    });

    it('slices when the buffer exactly covers the new size', () => {
        // A full page is a full page; Load-more still decides if there's more.
        expect(pageSizePlan(250, 100, 250)).toEqual({kind: 'slice'});
    });

    it('re-fetches when the buffer is one row short', () => {
        expect(pageSizePlan(250, 100, 249)).toEqual({kind: 'refetch'});
    });

    it('re-fetches when nothing is loaded yet', () => {
        // dataRef.current === null reaches the helper as buffered = 0.
        expect(pageSizePlan(100, 250, 0)).toEqual({kind: 'refetch'});
    });

    it('handles every ordered pair of the shipped page sizes', () => {
        const sizes = [100, 250, 500];
        // Buffer holds exactly one page at the current size, which is the
        // state right after a fresh load with no Load-more yet.
        for (const from of sizes) {
            for (const to of sizes) {
                const plan = pageSizePlan(to, from, from);
                if (to === from) {
                    expect(plan).toBeNull();
                } else if (to < from) {
                    expect(plan).toEqual({kind: 'slice'});
                } else {
                    expect(plan).toEqual({kind: 'refetch'});
                }
            }
        }
    });
});
