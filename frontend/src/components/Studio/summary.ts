import type { StudioStatus } from '../../lib/studio-api';

/** The studio's one line for the Content header: in production and the shortest runway. */
export function studioLine(status: StudioStatus | null, onOpen: () => void): { text: string; onOpen: () => void } | null {
  if (!status || status.lanes.length === 0) return null;
  const inProduction = status.lanes.reduce((n, l) => n + l.inProduction, 0);
  const runway = Math.min(...status.lanes.map((l) => l.runwayDays));
  return { text: `${inProduction} in production · runway ${runway} d`, onOpen };
}
