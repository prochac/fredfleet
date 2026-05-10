import {catalog} from '../../wailsjs/go/models';

type Props = {table: catalog.TableMetadataDTO};

export function PropertiesPanel({table}: Props) {
    return (
        <div className="properties">
            <table className="kv-table">
                <tbody>
                    <tr>
                        <th>Format version</th>
                        <td className="mono">{table.formatVersion}</td>
                    </tr>
                    <tr>
                        <th>Location</th>
                        <td className="mono">{table.location}</td>
                    </tr>
                    <tr>
                        <th>Current snapshot</th>
                        <td className="mono">
                            {table.currentSnapshotId !== undefined && table.currentSnapshotId !== null
                                ? table.currentSnapshotId
                                : <span className="muted">No snapshots yet</span>}
                        </td>
                    </tr>
                </tbody>
            </table>
            <h3>Properties</h3>
            {!table.properties || table.properties.length === 0 ? (
                <p className="empty">No properties set.</p>
            ) : (
                <table className="kv-table">
                    <thead>
                        <tr>
                            <th>Key</th>
                            <th>Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        {table.properties.map((p) => (
                            <tr key={p.key}>
                                <td className="mono">{p.key}</td>
                                <td className="mono wrap">{p.value}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
