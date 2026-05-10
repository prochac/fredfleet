import {useCallback, useEffect, useRef, useState} from 'react';
import {connections} from '../wailsjs/go/models';
import {DeleteConnection, ListConnections} from '../wailsjs/go/main/App';
import {ConnectionList} from './components/ConnectionList';
import {ConnectionFormModal} from './components/ConnectionFormModal';
import {ConfirmDialog} from './components/ConfirmDialog';
import {Sidebar} from './components/Sidebar';
import {TableMetadataPanel} from './components/TableMetadataPanel';
import type {TreePath} from './state/treeStore';
import {initTheme} from './theme';

type ModalState =
    | {kind: 'none'}
    | {kind: 'manage'}
    | {kind: 'add'}
    | {kind: 'edit'; connection: connections.Connection}
    | {kind: 'delete'; connection: connections.Connection};

type SelectedTable = {namespace: TreePath; name: string} | null;

export default function App() {
    const [items, setItems] = useState<connections.Connection[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [modal, setModal] = useState<ModalState>({kind: 'none'});
    const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
    const [selectedTable, setSelectedTable] = useState<SelectedTable>(null);
    const mainRef = useRef<HTMLElement>(null);

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
            setLoadError(null);
            setSelectedConnection((curr) => {
                if (curr && next.some((c) => c.name === curr)) return curr;
                return next.length > 0 ? next[0].name : null;
            });
        } catch (e) {
            setLoadError(errorMessage(e));
        }
    }, []);

    useEffect(() => {
        const cleanup = initTheme();
        refresh();
        return cleanup;
    }, [refresh]);

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
            setLoadError(errorMessage(e));
            setModal({kind: 'none'});
        }
    }

    function handleSelectConnection(name: string | null) {
        setSelectedConnection(name);
        setSelectedTable(null);
    }

    return (
        <div className="layout">
            <Sidebar
                connectionsList={items}
                selected={selectedConnection}
                onSelect={handleSelectConnection}
                onManage={() => setModal({kind: 'manage'})}
                selectedTable={selectedTable}
                onSelectTable={setSelectedTable}
                key={selectedConnection ?? '__none__'}
            />
            <main className="main" ref={mainRef}>
                {loadError && <p className="status error global">{loadError}</p>}
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
                <div className="modal-backdrop" onClick={() => setModal({kind: 'none'})}>
                    <div className="modal manage-modal" onClick={(e) => e.stopPropagation()}>
                        <ConnectionList
                            items={items}
                            onAdd={() => setModal({kind: 'add'})}
                            onEdit={(c) => setModal({kind: 'edit', connection: c})}
                            onDelete={(c) => setModal({kind: 'delete', connection: c})}
                        />
                        <div className="modal-actions">
                            <button type="button" onClick={() => setModal({kind: 'none'})}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {modal.kind === 'add' && (
                <ConnectionFormModal
                    mode="add"
                    existingNames={items.map((c) => c.name)}
                    onSaved={() => {
                        setModal({kind: 'manage'});
                        refresh();
                    }}
                    onCancel={() => setModal({kind: 'manage'})}
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
        </div>
    );
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

function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}
