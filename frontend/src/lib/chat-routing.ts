// Chat router model ids served by the backend (server/hermes_router.py).
// "auto" routes each turn local-first; "hermes-agent" always asks Hermes.
export const AUTO_MODEL_ID = 'auto';
export const HERMES_MODEL_ID = 'hermes-agent';

export type ChatRoute = 'local' | 'hermes';

export interface RouteInfo {
  target: ChatRoute;
  reason?: string;
  confidence?: number;
  hint?: string;
  notice?: string;
}

export function isRouterModel(id: string | undefined | null): boolean {
  return id === AUTO_MODEL_ID || id === HERMES_MODEL_ID;
}

export function modelDisplayName(id: string): string {
  if (id === AUTO_MODEL_ID) return 'Auto (local first)';
  if (id === HERMES_MODEL_ID) return 'Hermes';
  return id;
}

export function parseRouteEvent(data: string): RouteInfo | undefined {
  try {
    const parsed = JSON.parse(data);
    if (parsed?.target === 'local' || parsed?.target === 'hermes') return parsed as RouteInfo;
  } catch {}
  return undefined;
}
