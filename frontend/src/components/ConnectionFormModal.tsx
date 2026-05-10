import {useState} from 'react';
import {connections} from '../../wailsjs/go/models';
import {SaveConnection, TestConnection} from '../../wailsjs/go/main/App';

type Mode = 'add' | 'edit';

type Props = {
    mode: Mode;
    initial?: connections.Connection;
    existingNames: string[];
    onSaved: () => void;
    onCancel: () => void;
};

type Status =
    | {kind: 'idle'}
    | {kind: 'testing'}
    | {kind: 'saving'}
    | {kind: 'ok'; message: string}
    | {kind: 'error'; message: string};

const AUTH_BEARER = 'bearer';
const AUTH_OAUTH2 = 'oauth2_client_credentials';

export function ConnectionFormModal({mode, initial, existingNames, onSaved, onCancel}: Props) {
    const [name, setName] = useState(initial?.name ?? '');
    const [url, setUrl] = useState(initial?.url ?? '');
    const [warehouse, setWarehouse] = useState(initial?.warehouse ?? '');
    const [authKind, setAuthKind] = useState(initial?.auth?.kind ?? AUTH_BEARER);
    const [authURL, setAuthURL] = useState(initial?.auth?.authUrl ?? '');
    const [clientID, setClientID] = useState(initial?.auth?.clientId ?? '');
    const [scope, setScope] = useState(initial?.auth?.scope ?? '');
    const [secret, setSecret] = useState('');
    const [status, setStatus] = useState<Status>({kind: 'idle'});

    const isEdit = mode === 'edit';
    // In edit mode, leaving the secret blank keeps whatever's in the keyring.
    const secretRequired = !isEdit;

    function buildConnection(): connections.Connection {
        return connections.Connection.createFrom({
            name: name.trim(),
            type: 'rest',
            url: url.trim(),
            warehouse: warehouse.trim(),
            auth: {
                kind: authKind,
                authUrl: authKind === AUTH_OAUTH2 ? authURL.trim() : '',
                clientId: authKind === AUTH_OAUTH2 ? clientID.trim() : '',
                scope: authKind === AUTH_OAUTH2 ? scope.trim() : '',
            },
        });
    }

    function validate(): string | null {
        if (!name.trim()) return 'Name is required.';
        if (!url.trim()) return 'Catalog URL is required.';
        if (mode === 'add' && existingNames.includes(name.trim())) {
            return `A connection named "${name.trim()}" already exists.`;
        }
        if (authKind === AUTH_OAUTH2) {
            if (!authURL.trim()) return 'Auth URL is required for OAuth2.';
            if (!clientID.trim()) return 'Client ID is required for OAuth2.';
        }
        if (secretRequired && !secret) {
            return authKind === AUTH_OAUTH2 ? 'Client secret is required.' : 'Bearer token is required.';
        }
        return null;
    }

    async function handleTest() {
        const err = validate();
        if (err) {
            setStatus({kind: 'error', message: err});
            return;
        }
        setStatus({kind: 'testing'});
        try {
            await TestConnection(buildConnection(), secret);
            setStatus({kind: 'ok', message: 'Connection succeeded.'});
        } catch (e) {
            setStatus({kind: 'error', message: errorMessage(e)});
        }
    }

    async function handleSave() {
        const err = validate();
        if (err) {
            setStatus({kind: 'error', message: err});
            return;
        }
        setStatus({kind: 'saving'});
        try {
            await SaveConnection(buildConnection(), secret);
            onSaved();
        } catch (e) {
            setStatus({kind: 'error', message: errorMessage(e)});
        }
    }

    const busy = status.kind === 'testing' || status.kind === 'saving';
    const secretLabel = authKind === AUTH_OAUTH2 ? 'Client secret' : 'Bearer token';

    return (
        <div className="modal-backdrop" onClick={onCancel}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>{isEdit ? 'Edit connection' : 'Add connection'}</h2>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSave();
                    }}
                >
                    <label>
                        Name
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            disabled={isEdit}
                            autoFocus={!isEdit}
                            required
                        />
                    </label>
                    <label>
                        Catalog type
                        <select value="rest" disabled>
                            <option value="rest">REST</option>
                        </select>
                    </label>
                    <label>
                        Catalog URL
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://lakekeeper.example.com/catalog/"
                            required
                        />
                    </label>
                    <label>
                        Warehouse <span className="hint">(required by Lakekeeper / Polaris when multiple warehouses exist)</span>
                        <input
                            type="text"
                            value={warehouse}
                            onChange={(e) => setWarehouse(e.target.value)}
                            placeholder="warehouse name or ID"
                        />
                    </label>
                    <label>
                        Authentication
                        <select value={authKind} onChange={(e) => setAuthKind(e.target.value)}>
                            <option value={AUTH_BEARER}>Bearer token (static)</option>
                            <option value={AUTH_OAUTH2}>OAuth2 client credentials</option>
                        </select>
                    </label>

                    {authKind === AUTH_OAUTH2 && (
                        <>
                            <label>
                                Auth URL (token endpoint)
                                <input
                                    type="url"
                                    value={authURL}
                                    onChange={(e) => setAuthURL(e.target.value)}
                                    placeholder="https://keycloak.example.com/realms/iceberg/protocol/openid-connect/token"
                                    required
                                />
                            </label>
                            <label>
                                Client ID
                                <input
                                    type="text"
                                    value={clientID}
                                    onChange={(e) => setClientID(e.target.value)}
                                    autoComplete="off"
                                    required
                                />
                            </label>
                            <label>
                                Scope <span className="hint">(optional, defaults to "catalog")</span>
                                <input
                                    type="text"
                                    value={scope}
                                    onChange={(e) => setScope(e.target.value)}
                                    autoComplete="off"
                                />
                            </label>
                        </>
                    )}

                    <label>
                        {secretLabel}{isEdit && <span className="hint"> (leave blank to keep existing)</span>}
                        <input
                            type="password"
                            value={secret}
                            onChange={(e) => setSecret(e.target.value)}
                            autoComplete="off"
                            required={secretRequired}
                        />
                    </label>

                    {status.kind === 'ok' && <p className="status ok">{status.message}</p>}
                    {status.kind === 'error' && <p className="status error">{status.message}</p>}
                    {status.kind === 'testing' && <p className="status">Testing…</p>}
                    {status.kind === 'saving' && <p className="status">Saving…</p>}

                    <div className="modal-actions">
                        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
                        <button type="button" onClick={handleTest} disabled={busy}>Test</button>
                        <button type="submit" className="primary" disabled={busy}>Save</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}
