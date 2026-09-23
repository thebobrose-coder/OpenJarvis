import { createSharedDigestAudio } from './sharedDigestAudio';

/**
 * Owns the single real <audio> element for the Culture & Sports digest,
 * mounted once at the Layout level. Shared between the dashboard's
 * Culture & Sports panel and the sidebar's "Latest News" breaking-news
 * item -- both can be mounted simultaneously.
 */
const { Provider, useSharedDigestAudio } = createSharedDigestAudio('/api/digest/culture');

export const CultureAudioProvider = Provider;
export const useCultureAudio = useSharedDigestAudio;
