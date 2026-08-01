import {useCallback, useEffect, useRef, useState} from 'react';

/**
 * Returns the debounced value plus a flush that adopts the latest one now.
 *
 * `resetKey` names what the value belongs to. When it changes the new value is
 * adopted immediately, with no delay: a debounce is there to absorb typing,
 * and a value that belongs to something else is not a keystroke to wait out.
 * Without it, switching tables would fire one fetch carrying the *previous*
 * table's filters before the delay caught up.
 */
export function useDebounced<T>(value: T, ms: number, resetKey?: unknown): [T, () => void] {
    const [v, setV] = useState(value);
    const latest = useRef(value);
    latest.current = value;
    const lastKey = useRef(resetKey);

    // A render-phase adjustment rather than an effect, so the new value is
    // already in place for the effects of this same commit — which is where
    // the fetch that must not use the old value lives.
    if (lastKey.current !== resetKey) {
        lastKey.current = resetKey;
        setV(value);
    }

    useEffect(() => {
        const id = setTimeout(() => setV(value), ms);
        return () => clearTimeout(id);
    }, [value, ms]);
    // The pending timeout still fires afterwards, but it sets the same value,
    // so React bails out of the re-render.
    const flush = useCallback(() => setV(latest.current), []);
    return [v, flush];
}
