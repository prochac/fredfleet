import {keyOfNamespace, NamespaceNode, TableNode, TreePath} from '../state/treeStore';
import {Pending} from './Pending';
import type {NodeKey, TreeNode as TreeNodeT} from '../state/treeStore';

type SelectedTable = {namespace: TreePath; name: string} | null;

type TreeNodeProps = {
    nodeKey: NodeKey;
    byKey: Record<NodeKey, TreeNodeT>;
    depth: number;
    selectedTable: SelectedTable;
    onExpand: (path: TreePath) => void;
    onRefresh: (path: TreePath) => void;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
};

export function TreeNode({
    nodeKey,
    byKey,
    depth,
    selectedTable,
    onExpand,
    onRefresh,
    onSelectTable,
}: TreeNodeProps) {
    const node = byKey[nodeKey];
    if (!node) return null;
    if (node.kind === 'table') {
        return (
            <TableRow
                node={node}
                depth={depth}
                selected={
                    selectedTable !== null &&
                    selectedTable.name === node.name &&
                    pathsEqual(selectedTable.namespace, node.namespace)
                }
                onSelect={onSelectTable}
            />
        );
    }
    return (
        <NamespaceRow
            node={node}
            byKey={byKey}
            depth={depth}
            selectedTable={selectedTable}
            onExpand={onExpand}
            onRefresh={onRefresh}
            onSelectTable={onSelectTable}
        />
    );
}

function NamespaceRow({
    node,
    byKey,
    depth,
    selectedTable,
    onExpand,
    onRefresh,
    onSelectTable,
}: {
    node: NamespaceNode;
    byKey: Record<NodeKey, TreeNodeT>;
    depth: number;
    selectedTable: SelectedTable;
    onExpand: (path: TreePath) => void;
    onRefresh: (path: TreePath) => void;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
}) {
    const name = node.path.length > 0 ? node.path[node.path.length - 1] : '(root)';
    const isLoading = node.namespacesStatus === 'loading' || node.tablesStatus === 'loading';
    const isLoaded = node.namespacesStatus === 'loaded' && node.tablesStatus === 'loaded';
    const hasError = node.namespacesStatus === 'error' || node.tablesStatus === 'error';

    return (
        <div className="tree-node">
            <div
                className="tree-row"
                style={{paddingLeft: indentPx(depth)}}
                role="treeitem"
                aria-expanded={node.expanded}
                onClick={() => onExpand(node.path)}
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
                                onExpand={onExpand}
                                onRefresh={onRefresh}
                                onSelectTable={onSelectTable}
                            />
                        ))}
                        {node.childTables.map((childKey) => (
                            <TreeNode
                                key={childKey}
                                nodeKey={childKey}
                                byKey={byKey}
                                depth={depth + 1}
                                selectedTable={selectedTable}
                                onExpand={onExpand}
                                onRefresh={onRefresh}
                                onSelectTable={onSelectTable}
                            />
                        ))}
                    </Pending>
                </div>
            )}
        </div>
    );
}

function TableRow({
    node,
    depth,
    selected,
    onSelect,
}: {
    node: TableNode;
    depth: number;
    selected: boolean;
    onSelect: (t: {namespace: TreePath; name: string}) => void;
}) {
    return (
        <div
            className={'tree-row leaf' + (selected ? ' selected' : '')}
            style={{paddingLeft: indentPx(depth)}}
            role="treeitem"
            onClick={() => onSelect({namespace: node.namespace, name: node.name})}
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
export {keyOfNamespace};
