import {COMMANDS, COMMAND_GROUPS, type CommandGroup} from '../shortcuts/commands';
import {formatChord, formatShortcut} from '../shortcuts/keys';
import {Modal} from './Modal';

type Props = {
    onClose: () => void;
};

/**
 * One row. `keys` holds alternative bindings; each is a list of <kbd> tokens.
 * `chords` holds sequences, rendered with "then" between the steps because
 * pressing them together is exactly what does not work.
 */
type Hint = {keys: string[][]; chords?: string[][]; description: string};

/**
 * Rows that describe built-in widget behaviour rather than a registered
 * command — ARIA tree/tablist navigation, which the browser and the widgets
 * own. Everything with a real key binding is generated from COMMANDS instead,
 * so the dialog and the dispatcher cannot drift apart.
 */
const TREE_HINTS: Hint[] = [
    {keys: [['↑'], ['↓'], ['J'], ['K']], description: 'Move between visible rows'},
    {keys: [['→'], ['L']], description: 'Expand namespace, or move to first child'},
    {keys: [['←'], ['H']], description: 'Collapse namespace, or move to parent'},
    {
        keys: [['Home'], ['End'], ['Shift', 'G']],
        chords: [['G', 'G']],
        description: 'Jump to first / last visible row',
    },
    {keys: [['Enter'], ['Space']], description: 'Toggle a namespace, or open a table'},
    {
        keys: [],
        description:
            'While the tree has focus, G starts a tree motion — the G sequences below are for elsewhere',
    },
];

const TABS_HINTS: Hint[] = [
    {keys: [['←'], ['→']], description: 'Switch between Preview / Schema / Partition / Properties'},
    {keys: [['Home'], ['End']], description: 'Jump to first / last tab'},
];

const FOCUS_HINTS: Hint[] = [
    {keys: [['Tab'], ['Shift', 'Tab']], description: 'Move focus between sidebar, tabs, and panel controls'},
    {keys: [['Esc']], description: 'Close the current dialog'},
];

function commandHints(group: CommandGroup): Hint[] {
    return COMMANDS.filter(
        (c) => c.group === group && (c.keys.length > 0 || (c.chords?.length ?? 0) > 0),
    ).map((c) => ({
        keys: c.keys.map(formatShortcut),
        chords: c.chords?.map(formatChord),
        description: c.title,
    }));
}

export function KeyboardHelpModal({onClose}: Props) {
    return (
        <Modal onCancel={onClose} labelledBy="kbd-help-title">
            <h2 id="kbd-help-title">Keyboard shortcuts</h2>

            {COMMAND_GROUPS.map((group) => {
                const items = commandHints(group);
                if (items.length === 0) return null;
                return <Section key={group} title={group} items={items} />;
            })}

            <Section title="Focus" items={FOCUS_HINTS} />
            <Section title="Namespace tree" items={TREE_HINTS} />
            <Section title="Table sections" items={TABS_HINTS} />

            <div className="modal-actions">
                <span className="modal-kbd-hint">
                    <kbd>Esc</kbd> to close
                </span>
                <button type="button" className="primary" onClick={onClose}>
                    Close
                </button>
            </div>
        </Modal>
    );
}

function Section({title, items}: {title: string; items: Hint[]}) {
    return (
        <section className="kbd-section">
            <h3>{title}</h3>
            <dl className="kbd-list">
                {items.map((s) => (
                    <div key={s.description} className="kbd-row">
                        <dt>
                            {s.keys.map((combo, i) => (
                                <span key={combo.join('+')}>
                                    {i > 0 && <span className="kbd-or"> / </span>}
                                    {combo.map((k) => (
                                        <kbd key={k}>{k}</kbd>
                                    ))}
                                </span>
                            ))}
                            {(s.chords ?? []).map((chord, i) => (
                                <span key={'chord-' + chord.join('-')}>
                                    {(i > 0 || s.keys.length > 0) && (
                                        <span className="kbd-or"> / </span>
                                    )}
                                    {chord.map((step, j) => (
                                        <span key={step + j}>
                                            {j > 0 && <span className="kbd-then"> then </span>}
                                            <kbd>{step}</kbd>
                                        </span>
                                    ))}
                                </span>
                            ))}
                        </dt>
                        <dd>{s.description}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
