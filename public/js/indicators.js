// Technical indicators. Candles: {t, o, h, l, c, v, qv}

export const last = (arr) => {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = val();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = val();
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const signal = new Array(closes.length).fill(null);
  if (start >= 0) ema(line.slice(start), sig).forEach((v, i) => { signal[start + i] = v; });
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
  }
  return { mid, upper, lower };
}

function trueRanges(c) {
  return c.map((k, i) => (i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - c[i - 1].c), Math.abs(k.l - c[i - 1].c))));
}

export function atr(c, period = 14) {
  const tr = trueRanges(c);
  const out = new Array(c.length).fill(null);
  if (c.length <= period) return out;
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < c.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

export function adx(c, p = 14) {
  const n = c.length;
  const res = { adx: new Array(n).fill(null), pdi: new Array(n).fill(null), mdi: new Array(n).fill(null) };
  if (n < p * 2 + 1) return res;
  const tr = trueRanges(c), pdm = [0], mdm = [0];
  for (let i = 1; i < n; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let str = 0, sp = 0, sm = 0;
  for (let i = 1; i <= p; i++) { str += tr[i]; sp += pdm[i]; sm += mdm[i]; }
  const dx = new Array(n).fill(null);
  for (let i = p; i < n; i++) {
    if (i > p) { str = str - str / p + tr[i]; sp = sp - sp / p + pdm[i]; sm = sm - sm / p + mdm[i]; }
    const pd = str ? (100 * sp) / str : 0, md = str ? (100 * sm) / str : 0;
    res.pdi[i] = pd; res.mdi[i] = md;
    dx[i] = pd + md === 0 ? 0 : (100 * Math.abs(pd - md)) / (pd + md);
  }
  let a = 0;
  for (let i = p; i < 2 * p; i++) a += dx[i];
  a /= p;
  res.adx[2 * p - 1] = a;
  for (let i = 2 * p; i < n; i++) {
    a = (a * (p - 1) + dx[i]) / p;
    res.adx[i] = a;
  }
  return res;
}

// Swing highs/lows: a bar whose high (low) is the extreme of the surrounding window.
export function pivots(c, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < c.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) isH = false;
      if (c[j].l <= c[i].l) isL = false;
    }
    if (isH) highs.push({ i, price: c[i].h });
    if (isL) lows.push({ i, price: c[i].l });
  }
  return { highs, lows };
}

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export const returns = (closes) => closes.slice(1).map((v, i) => v / closes[i] - 1);
