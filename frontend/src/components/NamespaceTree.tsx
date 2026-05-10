import {useTreeStore, TreePath} from '../state/treeStore';
import {TreeNode} from './TreeNode';
import {Pending} from './Pending';

type Props = {
    connName: string | null;
    selectedTable: {namespace: TreePath; name: string} | null;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
};

export function NamespaceTree({connName, selectedTable, onSelectTable}: Props) {
    const {state, expand, refreshRoot, refreshNode} = useTreeStore(connName);

    if (!connName) {
        return <p className="tree-empty">Pick a connection to start browsing.</p>;
    }

    const isLoading = state.root.status === 'loading' || state.root.status === 'idle';
    const isError = state.root.status === 'error';
    const isLoaded = state.root.status === 'loaded';

    return (
        <div className="tree" role="tree">
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
                        onExpand={expand}
                        onRefresh={refreshNode}
                        onSelectTable={onSelectTable}
                    />
                ))}
            </Pending>
        </div>
    );
}
