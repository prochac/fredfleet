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

export function TableMetadataPanel({connName, namespace, name}: Props) {
    const [data, setData] = useState<catalog.TableMetadataDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

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
                        <section className="metadata-section">
                            <h2>Schema</h2>
                            <SchemaPanel schema={data.schema} />
                        </section>
                        <section className="metadata-section">
                            <h2>Partition spec</h2>
                            <PartitionPanel spec={data.partitionSpec} />
                        </section>
                        <section className="metadata-section">
                            <h2>Table properties</h2>
                            <PropertiesPanel table={data} />
                        </section>
                        <section className="metadata-section">
                            <h2>Preview</h2>
                            <PreviewPanel connName={connName} namespace={namespace} name={name} />
                        </section>
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
