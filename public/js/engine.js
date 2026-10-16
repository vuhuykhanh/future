// Analysis engine: scores factors, builds a trade plan, estimates win probability and risks.
// Probabilities here are heuristic estimates, not guarantees.
import * as I from './indicators.js';

const { clamp, last } = I;

export const STYLES = {
  scalp: { key: 'scalp', label: 'Scalp · 15m', tf: '15m', htf: '1h', period: '15m', holdCandles: 16, tfMs: 15 * 60e3, evalInterval: '1m', evalMs: 60e3, fillCandles: 4, volAtr: 0.012 },
  intraday: { key: 'intraday', label: 'Intraday · 1h', tf: '1h', htf: '4h', period: '1h', holdCandles: 24, tfMs: 3600e3, evalInterval: '5m', evalMs: 5 * 60e3, fillCandles: 6, volAtr: 0.025 },
  swing: { key: 'swing', label: 'Swing · 4h', tf: '4h', htf: '1d', period: '4h', holdCandles: 30, tfMs: 4 * 3600e3, evalInterval: '15m', evalMs: 15 * 60e3, fillCandles: 6, volAtr: 0.05 },
};

export const FACTORS = {
  trend: { name: 'Xu hướng khung chính', w: 1.5, group: 'Kỹ thuật' },
  htf: { name: 'Xu hướng khung lớn', w: 1.5, group: 'Kỹ thuật' },
  macd: { name: 'MACD (động lượng)', w: 1.0, group: 'Kỹ thuật' },
  rsi: { name: 'RSI 14', w: 1.0, group: 'Kỹ thuật' },
  boll: { name: 'Bollinger Bands', w: 0.5, group: 'Kỹ thuật' },
  flow: { name: 'Dòng lệnh taker & volume', w: 0.7, group: 'Phái sinh' },
  oi: { name: 'Open Interest', w: 0.7, group: 'Phái sinh' },
  funding: { name: 'Funding rate', w: 0.6, group: 'Phái sinh' },
  crowd: { name: 'Tỷ lệ Long/Short đám đông', w: 0.5, group: 'Phái sinh' },
  btc: { name: 'Xu hướng BTC', w: 1.2, group: 'Thị trường' },
  mood: { name: 'Tâm lý & vốn hóa thị trường', w: 0.6, group: 'Thị trường' },
  newsCoin: { name: 'Tin tức về coin', w: 0.8, group: 'Tin tức' },
  newsMarket: { name: 'Tin tức toàn thị trường', w: 0.4, group: 'Tin tức' },
  macro: { name: 'Tin Fed / vĩ mô', w: 0.6, group: 'Tin tức' },
};

const FEE = 0.0005; // taker fee per side
export const BREAKEVEN_P = 1 / (1 + 1.5); // TP1 = 1.5R, SL = 1R

// ---------- news sentiment ----------
const COIN_NAMES = {
  BTC: ['bitcoin'], ETH: ['ethereum', 'ether'], SOL: ['solana'], BNB: ['bnb', 'binance coin'], XRP: ['xrp', 'ripple'],
  DOGE: ['dogecoin'], ADA: ['cardano'], AVAX: ['avalanche'], LINK: ['chainlink'], DOT: ['polkadot'], TON: ['toncoin', 'ton network'],
  TRX: ['tron'], SUI: ['sui network', 'sui'], APT: ['aptos'], ARB: ['arbitrum'], OP: ['optimism'], NEAR: ['near protocol'],
  LTC: ['litecoin'], PEPE: ['pepe'], SHIB: ['shiba inu'], WIF: ['dogwifhat'], UNI: ['uniswap'], AAVE: ['aave'],
  INJ: ['injective'], TIA: ['celestia'], SEI: ['sei network'], HYPE: ['hyperliquid'], ENA: ['ethena'], ONDO: ['ondo'],
  FIL: ['filecoin'], ATOM: ['cosmos'], ETC: ['ethereum classic'], BCH: ['bitcoin cash'], XLM: ['stellar'], HBAR: ['hedera'],
  ICP: ['internet computer'], RENDER: ['render network'], FET: ['fetch.ai', 'artificial superintelligence alliance'], TAO: ['bittensor'],
  WLD: ['worldcoin', 'world network'], JUP: ['jupiter'], PYTH: ['pyth'], BONK: ['bonk'], FLOKI: ['floki'], TRUMP: ['trump coin', 'official trump'],
  POL: ['polygon'], MATIC: ['polygon'], ALGO: ['algorand'], XMR: ['monero'], KAS: ['kaspa'], STX: ['stacks'], MKR: ['maker'],
  LDO: ['lido'], CRV: ['curve'], PENDLE: ['pendle'], VIRTUAL: ['virtuals protocol'], BERA: ['berachain'], S: ['sonic'],
};

const lex = (pairs) => pairs.map(([w, v]) => [new RegExp(`\\b${w}`, 'i'), v]);
const POS = lex([
  ['surg', 1], ['soar', 1], ['rall', 1], ['jump', 0.7], ['gain', 0.5], ['rises?\\b', 0.5], ['climb', 0.6], ['bullish', 1], ['approv', 0.8],
  ['inflow', 0.7], ['partnership', 0.6], ['launch', 0.4], ['upgrade', 0.5], ['record high', 1], ['all-time high', 1], ['adoption', 0.6],
  ['breakout', 0.8], ['rebound', 0.6], ['recover', 0.5], ['accumulat', 0.6], ['lists?\\b', 0.4], ['listing', 0.5], ['integrat', 0.4],
  ['outperform', 0.6], ['milestone', 0.4], ['buyback', 0.6], ['reserve', 0.3], ['upbeat', 0.5], ['optimis', 0.5],
]);
const NEG = lex([
  ['plung', 1], ['crash', 1], ['drops?\\b', 0.6], ['falls?\\b', 0.6], ['slump', 0.8], ['bearish', 1], ['hack', 1], ['exploit', 1],
  ['lawsuit', 0.8], ['sues?\\b', 0.8], ['bans?\\b', 0.7], ['outflow', 0.7], ['liquidat', 0.6], ['delist', 1], ['sell-?off', 0.8],
  ['fraud', 1], ['investigat', 0.6], ['dump', 0.8], ['declin', 0.6], ['plummet', 1], ['tumbl', 0.8], ['scam', 1], ['crackdown', 0.8],
  ['sinks?\\b', 0.7], ['loss', 0.4], ['fear', 0.4], ['bankrupt', 1], ['unlock', 0.4], ['slid', 0.6], ['slide', 0.6], ['tariff', 0.4],
  ['warns?\\b', 0.4], ['drain', 0.8], ['stolen', 1], ['halt', 0.6],
]);

