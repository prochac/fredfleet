import {Modal} from './Modal';

type Props = {
    onClose: () => void;
};

type Shortcut = {keys: string[]; description: string};

const TREE_SHORTCUTS: Shortcut[] = [
    {keys: ['↑', '↓'], description: 'Move between visible rows'},
    {keys: ['→'], description: 'Expand namespace, or move to first child'},
    {keys: ['←'], description: 'Collapse namespace, or move to parent'},
    {keys: ['Home', 'End'], description: 'Jump to first / last visible row'},
    {keys: ['Enter', 'Space'], description: 'Toggle a namespace, or open a table'},
];

const TABS_SHORTCUTS: Shortcut[] = [
    {keys: ['←', '→'], description: 'Switch between Preview / Schema / Partition / Properties'},
    {keys: ['Home', 'End'], description: 'Jump to first / last tab'},
];

const GLOBAL_SHORTCUTS: Shortcut[] = [
    {keys: ['Tab', 'Shift+Tab'], description: 'Move focus between sidebar, tabs, and panel controls'},
    {keys: ['?'], description: 'Open this shortcuts dialog'},
    {keys: ['Esc'], description: 'Close the current dialog'},
];

export function KeyboardHelpModal({onClose}: Props) {
    return (
        <Modal onCancel={onClose} labelledBy="kbd-help-title">
            <h2 id="kbd-help-title">Keyboard shortcuts</h2>

            <Section title="Global" items={GLOBAL_SHORTCUTS} />
            <Section title="Namespace tree" items={TREE_SHORTCUTS} />
            <Section title="Table sections" items={TABS_SHORTCUTS} />

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

function Section({title, items}: {title: string; items: Shortcut[]}) {
    return (
        <section className="kbd-section">
            <h3>{title}</h3>
            <dl className="kbd-list">
                {items.map((s) => (
                    <div key={s.description} className="kbd-row">
                        <dt>
                            {s.keys.map((k, i) => (
                                <span key={k}>
                                    {i > 0 && <span className="kbd-or"> / </span>}
                                    <kbd>{k}</kbd>
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
