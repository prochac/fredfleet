import {useRef} from 'react';
import {connections} from '../../wailsjs/go/models';
import {NamespaceTree} from './NamespaceTree';
import {COMMANDS} from '../shortcuts/commands';
import {formatShortcut} from '../shortcuts/keys';
import {useCommand} from '../shortcuts/registry';
import type {TreePath} from '../state/treeStore';

type Props = {
    connectionsList: connections.Connection[];
    selected: string | null;
    onSelect: (name: string | null) => void;
    onManage: () => void;
    onOpenHelp: () => void;
    selectedTable: {namespace: TreePath; name: string} | null;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
};

export function Sidebar({
    connectionsList,
    selected,
    onSelect,
    onManage,
    onOpenHelp,
    selectedTable,
    onSelectTable,
}: Props) {
    const pickerRef = useRef<HTMLSelectElement>(null);
    const paletteKeys = formatShortcut(COMMANDS.find((c) => c.id === 'palette.open')!.keys[0]);

    // Focus only. There is no portable way to pop a native <select> open —
    // showPicker() is Chromium-only, so WebKitGTK and WKWebView would ignore
    // it. The user arrows or types from here.
    useCommand('focus.connectionPicker', () => pickerRef.current?.focus());

    return (
        <aside className="sidebar">
            <div className="sidebar-header">
                <select
                    ref={pickerRef}
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
                <button
                    type="button"
                    className="sidebar-help-button"
                    onClick={onOpenHelp}
                    aria-label="Keyboard shortcuts"
                    title="Keyboard shortcuts (press ?)"
                >
                    ?
                </button>
            </div>
            <NamespaceTree
                connName={selected}
                selectedTable={selectedTable}
                onSelectTable={onSelectTable}
            />
            <footer className="sidebar-footer">
                <span className="kbd-inline">
                    <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>→</kbd> expand · {paletteKeys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                    ))} jump · <kbd>?</kbd> help
                </span>
            </footer>
        </aside>
    );
}
