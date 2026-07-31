import {useCallback, useEffect, useReducer, useRef} from 'react';
import {ListNamespaces, ListTables} from '../../wailsjs/go/main/App';

export type NodeKey = string;
export type TreePath = string[];

const SEP = '\x00';
export const keyOfNamespace = (path: TreePath): NodeKey => 'ns' + SEP + path.join(SEP);
export const keyOfTable = (namespace: TreePath, name: string): NodeKey =>
    'tbl' + SEP + [...namespace, name].join(SEP);

type SlotStatus = 'idle' | 'loading' | 'loaded' | 'error';

export type NamespaceNode = {
    kind: 'namespace';
    path: TreePath;
    expanded: boolean;
    namespacesStatus: SlotStatus;
    tablesStatus: SlotStatus;
    childNamespaces: NodeKey[];
    childTables: NodeKey[];
    error: string | null;
};

export type TableNode = {
    kind: 'table';
    namespace: TreePath;
    name: string;
};

export type TreeNode = NamespaceNode | TableNode;

export type RootState = {
    status: SlotStatus;
    items: NodeKey[];
    error: string | null;
};

export type State = {
    root: RootState;
    byKey: Record<NodeKey, TreeNode>;
    focusedKey: NodeKey | null;
};

type Action =
    | {type: 'root_loading'}
    | {type: 'root_loaded'; items: NodeKey[]; nodes: TreeNode[]}
    | {type: 'root_error'; error: string}
    | {type: 'node_expanded'; key: NodeKey; expanded: boolean}
    | {type: 'node_loading'; key: NodeKey}
    | {type: 'node_namespaces_loaded'; key: NodeKey; items: NodeKey[]; nodes: TreeNode[]}
    | {type: 'node_tables_loaded'; key: NodeKey; items: NodeKey[]; nodes: TreeNode[]}
    | {type: 'node_error'; key: NodeKey; error: string}
    | {type: 'node_clear_children'; key: NodeKey}
    | {type: 'focus_set'; key: NodeKey | null};

// initialState, reducer and newNamespaceNode are exported for treeStore.test.ts.
// The invariants they carry — collapse/re-expand never re-fetches, and the two
// child slots are independent — are the reason this store exists, and they are
// far cheaper to pin here than through a mounted component.
export function initialState(): State {
    return {root: {status: 'idle', items: [], error: null}, byKey: {}, focusedKey: null};
}

export function reducer(state: State, a: Action): State {
    switch (a.type) {
        case 'root_loading':
            return {...state, root: {...state.root, status: 'loading', error: null}};
        case 'root_loaded':
            return {
                ...state,
                root: {status: 'loaded', items: a.items, error: null},
                byKey: mergeNodes(state.byKey, a.nodes),
            };
        case 'root_error':
            return {...state, root: {...state.root, status: 'error', error: a.error}};
        case 'node_expanded': {
            const node = state.byKey[a.key];
            if (!node || node.kind !== 'namespace') return state;
            return {
                ...state,
                byKey: {...state.byKey, [a.key]: {...node, expanded: a.expanded}},
            };
        }
        case 'node_loading': {
            const node = state.byKey[a.key];
            if (!node || node.kind !== 'namespace') return state;
            return {
                ...state,
                byKey: {
                    ...state.byKey,
                    [a.key]: {
                        ...node,
                        namespacesStatus: 'loading',
                        tablesStatus: 'loading',
                        error: null,
                    },
                },
            };
        }
        case 'node_namespaces_loaded': {
            const node = state.byKey[a.key];
            if (!node || node.kind !== 'namespace') return state;
            return {
                ...state,
                byKey: {
                    ...mergeNodes(state.byKey, a.nodes),
                    [a.key]: {...node, namespacesStatus: 'loaded', childNamespaces: a.items},
                },
            };
        }
        case 'node_tables_loaded': {
            const node = state.byKey[a.key];
            if (!node || node.kind !== 'namespace') return state;
            return {
                ...state,
                byKey: {
                    ...mergeNodes(state.byKey, a.nodes),
                    [a.key]: {...node, tablesStatus: 'loaded', childTables: a.items},
                },
            };
        }
        case 'node_error': {
            const node = state.byKey[a.key];
            if (!node || node.kind !== 'namespace') return state;
            return {
                ...state,
                byKey: {
                    ...state.byKey,
                    [a.key]: {
                        ...node,
                        namespacesStatus: 'error',
                        tablesStatus: 'error',
                        error: a.error,
                    },
                },
            };
        }
        case 'node_clear_children': {
            const node = state.byKey[a.key];
            if (!node || node.kind !== 'namespace') return state;
            return {
                ...state,
                byKey: {
                    ...state.byKey,
                    [a.key]: {
                        ...node,
                        namespacesStatus: 'idle',
                        tablesStatus: 'idle',
                        childNamespaces: [],
                        childTables: [],
                        error: null,
                    },
                },
            };
        }
        case 'focus_set':
            return {...state, focusedKey: a.key};
    }
}

