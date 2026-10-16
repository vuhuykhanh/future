// Scans the most traded coins with the same analysis + history check as the analysis page,
// and ranks them by how often signals like today's reached TP1 before SL in the past.
import { topCoins, fetchShared, fetchMarketBundle } from './data.js';
import { analyze } from './engine.js';
import { backtest } from './backtest.js';

const WORKERS = 4;

function summarize(r, coin) {
  return {
    symbol: r.meta.symbol, base: r.meta.base, decimals: r.meta.decimals, volumeRank: coin.rank,
    side: r.side, p: r.prob, evR: r.evR, verified: !!r.history,
    wins: r.history?.wins ?? null, n: r.history?.n ?? null,
    verdict: r.verdict.code, label: r.verdict.label, reason: r.verdict.reason,
    price: r.price, change24h: +coin.ticker.priceChangePercent,
  };
}

// Same bar as the analysis page: only a "Có thể vào" or "Đặt lệnh chờ" verdict counts as a pick.
export const passes = (x) => x.verified && x.verdict !== 'NO';

export function sortResults(list) {
  return [...list].sort((a, b) => Number(b.verified) - Number(a.verified) || b.p - a.p || b.evR - a.evR);
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
        const base = { meta: coin.meta, style, leverage, margin, data, learning };
        const side = analyze({ ...base, forcedSide: null, calib: null }).side;
        const history = await backtest({ meta: coin.meta, style, side, hist: data.hist, learning });
        results.push(summarize(analyze({ ...base, forcedSide: side, calib, history }), coin));
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
