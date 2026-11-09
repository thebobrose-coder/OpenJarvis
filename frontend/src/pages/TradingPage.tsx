import { TradingView } from '../components/Trading/TradingView';
import { PageFrame } from '../components/shared/PageFrame';
import { useTradingData } from '../hooks/useTradingData';

/** The x402 paper trader, read-only: see components/Trading. */
export function TradingPage() {
  const data = useTradingData();
  return (
    <PageFrame>
      <TradingView status={data.status} day={data.day} config={data.config} now={data.now} />
    </PageFrame>
  );
}
