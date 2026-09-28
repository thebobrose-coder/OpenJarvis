import { isTauri } from './api';

/** Open a URL outside the app: the system browser in the desktop build
 * (the webview must not navigate away), a new tab in the browser copy. */
export async function openExternal(url: string) {
  if (!url) return;
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
