import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {COMMANDS, type CommandDef} from '../shortcuts/commands';
import {fuzzyMatch} from '../shortcuts/fuzzy';
import {formatShortcut} from '../shortcuts/keys';
import {useIsCommandLive, useRunCommand} from '../shortcuts/registry';
import {useTableIndex, type TableTarget} from '../state/tableIndex';
import type {TreePath} from '../state/treeStore';
import {Modal} from './Modal';

type Props = {
    onClose: () => void;
    onOpenTable: (t: {namespace: TreePath; name: string}) => void;
};

type Item =
    | {kind: 'command'; key: string; command: CommandDef; score: number; positions: number[]}
    | {kind: 'table'; key: string; target: TableTarget; score: number; positions: number[]};

const MAX_RESULTS = 50;
const COMMAND_PREFIX = '>';

export function CommandPalette({onClose, onOpenTable}: Props) {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const runCommand = useRunCommand();
    const isLive = useIsCommandLive();
    const {tables, complete} = useTableIndex();
    const listRef = useRef<HTMLUListElement>(null);

    const commandsOnly = query.startsWith(COMMAND_PREFIX);
    const term = commandsOnly ? query.slice(COMMAND_PREFIX.length).trim() : query.trim();

    const items = useMemo<Item[]>(() => {
        const out: Item[] = [];

        for (const c of COMMANDS) {
            if (c.inPalette === false || !isLive(c.id)) continue;
            const m = fuzzyMatch(term, c.title);
            if (!m) continue;
            out.push({kind: 'command', key: `c:${c.id}`, command: c, ...m});
        }

        if (!commandsOnly) {
            for (const t of tables) {
                const m = fuzzyMatch(term, t.label);
                if (!m) continue;
                // Tables outrank commands on a non-empty query — jumping to a
                // table is the common reason to reach for the palette.
                out.push({
                    kind: 'table',
                    key: `t:${t.label}`,
                    target: t,
                    score: m.score + (term ? 20 : -1000),
                    positions: m.positions,
                });
            }
        }

        out.sort((a, b) => b.score - a.score);
        return out.slice(0, MAX_RESULTS);
    }, [term, commandsOnly, tables, isLive]);

    useEffect(() => {
        setActive(0);
    }, [query]);

    useEffect(() => {
        listRef.current
            ?.querySelector('[aria-selected="true"]')
            ?.scrollIntoView({block: 'nearest'});
    }, [active, items]);

    function choose(item: Item) {
        // Close first: a command may open a dialog, and the palette must never
        // sit on top of one.
        onClose();
        if (item.kind === 'table') onOpenTable({namespace: item.target.namespace, name: item.target.name});
        else runCommand(item.command.id);
    }

    function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const item = items[active];
            if (item) choose(item);
        }
    }

    const activeId = items[active] ? `palette-opt-${items[active].key}` : undefined;

    return (
        <Modal
            className="command-palette"
            onCancel={onClose}
            labelledBy="palette-title"
            initialFocus=".palette-input"
        >
            <h2 id="palette-title" className="visually-hidden">
                Command palette
            </h2>
            <input
                className="palette-input"
                type="text"
                role="combobox"
                aria-expanded
                aria-controls="palette-list"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                placeholder="Jump to a table, or type > for commands…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
            />

            <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
                {items.map((item, i) => (
                    <li
                        key={item.key}
                        id={`palette-opt-${item.key}`}
                        role="option"
                        aria-selected={i === active}
                        className={'palette-row' + (i === active ? ' active' : '')}
                        onMouseDown={(e) => {
                            // Keep focus in the input; mousedown would blur it.
                            e.preventDefault();
                            choose(item);
                        }}
                        onMouseEnter={() => setActive(i)}
                    >
                        {item.kind === 'table' ? (
                            <>
                                <span className="palette-label">
                                    {highlight(item.target.label, item.positions)}
                                </span>
                                <span className="palette-meta">table</span>
                            </>
                        ) : (
                            <>
                                <span className="palette-label">
                                    {highlight(item.command.title, item.positions)}
                                </span>
                                <span className="palette-meta">
                                    {item.command.keys.length > 0
                                        ? formatShortcut(item.command.keys[0]).map((k) => (
                                              <kbd key={k}>{k}</kbd>
                                          ))
                                        : item.command.group}
                                </span>
                            </>
                        )}
                    </li>
                ))}
            </ul>

            {items.length === 0 && (
                <p className="palette-empty">
                    {commandsOnly
                        ? `No command matches “${term}”.`
                        : `No loaded table or command matches “${term}”.`}
                </p>
            )}

            <p className="palette-footer">
                {complete
                    ? `Searching all ${tables.length} tables.`
                    : `Searching ${tables.length} loaded ${
                          tables.length === 1 ? 'table' : 'tables'
                      } — expand more namespaces in the sidebar to index them.`}
            </p>
        </Modal>
    );
}

function highlight(text: string, positions: number[]) {
    if (positions.length === 0) return text;
    const set = new Set(positions);
    const out: (string | JSX.Element)[] = [];
    let run = '';
    let markRun = '';

    const flush = () => {
        if (run) {
            out.push(run);
            run = '';
        }
        if (markRun) {
            out.push(<mark key={out.length}>{markRun}</mark>);
            markRun = '';
        }
    };

    for (let i = 0; i < text.length; i++) {
        if (set.has(i)) {
            if (run) {
                out.push(run);
                run = '';
            }
            markRun += text[i];
        } else {
            if (markRun) {
                out.push(<mark key={out.length}>{markRun}</mark>);
                markRun = '';
            }
            run += text[i];
        }
    }
    flush();
    return out;
}
