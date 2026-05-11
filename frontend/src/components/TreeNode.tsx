import {keyOfNamespace, keyOfTable, NamespaceNode, TableNode, TreePath} from '../state/treeStore';
import {Pending} from './Pending';
import type {NodeKey, TreeNode as TreeNodeT} from '../state/treeStore';

type SelectedTable = {namespace: TreePath; name: string} | null;

type TreeNodeProps = {
    nodeKey: NodeKey;
    byKey: Record<NodeKey, TreeNodeT>;
    depth: number;
    selectedTable: SelectedTable;
    focusedKey: NodeKey | null;
    registerRow: (key: NodeKey, el: HTMLDivElement | null) => void;
    onExpand: (path: TreePath) => void;
    onRefresh: (path: TreePath) => void;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
    onFocusNode: (key: NodeKey) => void;
};

export function TreeNode(props: TreeNodeProps) {
    const node = props.byKey[props.nodeKey];
    if (!node) return null;
    if (node.kind === 'table') {
        return (
            <TableRow
                nodeKey={props.nodeKey}
                node={node}
                depth={props.depth}
                selected={
                    props.selectedTable !== null &&
                    props.selectedTable.name === node.name &&
                    pathsEqual(props.selectedTable.namespace, node.namespace)
                }
                focused={props.focusedKey === props.nodeKey}
                registerRow={props.registerRow}
                onSelect={props.onSelectTable}
                onFocusNode={props.onFocusNode}
            />
        );
    }
    return (
        <NamespaceRow
            nodeKey={props.nodeKey}
            node={node}
            byKey={props.byKey}
            depth={props.depth}
            selectedTable={props.selectedTable}
            focusedKey={props.focusedKey}
            registerRow={props.registerRow}
            onExpand={props.onExpand}
            onRefresh={props.onRefresh}
            onSelectTable={props.onSelectTable}
            onFocusNode={props.onFocusNode}
        />
    );
}

function NamespaceRow({
    nodeKey,
    node,
    byKey,
    depth,
    selectedTable,
    focusedKey,
    registerRow,
    onExpand,
    onRefresh,
    onSelectTable,
    onFocusNode,
}: {
    nodeKey: NodeKey;
    node: NamespaceNode;
    byKey: Record<NodeKey, TreeNodeT>;
    depth: number;
    selectedTable: SelectedTable;
    focusedKey: NodeKey | null;
    registerRow: (key: NodeKey, el: HTMLDivElement | null) => void;
    onExpand: (path: TreePath) => void;
    onRefresh: (path: TreePath) => void;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
    onFocusNode: (key: NodeKey) => void;
}) {
    const name = node.path.length > 0 ? node.path[node.path.length - 1] : '(root)';
    const isLoading = node.namespacesStatus === 'loading' || node.tablesStatus === 'loading';
    const isLoaded = node.namespacesStatus === 'loaded' && node.tablesStatus === 'loaded';
    const hasError = node.namespacesStatus === 'error' || node.tablesStatus === 'error';
    const isFocused = focusedKey === nodeKey;

    return (
        <div className="tree-node">
            <div
                ref={(el) => registerRow(nodeKey, el)}
                className="tree-row"
                style={{paddingLeft: indentPx(depth)}}
                role="treeitem"
                aria-expanded={node.expanded}
                aria-level={depth + 1}
                tabIndex={isFocused ? 0 : -1}
                onClick={() => {
                    onFocusNode(nodeKey);
                    onExpand(node.path);
                }}
                onFocus={() => {
                    if (focusedKey !== nodeKey) onFocusNode(nodeKey);
                }}
            >
                <span className="tree-toggle" aria-hidden>
                    {node.expanded ? '▾' : '▸'}
                </span>
                <span className="tree-icon" aria-hidden>📁</span>
                <span className="tree-label">{name}</span>
            </div>
            {node.expanded && (
                <div className="tree-children">
                    <Pending
                        loading={isLoading && !isLoaded}
                        error={hasError ? node.error : null}
                        empty={isLoaded && node.childNamespaces.length === 0 && node.childTables.length === 0}
                        emptyMessage="(empty)"
                        onRetry={() => onRefresh(node.path)}
                    >
                        {node.childNamespaces.map((childKey) => (
                            <TreeNode
                                key={childKey}
                                nodeKey={childKey}
                                byKey={byKey}
                                depth={depth + 1}
                                selectedTable={selectedTable}
                                focusedKey={focusedKey}
                                registerRow={registerRow}
                                onExpand={onExpand}
                                onRefresh={onRefresh}
                                onSelectTable={onSelectTable}
                                onFocusNode={onFocusNode}
                            />
                        ))}
                        {node.childTables.map((childKey) => (
                            <TreeNode
                                key={childKey}
                                nodeKey={childKey}
                                byKey={byKey}
                                depth={depth + 1}
                                selectedTable={selectedTable}
                                focusedKey={focusedKey}
                                registerRow={registerRow}
                                onExpand={onExpand}
                                onRefresh={onRefresh}
                                onSelectTable={onSelectTable}
                                onFocusNode={onFocusNode}
                            />
                        ))}
                    </Pending>
                </div>
            )}
        </div>
    );
}

function TableRow({
    nodeKey,
    node,
    depth,
    selected,
    focused,
    registerRow,
    onSelect,
    onFocusNode,
}: {
    nodeKey: NodeKey;
    node: TableNode;
    depth: number;
    selected: boolean;
    focused: boolean;
    registerRow: (key: NodeKey, el: HTMLDivElement | null) => void;
    onSelect: (t: {namespace: TreePath; name: string}) => void;
    onFocusNode: (key: NodeKey) => void;
}) {
    return (
        <div
            ref={(el) => registerRow(nodeKey, el)}
            className={'tree-row leaf' + (selected ? ' selected' : '')}
            style={{paddingLeft: indentPx(depth)}}
            role="treeitem"
            aria-selected={selected}
            aria-level={depth + 1}
            tabIndex={focused ? 0 : -1}
            onClick={() => {
                onFocusNode(nodeKey);
                onSelect({namespace: node.namespace, name: node.name});
            }}
            onFocus={() => {
                if (!focused) onFocusNode(nodeKey);
            }}
        >
            <span className="tree-toggle" aria-hidden></span>
            <span className="tree-icon" aria-hidden>•</span>
            <span className="tree-label">{node.name}</span>
        </div>
    );
}

function indentPx(depth: number): number {
    return 8 + depth * 16;
}

function pathsEqual(a: TreePath, b: TreePath): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// re-export for layout component clarity
export {keyOfNamespace, keyOfTable};
