import type {KeySpec} from './keys';

export type CommandId =
    | 'palette.open'
    | 'help.open'
    | 'connections.manage'
    | 'connections.new'
    | 'theme.cycle'
    | 'focus.tree'
    | 'focus.connectionPicker'
    | 'focus.filter'
    | 'tab.preview'
    | 'tab.schema'
    | 'tab.partition'
    | 'tab.properties'
    | 'refresh.scope'
    | 'refresh.treeRoot'
    | 'filters.applyNow'
    | 'filters.clear';

export type CommandGroup = 'Global' | 'Navigation' | 'Data';

export type CommandDef = {
    id: CommandId;
    /** Label shown in the help dialog and the command palette. */
    title: string;
    group: CommandGroup;
    /** Empty means palette-only — no key binding. */
    keys: KeySpec[];
    /** Fire even when focus is in a form control. Defaults to true for Mod-chorded keys. */
    firesWhileTyping?: boolean;
    /**
     * 'app' (default) fires only with no overlay up. 'palette' also fires while
     * the command palette is open, which is what lets Mod+K toggle it shut.
     * Nothing fires over a modal dialog — it would fight the focus trap or
     * mutate state the user can't see.
     */
    scope?: 'app' | 'palette';
    /** Offer in the command palette. Defaults to true. */
    inPalette?: boolean;
    /**
     * Swallow the key even when no handler is registered. Only for chords that
     * shadow a destructive browser default — Mod+R / F5 reload the webview and
     * destroy all app state, which must never happen just because the relevant
     * panel wasn't mounted.
     */
    alwaysPreventDefault?: boolean;
};

/**
 * The single source of truth for bindings. The keydown dispatcher, the help
 * dialog, and the command palette all read this list, so a shortcut cannot
 * exist without being documented.
 *
 * A command with no registered handler is an inert binding: the dispatcher
 * leaves the keystroke to the browser rather than swallowing it.
 */
export const COMMANDS: CommandDef[] = [
    {
        id: 'palette.open',
        title: 'Open the command palette',
        group: 'Global',
        keys: [{key: 'k', mod: true}],
        scope: 'palette',
        // Listed as its own entry in the help dialog; offering it inside
        // itself would be noise.
        inPalette: false,
    },
    {
        id: 'help.open',
        title: 'Show keyboard shortcuts',
        group: 'Global',
        // '?' is Shift+/ on a US layout and Shift+, on a Czech one, so it must
        // match by character and tolerate Shift.
        keys: [{key: '?', shift: 'any'}],
        firesWhileTyping: false,
    },
    // Both stay suppressed while a dialog is open: firing over the edit form
    // would swap it out and silently discard whatever was typed into it.
    {
        id: 'connections.manage',
        title: 'Manage connections',
        group: 'Global',
        keys: [{code: 'Comma', mod: true}],
    },
    {
        id: 'connections.new',
        title: 'New connection',
        group: 'Global',
        keys: [{key: 'n', mod: true}],
    },
    {
        id: 'theme.cycle',
        title: 'Switch theme (system → light → dark)',
        group: 'Global',
        keys: [{key: 'd', mod: true, shift: true}],
    },

    // Digit chords match on `code` so they survive the Czech number row, and
    // leave Shift unconstrained because typing a digit there needs Shift —
    // a user may well press it out of habit. Nothing binds Mod+Shift+digit.
    {
        id: 'focus.tree',
        title: 'Focus the namespace tree',
        group: 'Navigation',
        keys: [{code: 'Digit0', mod: true, shift: 'any'}],
    },
    {
        id: 'tab.preview',
        title: 'Go to Preview',
        group: 'Navigation',
        keys: [{code: 'Digit1', mod: true, shift: 'any'}],
    },
    {
        id: 'tab.schema',
        title: 'Go to Schema',
        group: 'Navigation',
        keys: [{code: 'Digit2', mod: true, shift: 'any'}],
    },
    {
        id: 'tab.partition',
        title: 'Go to Partition spec',
        group: 'Navigation',
        keys: [{code: 'Digit3', mod: true, shift: 'any'}],
    },
    {
        id: 'tab.properties',
        title: 'Go to Properties',
        group: 'Navigation',
        keys: [{code: 'Digit4', mod: true, shift: 'any'}],
    },
    {
        id: 'focus.connectionPicker',
        title: 'Focus the connection picker',
        group: 'Navigation',
        keys: [{key: 'l', mod: true}],
    },
    {
        id: 'focus.filter',
        title: 'Focus the preview filter bar',
        group: 'Navigation',
        keys: [{key: 'f', mod: true}],
        // Shadows the webview's find-in-page, which we have no use for; the
        // filter bar is this app's find. Swallow it even with no table open,
        // otherwise find-in-page opens over the UI.
        alwaysPreventDefault: true,
    },

    {
        id: 'refresh.scope',
        title: 'Refresh the current view',
        group: 'Data',
        keys: [
            {key: 'r', mod: true},
            {key: 'F5'},
        ],
        // Mod+R and F5 reload the whole webview, wiping every bit of app state
        // and killing the Vite HMR session under `wails dev`. Always swallow.
        alwaysPreventDefault: true,
    },
    {
        id: 'refresh.treeRoot',
        title: 'Reload the namespace tree from the root',
        group: 'Data',
        keys: [{key: 'r', mod: true, shift: true}],
        alwaysPreventDefault: true,
    },
    {
        id: 'filters.applyNow',
        title: 'Apply filters now',
        group: 'Data',
        keys: [{key: 'Enter', mod: true}],
    },
    {
        id: 'filters.clear',
        title: 'Clear all preview filters',
        group: 'Data',
        keys: [],
    },
];

export const COMMAND_GROUPS: CommandGroup[] = ['Global', 'Navigation', 'Data'];
