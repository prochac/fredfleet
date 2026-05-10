import {catalog} from '../../wailsjs/go/models';

type Props = {spec: catalog.PartitionSpecDTO};

export function PartitionPanel({spec}: Props) {
    if (!spec.fields || spec.fields.length === 0) {
        return <p className="empty">Unpartitioned.</p>;
    }
    return (
        <div className="partition-spec">
            <div className="spec-meta">Spec ID: <span className="mono">{spec.specId}</span></div>
            <table className="kv-table">
                <thead>
                    <tr>
                        <th>Field ID</th>
                        <th>Name</th>
                        <th>Transform</th>
                        <th>Source ID</th>
                    </tr>
                </thead>
                <tbody>
                    {spec.fields.map((f) => (
                        <tr key={f.fieldId}>
                            <td className="mono">{f.fieldId}</td>
                            <td>{f.name}</td>
                            <td className="mono">{f.transform}</td>
                            <td className="mono">{f.sourceId}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
