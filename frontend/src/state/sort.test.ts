import {describe, expect, it} from 'vitest';
import {compareValues, previewSortingFn, sortableValue} from './sort';

describe('compareValues', () => {
    it('compares decimal strings numerically, not lexicographically', () => {
        // Decimals arrive as strings to keep their precision; "9" must not
        // sort above "10".
        expect(compareValues('9', '10')).toBeLessThan(0);
        expect(compareValues('10.5', '10.25')).toBeGreaterThan(0);
        expect(compareValues('-2', '1')).toBeLessThan(0);
        expect(compareValues('1e3', '999')).toBeGreaterThan(0);
    });

    it('leaves non-numeric strings in text order', () => {
        expect(compareValues('apple', 'banana')).toBeLessThan(0);
        // ISO-8601 sorts chronologically as text, which is why it is not
        // special-cased.
        expect(compareValues('2024-01-02', '2024-01-10')).toBeLessThan(0);
        expect(compareValues('2024-01-02T10:00:00Z', '2024-01-02T09:00:00Z')).toBeGreaterThan(0);
    });

    it('does not treat blank or partial numbers as zero', () => {
        expect(compareValues('', '0')).toBeLessThan(0);
        expect(compareValues('12abc', '9')).toBeLessThan(0); // plain text order
        expect(compareValues(' 5', '4')).toBeLessThan(0); // untrimmed: text order
    });

    it('compares numbers numerically', () => {
        expect(compareValues(2, 10)).toBeLessThan(0);
        expect(compareValues(-1, 0)).toBeLessThan(0);
    });

    it('orders booleans false before true', () => {
        expect(compareValues(false, true)).toBeLessThan(0);
        expect(compareValues(true, true)).toBe(0);
    });

    it('gives nested values a stable order rather than an arbitrary one', () => {
        const a = {city: 'aaa'};
        const b = {city: 'bbb'};
        expect(compareValues(a, b)).toBeLessThan(0);
        expect(compareValues(a, b)).toBe(compareValues(a, b));
    });
});

describe('sortableValue', () => {
    it('maps null to undefined so the column can sort nulls last', () => {
        // TanStack's sortUndefined only sees `undefined`, and it applies it
        // before inverting for a descending sort — which is what keeps nulls
        // at the bottom in both directions.
        expect(sortableValue(null)).toBeUndefined();
    });

    it('leaves every other value, including falsy ones, alone', () => {
        expect(sortableValue(0)).toBe(0);
        expect(sortableValue('')).toBe('');
        expect(sortableValue(false)).toBe(false);
    });
});

describe('previewSortingFn', () => {
    const row = (v: unknown) => ({getValue: () => v});

    it('reads the column off each row and compares', () => {
        expect(previewSortingFn(row('9'), row('10'), 'c')).toBeLessThan(0);
        expect(previewSortingFn(row(5), row(5), 'c')).toBe(0);
    });
});
