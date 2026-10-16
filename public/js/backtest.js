// Checks the current signal against this coin's own history: at every past point the same analysis is re-run,
// and we count how often signals like today's actually reached TP1 before SL.
// Funding, OI, long/short ratio, sentiment and news have no usable history, so this uses the price-based factors only.
import { analyze } from './engine.js';

const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
const WINDOW = 300;
const STEP = 3;
const MIN_SAMPLES = 30;
const PRIOR_WEIGHT = 20; // shrink small samples toward the coin's base rate
const FEE_ROUND_TRIP = 0.001;

// Last `n` candles that had closed by time tEnd (arr sorted by open time).
function closedUpTo(arr, tEnd, ms, n = WINDOW) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t + ms <= tEnd) lo = mid + 1; else hi = mid;
  }
  return arr.slice(Math.max(0, lo - n), lo);
}

// Simulates the plan on the candles that followed. SL is checked first inside a candle (conservative).
function simulate(plan, fut, fillCandles) {
  const dir = plan.dir;
  let start = 0;
  if (plan.mode === 'limit') {
    start = fut.slice(0, fillCandles).findIndex((c) => (dir > 0 ? c.l <= plan.entry : c.h >= plan.entry));
    if (start < 0) return null; // never filled: not a trade
  }
  const risk = Math.abs(plan.entry - plan.sl);
  const feeR = (FEE_ROUND_TRIP * plan.entry) / risk;
  for (const c of fut.slice(start)) {
    const worst = dir > 0 ? c.l : c.h, best = dir > 0 ? c.h : c.l;
    if ((worst - plan.sl) * dir <= 0) return { win: false, r: -1 - feeR };
    if ((best - plan.tp1) * dir >= 0) return { win: true, r: 1.5 - feeR };
  }
  // Time stop: closed at the last candle's close.
  return { win: false, r: ((fut.at(-1).c - plan.entry) * dir) / risk - feeR };
}

const taData = (k, hk, btc, btcH, tEnd, tfMs, hMs) => ({
  k, hk: closedUpTo(hk, tEnd, hMs),
  btcMain: btc ? closedUpTo(btc, tEnd, tfMs) : null,
  btcHtf: btcH ? closedUpTo(btcH, tEnd, hMs) : null,
  news: null,
});

export async function backtest({ meta, style, side, hist, learning }) {
  const tfMs = TF_MS[style.tf], hMs = TF_MS[style.htf];
  const { k, hk, btc, btcH } = hist;
  const run = (data) => analyze({ meta, style, leverage: 1, margin: 100, forcedSide: side, data, learning, calib: null });

  // Today's signal measured the same way (price factors only), so it is comparable with the past samples.
  const edgeNow = run({
    k: k.slice(-WINDOW), hk: hk.slice(-WINDOW),
    btcMain: btc ? btc.slice(-WINDOW) : null, btcHtf: btcH ? btcH.slice(-WINDOW) : null, news: null,
  }).edge;

  const samples = [];
  const last = k.length - style.holdCandles - 1;
  for (let i = WINDOW, n = 0; i <= last; i += STEP, n++) {
    const win = k.slice(i - WINDOW, i);
    const tEnd = win.at(-1).t + tfMs;
    const data = taData(win, hk, btc, btcH, tEnd, tfMs, hMs);
    if (data.hk.length < 60) continue;
    const r = run(data);
    const out = simulate(r.plan, k.slice(i, i + style.holdCandles), style.fillCandles);
    if (out) samples.push({ edge: r.edge, ...out });
    if (n % 40 === 39) await new Promise((res) => setTimeout(res)); // keep the page responsive
  }
  if (samples.length < MIN_SAMPLES) return null;

  const rate = (arr) => arr.filter((s) => s.win).length / arr.length;
  const meanR = (arr) => arr.reduce((s, x) => s + x.r, 0) / arr.length;
  let sel = samples.filter((s) => Math.abs(s.edge - edgeNow) <= 0.15);
  let scope = 'similar';
  if (sel.length < MIN_SAMPLES) {
    sel = samples.filter((s) => Math.sign(s.edge) === Math.sign(edgeNow));
    scope = 'side';
  }
  if (sel.length < MIN_SAMPLES) { sel = samples; scope = 'all'; }

  const baseRate = rate(samples), baseR = meanR(samples);
  const wins = sel.filter((s) => s.win).length, n = sel.length;
  return {
    p: (wins + PRIOR_WEIGHT * baseRate) / (n + PRIOR_WEIGHT),
    avgR: (n * meanR(sel) + PRIOR_WEIGHT * baseR) / (n + PRIOR_WEIGHT),
    wins, n, rawRate: wins / n, baseRate, scope, edgeNow,
    from: k[WINDOW].t, to: k.at(-1).t, total: samples.length,
  };
}
