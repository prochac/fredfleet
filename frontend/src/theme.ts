const MEDIA = '(prefers-color-scheme: dark)';

function apply(matches: boolean) {
    document.documentElement.dataset.theme = matches ? 'dark' : 'light';
}

export function initTheme(): () => void {
    const mq = window.matchMedia(MEDIA);
    apply(mq.matches);
    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
}
