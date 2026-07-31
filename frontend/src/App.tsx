import {useCallback, useEffect, useRef, useState} from 'react';
import {Toaster} from 'sonner';
import {connections} from '../wailsjs/go/models';
import {DeleteConnection, ListConnections} from '../wailsjs/go/main/App';
import {WindowSetTitle} from '../wailsjs/runtime/runtime';
import {ConnectionList} from './components/ConnectionList';
import {ConnectionFormModal} from './components/ConnectionFormModal';
import {ConfirmDialog} from './components/ConfirmDialog';
import {KeyboardHelpModal} from './components/KeyboardHelpModal';
import {Modal} from './components/Modal';
import {Sidebar} from './components/Sidebar';
import {TableMetadataPanel} from './components/TableMetadataPanel';
import {CommandPalette} from './components/CommandPalette';
import {ShortcutProvider, useCommand} from './shortcuts/registry';
import type {OverlayState} from './shortcuts/useGlobalShortcuts';
import {initPlatform} from './shortcuts/keys';
import {TableIndexProvider} from './state/tableIndex';
import type {TreePath} from './state/treeStore';
import {initTheme} from './theme';
import {toastError} from './toast';

type ModalState =
    | {kind: 'none'}
    | {kind: 'manage'}
    // `returnTo` distinguishes the form opened from the manage dialog (cancel
    // goes back to it) from one opened by Mod+N (cancel dismisses everything).
    | {kind: 'add'; returnTo: 'manage' | 'none'}
    | {kind: 'edit'; connection: connections.Connection}
    | {kind: 'delete'; connection: connections.Connection}
    | {kind: 'help'};

type SelectedTable = {namespace: TreePath; name: string} | null;

