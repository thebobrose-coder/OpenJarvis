import { createSharedDigestAudio } from './sharedDigestAudio';

/**
 * Owns the single real <audio> element for the general/flagship digest,
 * mounted once at the Layout level so it's genuinely persistent across
 * route navigation. See sharedDigestAudio.tsx for why every consumer must
 * share this one instance instead of each creating its own.
 */
const { Provider, useSharedDigestAudio } = createSharedDigestAudio('/api/digest');

export const DailyBriefAudioProvider = Provider;
export const useDailyBriefAudio = useSharedDigestAudio;
