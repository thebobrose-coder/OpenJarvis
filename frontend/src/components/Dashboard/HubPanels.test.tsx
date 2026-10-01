import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DayAheadView } from './DayAheadPanel';
import { WeatherView, unitLabels } from './WeatherPanel';
import type { DayAhead, WeatherConditions, WeatherPayload } from '../../lib/api';

// Neutral fixtures only: the real feeds carry calendar titles and the location.
const DAY: DayAhead = {
  events: [{ id: 'evt-1', title: 'Sample meeting', time: '2026-10-01T09:00:00' }],
  tasks: [{ id: 'task-1', title: 'Sample task', due: '', list: 'Sample list' }],
  calendar_connected: true,
  tasks_connected: true,
  window_hours: 24,
  as_of: '2026-10-01T08:00:00',
  errors: {},
  generated_at: '2026-10-01T13:00:00Z',
  age_seconds: 180,
  stale: false,
};

const conditions = (over: Partial<WeatherConditions> = {}): WeatherConditions => ({
  time: '2026-10-01T09:00:00',
  temperature: 72.4,
  feels_like: 70.6,
  temperature_min: null,
  temperature_max: null,
  description: 'clear sky',
  icon: '01d',
  humidity_percent: 40,
  wind_speed: 7.2,
  wind_direction_degrees: 90,
  precipitation_probability_percent: 0,
  rain_mm: null,
  snow_mm: null,
  ...over,
});

const WEATHER: WeatherPayload = {
  provider: 'openweathermap',
  location: { requested: 'Example City', name: 'Example City', country: null, latitude: null, longitude: null },
  units: 'imperial',
  language: 'en',
  current: conditions(),
  forecast: [],
  generated_at: '2026-10-01T13:00:00Z',
  age_seconds: 600,
  stale: false,
};

describe('Day Ahead (Hermes feed)', () => {
  it('lists events and open tasks with the feed age', () => {
    const html = renderToStaticMarkup(<DayAheadView data={DAY} />);
    expect(html).toContain('Sample meeting');
    expect(html).toContain('Sample task');
    expect(html).toContain('Updated 3 min ago');
    expect(html).not.toContain('>stale<');
  });

  it('shows the stale note when Hermes is unreachable', () => {
    const html = renderToStaticMarkup(<DayAheadView data={{ ...DAY, stale: true, age_seconds: 3600 }} />);
    expect(html).toContain('>stale<');
    expect(html).toContain('60 min ago');
  });

  it('still asks to connect when neither source is connected', () => {
    const html = renderToStaticMarkup(<DayAheadView data={{ ...DAY, calendar_connected: false, tasks_connected: false }} />);
    expect(html).toContain('Connect Google Calendar and Google Tasks');
  });
});

describe('Weather (Hermes feed)', () => {
  it('labels imperial units: °F and mph', () => {
    const html = renderToStaticMarkup(<WeatherView weather={WEATHER} />);
    expect(html).toMatch(/72(<!-- -->)?°F/);
    expect(html).toMatch(/feels (<!-- -->)?71(<!-- -->)?°F/);
    expect(html).toMatch(/7(<!-- -->)? (<!-- -->)?mph/);
    expect(html).toContain('Example City');
  });

  it('labels metric units: °C and m/s', () => {
    expect(unitLabels('metric')).toEqual({ temp: '°C', wind: 'm/s' });
    expect(unitLabels('imperial')).toEqual({ temp: '°F', wind: 'mph' });
    const html = renderToStaticMarkup(<WeatherView weather={{ ...WEATHER, units: 'metric', current: conditions({ temperature: 22 }) }} />);
    expect(html).toMatch(/22(<!-- -->)?°C/);
    expect(html).toContain('m/s');
  });

  it('shows the age and the stale note, and no narration controls', () => {
    const html = renderToStaticMarkup(<WeatherView weather={{ ...WEATHER, stale: true }} />);
    expect(html).toContain('Updated 10 min ago');
    expect(html).toContain('>stale<');
    expect(html).not.toMatch(/narration/i);
    expect(html).not.toContain('<audio');
  });

  it('asks for configuration when there is no weather', () => {
    expect(renderToStaticMarkup(<WeatherView weather={null} />)).toContain('Connect the Weather source');
  });
});
