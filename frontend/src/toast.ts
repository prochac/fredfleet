import {toast} from 'sonner';

export function errorMessage(e: unknown): string {
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message;
    return String(e);
}

/**
 * A neutral, self-dismissing notice. Used for the things the user should know
 * happened but did not ask to be told twice — a finished export, filters
 * dropped on a table switch.
 */
export function toastInfo(message: string): void {
    toast(message, {duration: 4000});
}

export function toastError(e: unknown, title?: string): void {
    const msg = errorMessage(e);
    if (title) {
        toast.error(title, {description: msg, duration: 6000});
    } else {
        toast.error(msg, {duration: 6000});
    }
}
