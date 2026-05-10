type Props = {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
};

export function ConfirmDialog({title, message, confirmLabel = 'Confirm', onConfirm, onCancel}: Props) {
    return (
        <div className="modal-backdrop" onClick={onCancel}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>{title}</h2>
                <p>{message}</p>
                <div className="modal-actions">
                    <button type="button" onClick={onCancel}>Cancel</button>
                    <button type="button" className="danger" onClick={onConfirm}>{confirmLabel}</button>
                </div>
            </div>
        </div>
    );
}
