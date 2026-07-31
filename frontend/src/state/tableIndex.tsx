import {createContext, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import type {TreePath} from './treeStore';

export type TableTarget = {
    namespace: TreePath;
    name: string;
    /** Fully-qualified dotted name, e.g. `sales.customers`. */
    label: string;
};

/**
 * The tables the lazily-loaded tree happens to have fetched. This is what the
 * command palette can answer from with zero latency; whether it covers the
 * whole catalog is the backend crawl's question, not this one's — see
 * `useTableSearch`.
 */
export type TableIndex = {
    tables: TableTarget[];
};

const EMPTY: TableIndex = {tables: []};

const ValueCtx = createContext<TableIndex>(EMPTY);
const SetterCtx = createContext<(i: TableIndex) => void>(() => {});

export function TableIndexProvider({children}: {children: ReactNode}) {
    const [index, setIndex] = useState<TableIndex>(EMPTY);
    return (
        <SetterCtx.Provider value={setIndex}>
            <ValueCtx.Provider value={index}>{children}</ValueCtx.Provider>
        </SetterCtx.Provider>
    );
}

export function useTableIndex(): TableIndex {
    return useContext(ValueCtx);
}

/**
 * Publishes the tree's tables upward. Lives here rather than lifting the tree
 * store into App, because the tree is reset by remounting on connection change
 * (`key={selectedConnection}`) and lifting it would break that.
 */
export function usePublishTableIndex(tables: TableTarget[]) {
    const setIndex = useContext(SetterCtx);
    const value = useMemo(() => ({tables}), [tables]);

    useEffect(() => {
        setIndex(value);
        return () => setIndex(EMPTY);
    }, [setIndex, value]);
}
