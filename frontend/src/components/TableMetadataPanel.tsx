import {useEffect, useState} from 'react';
import {LoadTable} from '../../wailsjs/go/main/App';
import {catalog} from '../../wailsjs/go/models';
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
                        <div className="tab-bar" role="tablist">
                            {TABS.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={tab === t.id}
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
