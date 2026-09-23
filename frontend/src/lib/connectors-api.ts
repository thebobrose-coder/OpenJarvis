import { apiFetch, getBase, isTauri } from './api';
import type { ConnectorInfo, SyncStatus, ConnectRequest, ConnectResponse } from '../types/connectors';

// ---------------------------------------------------------------------------
// Connectors API
// ---------------------------------------------------------------------------
//
// Every call here must go through apiFetch() (not a bare fetch()) so the
// Bearer auth header is attached when OPENJARVIS_API_KEY is set -- direct
// fetch() calls silently 401 against an authenticated server, exactly the
// bug apiFetch was introduced to prevent elsewhere (#266). This file was
// missed when that fix landed.

export async function listConnectors(): Promise<ConnectorInfo[]> {
  const res = await apiFetch('/v1/connectors');
  if (!res.ok) throw new Error(`Failed to list connectors: ${res.status}`);
  const data = await res.json();
  return data.connectors || [];
}

export async function getConnector(id: string): Promise<ConnectorInfo> {
  const res = await apiFetch(`/v1/connectors/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to get connector ${id}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Shopify multi-store -- "Add Store" management, separate from the generic
// connect flow above (each store still connects/disconnects through the
// normal /v1/connectors/shopify_{slug}/... endpoints once it exists; these
// three calls are just for creating/listing/removing the stores themselves).
// ---------------------------------------------------------------------------

export interface ShopifyStore {
  slug: string;
  display_name: string;
  gsc_site_url: string;
}

export interface AddShopifyStoreResponse {
  slug: string;
  connector_id: string;
  oauth_start: string;
}

export async function listShopifyStores(): Promise<ShopifyStore[]> {
  const res = await apiFetch('/v1/shopify-stores');
  if (!res.ok) throw new Error(`Failed to list Shopify stores: ${res.status}`);
  return res.json();
}

export async function addShopifyStore(
  displayName: string,
  gscSiteUrl?: string,
): Promise<AddShopifyStoreResponse> {
  const res = await apiFetch('/v1/shopify-stores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName, gsc_site_url: gscSiteUrl || '' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Failed to add store: ${res.status}`);
  }
  return res.json();
}

export async function removeShopifyStore(slug: string): Promise<void> {
  const res = await apiFetch(`/v1/shopify-stores/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to remove store: ${res.status}`);
}

export async function connectSource(id: string, req: ConnectRequest): Promise<ConnectResponse> {
  const res = await apiFetch(`/v1/connectors/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    // Surface the backend's actionable detail (e.g. malformed Client ID /
    // Secret) instead of a bare status code so the UI can render it.
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Failed to connect ${id}: ${res.status}`);
  }
  return res.json();
}

/** Open the server-side OAuth consent flow and resolve once the connector
 *  reports connected (or reject on timeout). Reused for any OAuth connector
 *  whose /connect returned `oauth_required` (issue #512).
 *
 *  In the packaged Tauri desktop build, `window.open()` creates no window at
 *  all -- the app has no Rust-side new-window handler (no `on_new_window` /
 *  navigation handler in src-tauri), so WebView2 silently drops the popup
 *  request. The consent screen never opens and the whole OAuth flow stalls
 *  with no error anywhere: /connect succeeds and saves the client
 *  id/secret, but /oauth/start and /oauth/callback never see a single
 *  request. Route through the system browser instead via the shell plugin
 *  (same mechanism already used for external article links), which is
 *  unaffected and actually opens something. The plain browser build keeps
 *  window.open since there's no popup-swallowing issue there. */
export async function startServerOAuth(id: string, oauthStartPath?: string): Promise<void> {
  const path = oauthStartPath || `/v1/connectors/${encodeURIComponent(id)}/oauth/start`;
  const url = `${getBase()}${path}`;
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } else {
    window.open(url, '_blank', 'width=600,height=700');
  }
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const info = await getConnector(id);
        if (info.connected) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      } catch {
        // ignore transient polling errors
      }
    }, 2000);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('Authorization timed out — please try again.'));
    }, 180000);
  });
}

export class ConnectorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConnectorApiError';
  }
}

export async function disconnectSource(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiFetch(`/v1/connectors/${encodeURIComponent(id)}/disconnect`, {
    method: 'POST',
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ConnectorApiError(
      err.detail || `Failed to disconnect ${id}: ${res.status}`,
      res.status,
    );
  }
}

export interface DisconnectUntilCompleteOptions {
  signal?: AbortSignal;
  retryDelayMs?: number;
  onPending?: (message: string) => void;
}

function waitForDisconnectRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Disconnect cancelled', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Disconnect cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

/**
 * Finish a disconnect even when the backend first returns 409 while an active
 * sync is stopping. The server deliberately keeps credentials and indexed
 * data intact until that worker exits; retrying is what completes cleanup.
 */
export async function disconnectSourceUntilComplete(
  id: string,
  {
    signal,
    retryDelayMs = 1500,
    onPending,
  }: DisconnectUntilCompleteOptions = {},
): Promise<void> {
  while (true) {
    try {
      await disconnectSource(id, signal);
      return;
    } catch (err) {
      if (!(err instanceof ConnectorApiError) || err.status !== 409) {
        throw err;
      }
      onPending?.(err.message);
      await waitForDisconnectRetry(retryDelayMs, signal);
    }
  }
}

export async function getSyncStatus(id: string): Promise<SyncStatus> {
  const res = await apiFetch(`/v1/connectors/${encodeURIComponent(id)}/sync`);
  if (!res.ok) throw new Error(`Failed to get sync status for ${id}: ${res.status}`);
  return res.json();
}

export async function triggerSync(id: string): Promise<{ connector_id: string; chunks_indexed: number; status: string }> {
  const res = await apiFetch(`/v1/connectors/${encodeURIComponent(id)}/sync`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Sync failed: ${res.status}`);
  }
  return res.json();
}
