import {KeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import {RefreshTableIndex} from '../../wailsjs/go/main/App';
import {
    flattenVisible,
    keyOfNamespace,
    parentKey,
    TreePath,
    useTreeStore,
} from '../state/treeStore';
import type {NodeKey, TableNode} from '../state/treeStore';
import {usePublishTableIndex} from '../state/tableIndex';
import {PRIORITY, useCommand} from '../shortcuts/registry';
import {toastInfo} from '../toast';
import {TreeNode} from './TreeNode';
import {Pending} from './Pending';

type Props = {
    connName: string | null;
    selectedTable: {namespace: TreePath; name: string} | null;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
    /**
     * Bumped by App to ask for the selected table to be revealed. A counter
     * rather than a boolean so asking twice for the same table works — the
     * user may have collapsed the branch in between.
     */
    revealNonce?: number;
};

export function NamespaceTree({connName, selectedTable, onSelectTable, revealNonce}: Props) {
    const {state, expand, refreshRoot, refreshNode, setFocus, reveal} = useTreeStore(connName);
    const treeRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<Map<NodeKey, HTMLDivElement>>(new Map());
    const registerRow = (key: NodeKey, el: HTMLDivElement | null) => {
        if (el) rowRefs.current.set(key, el);
        else rowRefs.current.delete(key);
    };

    const visible = useMemo(() => flattenVisible(state), [state]);
    const focusedKey = state.focusedKey ?? (visible.length > 0 ? visible[0] : null);

    useEffect(() => {
        if (state.focusedKey == null && visible.length > 0) {
            setFocus(visible[0]);
        } else if (state.focusedKey != null && !state.byKey[state.focusedKey]) {
            setFocus(visible.length > 0 ? visible[0] : null);
        }
    }, [state.focusedKey, state.byKey, visible, setFocus]);

    function moveFocus(nextKey: NodeKey | null) {
        if (nextKey == null) return;
        setFocus(nextKey);
    }

    // After focus state changes, move DOM focus to that row — but only if focus
    // already lives inside the tree (don't yank focus from elsewhere).
    useEffect(() => {
        if (!focusedKey) return;
        const root = treeRef.current;
        if (!root) return;
        if (!root.contains(document.activeElement)) return;
        const el = rowRefs.current.get(focusedKey);
        if (el && el !== document.activeElement) el.focus();
    }, [focusedKey]);

    // `g` waits for a second key, vim-style.
    //
    // While the tree has focus, `g` belongs to the tree and is not passed on —
    // so `gg` is "first row" here and the global `g`-prefixed sequences do not
    // fire from inside the tree. That is the same rule vim uses (the focused
    // buffer owns its motions), it keeps `gg` from half-arming a global chord
    // that would then swallow the next keystroke, and nothing is lost: `g t`
    // only focuses the tree, and the tab sequences are also on Mod+1…4.
    const pendingGRef = useRef(false);

    function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (!focusedKey || visible.length === 0) return;
        const idx = visible.indexOf(focusedKey);
        const node = state.byKey[focusedKey];
        if (!node) return;

        // --- vim motions -----------------------------------------------
        const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey;
        if (pendingGRef.current) {
            pendingGRef.current = false;
            if (e.key === 'g') {
                e.preventDefault();
                e.stopPropagation();
                moveFocus(visible[0]); // gg — first row
                return;
            }
            // Any other key ends the sequence and is handled normally below.
        } else if (e.key === 'g' && plainKey) {
            pendingGRef.current = true;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        switch (e.key) {
            case 'j': {
                e.preventDefault();
                e.stopPropagation();
                if (idx >= 0 && idx < visible.length - 1) moveFocus(visible[idx + 1]);
                return;
            }
            case 'k': {
                e.preventDefault();
                e.stopPropagation();
                if (idx > 0) moveFocus(visible[idx - 1]);
                return;
            }
            case 'h': {
                e.preventDefault();
                e.stopPropagation();
                if (node.kind === 'namespace' && node.expanded) {
                    expand(node.path); // collapse
                } else {
                    const p = parentKey(state, focusedKey);
                    if (p) moveFocus(p);
                }
                return;
            }
            case 'l': {
                e.preventDefault();
                e.stopPropagation();
                if (node.kind === 'namespace' && !node.expanded) expand(node.path);
                else if (idx >= 0 && idx < visible.length - 1) moveFocus(visible[idx + 1]);
                return;
            }
            case 'G': {
                e.preventDefault();
                e.stopPropagation();
                moveFocus(visible[visible.length - 1]);
                return;
            }
        }

        switch (e.key) {
            case 'ArrowDown': {
                e.preventDefault();
                if (idx >= 0 && idx < visible.length - 1) moveFocus(visible[idx + 1]);
                return;
            }
            case 'ArrowUp': {
                e.preventDefault();
                if (idx > 0) moveFocus(visible[idx - 1]);
                return;
            }
            case 'Home': {
                e.preventDefault();
                moveFocus(visible[0]);
                return;
            }
            case 'End': {
                e.preventDefault();
                moveFocus(visible[visible.length - 1]);
                return;
            }
            case 'ArrowRight': {
                e.preventDefault();
                if (node.kind === 'namespace') {
                    if (!node.expanded) {
                        expand(node.path);
                    } else if (idx >= 0 && idx < visible.length - 1) {
                        // Move to first child (next visible row, if it's a descendant).
                        const next = visible[idx + 1];
                        const nextNode = state.byKey[next];
                        if (nextNode) moveFocus(next);
                    }
                }
                return;
            }
            case 'ArrowLeft': {
                e.preventDefault();
                if (node.kind === 'namespace' && node.expanded) {
                    expand(node.path); // toggle: collapse
                } else {
                    const p = parentKey(state, focusedKey);
                    if (p) moveFocus(p);
                }
                return;
            }
            case 'Enter':
            case ' ': {
                e.preventDefault();
                if (node.kind === 'namespace') {
                    expand(node.path);
                } else {
                    onSelectTable({namespace: node.namespace, name: node.name});
                }
                return;
            }
        }
    }

    // The focus effect above deliberately won't pull focus in from outside the
    // tree, so this moves DOM focus itself. Programmatic focus on a
    // tabindex="-1" row is fine even before the roving index catches up.
    useCommand('focus.tree', () => {
        const key = focusedKey;
        const el = key ? rowRefs.current.get(key) : undefined;
        if (!el) {
            treeRef.current?.focus();
            return;
        }
        if (state.focusedKey !== key) setFocus(key);
        el.focus();
        el.scrollIntoView({block: 'nearest'});
    });

    // Reveal: expand down to the open table and put the keyboard on it. The
    // DOM row does not exist until the branch has rendered, so the scroll is
    // deferred to an effect keyed on the focus the reveal set.
    const [revealedKey, setRevealedKey] = useState<NodeKey | null>(null);
    useEffect(() => {
        if (!revealNonce || !selectedTable) return;
        let cancelled = false;
        reveal(selectedTable.namespace, selectedTable.name).then((key) => {
            if (cancelled) return;
            if (key) setRevealedKey(key);
            else toastInfo('That table is no longer in the tree — try reloading it.');
        });
        return () => {
            cancelled = true;
        };
        // selectedTable is intentionally not a dep: a reveal happens when asked
        // for, not every time the selection changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revealNonce, reveal]);

    useEffect(() => {
        if (!revealedKey) return;
        const el = rowRefs.current.get(revealedKey);
        if (!el) return;
        el.focus();
        el.scrollIntoView({block: 'nearest'});
        setRevealedKey(null);
    }, [revealedKey, visible]);

    const indexedTables = useMemo(
        () =>
            Object.values(state.byKey)
                .filter((n): n is TableNode => n.kind === 'table')
                .map((n) => ({
                    namespace: n.namespace,
                    name: n.name,
                    label: [...n.namespace, n.name].join('.'),
                })),
        [state.byKey],
    );
    usePublishTableIndex(indexedTables);

    // Lowest tier: only reached when no table is open, since the metadata and
    // preview panels register the same command at PRIORITY.TABLE.
    useCommand(
        'refresh.scope',
        () => {
            const node = focusedKey ? state.byKey[focusedKey] : undefined;
            if (node?.kind === 'namespace') refreshNode(node.path);
            else refreshRoot();
        },
        true,
        PRIORITY.TREE,
    );
    // "Forget what you know about this catalog": the tree drops its loaded
    // children, and the backend drops the cached table index the command
    // palette searches, so the next palette query re-crawls.
    useCommand('refresh.treeRoot', () => {
        refreshRoot();
        if (connName) RefreshTableIndex(connName).catch(() => {});
    });

    if (!connName) {
        return <p className="tree-empty">Pick a connection to start browsing.</p>;
    }

    const isLoading = state.root.status === 'loading' || state.root.status === 'idle';
    const isError = state.root.status === 'error';
    const isLoaded = state.root.status === 'loaded';

    return (
        <div
            ref={treeRef}
            className="tree"
            role="tree"
            // Fallback focus target for Mod+0 when the tree has no rows yet.
            tabIndex={-1}
            onKeyDown={handleKeyDown}
        >
            <Pending
                loading={isLoading}
                error={isError ? state.root.error : null}
                empty={isLoaded && state.root.items.length === 0}
                emptyMessage="No namespaces in this catalog."
                onRetry={refreshRoot}
            >
                {state.root.items.map((nodeKey) => (
                    <TreeNode
                        key={nodeKey}
                        nodeKey={nodeKey}
                        byKey={state.byKey}
                        depth={0}
                        selectedTable={selectedTable}
                        focusedKey={focusedKey}
                        registerRow={registerRow}
                        onExpand={expand}
                        onRefresh={refreshNode}
                        onSelectTable={onSelectTable}
                        onFocusNode={(k) => setFocus(k)}
                    />
                ))}
            </Pending>
        </div>
    );
}

// Re-export so layout files that need keyOfNamespace can pull from this module.
export {keyOfNamespace};
