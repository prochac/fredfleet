import {useState} from 'react';
import {connections} from '../../wailsjs/go/models';
import {TestSavedConnection} from '../../wailsjs/go/main/App';

type Props = {
    items: connections.Connection[];
    onAdd: () => void;
    onEdit: (c: connections.Connection) => void;
    onDelete: (c: connections.Connection) => void;
};

type RowStatus = {state: 'testing'} | {state: 'ok'} | {state: 'error'; message: string};

export function ConnectionList({items, onAdd, onEdit, onDelete}: Props) {
    const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});

    async function handleTest(c: connections.Connection) {
        setStatuses((s) => ({...s, [c.name]: {state: 'testing'}}));
        try {
            await TestSavedConnection(c.name);
            setStatuses((s) => ({...s, [c.name]: {state: 'ok'}}));
        } catch (e) {
            setStatuses((s) => ({...s, [c.name]: {state: 'error', message: errorMessage(e)}}));
        }
    }

    return (
        <section className="connection-list">
            <header>
                <h1>Connections</h1>
                <button type="button" className="primary" onClick={onAdd}>Add connection</button>
            </header>

            {items.length === 0 ? (
                <p className="empty">No connections yet. Add one to get started.</p>
            ) : (
                <table>
                    <thead>
                    <tr>
                        <th>Name</th>
                        <th>Auth</th>
                        <th>URL</th>
                        <th>Status</th>
                        <th></th>
                    </tr>
                    </thead>
                    <tbody>
                    {items.map((c) => {
                        const status = statuses[c.name];
                        return (
                            <tr key={c.name}>
                                <td>{c.name}</td>
                                <td>{authLabel(c.auth?.kind)}</td>
                                <td className="mono">{c.url}</td>
                                <td>{renderStatus(status)}</td>
                                <td className="actions">
                                    <button type="button" onClick={() => handleTest(c)}>Test</button>
                                    <button type="button" onClick={() => onEdit(c)}>Edit</button>
                                    <button type="button" className="danger" onClick={() => onDelete(c)}>Delete</button>
                                </td>
                            </tr>
                        );
                    })}
                    </tbody>
                </table>
            )}
        </section>
    );
}

function renderStatus(status: RowStatus | undefined) {
    if (!status) return <span className="status-pill">—</span>;
    if (status.state === 'testing') return <span className="status-pill testing">Testing…</span>;
    if (status.state === 'ok') return <span className="status-pill ok">OK</span>;
    return <span className="status-pill error" title={status.message}>Error</span>;
}

function authLabel(kind: string | undefined): string {
    if (kind === 'oauth2_client_credentials') return 'OAuth2';
    if (kind === 'bearer') return 'Bearer';
    return kind ?? '—';
}

function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}
