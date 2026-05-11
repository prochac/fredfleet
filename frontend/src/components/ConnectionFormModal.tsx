import {useState} from 'react';
import {connections} from '../../wailsjs/go/models';
import {SaveConnection, TestConnection} from '../../wailsjs/go/main/App';
import {toastError} from '../toast';
import {Modal} from './Modal';

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
    const [s3AccessKeyID, setS3AccessKeyID] = useState(initial?.s3?.accessKeyId ?? '');
    const [s3Region, setS3Region] = useState(initial?.s3?.region ?? '');
    const [s3Endpoint, setS3Endpoint] = useState(initial?.s3?.endpoint ?? '');
    const [s3Secret, setS3Secret] = useState('');
    const [status, setStatus] = useState<Status>({kind: 'idle'});

    const isEdit = mode === 'edit';
    // In edit mode, leaving the secret blank keeps whatever's in the keyring.
    const secretRequired = !isEdit;
    const hasS3Config = !!(s3AccessKeyID.trim() || s3Region.trim() || s3Endpoint.trim() || s3Secret);

    function buildConnection(): connections.Connection {
        const conn: any = {
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
        };
        if (hasS3Config) {
            conn.s3 = {
                accessKeyId: s3AccessKeyID.trim(),
                region: s3Region.trim(),
                endpoint: s3Endpoint.trim(),
            };
        }
        return connections.Connection.createFrom(conn);
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
        // S3 section: if any field is set, access-key-id is required (the secret
        // can be left blank in edit mode to reuse what's in the keyring).
        if (hasS3Config && !s3AccessKeyID.trim()) {
            return 'S3 access key ID is required when storage credentials are set.';
        }
        if (!isEdit && hasS3Config && !s3Secret) {
            return 'S3 secret access key is required when storage credentials are set.';
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
            await TestConnection(buildConnection(), secret, s3Secret);
            setStatus({kind: 'ok', message: 'Connection succeeded.'});
        } catch (e) {
            setStatus({kind: 'idle'});
            toastError(e, 'Connection test failed');
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
            await SaveConnection(buildConnection(), secret, s3Secret);
            onSaved();
        } catch (e) {
            setStatus({kind: 'idle'});
            toastError(e, 'Failed to save connection');
        }
    }

    const busy = status.kind === 'testing' || status.kind === 'saving';
    const secretLabel = authKind === AUTH_OAUTH2 ? 'Client secret' : 'Bearer token';

    return (
        <Modal
            onCancel={onCancel}
            labelledBy="conn-form-title"
            initialFocus={isEdit ? 'input[type="url"]' : 'input[type="text"]'}
        >
            <h2 id="conn-form-title">{isEdit ? 'Edit connection' : 'Add connection'}</h2>
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

                    <fieldset className="form-section">
                        <legend>Storage credentials <span className="hint">(optional — only when the catalog does not vend S3 credentials)</span></legend>
                        <label>
                            S3 access key ID
                            <input
                                type="text"
                                value={s3AccessKeyID}
                                onChange={(e) => setS3AccessKeyID(e.target.value)}
                                autoComplete="off"
                                placeholder="AKIA…  /  minioadmin"
                            />
                        </label>
                        <label>
                            S3 secret access key{isEdit && <span className="hint"> (leave blank to keep existing)</span>}
                            <input
                                type="password"
                                value={s3Secret}
                                onChange={(e) => setS3Secret(e.target.value)}
                                autoComplete="off"
                            />
                        </label>
                        <label>
                            Region
                            <input
                                type="text"
                                value={s3Region}
                                onChange={(e) => setS3Region(e.target.value)}
                                autoComplete="off"
                                placeholder="us-east-1"
                            />
                        </label>
                        <label>
                            Endpoint <span className="hint">(MinIO or S3-compatible)</span>
                            <input
                                type="url"
                                value={s3Endpoint}
                                onChange={(e) => setS3Endpoint(e.target.value)}
                                autoComplete="off"
                                placeholder="http://localhost:9000"
                            />
                        </label>
                    </fieldset>

                    {status.kind === 'ok' && <p className="status ok">{status.message}</p>}
                    {status.kind === 'error' && <p className="status error">{status.message}</p>}
                    {status.kind === 'testing' && <p className="status">Testing…</p>}
                    {status.kind === 'saving' && <p className="status">Saving…</p>}

                    <div className="modal-actions">
                        <span className="modal-kbd-hint">
                            <kbd>Esc</kbd> to cancel
                        </span>
                        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
                        <button type="button" onClick={handleTest} disabled={busy}>Test</button>
                        <button type="submit" className="primary" disabled={busy}>Save</button>
                    </div>
                </form>
        </Modal>
    );
}