// Fed / macro language, scored for its effect on crypto: hawkish = bearish, dovish = bullish.
const MACRO_TOPIC = /\b(fed|fomc|federal reserve|powell|warsh|fed chair|rate (cut|hike)s?|rate-(cut|hike)|interest rates?|cpi|ppi|inflation|treasury yields?|bond yields?|payrolls|jobs report|unemployment|recession|dollar index|dxy)\b/i;
const HAWKISH = lex([
  ['rate[ -]hikes?', 1], ['hikes? rates', 1], ['raises? rates', 1], ['hawkish', 1], ['hot(ter)? inflation', 1], ['inflation (rises|rose|jumps|accelerat|surges|heats|tops|beats)', 0.8],
  ['(cpi|ppi) (gains|jumps|rises|rose|beats|tops|hotter)', 0.8], ['higher for longer', 0.9], ['(tightening|tighter policy)', 0.7],
  ['yields? (rise|rises|rose|jump|surge|climb|spike)', 0.6], ['dollar (rall|surge|strengthen|jumps)', 0.5], ['stronger dollar', 0.5],
  ['strong (jobs|payrolls|labor)', 0.4], ['no rate cuts?', 0.8],
]);
const DOVISH = lex([
  ['rate[ -]cuts?', 1], ['cuts? rates', 1], ['dovish', 1], ['cool(ing|er|s)? inflation', 0.9], ['inflation (eases|eased|slows|slowed|cools|cooled|falls|fell)', 0.8],
  ['(cpi|ppi|inflation) (misses|cooler|cools|cooled|eases|eased|falls|fell|slows|slowed)', 0.8], ['(easing|looser policy)', 0.6], ['yields? (fall|falls|fell|drop|slide|slump)', 0.6],
  ['dollar (falls|fell|slides|weakens|slumps)', 0.5], ['weaker dollar', 0.5], ['quantitative easing', 0.9], ['liquidity injection', 0.8],
  ['weak (jobs|payrolls|labor)', 0.4],
]);
// "avoids rate-hike hints", "rules out a cut": a negation just before the phrase flips its meaning.
const NEGATION = /\b(avoids?|avoided|no|not|without|rules? out|ruled out|dismiss(es|ed)?|rejects?|rejected|downplays?|shuns?|silent on|unlikely)\b[^.]{0,25}$/i;

