import {KeyboardEvent, useCallback, useEffect, useRef, useState} from 'react';
import {LoadTable} from '../../wailsjs/go/main/App';
import {catalog} from '../../wailsjs/go/models';
import {PRIORITY, useCommand} from '../shortcuts/registry';
import {Pending} from './Pending';
import {SchemaPanel} from './SchemaPanel';
import {PartitionPanel} from './PartitionPanel';
import {PropertiesPanel} from './PropertiesPanel';
import {PreviewPanel} from './PreviewPanel';

type Props = {
    connName: string;
    namespace: string[];
    name: string;
};

type Tab = 'preview' | 'schema' | 'partition' | 'properties';

const TABS: {id: Tab; label: string}[] = [
    {id: 'preview', label: 'Preview'},
    {id: 'schema', label: 'Schema'},
    {id: 'partition', label: 'Partition spec'},
    {id: 'properties', label: 'Properties'},
];

export function TableMetadataPanel({connName, namespace, name}: Props) {
    const [data, setData] = useState<catalog.TableMetadataDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [tab, setTab] = useState<Tab>('preview');
    const tabRefs = useRef<Map<Tab, HTMLButtonElement>>(new Map());

    // Mirrors handleTabKey's "switch, then move DOM focus" so a Mod+digit jump
    // leaves the keyboard in the section the user asked for. tabRefs is empty
    // until `data` arrives, so the focus call is a no-op while loading.
    const goToTab = useCallback((next: Tab) => {
        setTab(next);
        queueMicrotask(() => tabRefs.current.get(next)?.focus());
    }, []);

    useCommand('tab.preview', () => goToTab('preview'), !!data);
    useCommand('tab.schema', () => goToTab('schema'), !!data);
    useCommand('tab.partition', () => goToTab('partition'), !!data);
    useCommand('tab.properties', () => goToTab('properties'), !!data);

    // Same tier as the preview's own refresh, so Mod+R reloads both halves of
    // the open table rather than picking one.
    useCommand('refresh.scope', () => setReloadKey((k) => k + 1), true, PRIORITY.TABLE);

    function handleTabKey(e: KeyboardEvent<HTMLDivElement>) {
        const idx = TABS.findIndex((t) => t.id === tab);
        if (idx < 0) return;
        let next = idx;
        switch (e.key) {
            case 'ArrowLeft':
                next = idx > 0 ? idx - 1 : TABS.length - 1;
                break;
            case 'ArrowRight':
                next = idx < TABS.length - 1 ? idx + 1 : 0;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = TABS.length - 1;
                break;
            default:
                return;
        }
        e.preventDefault();
        const nextTab = TABS[next].id;
        setTab(nextTab);
        // Move DOM focus to keep keyboard interaction continuous.
        queueMicrotask(() => tabRefs.current.get(nextTab)?.focus());
    }

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        LoadTable(connName, namespace, name)
            .then((result) => {
                if (cancelled) return;
                setData(result);
                setLoading(false);
            })
            .catch((e) => {
                if (cancelled) return;
                setError(errorMessage(e));
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [connName, namespace.join('\x00'), name, reloadKey]);

    return (
        <div className="metadata-panel">
            <header className="metadata-header">
                <h1>{[...namespace, name].join('.')}</h1>
            </header>
            <Pending loading={loading} error={error} onRetry={() => setReloadKey((k) => k + 1)}>
                {data && (
                    <>
                        <div
                            className="tab-bar"
                            role="tablist"
                            aria-label="Table sections"
                            onKeyDown={handleTabKey}
                        >
                            {TABS.map((t) => (
                                <button
                                    key={t.id}
                                    ref={(el) => {
                                        if (el) tabRefs.current.set(t.id, el);
                                        else tabRefs.current.delete(t.id);
                                    }}
                                    type="button"
                                    role="tab"
                                    aria-selected={tab === t.id}
                                    tabIndex={tab === t.id ? 0 : -1}
                                    onClick={() => setTab(t.id)}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                        <div role="tabpanel" hidden={tab !== 'preview'}>
                            <PreviewPanel connName={connName} namespace={namespace} name={name} />
                        </div>
                        <div className="metadata-narrow" role="tabpanel" hidden={tab !== 'schema'}>
                            <SchemaPanel schema={data.schema} />
                        </div>
                        <div className="metadata-narrow" role="tabpanel" hidden={tab !== 'partition'}>
                            <PartitionPanel spec={data.partitionSpec} />
                        </div>
                        <div className="metadata-narrow" role="tabpanel" hidden={tab !== 'properties'}>
                            <PropertiesPanel table={data} />
                        </div>
                    </>
                )}
            </Pending>
        </div>
    );
}

function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}
