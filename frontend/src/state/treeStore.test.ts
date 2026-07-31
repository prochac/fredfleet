import {describe, expect, it} from 'vitest';
import {
    flattenVisible,
    initialState,
    keyOfNamespace,
    keyOfTable,
    newNamespaceNode,
    parentKey,
    reducer,
    State,
    TreeNode,
} from './treeStore';

const nsKey = (...path: string[]) => keyOfNamespace(path);

/** A state with one loaded root namespace, expanded, holding one child of each kind. */
function loadedTree(): State {
    const sales = newNamespaceNode(['sales']);
    let s = reducer(initialState(), {
        type: 'root_loaded',
        items: [nsKey('sales')],
        nodes: [sales],
    });
    s = reducer(s, {type: 'node_expanded', key: nsKey('sales'), expanded: true});
    s = reducer(s, {
        type: 'node_namespaces_loaded',
        key: nsKey('sales'),
        items: [nsKey('sales', 'eu')],
        nodes: [newNamespaceNode(['sales', 'eu'])],
    });
    s = reducer(s, {
        type: 'node_tables_loaded',
        key: nsKey('sales'),
        items: [keyOfTable(['sales'], 'orders')],
        nodes: [{kind: 'table', namespace: ['sales'], name: 'orders'}],
    });
    return s;
}

describe('tree keys', () => {
    it('separates namespaces from tables of the same dotted name', () => {
        // A namespace a.b and a table b in namespace a must not collide.
        expect(keyOfNamespace(['a', 'b'])).not.toBe(keyOfTable(['a'], 'b'));
    });

    it('does not collide on names containing the display separator', () => {
        expect(keyOfNamespace(['a.b'])).not.toBe(keyOfNamespace(['a', 'b']));
    });
});

describe('reducer', () => {
    // The invariant CLAUDE.md calls out: collapse and re-expand must not
    // re-fetch, which only holds if collapsing leaves the loaded children and
    // their 'loaded' status in place for useTreeStore.expand to see.
    it('keeps loaded children across a collapse and re-expand', () => {
        const s = loadedTree();
        const collapsed = reducer(s, {type: 'node_expanded', key: nsKey('sales'), expanded: false});
        const reexpanded = reducer(collapsed, {
            type: 'node_expanded',
            key: nsKey('sales'),
            expanded: true,
        });

        const node = reexpanded.byKey[nsKey('sales')];
        if (node.kind !== 'namespace') throw new Error('expected a namespace node');
        expect(node.childNamespaces).toEqual([nsKey('sales', 'eu')]);
        expect(node.childTables).toEqual([keyOfTable(['sales'], 'orders')]);
        expect(node.namespacesStatus).toBe('loaded');
        expect(node.tablesStatus).toBe('loaded');
    });

    it('fills the two child slots independently', () => {
        let s = reducer(initialState(), {
            type: 'root_loaded',
            items: [nsKey('sales')],
            nodes: [newNamespaceNode(['sales'])],
        });
        s = reducer(s, {
            type: 'node_tables_loaded',
            key: nsKey('sales'),
            items: [keyOfTable(['sales'], 'orders')],
            nodes: [{kind: 'table', namespace: ['sales'], name: 'orders'}],
        });

        const node = s.byKey[nsKey('sales')];
        if (node.kind !== 'namespace') throw new Error('expected a namespace node');
        // Tables landing first must not mark namespaces loaded — otherwise an
        // expand would skip the namespace fetch entirely.
        expect(node.tablesStatus).toBe('loaded');
        expect(node.namespacesStatus).toBe('idle');
    });

    it('does not clobber an already-known node when a parent reloads', () => {
        const s = loadedTree();
        const before = s.byKey[nsKey('sales', 'eu')];

        // Re-announcing the child, as a refreshed parent does, must keep the
        // existing node — replacing it would drop its expanded state and its
        // own loaded children.
        const after = reducer(s, {
            type: 'node_namespaces_loaded',
            key: nsKey('sales'),
            items: [nsKey('sales', 'eu')],
            nodes: [newNamespaceNode(['sales', 'eu'])],
        });
        expect(after.byKey[nsKey('sales', 'eu')]).toBe(before);
    });

    it('resets a node to idle on clear_children so a refresh re-fetches', () => {
        const s = reducer(loadedTree(), {type: 'node_clear_children', key: nsKey('sales')});
        const node = s.byKey[nsKey('sales')];
        if (node.kind !== 'namespace') throw new Error('expected a namespace node');
        expect(node.namespacesStatus).toBe('idle');
        expect(node.tablesStatus).toBe('idle');
        expect(node.childNamespaces).toEqual([]);
        expect(node.childTables).toEqual([]);
        expect(node.expanded).toBe(true); // refresh keeps the node open
    });

    it('ignores node actions for keys it does not know', () => {
        const s = loadedTree();
        expect(reducer(s, {type: 'node_expanded', key: nsKey('ghost'), expanded: true})).toBe(s);
        expect(reducer(s, {type: 'node_loading', key: nsKey('ghost')})).toBe(s);
        expect(reducer(s, {type: 'node_error', key: nsKey('ghost'), error: 'x'})).toBe(s);
    });

    it('ignores node actions aimed at a table', () => {
        const s = loadedTree();
        const tbl = keyOfTable(['sales'], 'orders');
        expect(reducer(s, {type: 'node_expanded', key: tbl, expanded: true})).toBe(s);
    });

    it('clears the error when a reload starts', () => {
        let s = reducer(loadedTree(), {
            type: 'node_error',
            key: nsKey('sales'),
            error: 'Catalog unreachable',
        });
        let node = s.byKey[nsKey('sales')];
        if (node.kind !== 'namespace') throw new Error('expected a namespace node');
        expect(node.error).toBe('Catalog unreachable');

        s = reducer(s, {type: 'node_loading', key: nsKey('sales')});
        node = s.byKey[nsKey('sales')];
        if (node.kind !== 'namespace') throw new Error('expected a namespace node');
        expect(node.error).toBeNull();
    });

    it('tracks the focused key for roving tabIndex', () => {
        const s = reducer(loadedTree(), {type: 'focus_set', key: nsKey('sales')});
        expect(s.focusedKey).toBe(nsKey('sales'));
        expect(reducer(s, {type: 'focus_set', key: null}).focusedKey).toBeNull();
    });
});

