import { TradingView } from '../components/Trading/TradingView';
import { useTradingData } from '../hooks/useTradingData';

/** The x402 paper trader, read-only: see components/Trading. */
export function TradingPage() {
  const data = useTradingData();
  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <TradingView status={data.status} day={data.day} config={data.config} now={data.now} />
    </div>
  );
}
