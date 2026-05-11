import {MouseEvent, ReactNode} from 'react';
import {useEscapeKey} from '../hooks/useEscapeKey';
import {useFocusTrap} from '../hooks/useFocusTrap';

type Props = {
    onCancel: () => void;
    children: ReactNode;
    className?: string;
    labelledBy?: string;
    initialFocus?: string;
};

export function Modal({onCancel, children, className, labelledBy, initialFocus}: Props) {
    useEscapeKey(true, onCancel);
    const trapRef = useFocusTrap<HTMLDivElement>(initialFocus);

    const stop = (e: MouseEvent) => e.stopPropagation();

    return (
        <div className="modal-backdrop" onClick={onCancel}>
            <div
                ref={trapRef}
                className={'modal' + (className ? ` ${className}` : '')}
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelledBy}
                onClick={stop}
                tabIndex={-1}
            >
                {children}
            </div>
        </div>
    );
}