export function flattenVisible(state: State): NodeKey[] {
    const out: NodeKey[] = [];
    const walk = (keys: NodeKey[]) => {
        for (const key of keys) {
            const node = state.byKey[key];
            if (!node) continue;
            out.push(key);
            if (node.kind === 'namespace' && node.expanded) {
                walk(node.childNamespaces);
                walk(node.childTables);
            }
        }
    };
    walk(state.root.items);
    return out;
}

export function parentKey(state: State, key: NodeKey): NodeKey | null {
    const node = state.byKey[key];
    if (!node) return null;
    const parentPath =
        node.kind === 'namespace' ? node.path.slice(0, -1) : node.namespace;
    if (parentPath.length === 0 && node.kind === 'namespace') return null;
    const candidate = keyOfNamespace(parentPath);
    return state.byKey[candidate] ? candidate : null;
}

function mergeNodes(byKey: Record<NodeKey, TreeNode>, nodes: TreeNode[]): Record<NodeKey, TreeNode> {
    const next = {...byKey};
    for (const node of nodes) {
        const key = node.kind === 'namespace' ? keyOfNamespace(node.path) : keyOfTable(node.namespace, node.name);
        if (!next[key]) {
            next[key] = node;
        }
    }
    return next;
}

export function newNamespaceNode(path: TreePath): NamespaceNode {
    return {
        kind: 'namespace',
        path,
        expanded: false,
        namespacesStatus: 'idle',
        tablesStatus: 'idle',
        childNamespaces: [],
        childTables: [],
        error: null,
    };
}

export function useTreeStore(connName: string | null) {
    const [state, dispatch] = useReducer(reducer, undefined, initialState);
    const aliveRef = useRef(true);

    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
        };
    }, []);

    const fetchRoot = useCallback(async () => {
        if (!connName) return;
        dispatch({type: 'root_loading'});
        try {
            const items = await ListNamespaces(connName, []);
            if (!aliveRef.current) return;
            const nodes: TreeNode[] = (items ?? []).map((i) => newNamespaceNode(i.path));
            const keys = nodes.map((n) => keyOfNamespace((n as NamespaceNode).path));
            dispatch({type: 'root_loaded', items: keys, nodes});
        } catch (e) {
            if (!aliveRef.current) return;
            dispatch({type: 'root_error', error: errorMessage(e)});
        }
    }, [connName]);

    useEffect(() => {
        if (connName) fetchRoot();
    }, [connName, fetchRoot]);

    const fetchChildren = useCallback(
        async (path: TreePath) => {
            if (!connName) return;
            const key = keyOfNamespace(path);
            dispatch({type: 'node_loading', key});
            const namespacesP = ListNamespaces(connName, path).then((items) => {
                if (!aliveRef.current) return;
                const childNodes: TreeNode[] = (items ?? []).map((i) => newNamespaceNode(i.path));
                const keys = childNodes.map((n) => keyOfNamespace((n as NamespaceNode).path));
                dispatch({type: 'node_namespaces_loaded', key, items: keys, nodes: childNodes});
            });
            const tablesP = ListTables(connName, path).then((items) => {
                if (!aliveRef.current) return;
                const childNodes: TreeNode[] = (items ?? []).map((i) => ({
                    kind: 'table' as const,
                    namespace: i.namespace ?? path,
                    name: i.name,
                }));
                const keys = (items ?? []).map((i) =>
                    keyOfTable(i.namespace ?? path, i.name),
                );
                dispatch({type: 'node_tables_loaded', key, items: keys, nodes: childNodes});
            });
            try {
                await Promise.all([namespacesP, tablesP]);
            } catch (e) {
                if (!aliveRef.current) return;
                dispatch({type: 'node_error', key, error: errorMessage(e)});
            }
        },
        [connName],
    );

    const expand = useCallback(
        (path: TreePath) => {
            const key = keyOfNamespace(path);
            const node = state.byKey[key];
            if (!node || node.kind !== 'namespace') return;
            const willExpand = !node.expanded;
            dispatch({type: 'node_expanded', key, expanded: willExpand});
            if (willExpand && node.namespacesStatus === 'idle' && node.tablesStatus === 'idle') {
                fetchChildren(path);
            }
        },
        [state.byKey, fetchChildren],
    );

    const refreshNode = useCallback(
        (path: TreePath) => {
            const key = keyOfNamespace(path);
            dispatch({type: 'node_clear_children', key});
            fetchChildren(path);
        },
        [fetchChildren],
    );

    const setFocus = useCallback((key: NodeKey | null) => {
        dispatch({type: 'focus_set', key});
    }, []);

    return {state, expand, refreshRoot: fetchRoot, refreshNode, setFocus};
}

function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}
