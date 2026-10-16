// Scans the most traded coins with the same analysis + history check as the analysis page,
// and ranks them by how often signals like today's reached TP1 before SL in the past.
import { topCoins, fetchShared, fetchMarketBundle } from './data.js';
import { analyze } from './engine.js';
import { selectStrategy } from './backtest.js';

const WORKERS = 4;

function summarize(r, coin) {
  return {
    symbol: r.meta.symbol, base: r.meta.base, decimals: r.meta.decimals, volumeRank: coin.rank,
    side: r.side, p: r.prob, be: r.be, evR: r.evR, verified: !!r.history, strategy: r.strategy?.name ?? null,
    wins: r.history?.wins ?? null, n: r.history?.n ?? null,
    verdict: r.verdict.code, label: r.verdict.label, reason: r.verdict.reason,
    price: r.price, change24h: +coin.ticker.priceChangePercent,
  };
}

// Same bar as the analysis page: only a "Có thể vào" or "Đặt lệnh chờ" verdict counts as a pick.
export const passes = (x) => x.verified && x.verdict !== 'NO';

// Strategies have different breakevens (a 1R target needs 50%, a 2R target 33%), so rank by how far the
// tested win rate clears its own breakeven rather than by the raw rate.
export function sortResults(list) {
  return [...list].sort((a, b) => Number(b.verified) - Number(a.verified) || (b.p - b.be) - (a.p - a.be) || b.evR - a.evR);
}

export async function scanTop({ style, leverage, margin, learning, calib, count = 50, onProgress, signal }) {
  const [coins, shared] = await Promise.all([topCoins(count), fetchShared(style)]);
  const queue = coins.map((c, i) => ({ ...c, rank: i + 1 }));
  const results = [];
  let done = 0, failed = 0;

  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const coin = queue.shift();
      try {
        const data = await fetchMarketBundle(coin.meta, style, shared, coin.ticker);
        const selection = await selectStrategy({ meta: coin.meta, style, hist: data.hist, learning, forcedSide: null });
        const r = analyze({
          meta: coin.meta, style, leverage, margin, data, learning, forcedSide: null, calib,
          history: selection.history, strategy: selection.strategy, selection,
        });
        results.push(summarize(r, coin));
      } catch (err) {
        failed++;
        console.warn('scan', coin.meta.symbol, err);
      }
      done++;
      onProgress?.({ done, total: coins.length, failed, results });
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { at: Date.now(), style: style.key, total: coins.length, done, failed, aborted: !!signal?.aborted, results: sortResults(results) };
}
