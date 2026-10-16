// Picks a strategy for this coin and timeframe, and measures it honestly:
// 1. At every past moment the same analysis is re-run and each of the six strategies (strategies.js) is simulated.
// 2. The strategy is CHOSEN on the older 60% of that history.
// 3. The win rate shown is measured only on the newer 40%, which played no part in choosing.
//    Picking the best of six and reporting its score on the same data would flatter it by luck.
// Funding, OI, long/short ratio, sentiment and news have no usable history, so this uses the price-based factors only.
import { analyze, planLevels } from './engine.js';
import { STRATEGIES, breakeven } from './strategies.js';

const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
const WINDOW = 300;
const STEP = 3;
const TRAIN_SHARE = 0.6;
const MIN_TRAIN_TRADES = 12;
const PRIOR = 8; // small samples are pulled toward breakeven (no edge) rather than trusted at face value
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

// Simulates a plan on the candles that followed. SL is checked first inside a candle (conservative).
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
    if ((best - plan.tp1) * dir >= 0) return { win: true, r: plan.tpR - feeR };
  }
  // Time stop: closed at the last candle's close.
  return { win: false, r: ((fut.at(-1).c - plan.entry) * dir) / risk - feeR };
}

function stats(trades) {
  const n = trades.length, wins = trades.filter((t) => t.win).length;
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  return { n, wins, rate: n ? wins / n : null, avgR: n ? sumR / n : null, sumR };
}

const lastN = (arr) => (arr ? arr.slice(-WINDOW) : null);

// Returns { strategy, history, table, reason }. strategy is null when nothing can be recommended right now.
export async function selectStrategy({ meta, style, hist, learning, forcedSide }) {
  const tfMs = TF_MS[style.tf], hMs = TF_MS[style.htf];
  const { k, hk, btc, btcH } = hist;
  const run = (data) => analyze({ meta, style, leverage: 1, margin: 100, forcedSide: null, data, learning, calib: null });

  // Today's signals, measured the same way as the past ones (price-based factors only).
  const now = run({ k: lastN(k), hk: lastN(hk), btcMain: lastN(btc), btcHtf: lastN(btcH), news: null });
  const sideNow = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.signal(now)]));

  const trades = Object.fromEntries(STRATEGIES.map((s) => [s.key, []]));
  const last = k.length - style.holdCandles - 1;
  for (let i = WINDOW, step = 0; i <= last; i += STEP, step++) {
    const win = k.slice(i - WINDOW, i);
    const tEnd = win.at(-1).t + tfMs;
    const data = {
      k: win, hk: closedUpTo(hk, tEnd, hMs),
      btcMain: btc ? closedUpTo(btc, tEnd, tfMs) : null, btcHtf: btcH ? closedUpTo(btcH, tEnd, hMs) : null, news: null,
    };
    if (data.hk.length < 60) continue;
    const r = run(data);
    const fut = k.slice(i, i + style.holdCandles);
    for (const s of STRATEGIES) {
      const side = s.signal(r);
      if (!side) continue;
      const plan = planLevels({ side, k: win, a: r.ind.a, e20: r.ind.e20, piv: r.ind.piv, tpR: s.tpR, entryMode: s.entryMode, slMode: s.slMode });
      const out = simulate(plan, fut, style.fillCandles);
      if (out) trades[s.key].push({ i, ...out });
    }
    if (step % 40 === 39) await new Promise((res) => setTimeout(res)); // keep the page responsive
  }

  // Time split with a gap of one holding period, so no training trade is still open inside the test period.
  const cut = WINDOW + Math.floor((last - WINDOW) * TRAIN_SHARE);
  const testStart = cut + style.holdCandles;
  const at = (i) => k[Math.min(i, k.length - 1)].t;
  const table = STRATEGIES.map((s) => {
    const train = stats(trades[s.key].filter((t) => t.i < cut));
    const test = stats(trades[s.key].filter((t) => t.i >= testStart));
    const be = breakeven(s);
    return {
      key: s.key, name: s.name, family: s.family, tpR: s.tpR, entryMode: s.entryMode, slMode: s.slMode, be,
      sideNow: sideNow[s.key], train, test,
      score: train.n ? train.sumR / (train.n + PRIOR) : -Infinity, // expectancy, shrunk when few trades
      p: (test.wins + PRIOR * be) / (test.n + PRIOR),
      avgR: test.sumR / (test.n + PRIOR),
    };
  });
  const period = { trainFrom: at(WINDOW), trainTo: at(cut), testFrom: at(testStart), testTo: k.at(-1).t };

  const firing = table.filter((t) => t.sideNow);
  const eligible = firing.filter((t) => (!forcedSide || t.sideNow === forcedSide) && t.train.n >= MIN_TRAIN_TRADES);
  if (!eligible.length) {
    const reason = !firing.length
      ? 'Lúc này không chiến lược nào trong 6 chiến lược có tín hiệu vào lệnh.'
      : forcedSide && !firing.some((t) => t.sideNow === forcedSide)
        ? `Lúc này không chiến lược nào cho tín hiệu ${forcedSide}.`
        : 'Chưa đủ dữ liệu quá khứ để chọn chiến lược.';
    return { strategy: null, history: null, table, period, reason };
  }
  const best = eligible.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    strategy: { ...best, side: best.sideNow },
    history: { p: best.p, avgR: best.avgR, be: best.be, wins: best.test.wins, n: best.test.n, rawRate: best.test.rate, ...period },
    table, period, reason: null,
  };
}
