import { apiFetch } from './api';

/** A failed call with its HTTP status, so a hook can tell 503 (Hermes or the
 * bridge is down: try again) from a refusal. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The body's `detail` (FastAPI) or `error` (the bridge) text, else `fallback`. */
export async function detail(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  if (typeof body?.detail === 'string' && body.detail) return body.detail;
  if (typeof body?.error === 'string' && body.error) return body.error;
  return fallback;
}

/** The error to throw for a failed write: the server's reason, or "<what> failed: <status>". */
export async function failure(res: Response, what: string): Promise<ApiError> {
  return new ApiError(res.status, await detail(res, `${what} failed: ${res.status}`));
}

/** A Hermes feed's document through `/api/<prefix>/<feed>`, or null when
 * Hermes hasn't produced it yet (404). */
export async function fetchFeed<T>(prefix: string, feed: string): Promise<T | null> {
  const res = await apiFetch(`/api/${prefix}/${feed}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, res.status === 503 ? 'Hermes is unreachable' : `Failed: ${res.status}`);
  return res.json();
}
