import {Modal} from './Modal';

type Props = {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
};

export function ConfirmDialog({title, message, confirmLabel = 'Confirm', onConfirm, onCancel}: Props) {
    return (
        <Modal
            onCancel={onCancel}
            labelledBy="confirm-dialog-title"
            initialFocus="button:not(.danger)"
        >
            <h2 id="confirm-dialog-title">{title}</h2>
            <p>{message}</p>
            <div className="modal-actions">
                <span className="modal-kbd-hint">
                    <kbd>Esc</kbd> to cancel
                </span>
                <button type="button" onClick={onCancel}>Cancel</button>
                <button type="button" className="danger" onClick={onConfirm}>{confirmLabel}</button>
            </div>
        </Modal>
    );
}