export default function App() {
    const [items, setItems] = useState<connections.Connection[]>([]);
    const [modal, setModal] = useState<ModalState>({kind: 'none'});
    const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
    const [selectedTable, setSelectedTable] = useState<SelectedTable>(null);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const mainRef = useRef<HTMLElement>(null);

    // A modal always wins: the palette can't be opened over one (palette.open
    // is scoped out), and every palette action closes the palette before it
    // opens a dialog, so the two are never up at the same time.
    const overlay: OverlayState =
        modal.kind !== 'none' ? 'modal' : paletteOpen ? 'palette' : 'none';

    // WebKit doesn't always reclamp scrollTop when the container grows past
    // the content height (e.g. window maximize), leaving a phantom scroll
    // position. Reset it ourselves whenever the main panel's box changes.
    useEffect(() => {
        const el = mainRef.current;
        if (!el) return;
        const clamp = () => {
            const max = Math.max(0, el.scrollHeight - el.clientHeight);
            if (el.scrollTop > max) el.scrollTop = max;
        };
        const ro = new ResizeObserver(clamp);
        ro.observe(el);
        if (el.firstElementChild) ro.observe(el.firstElementChild);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        if (mainRef.current) mainRef.current.scrollTop = 0;
    }, [selectedTable?.namespace.join('\x00'), selectedTable?.name]);

    const refresh = useCallback(async () => {
        try {
            const list = await ListConnections();
            const next = list ?? [];
            setItems(next);
            setSelectedConnection((curr) => {
                if (curr && next.some((c) => c.name === curr)) return curr;
                return next.length > 0 ? next[0].name : null;
            });
        } catch (e) {
            toastError(e, 'Failed to load connections');
        }
    }, []);

    useEffect(() => {
        const cleanup = initTheme();
        initPlatform();
        refresh();
        return cleanup;
    }, [refresh]);

    useEffect(() => {
        const t = selectedConnection ? `fredfleet — ${selectedConnection}` : 'fredfleet';
        WindowSetTitle(t);
        document.title = t;
    }, [selectedConnection]);

    async function handleConfirmDelete(name: string) {
        try {
            await DeleteConnection(name);
            setModal({kind: 'manage'});
            if (selectedConnection === name) {
                setSelectedConnection(null);
                setSelectedTable(null);
            }
            refresh();
        } catch (e) {
            toastError(e, 'Failed to delete connection');
            setModal({kind: 'none'});
        }
    }

    function handleSelectConnection(name: string | null) {
        setSelectedConnection(name);
        setSelectedTable(null);
    }

    return (
        <ShortcutProvider overlay={overlay}>
            <TableIndexProvider>
                <div className="layout">
                    <AppCommands
                        onHelp={() => setModal({kind: 'help'})}
                        onManage={() => setModal({kind: 'manage'})}
                        onNew={() => setModal({kind: 'add', returnTo: 'none'})}
                        onTogglePalette={() => setPaletteOpen((v) => !v)}
                    />
                    <Sidebar
                        connectionsList={items}
                        selected={selectedConnection}
                        onSelect={handleSelectConnection}
                        onManage={() => setModal({kind: 'manage'})}
                        onOpenHelp={() => setModal({kind: 'help'})}
                        selectedTable={selectedTable}
                        onSelectTable={setSelectedTable}
                        key={selectedConnection ?? '__none__'}
                    />
                    <main className="main" ref={mainRef}>
                        {selectedConnection && selectedTable ? (
                            <TableMetadataPanel
                                connName={selectedConnection}
                                namespace={selectedTable.namespace}
                                name={selectedTable.name}
                            />
                        ) : (
                            <EmptyState hasConnection={!!selectedConnection} />
                        )}
                    </main>

                    {modal.kind === 'manage' && (
                        <Modal
                            className="manage-modal"
                            onCancel={() => setModal({kind: 'none'})}
                        >
                            <ConnectionList
                                items={items}
                                onAdd={() => setModal({kind: 'add', returnTo: 'manage'})}
                                onEdit={(c) => setModal({kind: 'edit', connection: c})}
                                onDelete={(c) => setModal({kind: 'delete', connection: c})}
                            />
                            <div className="modal-actions">
                                <span className="modal-kbd-hint">
                                    <kbd>Esc</kbd> to close
                                </span>
                                <button type="button" onClick={() => setModal({kind: 'none'})}>
                                    Close
                                </button>
                            </div>
                        </Modal>
                    )}

                    {modal.kind === 'help' && (
                        <KeyboardHelpModal onClose={() => setModal({kind: 'none'})} />
                    )}

                    {modal.kind === 'add' && (
                        <ConnectionFormModal
                            mode="add"
                            existingNames={items.map((c) => c.name)}
                            onSaved={() => {
                                setModal({kind: modal.returnTo});
                                refresh();
                            }}
                            onCancel={() => setModal({kind: modal.returnTo})}
                        />
                    )}

                    {modal.kind === 'edit' && (
                        <ConnectionFormModal
                            mode="edit"
                            initial={modal.connection}
                            existingNames={items.map((c) => c.name)}
                            onSaved={() => {
                                setModal({kind: 'manage'});
                                refresh();
                            }}
                            onCancel={() => setModal({kind: 'manage'})}
                        />
                    )}

                    {modal.kind === 'delete' && (
                        <ConfirmDialog
                            title="Delete connection"
                            message={`Delete "${modal.connection.name}"? This also removes the saved token from your OS keyring.`}
                            confirmLabel="Delete"
                            onConfirm={() => handleConfirmDelete(modal.connection.name)}
                            onCancel={() => setModal({kind: 'manage'})}
                        />
                    )}

                    {paletteOpen && (
                        <CommandPalette
                            onClose={() => setPaletteOpen(false)}
                            onOpenTable={setSelectedTable}
                        />
                    )}

                    <Toaster richColors position="bottom-right" theme="system" />
                </div>
            </TableIndexProvider>
        </ShortcutProvider>
    );
}

/**
 * Registers App-level commands. Lives in its own component because useCommand
 * needs the provider above it, and App is what renders the provider.
 */
function AppCommands({
    onHelp,
    onManage,
    onNew,
    onTogglePalette,
}: {
    onHelp: () => void;
    onManage: () => void;
    onNew: () => void;
    onTogglePalette: () => void;
}) {
    useCommand('help.open', onHelp);
    useCommand('connections.manage', onManage);
    useCommand('connections.new', onNew);
    useCommand('palette.open', onTogglePalette);
    return null;
}

function EmptyState({hasConnection}: {hasConnection: boolean}) {
    return (
        <div className="empty-state">
            {hasConnection ? (
                <p>Pick a table from the sidebar to see its schema.</p>
            ) : (
                <p>Choose or add a connection to start browsing.</p>
            )}
        </div>
    );
}

