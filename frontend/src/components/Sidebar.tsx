import {connections} from '../../wailsjs/go/models';
import {NamespaceTree} from './NamespaceTree';
import type {TreePath} from '../state/treeStore';

type Props = {
    connectionsList: connections.Connection[];
    selected: string | null;
    onSelect: (name: string | null) => void;
    onManage: () => void;
    selectedTable: {namespace: TreePath; name: string} | null;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
};

export function Sidebar({
    connectionsList,
    selected,
    onSelect,
    onManage,
    selectedTable,
    onSelectTable,
}: Props) {
    return (
        <aside className="sidebar">
            <div className="sidebar-header">
                <select
                    className="connection-picker"
                    value={selected ?? ''}
                    onChange={(e) => onSelect(e.target.value || null)}
                >
                    <option value="">— choose a connection —</option>
                    {connectionsList.map((c) => (
                        <option key={c.name} value={c.name}>
                            {c.name}
                        </option>
                    ))}
                </select>
                <button type="button" onClick={onManage}>
                    Manage…
                </button>
            </div>
            <NamespaceTree
                connName={selected}
                selectedTable={selectedTable}
                onSelectTable={onSelectTable}
            />
        </aside>
    );
}
