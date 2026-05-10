import {useEffect, useMemo, useState} from 'react';
import {
    type ColumnDef,
    flexRender,
    getCoreRowModel,
    useReactTable,
} from '@tanstack/react-table';
import {PreviewTable} from '../../wailsjs/go/main/App';
import {catalog} from '../../wailsjs/go/models';
import {Pending} from './Pending';

type Props = {
    connName: string;
    namespace: string[];
    name: string;
};

const PAGE_SIZE = 100;

type Row = Record<string, unknown>;

export function PreviewPanel({connName, namespace, name}: Props) {
    const [data, setData] = useState<catalog.PreviewRowsDTO | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        PreviewTable(connName, namespace, name, PAGE_SIZE)
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

    const columns = useMemo<ColumnDef<Row>[]>(
        () =>
            (data?.columns ?? []).map((c) => ({
                id: c.name,
                header: c.name,
                accessorFn: (row) => row[c.name],
                cell: (info) => renderCell(info.getValue()),
            })),
        [data?.columns],
    );

    const rows = useMemo<Row[]>(() => (data?.rows ?? []) as Row[], [data?.rows]);

    const table = useReactTable({
        data: rows,
        columns,
        getCoreRowModel: getCoreRowModel(),
    });

    return (
        <Pending
            loading={loading}
            error={error}
            empty={!!data && rows.length === 0}
            emptyMessage="No data files in this table."
            onRetry={() => setReloadKey((k) => k + 1)}
        >
            {data && rows.length > 0 && (
                <table className="preview-table">
                    <thead>
                        {table.getHeaderGroups().map((hg) => (
                            <tr key={hg.id}>
                                {hg.headers.map((h) => (
                                    <th key={h.id}>
                                        {h.isPlaceholder
                                            ? null
                                            : flexRender(h.column.columnDef.header, h.getContext())}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {table.getRowModel().rows.map((r) => (
                            <tr key={r.id}>
                                {r.getVisibleCells().map((cell) => (
                                    <td key={cell.id}>
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Pending>
    );
}

function renderCell(value: unknown) {
    if (value === null || value === undefined) {
        return <span className="null">null</span>;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}
