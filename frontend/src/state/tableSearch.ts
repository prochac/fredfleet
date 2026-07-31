import {useEffect, useRef, useState} from 'react';
import {CancelRequest, SearchTables} from '../../wailsjs/go/main/App';
import type {catalog} from '../../wailsjs/go/models';
import {useDebounced} from '../hooks/useDebounced';
import type {TableTarget} from './tableIndex';

export type SearchStatus = 'idle' | 'searching' | 'ready' | 'error';

export type TableSearch = {
    tables: TableTarget[];
    /** Total matches before the server-side limit cut. */
    matched: number;
    /** Size of the crawled index on the backend. */
    indexed: number;
    /** False when the crawl was cut short by a cap or an unreadable namespace. */
    complete: boolean;
    status: SearchStatus;
};

const IDLE: TableSearch = {
    tables: [],
    matched: 0,
    indexed: 0,
    complete: false,
    status: 'idle',
};

const DEBOUNCE_MS = 300;

/**
 * Searches every table in the catalog, not just the ones the lazily-loaded
 * namespace tree has already fetched.
 *
 * The first query for a connection makes the backend crawl the whole catalog
 * (bounded by app.go's searchTimeout), so the hook is deliberately frugal about
 * when it fires: nothing happens until the user actually types a table name.
 * A bare Mod+K, or a `>` command query, never costs a crawl.
 *
 * Two rules keep a cold index from being destroyed before it exists:
 *
 *   - Only one request is in flight at a time. A newer query waits for the
 *     current one and is issued when it settles, rather than racing it.
 *   - Superseded queries are never cancelled, and neither is unmount. Cancelling
 *     a cold crawl throws the partial index away, so an Esc a few seconds in
 *     would leave the user re-crawling from zero on every open. Letting it run
 *     costs one bounded crawl and warms the cache instead.
 *
 * The only cancellation is a connection switch, where the in-flight crawl is for
 * a catalog the user has left.
 */
export function useTableSearch(
    connName: string | null,
    term: string,
    enabled: boolean,
): TableSearch {
    const [debouncedTerm] = useDebounced(term, DEBOUNCE_MS);
    const [state, setState] = useState<TableSearch>(IDLE);

    const inFlightReqIDRef = useRef<string | null>(null);
    // The term the in-flight (or most recently settled) request was issued for.
    // Not state: it must not retrigger the effect that writes it.
    const servedTermRef = useRef<string | null>(null);
    const connRef = useRef<string | null>(connName);
    // Bumped whenever a request settles, so the effect re-runs and can pick up
    // a query the user typed while the previous one was in flight.
    const [settled, setSettled] = useState(0);

    useEffect(() => {
        if (connRef.current !== connName) {
            // A crawl belonging to the connection we just left. This can't live
            // in an effect cleanup: cleanup also runs on unmount, and unmount
            // must let the crawl finish.
            if (inFlightReqIDRef.current) {
                CancelRequest(inFlightReqIDRef.current).catch(() => {});
                inFlightReqIDRef.current = null;
            }
            connRef.current = connName;
            servedTermRef.current = null;
            setState(IDLE);
        }

        if (debouncedTerm === '') {
            // Nothing typed: drop stale hits so the palette falls back to the
            // tree index and the footer invites a search.
            servedTermRef.current = null;
            setState((s) => (s.status === 'idle' ? s : IDLE));
            return;
        }
        if (!enabled || !connName) return;
        // One at a time — the settled bump re-runs this effect.
        if (inFlightReqIDRef.current) return;
        if (servedTermRef.current === debouncedTerm) return;

        const reqID = crypto.randomUUID();
        inFlightReqIDRef.current = reqID;
        servedTermRef.current = debouncedTerm;
        setState((s) => ({...s, status: 'searching'}));

        const done = () => {
            inFlightReqIDRef.current = null;
            setSettled((n) => n + 1);
        };

        SearchTables(reqID, connName, debouncedTerm, 0)
            .then((res) => {
                // A connection switch cancelled us and cleared the ref.
                if (inFlightReqIDRef.current !== reqID) return;
                setState({
                    tables: (res.tables ?? []).map(toTarget),
                    matched: res.matched,
                    indexed: res.indexed,
                    complete: res.complete,
                    status: 'ready',
                });
                done();
            })
            .catch(() => {
                if (inFlightReqIDRef.current !== reqID) return;
                // Keep whatever was already found and report it in the palette
                // footer. A toast per keystroke against a dead catalog would
                // bury the UI.
                setState((s) => ({...s, status: 'error'}));
                done();
            });
    }, [connName, debouncedTerm, enabled, settled]);

    return state;
}

function toTarget(t: catalog.TableDTO): TableTarget {
    const namespace = t.namespace ?? [];
    return {namespace, name: t.name, label: [...namespace, t.name].join('.')};
}
