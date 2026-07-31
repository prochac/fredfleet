export type FuzzyMatch = {score: number; positions: number[]};

/**
 * Strips diacritics and case so `zakaznici` matches `zákazníci` — and so does
 * `zákazníci` itself. Positions returned by fuzzyMatch index the *original*
 * string, because NFD normalisation is applied per character and the
 * combining marks are dropped without shifting the base characters.
 */
export function normalize(s: string): string {
    return s
        .split('')
        .map((c) => c.normalize('NFD').replace(/\p{Diacritic}/gu, '') || c)
        .map((c) => c.toLowerCase())
        .join('');
}

const SEPARATORS = new Set(['.', '_', '-', ' ', '/']);

/**
 * Subsequence match with a bias towards matches at word starts and
 * consecutive runs. Returns null when `query` is not a subsequence of
 * `target`. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
    if (query === '') return {score: 0, positions: []};

    const q = normalize(query);
    const t = normalize(target);
    // Per-character normalisation keeps the two strings index-aligned, so a
    // hit at index i in `t` is also index i in `target`.
    if (q.length > t.length) return null;

    const positions: number[] = [];
    let score = 0;
    let qi = 0;
    let prevHit = -2;

    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] !== q[qi]) continue;

        const atStart = ti === 0 || SEPARATORS.has(t[ti - 1]);
        const consecutive = ti === prevHit + 1;
        score += 10;
        if (atStart) score += 15;
        if (consecutive) score += 8;
        // Gaps cost, so a tight match outranks one scattered across the name.
        if (!consecutive && prevHit >= 0) score -= Math.min(ti - prevHit - 1, 10);

        positions.push(ti);
        prevHit = ti;
        qi++;
    }

    if (qi < q.length) return null;
    // Mild preference for shorter targets when scores are otherwise equal.
    score -= Math.floor(t.length / 10);
    return {score, positions};
}
