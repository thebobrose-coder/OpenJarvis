import { useState, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { fetchEnergy, fetchTelemetry } from '../../lib/api';
import { useAppStore } from '../../lib/store';
import { Quiet, Tile } from '../shared/ui';

interface EnergySample {
  timestamp: string;
  power_w: number;
  energy_j: number;
}

interface EnergyData {
  total_energy_j?: number;
  energy_per_token_j?: number;
  avg_power_w?: number;
  samples?: EnergySample[];
}

interface TelemetryStats {
  total_requests?: number;
  total_tokens?: number;
}

interface ChartPoint {
  time: string;
  power: number;
}

/** How often the body polls while it is mounted: only the Ops page mounts it. */
export const ENERGY_POLL_MS = 5000;

/**
 * Local-LLM energy telemetry: six tiles and the power line. A body only: the Ops
 * page's Machine panel gives it the DashboardPanel chrome (widescreen plan 5.3),
 * and it polls every 5 s only while that tab is open.
 */
export function EnergyDashboard() {
  const savings = useAppStore((s) => s.savings);
  const [energy, setEnergy] = useState<EnergyData | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryStats | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [energyRes, telRes] = await Promise.allSettled([
        fetchEnergy().catch(() => null),
        fetchTelemetry().catch(() => null),
      ]);

      if (energyRes.status === 'fulfilled' && energyRes.value) {
        const data = energyRes.value as EnergyData;
        setEnergy(data);
        if (data.samples) {
          setChartData(
            data.samples.map((s) => ({
              time: new Date(s.timestamp).toLocaleTimeString(),
              power: Math.round(s.power_w * 10) / 10,
            })),
          );
        }
        setError(null);
      }
      if (telRes.status === 'fulfilled' && telRes.value) {
        setTelemetry(telRes.value as TelemetryStats);
      }
    } catch {
      setError('Cannot connect to server');
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, ENERGY_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const thermalStatus = (energy?.avg_power_w ?? 0) < 50
    ? { label: 'Cool', color: 'var(--color-success)' }
    : (energy?.avg_power_w ?? 0) < 150
    ? { label: 'Warm', color: 'var(--color-warning)' }
    : { label: 'Hot', color: 'var(--color-error)' };

  if (error || !energy) return <Quiet>{error || 'Awaiting the telemetry stream…'}</Quiet>;

  return (
    <div className="flex flex-col gap-3" data-energy>
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Total energy" value={`${((energy.total_energy_j ?? 0) / 1000).toFixed(1)} kJ`} />
        <Tile label="Energy / token" value={`${(energy.energy_per_token_j ?? 0).toFixed(3)} J`} />
        <Tile label="Avg power" value={`${(energy.avg_power_w ?? 0).toFixed(1)} W`} />
        <Tile label="Requests" value={String(savings?.total_calls ?? telemetry?.total_requests ?? 0)} />
        <Tile label="Thermal" value={<span style={{ color: thermalStatus.color }}>{thermalStatus.label}</span>} />
        <Tile label="Tokens" value={formatNumber(savings?.total_tokens ?? telemetry?.total_tokens ?? 0)} />
      </div>

      {chartData.length > 1 ? (
        <div className="h-56" data-energy-chart>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }} minTickGap={40} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--color-text-tertiary)' }} unit=" W" />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 12,
                  color: 'var(--color-text)',
                }}
                formatter={(v) => [`${v} W`, 'Power']}
              />
              <Line type="monotone" dataKey="power" stroke="var(--viz-series-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Quiet>The power line draws once two samples are in.</Quiet>
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
