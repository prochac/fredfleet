import {describe, expect, it} from 'vitest';
import {fuzzyMatch, normalize} from './fuzzy';

const score = (q: string, t: string) => {
    const m = fuzzyMatch(q, t);
    if (!m) throw new Error(`expected ${q} to match ${t}`);
    return m.score;
};

describe('normalize', () => {
    it('folds diacritics and case', () => {
        expect(normalize('Zákazníci')).toBe('zakaznici');
        expect(normalize('ŘEŽ')).toBe('rez');
    });

    it('keeps the string length, which is what keeps positions aligned', () => {
        // fuzzyMatch returns indices into the *original* string and relies on
        // per-character folding never adding or dropping a character.
        for (const s of ['zákazníci', 'ŘEŽ', 'sales.orders', 'ÄÖÜ']) {
            expect(normalize(s)).toHaveLength(s.length);
        }
    });
});

describe('fuzzyMatch', () => {
    it('matches a subsequence and reports where it hit', () => {
        expect(fuzzyMatch('so', 'sales.orders')?.positions).toEqual([0, 6]);
    });

    it('returns null when the query is not a subsequence', () => {
        expect(fuzzyMatch('xyz', 'sales.orders')).toBeNull();
        expect(fuzzyMatch('sro', 'sales.orders')).toBeNull(); // right letters, wrong order
    });

    it('returns null when the query is longer than the target', () => {
        expect(fuzzyMatch('orders_2024', 'orders')).toBeNull();
    });

    it('matches everything on an empty query', () => {
        expect(fuzzyMatch('', 'anything')).toEqual({score: 0, positions: []});
    });

    it('is diacritic- and case-insensitive both ways', () => {
        // Typing ASCII must find the accented table, and typing the accented
        // form must find it too.
        expect(fuzzyMatch('zakaznici', 'zákazníci')).not.toBeNull();
        expect(fuzzyMatch('zákazníci', 'zakaznici')).not.toBeNull();
        expect(fuzzyMatch('ZAK', 'zákazníci')).not.toBeNull();
    });

    it('reports positions that index the original, accented string', () => {
        const m = fuzzyMatch('zak', 'zákazníci');
        expect(m?.positions).toEqual([0, 1, 2]);
        // Highlighting slices the original string with these indices.
        expect(m?.positions.map((i) => 'zákazníci'[i]).join('')).toBe('zák');
    });

    it('ranks word-start matches above mid-word ones', () => {
        // Mod+K typing "ord" should surface sales.orders before recorder.
        expect(score('ord', 'sales.orders')).toBeGreaterThan(score('ord', 'recorder'));
    });

    it('ranks a tight run above a match scattered through one word', () => {
        expect(score('ord', 'orders')).toBeGreaterThan(score('ord', 'oxrxd'));
    });

    it('ranks an acronym across separators above a mid-word run', () => {
        // Separator hits are word starts, so "so" is meant to find
        // sales.orders rather than the incidental "so" inside isolation.
        expect(score('so', 'sales.orders')).toBeGreaterThan(score('so', 'isolation'));
    });

    it('treats every separator as a word start', () => {
        // The palette shows dotted labels, the tree shows underscored names.
        const dotted = score('o', 'sales.orders');
        for (const sep of ['_', '-', ' ', '/']) {
            expect(score('o', `sales${sep}orders`)).toBe(dotted);
        }
    });

    it('prefers the shorter target when the match is otherwise identical', () => {
        expect(score('orders', 'orders')).toBeGreaterThan(
            score('orders', 'orders_archive_2024_partitioned'),
        );
    });

    it('matches greedily from the left', () => {
        // First-fit is what keeps positions monotonic for <mark> rendering.
        const m = fuzzyMatch('oo', 'orders_of_orders');
        expect(m?.positions).toEqual([0, 7]);
        expect(m?.positions).toEqual([...(m?.positions ?? [])].sort((a, b) => a - b));
    });
});
