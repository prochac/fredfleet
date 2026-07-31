import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import type {CommandId} from './commands';
import {useGlobalShortcuts, type OverlayState} from './useGlobalShortcuts';

type Handler = () => void;
type Entry = {fn: Handler; priority: number};

/**
 * Priority tiers for commands several components answer to. `run` invokes
 * every handler in the highest tier present and ignores the rest, so Mod+R
 * refreshes the open table (preview *and* metadata, both at TABLE) and falls
 * through to the tree only when no table is selected.
 */
export const PRIORITY = {TABLE: 20, TREE: 10, APP: 0} as const;

type Registry = {
    register: (id: CommandId, h: Handler, priority: number) => () => void;
    run: (id: CommandId) => boolean;
    has: (id: CommandId) => boolean;
};

// Two contexts on purpose. RegistryCtx must be referentially stable for the
// life of the provider: useCommand depends on it, so if it changed identity on
// every subscription the effect would unregister/re-register and bump the
// version again — an infinite loop. VersionCtx carries the churn instead, and
// only components that render command lists subscribe to it.
const RegistryCtx = createContext<Registry | null>(null);
const VersionCtx = createContext(0);

type ProviderProps = {
    /** Suppresses commands that shouldn't fire over the palette or a dialog. */
    overlay: OverlayState;
    children: ReactNode;
};

export function ShortcutProvider({overlay, children}: ProviderProps) {
    // A Set per command, so one key can fan out to several subscribers —
    // Mod+R refreshes both the preview and the metadata panel.
    const handlers = useRef<Map<CommandId, Set<Entry>>>(new Map());
    const [version, setVersion] = useState(0);

    const register = useCallback((id: CommandId, h: Handler, priority: number) => {
        const entry: Entry = {fn: h, priority};
        let set = handlers.current.get(id);
        if (!set) {
            set = new Set();
            handlers.current.set(id, set);
        }
        set.add(entry);
        setVersion((v) => v + 1);

        // Removal is by entry identity, which keeps StrictMode's
        // mount → unmount → mount cycle from dropping the live registration.
        return () => {
            const curr = handlers.current.get(id);
            if (!curr) return;
            curr.delete(entry);
            if (curr.size === 0) handlers.current.delete(id);
            setVersion((v) => v + 1);
        };
    }, []);

    const run = useCallback((id: CommandId) => {
        const set = handlers.current.get(id);
        if (!set || set.size === 0) return false;
        const entries = Array.from(set);
        const top = Math.max(...entries.map((e) => e.priority));
        for (const e of entries) {
            if (e.priority === top) e.fn();
        }
        return true;
    }, []);

    const has = useCallback((id: CommandId) => (handlers.current.get(id)?.size ?? 0) > 0, []);

    const registry = useMemo(() => ({register, run, has}), [register, run, has]);

    useGlobalShortcuts(run, overlay);

    return (
        <RegistryCtx.Provider value={registry}>
            <VersionCtx.Provider value={version}>{children}</VersionCtx.Provider>
        </RegistryCtx.Provider>
    );
}

/** Subscribe a handler for the lifetime of the calling component. */
export function useCommand(
    id: CommandId,
    handler: Handler,
    enabled = true,
    priority: number = PRIORITY.APP,
) {
    const reg = useContext(RegistryCtx);
    const ref = useRef(handler);
    ref.current = handler;

    useEffect(() => {
        if (!reg || !enabled) return;
        // Registered through the ref so a new closure each render doesn't
        // churn the subscription.
        return reg.register(id, () => ref.current(), priority);
    }, [reg, id, enabled, priority]);
}

export function useRunCommand(): (id: CommandId) => boolean {
    const reg = useContext(RegistryCtx);
    return useCallback((id: CommandId) => reg?.run(id) ?? false, [reg]);
}

/** Which commands currently have a live handler — used by the palette. */
export function useIsCommandLive(): (id: CommandId) => boolean {
    const reg = useContext(RegistryCtx);
    const version = useContext(VersionCtx);
    return useCallback(
        (id: CommandId) => reg?.has(id) ?? false,
        // `version` is a dep on purpose: it hands callers a fresh callback
        // whenever subscriptions change, so memoised lists recompute.
        [reg, version],
    );
}
