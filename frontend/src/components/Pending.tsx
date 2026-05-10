import React from 'react';

type Props = {
    loading: boolean;
    error: string | null;
    empty?: boolean;
    emptyMessage?: string;
    children: React.ReactNode;
    onRetry?: () => void;
};

export function Pending({loading, error, empty, emptyMessage, children, onRetry}: Props) {
    if (loading) {
        return (
            <div className="pending">
                <span className="spinner" aria-hidden /> <span>Loading…</span>
            </div>
        );
    }
    if (error) {
        return (
            <div className="status error" role="alert">
                <span>{error}</span>
                {onRetry && (
                    <button type="button" onClick={onRetry} className="retry">Retry</button>
                )}
            </div>
        );
    }
    if (empty) {
        return <p className="empty">{emptyMessage ?? 'Nothing here.'}</p>;
    }
    return <>{children}</>;
}
