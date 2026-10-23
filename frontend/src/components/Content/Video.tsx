import { Film } from 'lucide-react';
import { LIMITS, type Motion, type PropertyMotion } from '../../lib/content-api';
import { Chip, Segmented } from '../shared/ui';

/**
 * The flag for video (contract v1.14): a short-form item may render a clip
 * from its beat. Hermes decides where that is allowed (the bundle's
 * `motion.lanes`) and checks the beat's wording; this only offers the
 * control where it applies and shows what was decided.
 */

export type MotionChoice = 'default' | 'always' | 'never';

export const choiceOf = (motion?: Motion): MotionChoice => motion ?? 'default';
export const motionOf = (choice: MotionChoice): Motion => (choice === 'default' ? null : choice);

/** The Video control shows only on a lane the bundle lists, never on long-form or the thesis. */
export function videoAllowed(motion: PropertyMotion | null | undefined, lane: string, contentType?: string | null): boolean {
  if (!motion?.lanes?.includes(lane)) return false;
  return lane !== 'long' && contentType !== 'thesis';
}

/** A beat can render unless the operator said Never. */
export const beatEnabled = (choice: MotionChoice) => choice !== 'never';

/** The asset key's shape as Hermes checks it: an .mp4 under assets/<property>/, no "..". */
export function assetKeyProblem(key: string, propertyId: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (k.length > LIMITS.video_asset_key) return `Asset key is over ${LIMITS.video_asset_key} characters.`;
  if (!k.startsWith(`assets/${propertyId}/`) || !k.toLowerCase().endsWith('.mp4') || k.includes('..')) {
    return `Asset key: an .mp4 under assets/${propertyId}/.`;
  }
  return null;
}

const field = {
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
} as const;

function Label({ children }: { children: string }) {
  return (
    <span className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </span>
  );
}

const RELEASE: Record<string, string> = {
  instagram: 'posts as a Reel',
  g1: 'clip stops at G1',
  preview: 'preview only',
};

/**
 * Video (Default / Always / Never), the beat, and under Advanced the
 * operator's own asset key. The key is never prefilled; `currentKey` is the
 * one already set, which the operator may remove.
 */
export function VideoFields({
  propertyId,
  release,
  choice,
  onChoice,
  beat,
  onBeat,
  assetKey,
  onAssetKey,
  currentKey,
  removeKey,
  onRemoveKey,
}: {
  propertyId: string;
  release?: string | null;
  choice: MotionChoice;
  onChoice: (c: MotionChoice) => void;
  beat: string;
  onBeat: (b: string) => void;
  assetKey: string;
  onAssetKey: (k: string) => void;
  currentKey?: string | null;
  removeKey?: boolean;
  onRemoveKey?: (remove: boolean) => void;
}) {
  const enabled = beatEnabled(choice);
  const keyProblem = assetKeyProblem(assetKey, propertyId);
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Video">
      <div className="flex flex-wrap items-center gap-1.5">
        <Label>Video</Label>
        <Segmented
          ariaLabel="Video"
          value={choice}
          onChange={onChoice}
          options={[
            { value: 'default', label: 'Default (lane)' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' },
          ]}
        />
        {release && (
          <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {RELEASE[release] ?? release}
          </span>
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between gap-2">
          <Label>Beat</Label>
          <span className="text-[10.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
            {beat.trim().length} / {LIMITS.motion_brief}
          </span>
        </span>
        <input
          value={beat}
          onChange={(e) => onBeat(e.target.value.slice(0, LIMITS.motion_brief))}
          disabled={!enabled}
          placeholder="what happens in the frame — not a caption"
          aria-label="Beat"
          className="rounded-md px-2 py-1 text-[12px] disabled:opacity-50"
          style={field}
        />
      </label>
      <details>
        <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
          Advanced
        </summary>
        <label className="mt-1.5 flex flex-col gap-1">
          <Label>Video asset key</Label>
          <input
            value={assetKey}
            onChange={(e) => onAssetKey(e.target.value.slice(0, LIMITS.video_asset_key))}
            placeholder={`assets/${propertyId}/… .mp4 (your own clip, optional)`}
            aria-label="Video asset key"
            autoComplete="off"
            className="rounded-md px-2 py-1 text-[12px]"
            style={field}
          />
        </label>
        {keyProblem && (
          <span className="text-[11px]" style={{ color: 'var(--color-warning)' }}>
            {keyProblem}
          </span>
        )}
        {currentKey && onRemoveKey && (
          <label className="mt-1 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
            <input type="checkbox" checked={!!removeKey} onChange={(e) => onRemoveKey(e.target.checked)} />
            Remove the current key (<code>{currentKey}</code>)
          </label>
        )}
      </details>
    </div>
  );
}

/** "Video" (always) or "No video" (never), with the beat on hover. */
export function VideoChip({ motion, brief }: { motion?: Motion; brief?: string | null }) {
  if (motion === 'always') {
    return (
      <Chip tone="accent" title={brief ? `Beat: ${brief}` : 'Video: always'}>
        <Film size={10} className="mr-0.5" />
        Video
      </Chip>
    );
  }
  if (motion === 'never') return <Chip tone="muted" title="Video: never">No video</Chip>;
  return null;
}

const SKIPPED: Record<string, string> = {
  'release-blocked': 'clip held at G1',
  'reel-upload-failed': 'posted as still',
  'reel-post-failed': 'posted as still',
};
const REASON_MAX = 60;

/** The skipped reason, mapped where known and clipped otherwise. */
export function skippedLabel(reason: string): string {
  const known = SKIPPED[reason.trim()];
  if (known) return known;
  const r = reason.trim();
  return r.length > REASON_MAX ? `${r.slice(0, REASON_MAX - 1)}…` : r;
}

/** A Reel marker for a post with `video_key`; a muted chip when its clip was skipped. */
export function ReelMarks({ videoKey, skipped }: { videoKey?: string | null; skipped?: string | null }) {
  if (!videoKey && !skipped) return null;
  return (
    <>
      {videoKey && (
        <Chip tone="accent" title="Posted as a Reel">
          <Film size={10} className="mr-0.5" />
          Reel
        </Chip>
      )}
      {skipped && (
        <Chip tone="muted" title={skipped.slice(0, 500)}>
          {skippedLabel(skipped)}
        </Chip>
      )}
    </>
  );
}
