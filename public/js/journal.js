// Trade journal: persistence, manually entered/closed trades, statistics and self-learning.
import { STYLES, FACTORS, pnlFor, probBucket } from './engine.js';
import { api } from './api.js';

const LS_KEY = 'radar-futures-state-v1';
const CLOSED = new Set(['win', 'loss', 'breakeven']);
const BASE_THRESHOLD = 0.25;
const MAX_THRESHOLD = 0.45;

export const defaultLearning = () => ({
  threshold: BASE_THRESHOLD, weightMult: {}, rules: {}, protective: false, log: [], lastTriggerId: null, lastRelaxId: null,
});
export const defaultState = () => ({ version: 1, trades: [], deleted: [], learning: defaultLearning() });

function normalize(raw) {
  const st = defaultState();
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.trades)) st.trades = raw.trades;
    if (Array.isArray(raw.deleted)) st.deleted = raw.deleted;
    if (raw.learning) st.learning = { ...defaultLearning(), ...raw.learning };
  }
  return st;
}

// 'file' = shared journal on the server (computer and phone see the same trades), 'locked' = phone without the
// access key, 'browser' = server not running, 'memory' = no storage at all.
export let storageMode = 'memory';

const readLocal = () => {
  try { return normalize(JSON.parse(localStorage.getItem(LS_KEY))); } catch { return defaultState(); }
};

async function readServer() {
  const res = await api('/api/state');
  if (res.status === 401) { storageMode = 'locked'; return null; }
  if (!res.ok) throw new Error(String(res.status));
  storageMode = 'file';
  const data = await res.json();
  return data && Array.isArray(data.trades) ? normalize(data) : null;
}

export async function loadState() {
  try {
    const remote = await readServer();
    if (remote) return remote;
    return readLocal(); // empty server (first run) or locked phone
  } catch { /* server not running */ }
  storageMode = 'browser';
  return readLocal();
}

// Two devices may each hold an older copy, so merge per trade instead of overwriting:
// deletions win, and a closed trade beats the still-open copy of the same trade.
function merge(local, remote) {
  const dead = new Set([...(local.deleted || []), ...(remote.deleted || [])]);
  const byId = new Map();
  for (const t of remote.trades) if (!dead.has(t.id)) byId.set(t.id, t);
  for (const t of local.trades) {
    if (dead.has(t.id)) continue;
    const other = byId.get(t.id);
    if (!other || !other.closedAt || t.closedAt) byId.set(t.id, t);
  }
  const newestLog = (st) => st.learning?.log?.[0]?.at || 0;
  return {
    trades: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt),
    deleted: [...dead].slice(-500),
    learning: newestLog(remote) > newestLog(local) ? remote.learning : local.learning,
  };
}

// Pulls changes made on the other device into `state` (in place). Returns true when something changed.
export async function syncState(state) {
  if (storageMode !== 'file') return false;
  try {
    const remote = await readServer();
    if (!remote) return false;
    const before = JSON.stringify([state.trades, state.learning]);
    Object.assign(state, merge(state, remote));
    return JSON.stringify([state.trades, state.learning]) !== before;
  } catch { return false; }
}

export async function saveState(state) {
  if (storageMode === 'file') {
    try {
      const remote = await readServer();
      if (remote) Object.assign(state, merge(state, remote));
    } catch { /* write what we have */ }
  }
  const body = JSON.stringify(state);
  try { localStorage.setItem(LS_KEY, body); } catch { /* storage blocked */ }
  if (storageMode === 'file') {
    try {
      await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    } catch { /* keep local copy */ }
  }
}

// ---------- recording ----------
// Called when the user confirms they actually entered the position (fill = real entry price, margin, leverage).
export function tradeFromAnalysis(r, fill = {}) {
  const { plan, style } = r;
  const entry = fill.entry ?? plan.entry;
  const leverage = fill.leverage ?? r.leverage;
  const margin = fill.margin ?? r.margin;
  const dir = r.side === 'LONG' ? 1 : -1;
  const liq = dir > 0 ? entry * (1 - 1 / leverage + plan.mmr) : entry * (1 + 1 / leverage - plan.mmr);
  const factors = Object.fromEntries(r.factors.filter((f) => f.w > 0).map((f) => [f.key, +f.s.toFixed(3)]));
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    symbol: r.meta.symbol, base: r.meta.base, decimals: r.meta.decimals,
    side: r.side, style: style.key, leverage, margin,
    planEntry: plan.entry, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2, liq: +liq.toFixed(r.meta.decimals),
    prob: +r.prob.toFixed(3), modelP: +r.modelP.toFixed(3), edge: +r.edge.toFixed(3), verdict: r.verdict.code,
    strategy: r.strategy?.key ?? null, be: +r.be.toFixed(3),
    riskUsd: Math.abs(pnlFor({ side: r.side, entry, leverage, margin }, [{ frac: 1, price: plan.sl }])),
    factors, ctx: Object.fromEntries(Object.entries(r.ctx).map(([k, v]) => [k, v == null ? null : +(+v).toFixed(4)])),
    status: 'open',
    exitPrice: null, pnl: null, r: null, closedAt: null,
  };
}

