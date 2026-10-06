/**
 * Trading page data: `trading_status` (polled every minute; Hermes publishes
 * it every 5), `trading_day` (the nightly report; polled hourly) and the
 * page-URL config, all read-only through /api/trading.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchTradingConfig,
  fetchTradingFeed,
  type TradingConfig,
  type TradingDay,
  type TradingStatus,
} from '../lib/trading-api';

const STATUS_POLL_MS = 60 * 1000;
const DAY_POLL_MS = 60 * 60 * 1000;
const CLOCK_MS = 30 * 1000;

export interface FeedState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface TradingData {
  status: FeedState<TradingStatus>;
  day: FeedState<TradingDay>;
  config: TradingConfig | null;
  /** A clock that ticks every 30 s, so the status age and the stale banner
   * keep up between polls. */
  now: number;
}

const EMPTY: FeedState<never> = { data: null, loading: true, error: null };

export function useTradingData(): TradingData {
  const [status, setStatus] = useState<FeedState<TradingStatus>>(EMPTY);
  const [day, setDay] = useState<FeedState<TradingDay>>(EMPTY);
  const [config, setConfig] = useState<TradingConfig | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchTradingFeed<TradingStatus>('trading_status');
      setStatus({ data, loading: false, error: null });
    } catch (e: unknown) {
      setStatus((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : 'Failed to load.' }));
    }
  }, []);

  const loadDay = useCallback(async () => {
    try {
      const data = await fetchTradingFeed<TradingDay>('trading_day');
      setDay({ data, loading: false, error: null });
    } catch (e: unknown) {
      setDay((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : 'Failed to load.' }));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadDay();
    void fetchTradingConfig().then(setConfig);
    const statusPoll = window.setInterval(() => void loadStatus(), STATUS_POLL_MS);
    const dayPoll = window.setInterval(() => void loadDay(), DAY_POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      window.clearInterval(statusPoll);
      window.clearInterval(dayPoll);
      window.clearInterval(clock);
    };
  }, [loadStatus, loadDay]);

  return { status, day, config, now };
}