describe('flattenVisible', () => {
    it('lists children only while the parent is expanded', () => {
        const s = loadedTree();
        expect(flattenVisible(s)).toEqual([
            nsKey('sales'),
            nsKey('sales', 'eu'),
            keyOfTable(['sales'], 'orders'),
        ]);

        const collapsed = reducer(s, {type: 'node_expanded', key: nsKey('sales'), expanded: false});
        expect(flattenVisible(collapsed)).toEqual([nsKey('sales')]);
    });

    it('puts child namespaces before child tables', () => {
        const order = flattenVisible(loadedTree());
        expect(order.indexOf(nsKey('sales', 'eu'))).toBeLessThan(
            order.indexOf(keyOfTable(['sales'], 'orders')),
        );
    });

    it('skips keys with no node behind them', () => {
        const s = loadedTree();
        const withDangling: State = {
            ...s,
            root: {...s.root, items: [...s.root.items, nsKey('vanished')]},
        };
        expect(flattenVisible(withDangling)).not.toContain(nsKey('vanished'));
    });
});

describe('parentKey', () => {
    it('walks a table up to its namespace and a namespace up to its parent', () => {
        const s = loadedTree();
        expect(parentKey(s, keyOfTable(['sales'], 'orders'))).toBe(nsKey('sales'));
        expect(parentKey(s, nsKey('sales', 'eu'))).toBe(nsKey('sales'));
    });

    it('returns null at the root and for unknown keys', () => {
        const s = loadedTree();
        expect(parentKey(s, nsKey('sales'))).toBeNull();
        expect(parentKey(s, nsKey('ghost'))).toBeNull();
    });

    it('returns null when the parent namespace is not in the tree', () => {
        // A palette jump can put a deep table in byKey without its ancestors.
        const orphan: TreeNode = {kind: 'table', namespace: ['unloaded', 'ns'], name: 'x'};
        const key = keyOfTable(['unloaded', 'ns'], 'x');
        const s: State = {...initialState(), byKey: {[key]: orphan}};
        expect(parentKey(s, key)).toBeNull();
    });
});
