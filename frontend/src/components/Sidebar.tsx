import {useRef} from 'react';
import {connections} from '../../wailsjs/go/models';
import {NamespaceTree} from './NamespaceTree';
import {COMMANDS} from '../shortcuts/commands';
import {formatShortcut} from '../shortcuts/keys';
import {useCommand} from '../shortcuts/registry';
import type {TreePath} from '../state/treeStore';
import {
    cycleThemePreference,
    useTheme,
    type ResolvedTheme,
    type ThemePreference,
} from '../theme';

const THEME_GLYPH: Record<ThemePreference, string> = {
    system: '◐',
    light: '☀',
    dark: '☾',
};

/**
 * The button cycles rather than toggles, so the label has to say both what the
 * current setting is and — for 'system' — what it currently resolves to.
 */
function themeLabel(preference: ThemePreference, resolved: ResolvedTheme): string {
    if (preference === 'system') return `Theme: system (${resolved})`;
    return `Theme: ${preference}`;
}

type Props = {
    connectionsList: connections.Connection[];
    selected: string | null;
    onSelect: (name: string | null) => void;
    onManage: () => void;
    onOpenHelp: () => void;
    selectedTable: {namespace: TreePath; name: string} | null;
    onSelectTable: (t: {namespace: TreePath; name: string}) => void;
    /** Bumped to ask the tree to open down to the selected table. */
    revealNonce?: number;
};

export function Sidebar({
    connectionsList,
    selected,
    onSelect,
    onManage,
    onOpenHelp,
    selectedTable,
    onSelectTable,
    revealNonce,
}: Props) {
    const pickerRef = useRef<HTMLSelectElement>(null);
    const paletteKeys = formatShortcut(COMMANDS.find((c) => c.id === 'palette.open')!.keys[0]);
    const {preference, resolved} = useTheme();

    // Focus only. There is no portable way to pop a native <select> open —
    // showPicker() is Chromium-only, so WebKitGTK and WKWebView would ignore
    // it. The user arrows or types from here.
    useCommand('focus.connectionPicker', () => pickerRef.current?.focus());
    useCommand('theme.cycle', cycleThemePreference);

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
                    className="sidebar-icon-button"
                    onClick={cycleThemePreference}
                    aria-label={themeLabel(preference, resolved)}
                    title={`${themeLabel(preference, resolved)} (${formatShortcut(
                        COMMANDS.find((c) => c.id === 'theme.cycle')!.keys[0],
                    ).join('+')})`}
                >
                    <span aria-hidden="true">{THEME_GLYPH[preference]}</span>
                </button>
                <button
                    type="button"
                    className="sidebar-icon-button"
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
                revealNonce={revealNonce}
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
