import {useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement} from 'react';
import {COMMANDS, type CommandDef} from '../shortcuts/commands';
import {fuzzyMatch} from '../shortcuts/fuzzy';
import {formatChord, formatShortcut} from '../shortcuts/keys';
import {useIsCommandLive, useRunCommand} from '../shortcuts/registry';
import {useTableIndex, type TableTarget} from '../state/tableIndex';
import {useTableSearch, type TableSearch} from '../state/tableSearch';
import type {TreePath} from '../state/treeStore';
import {Modal} from './Modal';

type Props = {
    connName: string | null;
    onClose: () => void;
    onOpenTable: (t: {namespace: TreePath; name: string}) => void;
};

type Item =
    | {kind: 'command'; key: string; command: CommandDef; score: number; positions: number[]}
    | {kind: 'table'; key: string; target: TableTarget; score: number; positions: number[]};

const MAX_RESULTS = 50;
const COMMAND_PREFIX = '>';

export function CommandPalette({connName, onClose, onOpenTable}: Props) {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const runCommand = useRunCommand();
    const isLive = useIsCommandLive();
    const {tables: treeTables} = useTableIndex();
    const listRef = useRef<HTMLUListElement>(null);

    const commandsOnly = query.startsWith(COMMAND_PREFIX);
    const term = commandsOnly ? query.slice(COMMAND_PREFIX.length).trim() : query.trim();

    // Typing a table name searches the whole catalog; the tree index is what we
    // can answer from instantly while that comes back.
    const search = useTableSearch(connName, term, !commandsOnly);

    const tables = useMemo<TableTarget[]>(() => {
        if (search.tables.length === 0) return treeTables;
        const seen = new Set(treeTables.map((t) => t.label));
        return [...treeTables, ...search.tables.filter((t) => !seen.has(t.label))];
    }, [treeTables, search.tables]);

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
    const shownTables = items.reduce((n, i) => (i.kind === 'table' ? n + 1 : n), 0);

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
                                    {item.command.keys.length > 0 ? (
                                        formatShortcut(item.command.keys[0]).map((k) => (
                                            <kbd key={k}>{k}</kbd>
                                        ))
                                    ) : item.command.chords?.length ? (
                                        // A sequence, so the steps are shown
                                        // one after another rather than joined.
                                        formatChord(item.command.chords[0]).map((step, i) => (
                                            <kbd key={step + i}>{step}</kbd>
                                        ))
                                    ) : (
                                        item.command.group
                                    )}
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
                        : search.status === 'searching'
                          ? `Still indexing the catalog — nothing matches “${term}” yet.`
                          : `No table or command matches “${term}”.`}
                </p>
            )}

            <p className="palette-footer">
                {coverageText(search, commandsOnly, treeTables.length, shownTables)}
            </p>
        </Modal>
    );
}

/**
 * One line saying what the results actually cover. The tree index and the
 * backend crawl have different reaches, and a crawl can come back partial, so
 * silence here would read as "that table doesn't exist".
 */
function coverageText(
    search: TableSearch,
    commandsOnly: boolean,
    treeCount: number,
    shownTables: number,
): string {
    const loaded = `${treeCount} ${treeCount === 1 ? 'table' : 'tables'} loaded from the tree`;

    if (commandsOnly) return 'Listing commands — remove the “>” to search tables.';

    switch (search.status) {
        case 'error':
            return `Catalog search unavailable — showing ${loaded}.`;
        case 'searching':
            return `Indexing the catalog… showing ${loaded} meanwhile.`;
        case 'ready': {
            if (!search.complete) {
                return `Searching ${search.indexed} indexed tables — the crawl was cut short by a size cap or a namespace it couldn't read.`;
            }
            const all = `Searching all ${search.indexed} tables.`;
            return search.matched > shownTables
                ? `${all} Showing ${shownTables} of ${search.matched} matches — refine the query.`
                : all;
        }
        default:
            return `Type to search the whole catalog — ${loaded}.`;
    }
}

function highlight(text: string, positions: number[]) {
    if (positions.length === 0) return text;
    const set = new Set(positions);
    const out: (string | ReactElement)[] = [];
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
