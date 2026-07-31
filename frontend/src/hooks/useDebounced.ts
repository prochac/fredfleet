import {useCallback, useEffect, useRef, useState} from 'react';

/** Returns the debounced value plus a flush that adopts the latest one now. */
export function useDebounced<T>(value: T, ms: number): [T, () => void] {
    const [v, setV] = useState(value);
    const latest = useRef(value);
    latest.current = value;
    useEffect(() => {
        const id = setTimeout(() => setV(value), ms);
        return () => clearTimeout(id);
    }, [value, ms]);
    // The pending timeout still fires afterwards, but it sets the same value,
    // so React bails out of the re-render.
    const flush = useCallback(() => setV(latest.current), []);
    return [v, flush];
}