// Returns the macro score and the text with scored phrases blanked out, so "yields fall"
// is not counted a second time as a bearish "fall" by the generic word list.
function macroSentiment(text) {
  let s = 0, rest = text;
  const score = (pairs, sign) => {
    for (const [re, v] of pairs) {
      const m = re.exec(rest);
      if (!m) continue;
      s += sign * v * (NEGATION.test(rest.slice(0, m.index)) ? -1 : 1);
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  };
  score(HAWKISH, -1);
  score(DOVISH, 1);
  return { s, rest };
}

export const isMacroNews = (it) => MACRO_TOPIC.test(`${it.title} ${it.summary || ''}`);

export function headlineSentiment(text) {
  const macro = macroSentiment(text);
  let s = macro.s;
  for (const [re, v] of POS) if (re.test(macro.rest)) s += v;
  for (const [re, v] of NEG) if (re.test(macro.rest)) s -= v;
  return clamp(s, -2, 2) / 2;
}

function newsMatcher(base) {
  const names = COIN_NAMES[base] || [];
  const nameRes = names.map((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  const symRe = base.length >= 3 ? new RegExp(`(^|[^A-Za-z$])\\$?${base}([^A-Za-z]|$)`) : null;
  return (it) => nameRes.some((re) => re.test(it.title) || re.test(it.summary || '')) || (symRe && symRe.test(it.title));
}

function aggregateNews(items, horizonH, now) {
  const recent = items.filter((it) => it.published && now - it.published < horizonH * 3600e3);
  let sw = 0, ss = 0;
  const scored = recent.map((it) => {
    const s = headlineSentiment(`${it.title}. ${it.summary || ''}`);
    const w = Math.exp(-(now - it.published) / (24 * 3600e3));
    sw += w; ss += w * s;
    return { ...it, s };
  });
  return { score: sw ? ss / sw : 0, count: recent.length, items: scored.slice(0, 8) };
}

// ---------- helpers ----------
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

function trendInfo(k) {
  const closes = k.map((x) => x.c);
  const e20 = last(I.ema(closes, 20)), e50 = last(I.ema(closes, 50));
  const e200 = closes.length >= 200 ? last(I.ema(closes, 200)) : null;
  const c = closes.at(-1);
  let s = (c > e20 ? 0.3 : -0.3) + (e20 > e50 ? 0.35 : -0.35);
  if (e200 != null) s += e50 > e200 ? 0.35 : -0.35;
  else s /= 0.65;
  return { s: clamp(s, -1, 1), c, e20, e50, e200 };
}

export const trendLabel = (s) => (s >= 0.65 ? 'tăng mạnh' : s >= 0.2 ? 'nghiêng tăng' : s <= -0.65 ? 'giảm mạnh' : s <= -0.2 ? 'nghiêng giảm' : 'đi ngang');

export const probBucket = (p) => (p < 0.45 ? '<45%' : p < 0.55 ? '45–55%' : p < 0.65 ? '55–65%' : '≥65%');

export function makeFmt(decimals) {
  return (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
}

// PnL for an isolated-margin position given exits [{frac, price}] in USDT, fees included.
// The loss is capped at the margin: past the liquidation price the position is already gone.
export function pnlFor({ side, entry, leverage, margin }, exits) {
  const dir = side === 'LONG' ? 1 : -1;
  const qty = (margin * leverage) / entry;
  let pnl = -margin * leverage * FEE;
  for (const { frac, price } of exits) pnl += frac * qty * (price - entry) * dir - frac * qty * price * FEE;
  return Math.max(pnl, -margin);
}

// ---------- trade plan ----------
function buildPlan({ side, k, a, e20, piv, leverage, margin, mmr, style, decimals }) {
  const dir = side === 'LONG' ? 1 : -1;
  const c = k.at(-1).c;
  const n = k.length;
  const round = (v) => +v.toFixed(decimals);
  const ext = ((c - e20) * dir) / a; // how far price already ran in our direction, in ATR

  let entry = c, mode = 'market';
  if (ext > 1.5) {
    entry = c - dir * Math.min(1.0 * a, (c - e20) * dir * 0.5);
    mode = 'limit';
  }

  const recentLows = piv.lows.filter((p) => p.i > n - 60).map((p) => p.price);
  const recentHighs = piv.highs.filter((p) => p.i > n - 60).map((p) => p.price);
  let sl, structural = false;
  if (dir > 0) {
    const cands = recentLows.filter((p) => p < entry - 0.3 * a && p > entry - 3 * a);
    if (cands.length) { sl = Math.max(...cands) - 0.3 * a; structural = true; } else sl = entry - 1.5 * a;
    if (entry - sl < 0.8 * a) sl = entry - 0.8 * a;
  } else {
    const cands = recentHighs.filter((p) => p > entry + 0.3 * a && p < entry + 3 * a);
    if (cands.length) { sl = Math.min(...cands) + 0.3 * a; structural = true; } else sl = entry + 1.5 * a;
    if (sl - entry < 0.8 * a) sl = entry + 0.8 * a;
  }
  const risk = Math.abs(entry - sl);
  let tp1 = entry + dir * 1.5 * risk;
  let tp2 = entry + dir * 2.5 * risk;

  // Opposite swing levels sitting between entry and TP1 can stall the move
  const lookback = piv[dir > 0 ? 'highs' : 'lows'].filter((p) => p.i > n - 100).map((p) => p.price);
  const blockers = lookback.filter((p) => (dir > 0 ? p > entry && p < tp1 : p < entry && p > tp1));
  const obstacle = blockers.length ? (dir > 0 ? Math.min(...blockers) : Math.max(...blockers)) : null;

  entry = round(entry); sl = round(sl); tp1 = round(tp1); tp2 = round(tp2);
  const liq = round(dir > 0 ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr));
  const slPct = Math.abs(entry - sl) / entry;
  const liqPct = Math.abs(entry - liq) / entry;
  const maxSafeLev = Math.max(1, Math.floor(1 / (slPct * 1.3 + mmr)));

  const pos = { side, entry, leverage, margin };
  const notional = margin * leverage;
  const money = {
    notional,
    qty: notional / entry,
    pnlTp1: pnlFor(pos, [{ frac: 1, price: tp1 }]),
    pnlTp2: pnlFor(pos, [{ frac: 1, price: tp2 }]),
    pnlPlan: pnlFor(pos, [{ frac: 0.5, price: tp1 }, { frac: 0.5, price: tp2 }]),
    pnlSl: pnlFor(pos, [{ frac: 1, price: sl }]),
    fees: notional * FEE * 2,
  };
  money.roeTp1 = money.pnlTp1 / margin;
  money.roePlan = money.pnlPlan / margin;
  money.roeSl = money.pnlSl / margin;

  return {
    side, dir, mode, entry, sl, tp1, tp2, liq, ext, structural, obstacle, risk, slPct, liqPct, maxSafeLev, mmr,
    tp1Pct: Math.abs(tp1 - entry) / entry, tp2Pct: Math.abs(tp2 - entry) / entry,
    money, holdHours: (style.holdCandles * style.tfMs) / 3600e3,
  };
}

// ---------- main ----------
export function analyze({ meta, style, leverage, margin, forcedSide, data, learning, calib, history }) {
  const now = Date.now();
  const { k, hk } = data;
  const closes = k.map((x) => x.c);
  const c = closes.at(-1);
  const fmt = makeFmt(meta.decimals);
  const a = last(I.atr(k));
  const atrPct = a / c;
  const tMain = trendInfo(k), tH = trendInfo(hk);
  const rsiArr = I.rsi(closes);
  const rNow = last(rsiArr), rPrev = rsiArr[rsiArr.length - 4];
  const m = I.macd(closes);
  const h = last(m.hist), hp = m.hist[m.hist.length - 2];
  const bb = I.bollinger(closes);
  const bUp = last(bb.upper), bLo = last(bb.lower);
  const pb = (c - bLo) / (bUp - bLo);
  const ax = I.adx(k);
  const adxNow = last(ax.adx);
  const piv = I.pivots(k);
  const L = learning || {};
  const factors = [];
  const add = (key, s, value, note, wScale = 1) => {
    const mult = L.weightMult?.[key] ?? 1;
    factors.push({ key, name: FACTORS[key].name, group: FACTORS[key].group, s: clamp(s, -1, 1), w: FACTORS[key].w * wScale * mult, mult, value, note });
  };

  // Trend
  const trendNote = (t, tf) => `Khung ${tf}: ${trendLabel(t.s)}. Giá ${t.c > t.e20 ? 'trên' : 'dưới'} EMA20, EMA20 ${t.e20 > t.e50 ? 'trên' : 'dưới'} EMA50${t.e200 != null ? `, EMA50 ${t.e50 > t.e200 ? 'trên' : 'dưới'} EMA200` : ''}.`;
  add('trend', tMain.s, trendLabel(tMain.s), trendNote(tMain, style.tf));
  add('htf', tH.s, trendLabel(tH.s), trendNote(tH, style.htf));

  // MACD
  {
    const crossUp = m.hist.slice(-4).some((v, i, arr) => i > 0 && arr[i - 1] < 0 && v >= 0);
    const crossDn = m.hist.slice(-4).some((v, i, arr) => i > 0 && arr[i - 1] > 0 && v <= 0);
    const s = (h > 0 ? 0.6 : -0.6) + (h > hp ? 0.4 : -0.4);
    const note = `Histogram ${h > 0 ? 'dương' : 'âm'} và đang ${h > hp ? 'tăng' : 'giảm'}${crossUp ? ', vừa cắt lên tín hiệu' : crossDn ? ', vừa cắt xuống tín hiệu' : ''}.`;
    add('macd', s, `${h > 0 ? '+' : ''}${((h / c) * 100).toFixed(3)}%`, note);
  }

  // RSI
  {
    const slope = rNow - rPrev;
    let s, note;
    if (rNow >= 75) { s = -0.8; note = 'Quá mua mạnh, rủi ro điều chỉnh cao.'; }
    else if (rNow >= 70) { s = -0.4; note = 'Vùng quá mua, mua đuổi kém an toàn.'; }
    else if (rNow >= 55) { s = 0.5; note = 'Động lượng tăng khỏe, chưa quá mua.'; }
    else if (rNow > 45) { s = clamp(slope / 10, -0.3, 0.3); note = `Trung tính, RSI đang ${slope >= 0 ? 'đi lên' : 'đi xuống'}.`; }
    else if (rNow > 30) { s = -0.5; note = 'Động lượng giảm chiếm ưu thế.'; }
    else if (rNow > 25) { s = 0.4; note = 'Vùng quá bán, có thể bật lại.'; }
    else { s = 0.8; note = 'Quá bán mạnh, rủi ro short đuổi cao.'; }
    add('rsi', s, rNow.toFixed(1), note);
  }

  // Bollinger
  {
    let s, note;
    if (pb > 1) {
      s = adxNow > 30 && tMain.s > 0.5 ? 0.1 : -0.6;
      note = s > 0 ? 'Giá vượt dải trên trong xu hướng mạnh (đi theo dải).' : 'Giá vượt dải trên, dễ bị kéo về giữa dải.';
    } else if (pb < 0) {
      s = adxNow > 30 && tMain.s < -0.5 ? -0.1 : 0.6;
      note = s < 0 ? 'Giá thủng dải dưới trong xu hướng giảm mạnh.' : 'Giá thủng dải dưới, dễ hồi về giữa dải.';
    } else {
      s = (0.5 - pb) * 0.6;
      note = pb > 0.8 ? 'Giá sát dải trên.' : pb < 0.2 ? 'Giá sát dải dưới.' : 'Giá ở giữa dải, chưa có lợi thế.';
    }
    add('boll', s, `%B ${(pb * 100).toFixed(0)}`, note);
  }

  // Taker flow + volume
  {
    let s = 0;
    const notes = [];
    let value = '—';
    if (data.taker?.length >= 3) {
      const avg = mean(data.taker.slice(-3).map((x) => +x.buySellRatio));
      s += clamp((avg - 1) * 2.5, -0.6, 0.6);
      value = `Mua/Bán ${avg.toFixed(2)}`;
      notes.push(avg > 1.05 ? 'Lệnh mua chủ động áp đảo.' : avg < 0.95 ? 'Lệnh bán chủ động áp đảo.' : 'Mua/bán chủ động cân bằng.');
    }
    const vol20 = mean(k.slice(-23, -3).map((x) => x.qv));
    const vol3 = mean(k.slice(-3).map((x) => x.qv));
    const vr = vol20 ? vol3 / vol20 : 1;
    const dir3 = Math.sign(c - k.at(-4).c);
    if (vr > 1.3) {
      s += 0.4 * dir3 * Math.min(1, vr - 1);
      notes.push(`Volume 3 nến gần nhất gấp ${vr.toFixed(1)} lần trung bình, ủng hộ chiều ${dir3 > 0 ? 'tăng' : 'giảm'}.`);
    } else notes.push(`Volume ${vr < 0.7 ? 'yếu' : 'bình thường'} (${vr.toFixed(1)}x trung bình).`);
    add('flow', s, value, notes.join(' '));
  }

  // Open interest vs price
  if (data.oiHist?.length >= 7) {
    const o = data.oiHist;
    const oiCh = +o.at(-1).sumOpenInterest / +o.at(-7).sumOpenInterest - 1;
    const pxCh = c / closes.at(-7) - 1;
    const mag = clamp(Math.abs(oiCh) / 0.05, 0.2, 1);
    let s = 0, note = 'OI ít thay đổi, chưa có dòng tiền mới rõ ràng.';
    if (oiCh > 0.005 && pxCh > 0) { s = 0.6 * mag; note = 'Giá tăng kèm OI tăng: vị thế Long mới vào, xu hướng có lực.'; }
    else if (oiCh > 0.005 && pxCh < 0) { s = -0.6 * mag; note = 'Giá giảm kèm OI tăng: Short mới mở mạnh.'; }
    else if (oiCh < -0.005 && pxCh > 0) { s = 0.2; note = 'Giá tăng nhưng OI giảm: chủ yếu Short đóng lệnh, đà tăng yếu.'; }
    else if (oiCh < -0.005 && pxCh < 0) { s = -0.2; note = 'Giá giảm và OI giảm: Long đang cắt lỗ.'; }
    add('oi', s, `${oiCh >= 0 ? '+' : ''}${(oiCh * 100).toFixed(2)}% / 6 nến`, note);
  } else add('oi', 0, '—', 'Không lấy được dữ liệu OI.', 0);

  // Funding
  const funding = data.premium ? +data.premium.lastFundingRate : null;
  if (funding != null) {
    let s = 0, note = 'Funding trung tính.';
    if (funding >= 0.0005) { s = -0.8; note = 'Funding rất cao: phe Long quá đông, dễ bị xả (long squeeze).'; }
    else if (funding >= 0.0002) { s = -0.4; note = 'Funding dương cao: Long đang trả phí, đám đông nghiêng Long.'; }
    else if (funding <= -0.0003) { s = 0.6; note = 'Funding âm sâu: Short quá đông, dễ bị ép (short squeeze).'; }
    else if (funding <= -0.0001) { s = 0.3; note = 'Funding âm: phe Short trả phí.'; }
    add('funding', s, `${(funding * 100).toFixed(4)}%/8h`, note);
  } else add('funding', 0, '—', 'Không lấy được funding.', 0);

  // Crowd long/short ratio (contrarian)
  if (data.lsr?.length) {
    const r = +data.lsr.at(-1).longShortRatio;
    let s = 0, note = 'Tỷ lệ Long/Short cân bằng.';
    if (r > 2.5) { s = -0.6; note = 'Đám đông Long áp đảo: rủi ro bị quét Long.'; }
    else if (r > 1.8) { s = -0.3; note = 'Nhiều tài khoản Long hơn Short đáng kể.'; }
    else if (r < 0.7) { s = 0.5; note = 'Đám đông Short áp đảo: dễ bị ép Short.'; }
    else if (r < 0.9) { s = 0.25; note = 'Tài khoản Short nhiều hơn Long.'; }
    add('crowd', s, r.toFixed(2), note);
  } else add('crowd', 0, '—', 'Không có dữ liệu.', 0);

  // BTC / market trend
  let btcAlignRaw = 0, btcCorr = null, btcTrend = null;
  if (data.btcHtf && data.btcMain) {
    const bH = trendInfo(data.btcHtf), bM = trendInfo(data.btcMain);
    btcAlignRaw = 0.6 * bH.s + 0.4 * bM.s;
    btcTrend = { htf: bH, main: bM };
    const byT = new Map(data.btcMain.map((x) => [x.t, x.c]));
    const pairs = k.slice(-101).filter((x) => byT.has(x.t));
    btcCorr = I.correlation(I.returns(pairs.map((x) => x.c)), I.returns(pairs.map((x) => byT.get(x.t))));
    const scale = btcCorr == null ? 0.6 : clamp(btcCorr, 0.35, 1);
    add('btc', btcAlignRaw, `${trendLabel(bH.s)} · tương quan ${btcCorr == null ? '—' : btcCorr.toFixed(2)}`,
      `BTC khung ${style.htf} ${trendLabel(bH.s)}, khung ${style.tf} ${trendLabel(bM.s)}. Coin này ${btcCorr != null && btcCorr > 0.6 ? 'đi rất sát' : btcCorr != null && btcCorr > 0.35 ? 'chịu ảnh hưởng vừa phải từ' : 'ít phụ thuộc'} BTC.`, scale);
  } else if (meta.symbol === 'BTCUSDT') {
    add('btc', 0, 'Chính là BTC', 'Coin là BTC nên xu hướng thị trường đã nằm trong mục xu hướng.', 0);
  } else add('btc', 0, '—', 'Không lấy được dữ liệu BTC.', 0);

  // Mood: fear & greed + total market cap change
  const fng = data.fng?.data?.[0] ? +data.fng.data[0].value : null;
  const mcapCh = data.global?.market_cap_change_percentage_24h_usd ?? null;
  if (fng != null || mcapCh != null) {
    let s = 0;
    const notes = [];
    if (fng != null) {
      if (fng >= 80) { s -= 0.5; notes.push('Thị trường tham lam cực độ: dễ điều chỉnh.'); }
      else if (fng >= 65) { s -= 0.15; notes.push('Tâm lý tham lam.'); }
      else if (fng <= 20) { s += 0.5; notes.push('Sợ hãi cực độ: thường gần vùng đáy ngắn hạn.'); }
      else if (fng <= 35) { s += 0.15; notes.push('Tâm lý sợ hãi.'); }
      else notes.push('Tâm lý trung tính.');
    }
    if (mcapCh != null) {
      s += clamp(mcapCh / 6, -0.5, 0.5);
      notes.push(`Tổng vốn hóa 24h ${mcapCh >= 0 ? '+' : ''}${mcapCh.toFixed(2)}%.`);
    }
    add('mood', s, `F&G ${fng ?? '—'}`, notes.join(' '));
  } else add('mood', 0, '—', 'Không lấy được dữ liệu tâm lý.', 0);

  // News
  let coinNews = null, marketNews = null, macroNews = null;
  if (Array.isArray(data.news)) {
    const base = meta.base.replace(/^1000000|^1000/, '');
    const match = newsMatcher(base);
    coinNews = aggregateNews(data.news.filter(match), 48, now);
    marketNews = aggregateNews(data.news, 24, now);
    if (coinNews.count) {
      add('newsCoin', clamp(coinNews.score * 1.6, -1, 1) * (coinNews.count < 2 ? 0.6 : 1), `${coinNews.count} tin / 48h`,
        coinNews.score > 0.1 ? 'Tin tức về coin nghiêng tích cực.' : coinNews.score < -0.1 ? 'Tin tức về coin nghiêng tiêu cực.' : 'Tin tức về coin trung tính.');
    } else add('newsCoin', 0, '0 tin', 'Không có tin đáng chú ý về coin này trong 48h.', 0);
    add('newsMarket', clamp(marketNews.score * 1.6, -1, 1), `${marketNews.count} tin / 24h`,
      marketNews.score > 0.1 ? 'Dòng tin chung nghiêng tích cực.' : marketNews.score < -0.1 ? 'Dòng tin chung nghiêng tiêu cực.' : 'Dòng tin chung trung tính.', marketNews.count ? 1 : 0);
    macroNews = aggregateNews(data.news.filter(isMacroNews), 48, now);
    add('macro', clamp(macroNews.score * 1.6, -1, 1), `${macroNews.count} tin / 48h`,
      macroNews.score > 0.1 ? 'Tin Fed/vĩ mô nghiêng nới lỏng (tốt cho crypto).' : macroNews.score < -0.1 ? 'Tin Fed/vĩ mô nghiêng thắt chặt (xấu cho crypto).' : 'Tin Fed/vĩ mô trung tính.',
      macroNews.count ? 1 : 0);
  } else {
    add('newsCoin', 0, '—', 'Không tải được tin (cần chạy server.py).', 0);
    add('newsMarket', 0, '—', 'Không tải được tin.', 0);
    add('macro', 0, '—', 'Không tải được tin.', 0);
  }

  // ---------- aggregate ----------
  const active = factors.filter((f) => f.w > 0);
  const wSum = active.reduce((s, f) => s + f.w, 0);
  const S = wSum ? active.reduce((s, f) => s + f.w * f.s, 0) / wSum : 0;
  const adxMult = adxNow == null ? 0.9 : adxNow < 18 ? 0.75 : adxNow < 25 ? 0.9 : 1;
  const autoSide = S >= 0 ? 'LONG' : 'SHORT';
  const side = forcedSide || autoSide;
  const dir = side === 'LONG' ? 1 : -1;
  const edge = S * dir;
  const agree = active.filter((f) => f.s * dir > 0.1).length;
  const against = active.filter((f) => f.s * dir < -0.1).length;

  const mmr = ['BTCUSDT', 'ETHUSDT'].includes(meta.symbol) ? 0.004 : 0.005;
  const plan = buildPlan({ side, k, a, e20: tMain.e20, piv, leverage, margin, mmr, style, decimals: meta.decimals });

  const fOf = (key) => factors.find((f) => f.key === key);
  const btcAlign = (fOf('btc')?.w ? fOf('btc').s : 0) * dir;
  const newsAlign = (fOf('newsCoin')?.w ? fOf('newsCoin').s : 0) * dir;
  const quoteVol = data.ticker ? +data.ticker.quoteVolume : null;
  const fundingAgainst = funding != null && funding * dir >= 0.0003;

  // ---------- probability ----------
  // With a history check (backtest.js) the probability is the measured past hit rate of similar signals.
  // Without it, fall back to the unverified heuristic below.
  const adjustments = [];
  let p, evR, probSource;
  if (history) {
    p = history.p;
    evR = history.avgR;
    probSource = 'history';
  } else {
    p = 0.4 + 0.38 * edge * adxMult;
    const pen = (cond, amt, why) => { if (cond) { p -= amt; adjustments.push({ amt: -amt, why }); } };
    pen(btcAlign < -0.3, 0.04, 'Đi ngược xu hướng BTC');
    pen(fundingAgainst, 0.02, 'Funding bất lợi cho hướng vào');
    pen(newsAlign < -0.3, 0.03, 'Tin tức ngược hướng');
    pen(atrPct > style.volAtr, 0.02, 'Biến động cao, dễ quét SL');
    pen(plan.obstacle != null, 0.03, 'Có vùng cản trước TP1');
    pen(quoteVol != null && quoteVol < 20e6, 0.02, 'Thanh khoản thấp');
    p = clamp(p, 0.15, 0.75);
    probSource = 'model';
  }
  const modelP = p;
  let calibNote = null;
  const cb = calib?.[probBucket(modelP)];
  if (cb && cb.n >= 3) {
    p = (modelP * 8 + cb.wins) / (8 + cb.n);
    calibNote = `Đã hiệu chỉnh theo ${cb.n} lệnh thật của bạn cùng nhóm (thắng ${Math.round((cb.wins / cb.n) * 100)}%).`;
  }
  if (!history || cb?.n >= 3) evR = p * 1.5 - (1 - p);
  const evUsd = evR * Math.abs(plan.money.pnlSl);

  // ---------- risks ----------
  const risks = [];
  const risk = (level, title, detail) => risks.push({ level, title, detail });
  if (plan.slPct >= plan.liqPct * 0.85) {
    risk('critical', 'Giá thanh lý nằm trước điểm cắt lỗ', `Với ${leverage}x, giá thanh lý ${fmt(plan.liq)} gần hơn SL ${fmt(plan.sl)}. Bạn sẽ bị thanh lý trước khi kịp cắt lỗ. Hạ đòn bẩy xuống tối đa ${plan.maxSafeLev}x.`);
  }
  if (leverage >= 50) risk('high', `Đòn bẩy ${leverage}x cực cao`, 'Chỉ cần giá chạy ngược khoảng ' + ((1 / leverage) * 100).toFixed(1) + '% là mất toàn bộ vốn lệnh.');
  else if (leverage >= 20) risk('high', `Đòn bẩy ${leverage}x cao`, `Mức an toàn theo SL hiện tại: ≤ ${plan.maxSafeLev}x.`);
  else if (leverage >= 10) risk('medium', `Đòn bẩy ${leverage}x`, `Chấp nhận được nếu tuân thủ SL. Mức an toàn tối đa: ${plan.maxSafeLev}x.`);
  const lossPct = -plan.money.roeSl;
  if (lossPct > 0.6) risk('high', `Chạm SL mất ~${(lossPct * 100).toFixed(0)}% vốn lệnh`, 'Nên giảm đòn bẩy hoặc số tiền vào lệnh.');
  else if (lossPct > 0.3) risk('medium', `Chạm SL mất ~${(lossPct * 100).toFixed(0)}% vốn lệnh`, 'Mức lỗ đáng kể so với số tiền vào.');
  if (atrPct > style.volAtr) risk('medium', 'Biến động cao', `ATR = ${(atrPct * 100).toFixed(2)}% mỗi nến ${style.tf}, giá dễ quét qua SL rồi quay lại.`);
  if (quoteVol != null && quoteVol < 20e6) risk('high', 'Thanh khoản thấp', `Khối lượng 24h chỉ ~${(quoteVol / 1e6).toFixed(1)}M USDT: trượt giá lớn, dễ bị thao túng.`);
  else if (quoteVol != null && quoteVol < 80e6) risk('medium', 'Thanh khoản trung bình', `Khối lượng 24h ~${(quoteVol / 1e6).toFixed(0)}M USDT.`);
  if (btcAlign < -0.3) risk('high', 'Ngược xu hướng BTC', 'BTC đang đi ngược hướng lệnh. Altcoin thường bị kéo theo BTC.');
  if (fundingAgainst) risk('medium', 'Funding bất lợi', `Bạn trả ~${Math.abs(funding * plan.money.notional).toFixed(2)} USDT mỗi 8h, và phe ${side === 'LONG' ? 'Long' : 'Short'} đang quá đông.`);
  if (data.premium?.nextFundingTime && data.premium.nextFundingTime - now < 30 * 60e3) {
    risk('low', 'Sắp chốt funding', `Funding chốt sau ${Math.max(0, Math.round((data.premium.nextFundingTime - now) / 60e3))} phút, giá hay giật quanh thời điểm này.`);
  }
  if (newsAlign < -0.3) risk('high', 'Tin tức ngược hướng', 'Tin về coin đang bất lợi cho hướng vào lệnh.');
  if (side === 'LONG' && rNow > 72) risk('medium', 'Mua đuổi vùng quá mua', `RSI ${rNow.toFixed(0)}.`);
  if (side === 'SHORT' && rNow < 28) risk('medium', 'Bán đuổi vùng quá bán', `RSI ${rNow.toFixed(0)}.`);
  if (adxNow != null && adxNow < 18) risk('medium', 'Thị trường đi ngang', `ADX ${adxNow.toFixed(0)}: tín hiệu xu hướng dễ nhiễu.`);
  if (plan.obstacle != null) risk('medium', `Vùng cản tại ${fmt(plan.obstacle)}`, `Nằm giữa entry và TP1, giá có thể bị chặn trước khi tới mục tiêu.`);
  if (forcedSide && edge < 0) risk('high', 'Bạn chọn ngược hướng hệ thống', `Hệ thống nghiêng ${autoSide}. Lệnh ${side} đang đi ngược đa số tín hiệu.`);

  // Fed / macro headlines against the trade
  const macroF = fOf('macro');
  if (macroF?.w && macroF.s * dir < -0.15) {
    const worst = macroNews.items.filter((n) => n.s * dir < 0).sort((a, b) => b.published - a.published)[0];
    risk('medium', `Tin Fed/vĩ mô bất lợi cho lệnh ${side}`,
      worst ? `"${worst.title}" (${worst.source}, ${Math.max(1, Math.round((now - worst.published) / 3600e3))} giờ trước).` : 'Dòng tin vĩ mô 48 giờ qua nghiêng ngược hướng lệnh.');
  }

  // Scheduled US macro events (FOMC, CPI, PPI) near or inside the holding period
  const holdMs = style.holdCandles * style.tfMs;
  const when = (t) => new Date(t).toLocaleString('vi-VN', { weekday: 'short', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  const inText = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} phút` : `${(ms / 3600e3).toFixed(ms < 10 * 3600e3 ? 1 : 0)} giờ`);
  for (const ev of (data.events || []).filter((e) => e.at > now - 3600e3 && e.at < now + Math.max(holdMs, 6 * 3600e3)).slice(0, 2)) {
    const dt = ev.at - now;
    if (dt <= 0) {
      risk('high', `Vừa có ${ev.title} (${inText(-dt)} trước)`, 'Giá thường còn giật mạnh 30–60 phút sau công bố. Nên chờ thị trường ổn định.');
    } else if (dt <= 2 * 3600e3) {
      risk('high', `${ev.title} sau ${inText(dt)}`, `Lúc ${when(ev.at)}. Giá thường giật mạnh cả hai chiều quanh giờ công bố, dễ quét SL. Nên chờ sau công bố hoặc giảm đòn bẩy.`);
    } else if (dt <= holdMs) {
      risk('medium', `${ev.title} trong thời gian giữ lệnh`, `Lúc ${when(ev.at)} (sau ${inText(dt)}). Cân nhắc chốt bớt hoặc dời SL trước giờ công bố.`);
    }
  }

  // learned rules
  const rules = L.rules || {};
  if (rules.blockCounterBtc && btcAlign < -0.2) risk('critical', 'Quy tắc đã học: không vào ngược BTC', 'Lịch sử của bạn thua nhiều khi vào lệnh ngược xu hướng BTC.');
  if (rules.maxLev && leverage > rules.maxLev) risk('high', `Quy tắc đã học: đòn bẩy ≤ ${rules.maxLev}x`, 'Lịch sử của bạn thua nhiều ở đòn bẩy cao.');
  if (rules.minAdx && adxNow != null && adxNow < rules.minAdx) risk('critical', `Quy tắc đã học: cần ADX ≥ ${rules.minAdx}`, 'Lịch sử của bạn thua nhiều khi thị trường đi ngang.');
  if (rules.blockAgainstNews && newsAlign < -0.2) risk('critical', 'Quy tắc đã học: không vào ngược tin tức', 'Lịch sử của bạn thua nhiều khi tin tức bất lợi.');
  if (rules.styleWarn?.[style.key]) risk('medium', `Quy tắc đã học: khung ${style.label} kém hiệu quả`, 'Tỷ lệ thua cao ở phong cách này.');
  if (L.protective) risk('medium', 'Đang ở chế độ phòng thủ', 'Sau chuỗi thua, nên giảm 50% đòn bẩy và số tiền vào lệnh cho tới khi thắng lại 2 lệnh liên tiếp.');

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  risks.sort((x, y) => order[x.level] - order[y.level]);

  // ---------- timing ----------
  const timing = [];
  const lastRange = k.at(-1).h - k.at(-1).l;
  timing.push(plan.ext > 1.5
    ? { ok: false, text: `Giá đã chạy xa EMA20 (${plan.ext.toFixed(1)} ATR). Chờ hồi về ${fmt(plan.entry)} rồi mới vào.` }
    : { ok: true, text: 'Giá đang gần vùng cân bằng, không phải mua/bán đuổi.' });
  timing.push(lastRange > 2.5 * a
    ? { ok: false, blocking: true, text: 'Nến hiện tại biến động bất thường (>2.5 ATR). Chờ 1–2 nến ổn định.' }
    : { ok: true, text: 'Không có nến biến động bất thường.' });
  if (fOf('btc')?.w) timing.push(btcAlign >= 0 ? { ok: true, text: 'BTC đồng thuận hoặc trung tính với hướng lệnh.' } : { ok: false, text: 'BTC đang đi ngược hướng lệnh.' });
  if (fng != null && (fng >= 80 || fng <= 20)) timing.push({ ok: false, text: `Tâm lý thị trường ở mức cực đoan (F&G ${fng}), dễ đảo chiều đột ngột.` });
  const d = new Date(now);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) timing.push({ ok: null, text: 'Cuối tuần: thanh khoản mỏng, dễ có râu nến quét SL.' });
  const hr = d.getUTCHours();
  if (hr >= 13 && hr < 16) timing.push({ ok: null, text: 'Đang trong giờ mở cửa phiên Mỹ: biến động thường mạnh hơn.' });

  // ---------- verdict ----------
  const thr = (L.threshold ?? 0.25) + (rules.sidePenalty?.[side] ?? 0);
  const critical = risks.find((r) => r.level === 'critical');
  const blockingTiming = timing.find((t) => t.ok === false && t.blocking);
  const pctTxt = (v) => `${Math.round(v * 100)}%`;
  let verdict;
  if (!history) {
    verdict = { code: 'WAIT', label: 'Chưa kiểm chứng được', reason: 'Không tải đủ dữ liệu quá khứ để kiểm tra tín hiệu này, xác suất chỉ là ước tính.' };
  } else if (p <= BREAKEVEN_P || evR <= 0) {
    verdict = { code: 'NO', label: 'Không nên vào',
      reason: `Trong quá khứ, tín hiệu ${side} tương tự trên ${meta.base} chạm TP1 trước SL ${pctTxt(p)} số lần (cần trên ${pctTxt(BREAKEVEN_P)}), kỳ vọng ${evR >= 0 ? '+' : ''}${evR.toFixed(2)}R mỗi lệnh.` };
  } else if (edge < 0.08) {
    verdict = { code: 'NO', label: 'Không nên vào', reason: 'Tín hiệu hiện tại quá yếu hoặc trái chiều.' };
  } else if (critical) {
    verdict = { code: 'NO', label: 'Không nên vào', reason: critical.title };
  } else if (edge < thr) {
    verdict = { code: 'WAIT', label: 'Chờ thêm xác nhận', reason: `Điểm tín hiệu ${(edge * 100).toFixed(0)} chưa đạt ngưỡng ${(thr * 100).toFixed(0)}.` };
  } else if (plan.mode === 'limit' || blockingTiming) {
    verdict = { code: 'WAIT', label: 'Đặt lệnh chờ', reason: blockingTiming ? blockingTiming.text : `Đặt limit tại ${fmt(plan.entry)}, không vào giá thị trường.` };
  } else {
    verdict = { code: 'GO', label: side === 'LONG' ? 'Có thể vào Long' : 'Có thể vào Short',
      reason: `Trong quá khứ, ${history.wins}/${history.n} tín hiệu ${side} tương tự chạm TP1 trước SL, kỳ vọng +${evR.toFixed(2)}R mỗi lệnh.` };
  }

  // ---------- exit plan ----------
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const usd = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} USDT`;
  const exitPlan = [
    plan.mode === 'limit'
      ? `Đặt lệnh limit ${side} tại ${fmt(plan.entry)}. Hủy nếu sau ${style.fillCandles} nến ${style.tf} vẫn chưa khớp.`
      : `Vào lệnh ${side} giá thị trường quanh ${fmt(plan.entry)}.`,
    `Đặt Stop Loss ngay tại ${fmt(plan.sl)} (${side === 'LONG' ? '−' : '+'}${pct(plan.slPct)} giá, ${usd(plan.money.pnlSl)}).`,
    `Chốt 50% vị thế tại TP1 ${fmt(plan.tp1)} (${pct(plan.tp1Pct)} giá), rồi dời SL về entry để lệnh không thể lỗ.`,
    `Chốt phần còn lại tại TP2 ${fmt(plan.tp2)}, hoặc sớm hơn nếu nến ${style.tf} đóng ${side === 'LONG' ? 'dưới' : 'trên'} EMA20 (${fmt(tMain.e20)}).`,
    `Nếu sau ${style.holdCandles} nến (~${plan.holdHours} giờ) chưa chạm TP1 thì đóng lệnh: tín hiệu đã hết hiệu lực.`,
    `Thoát sớm nếu BTC đảo chiều mạnh hoặc xuất hiện tin xấu đột ngột về ${meta.base}.`,
  ];

  return {
    meta, style, leverage, margin, side, autoSide, forcedSide, S, edge, adxMult, agree, against, activeCount: active.length,
    factors, plan, prob: p, modelP, probSource, history, calibNote, adjustments, evR, evUsd, risks, timing, verdict, exitPlan, threshold: thr,
    price: c, atr: a, atrPct, rsi: rNow, adx: adxNow, funding, fng, fngLabel: data.fng?.data?.[0]?.value_classification,
    mcapCh, btcDom: data.global?.market_cap_percentage?.btc ?? null, quoteVol, change24h: data.ticker ? +data.ticker.priceChangePercent : null,
    lsr: data.lsr?.length ? +data.lsr.at(-1).longShortRatio : null, btcTrend, btcCorr, coinNews, marketNews, macroNews,
    ema: { e20: I.ema(closes, 20), e50: I.ema(closes, 50) }, candles: k,
    ctx: { btcAlign, newsAlign, adx: adxNow, ext: plan.ext, rsi: rNow, atrPct, fng, funding },
    at: now,
  };
}