// The user closes the whole position at one (average) exit price.
export function closeTrade(t, price, at = Date.now()) {
  t.pnl = +pnlFor(t, [{ frac: 1, price }]).toFixed(4);
  t.exitPrice = price;
  t.status = t.pnl > 0.0001 ? 'win' : t.pnl < -0.0001 ? 'loss' : 'breakeven';
  t.r = t.riskUsd ? +(t.pnl / t.riskUsd).toFixed(3) : null;
  t.closedAt = at;
}

// ---------- statistics ----------
export const isClosed = (t) => CLOSED.has(t.status);
const isWin = (t) => t.status === 'win';
const isLoss = (t) => t.status === 'loss';

function group(trades, keyFn) {
  const map = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    const g = (map[k] ||= { n: 0, wins: 0, losses: 0, pnl: 0 });
    g.n++; g.pnl += t.pnl || 0;
    if (isWin(t)) g.wins++;
    if (isLoss(t)) g.losses++;
  }
  return map;
}

export const levBucket = (l) => (l <= 5 ? '1–5x' : l <= 10 ? '6–10x' : l <= 20 ? '11–20x' : '>20x');

export function computeStats(trades) {
  const closed = trades.filter(isClosed).sort((a, b) => a.closedAt - b.closedAt);
  const wins = closed.filter(isWin), losses = closed.filter(isLoss);
  const grossWin = closed.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -closed.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  let run = 0, maxRun = 0;
  for (const t of closed) { run = isLoss(t) ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  let cur = 0;
  for (let i = closed.length - 1; i >= 0 && isLoss(closed[i]); i--) cur++;
  let eq = 0;
  const equity = closed.map((t) => ({ t: t.closedAt, v: (eq += t.pnl || 0), id: t.id }));
  const calib = {};
  for (const t of closed) {
    const b = probBucket(t.modelP ?? t.prob);
    const g = (calib[b] ||= { n: 0, wins: 0, sumP: 0 });
    g.n++; g.sumP += t.prob; if (isWin(t)) g.wins++;
  }
  const rs = closed.map((t) => t.r).filter((v) => v != null);
  return {
    total: trades.length,
    open: trades.filter((t) => t.status === 'open' || t.status === 'pending').length,
    closed: closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    pnl: closed.reduce((s, t) => s + (t.pnl || 0), 0),
    grossWin, grossLoss, pf: grossLoss ? grossWin / grossLoss : grossWin ? Infinity : null,
    avgR: rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null,
    maxConsecLoss: maxRun, curConsecLoss: cur,
    last5Losses: closed.slice(-5).filter(isLoss).length,
    bySide: group(closed, (t) => t.side),
    byStyle: group(closed, (t) => STYLES[t.style]?.label || t.style),
    byLev: group(closed, (t) => levBucket(t.leverage)),
    bySymbol: group(closed, (t) => t.base),
    calib, equity, closedList: closed,
  };
}

// ---------- self-learning ----------
const PATTERNS = [
  { key: 'counterBtc', label: 'vào lệnh ngược xu hướng BTC', test: (t) => (t.ctx?.btcAlign ?? 0) < -0.2,
    apply: (L) => { L.rules.blockCounterBtc = true; return 'Chặn lệnh ngược xu hướng BTC'; } },
  { key: 'highLev', label: 'đòn bẩy trên 15x', test: (t) => t.leverage > 15,
    apply: (L) => { L.rules.maxLev = 10; return 'Giới hạn đòn bẩy khuyến nghị ≤ 10x'; } },
  { key: 'lowAdx', label: 'thị trường đi ngang (ADX < 20)', test: (t) => (t.ctx?.adx ?? 99) < 20,
    apply: (L) => { L.rules.minAdx = 20; return 'Chỉ vào lệnh khi ADX ≥ 20'; } },
  { key: 'againstNews', label: 'tin tức ngược hướng', test: (t) => (t.ctx?.newsAlign ?? 0) < -0.2,
    apply: (L) => { L.rules.blockAgainstNews = true; return 'Chặn lệnh ngược chiều tin tức'; } },
  { key: 'extended', label: 'vào khi giá đã chạy xa EMA20 (> 1.2 ATR)', test: (t) => (t.ctx?.ext ?? 0) > 1.2,
    apply: (L) => { L.threshold = Math.min(MAX_THRESHOLD, L.threshold + 0.03); return 'Tăng ngưỡng tín hiệu thêm 3 điểm (tránh vào đuổi)'; } },
  { key: 'LONG', label: 'lệnh Long', test: (t) => t.side === 'LONG',
    apply: (L) => { L.rules.sidePenalty = { ...L.rules.sidePenalty, LONG: 0.07 }; return 'Lệnh Long cần tín hiệu mạnh hơn 7 điểm'; } },
  { key: 'SHORT', label: 'lệnh Short', test: (t) => t.side === 'SHORT',
    apply: (L) => { L.rules.sidePenalty = { ...L.rules.sidePenalty, SHORT: 0.07 }; return 'Lệnh Short cần tín hiệu mạnh hơn 7 điểm'; } },
  ...Object.values(STYLES).map((s) => ({
    key: `style-${s.key}`, label: `phong cách ${s.label}`, test: (t) => t.style === s.key,
    apply: (L) => { L.rules.styleWarn = { ...L.rules.styleWarn, [s.key]: true }; return `Cảnh báo khi dùng ${s.label}`; },
  })),
  { key: 'weakSignal', label: 'xác suất dự đoán dưới 50%', test: (t) => t.prob < 0.5,
    apply: (L) => { L.threshold = Math.min(MAX_THRESHOLD, L.threshold + 0.03); return 'Tăng ngưỡng tín hiệu thêm 3 điểm (bỏ lệnh yếu)'; } },
];

// Returns a log entry when something was learned, otherwise null. Mutates state.learning.
export function learn(state) {
  const L = state.learning;
  const closed = state.trades.filter(isClosed).sort((a, b) => a.closedAt - b.closedAt);
  if (!closed.length) return null;
  const lastId = closed.at(-1).id;

  let winsTail = 0;
  for (let i = closed.length - 1; i >= 0 && isWin(closed[i]); i--) winsTail++;
  if (L.protective && winsTail >= 2 && L.lastRelaxId !== lastId) {
    L.protective = false;
    L.threshold = Math.max(BASE_THRESHOLD, +(L.threshold - 0.03).toFixed(3));
    L.lastRelaxId = lastId;
    const entry = { at: Date.now(), trigger: 'relax', title: 'Thắng 2 lệnh liên tiếp: thoát chế độ phòng thủ', findings: [], changes: [`Ngưỡng tín hiệu giảm về ${(L.threshold * 100).toFixed(0)}`] };
    L.log.unshift(entry);
    return entry;
  }

  let consec = 0;
  for (let i = closed.length - 1; i >= 0 && isLoss(closed[i]); i--) consec++;
  const losses5 = closed.slice(-5).filter(isLoss).length;
  const trigger = consec >= 3 ? 'streak' : losses5 >= 3 ? 'cluster' : null;
  if (!trigger || L.lastTriggerId === lastId || !isLoss(closed.at(-1))) return null;
  L.lastTriggerId = lastId;

  const changes = [], findings = [];

  // 1) Factor reliability: lower the weight of factors that agreed with losing trades.
  const overallWr = closed.filter(isWin).length / closed.length;
  for (const key of Object.keys(FACTORS)) {
    const agreed = closed.filter((t) => t.factors?.[key] != null && t.factors[key] * (t.side === 'LONG' ? 1 : -1) > 0.15);
    if (agreed.length < 4) continue;
    const wr = agreed.filter(isWin).length / agreed.length;
    const mult = +Math.min(1.6, Math.max(0.4, 1 + 1.2 * (wr - overallWr))).toFixed(2);
    const old = L.weightMult[key] ?? 1;
    if (Math.abs(mult - old) >= 0.05) {
      L.weightMult[key] = mult;
      changes.push(`Trọng số "${FACTORS[key].name}": ${old.toFixed(2)} → ${mult.toFixed(2)} (khi đồng thuận thắng ${Math.round(wr * 100)}%)`);
    }
  }

  // 2) Look for conditions shared by recent losses.
  const recent = closed.slice(-12);
  const overallLossRate = recent.filter(isLoss).length / recent.length;
  for (const pat of PATTERNS) {
    const sub = recent.filter(pat.test);
    if (sub.length < 3) continue;
    const lr = sub.filter(isLoss).length / sub.length;
    if (lr >= 0.67 && lr >= overallLossRate + 0.1) {
      findings.push(`Thua ${sub.filter(isLoss).length}/${sub.length} lệnh khi ${pat.label}.`);
      changes.push(pat.apply(L));
    }
  }
  if (!findings.length) findings.push('Không thấy điều kiện chung rõ ràng giữa các lệnh thua. Có thể do biến động ngẫu nhiên hoặc thị trường đổi trạng thái.');

  // 3) Stricter threshold + protective sizing.
  const before = L.threshold;
  L.threshold = Math.min(MAX_THRESHOLD, +(L.threshold + 0.05).toFixed(3));
  if (L.threshold !== before) changes.push(`Ngưỡng tín hiệu tối thiểu: ${(before * 100).toFixed(0)} → ${(L.threshold * 100).toFixed(0)}`);
  if (!L.protective) { L.protective = true; changes.push('Bật chế độ phòng thủ: khuyến nghị giảm 50% đòn bẩy và số tiền vào lệnh'); }

  const entry = {
    at: Date.now(), trigger,
    title: trigger === 'streak' ? `Thua ${consec} lệnh liên tiếp` : `Thua ${losses5}/5 lệnh gần nhất (ngắt quãng)`,
    findings, changes,
  };
  L.log.unshift(entry);
  L.log = L.log.slice(0, 50);
  return entry;
}
