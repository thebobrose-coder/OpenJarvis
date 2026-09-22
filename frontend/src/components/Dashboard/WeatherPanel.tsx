import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Cloudy,
  Droplets,
  Moon,
  Navigation,
  Pause,
  Play,
  Sun,
} from 'lucide-react';
import {
  fetchDigest,
  fetchWeather,
  regenerateDigest,
  resolveDigestAudioSrc,
} from '../../lib/api';
import type { Digest, WeatherPayload } from '../../lib/api';
import { DashboardPanel } from './DashboardPanel';

const WEATHER_PREFIX = '/api/digest/weather';
const LIVE_REFRESH_MS = 15 * 60 * 1000;

/** Map an OpenWeatherMap icon code to a symbolic lucide icon -- the graphical
 * "at a glance" read this panel exists for, not the literal OWM sprite. */
function conditionIcon(code: string) {
  const family = code.slice(0, 2);
  const night = code.endsWith('n');
  switch (family) {
    case '01':
      return night ? Moon : Sun;
    case '02':
    case '03':
    case '04':
      return night ? Cloudy : CloudSun;
    case '09':
      return CloudDrizzle;
    case '10':
      return CloudRain;
    case '11':
      return CloudLightning;
    case '13':
      return CloudSnow;
    case '50':
      return CloudFog;
    default:
      return CloudSun;
  }
}

function formatHour(iso: string): string {
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric' });
}

export function WeatherPanel() {
  const [weather, setWeather] = useState<WeatherPayload | null>(null);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const loadLive = useCallback(async () => {
    try {
      const w = await fetchWeather();
      setWeather(w);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load weather.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadNarration = useCallback(async () => {
    try {
      const d = await fetchDigest(WEATHER_PREFIX);
      setDigest(d);
      setAudioUrl(d ? await resolveDigestAudioSrc(d, WEATHER_PREFIX).catch(() => null) : null);
    } catch {
      // Narration is a secondary affordance -- a failure here shouldn't
      // block the live graphical read above it.
    }
  }, []);

  useEffect(() => {
    loadLive();
    loadNarration();
    const interval = setInterval(loadLive, LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadLive, loadNarration]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerateDigest(WEATHER_PREFIX);
      await Promise.all([loadLive(), loadNarration()]);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to regenerate.');
    } finally {
      setRegenerating(false);
    }
  };

  const toggleAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  const current = weather?.current;
  const Icon = current ? conditionIcon(current.icon) : CloudSun;
  const forecast = (weather?.forecast ?? []).slice(0, 8);
  const chartData = forecast.map((f) => ({
    hour: formatHour(f.time),
    temp: f.temperature ?? null,
    pop: f.precipitation_probability_percent ?? 0,
  }));

  return (
    <DashboardPanel
      icon={Icon}
      title="Weather"
      tag="15 min"
      size="wide"
      priority
      loading={loading}
      error={error}
      onRegenerate={handleRegenerate}
      regenerating={regenerating}
    >
      {!weather || !current ? (
        <p style={{ color: 'var(--color-text-tertiary)' }}>
          Connect the Weather source and set a location to populate this panel.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <Icon size={40} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold" style={{ color: 'var(--color-text)' }}>
                  {current.temperature != null ? Math.round(current.temperature) : '--'}°
                </span>
                {current.feels_like != null && (
                  <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    feels {Math.round(current.feels_like)}°
                  </span>
                )}
              </div>
              <div className="text-xs capitalize truncate" style={{ color: 'var(--color-text-secondary)' }}>
                {current.description || '—'}
                {weather.location.name ? ` · ${weather.location.name}` : ''}
              </div>
            </div>

            <div className="ml-auto flex items-center gap-4 shrink-0">
              {current.wind_speed != null && (
                <div className="flex items-center gap-1.5">
                  <Navigation
                    size={13}
                    style={{
                      color: 'var(--color-text-tertiary)',
                      transform: `rotate(${(current.wind_direction_degrees ?? 0)}deg)`,
                    }}
                  />
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {Math.round(current.wind_speed)}
                  </span>
                </div>
              )}
              {current.humidity_percent != null && (
                <div className="flex items-center gap-1.5">
                  <Droplets size={13} style={{ color: 'var(--color-text-tertiary)' }} />
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {current.humidity_percent}%
                  </span>
                </div>
              )}
            </div>
          </div>

          {chartData.length > 0 && (
            <div style={{ height: 90 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                  <defs>
                    <linearGradient id="weatherTempFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="hour"
                    tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis hide domain={['dataMin - 2', 'dataMax + 2']} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                    labelStyle={{ color: 'var(--color-text-secondary)' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="temp"
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    fill="url(#weatherTempFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {chartData.some((c) => c.pop > 0) && (
            <div className="flex items-end gap-1" style={{ height: 24 }}>
              {chartData.map((c, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`${c.pop}%`}>
                  <div
                    style={{
                      width: '100%',
                      height: Math.max(2, (c.pop / 100) * 18),
                      background: 'var(--color-accent)',
                      opacity: 0.4,
                      borderRadius: 2,
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {digest?.text && (
            <div
              className="flex items-start gap-2 pt-2 text-xs"
              style={{ borderTop: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              {audioUrl && (
                <button
                  onClick={toggleAudio}
                  className="flex items-center justify-center w-5 h-5 rounded-full shrink-0 cursor-pointer"
                  style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)' }}
                  title={playing ? 'Pause' : 'Play narration'}
                >
                  {playing ? <Pause size={10} /> : <Play size={10} />}
                </button>
              )}
              <span className="pt-0.5">{digest.text}</span>
              {audioUrl && (
                <audio
                  ref={audioRef}
                  src={audioUrl}
                  onEnded={() => setPlaying(false)}
                  onPause={() => setPlaying(false)}
                  style={{ display: 'none' }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
