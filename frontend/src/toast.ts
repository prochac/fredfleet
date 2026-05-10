import {toast} from 'sonner';

export function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}

export function toastError(e: unknown, title?: string): void {
    const msg = errorMessage(e);
    if (title) {
        toast.error(title, {description: msg, duration: 6000});
    } else {
        toast.error(msg, {duration: 6000});
    }
}
