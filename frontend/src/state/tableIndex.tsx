import {createContext, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import type {TreePath} from './treeStore';

export type TableTarget = {
    namespace: TreePath;
    name: string;
    /** Fully-qualified dotted name, e.g. `sales.customers`. */
    label: string;
};

export type TableIndex = {
    tables: TableTarget[];
    /**
     * False while any namespace is still unexpanded. The tree loads children
     * lazily, so the palette can only search what has been fetched — the UI
     * has to say so rather than report a bare "no results".
     */
    complete: boolean;
};

const EMPTY: TableIndex = {tables: [], complete: false};

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
export function usePublishTableIndex(tables: TableTarget[], complete: boolean) {
    const setIndex = useContext(SetterCtx);
    const value = useMemo(() => ({tables, complete}), [tables, complete]);

    useEffect(() => {
        setIndex(value);
        return () => setIndex(EMPTY);
    }, [setIndex, value]);
}
