import { api } from './api.js';

// Market data: Binance USDT-M Futures (public), Fear & Greed, CoinGecko global, local news proxy.

const FAPI = 'https://fapi.binance.com';

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = url.startsWith('/api/') ? await api(url, { signal: ctrl.signal }) : await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0]}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Binance allows 2400 request weight per minute per IP and does not let browsers read how much is used,
// so we count it ourselves and stay well below: scanning 100 coins then simply takes a little longer.
const WEIGHT_BUDGET = 1600;
const spent = []; // [time, weight]
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function spendWeight(weight) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0][0] > 60e3) spent.shift();
    const used = spent.reduce((sum, [, w]) => sum + w, 0);
    if (used + weight <= WEIGHT_BUDGET) { spent.push([now, weight]); return; }
    await sleep(spent[0][0] + 60e3 - now + 50);
  }
}

// Binance REST call with weight accounting; a 429 (too many requests) waits and retries once.
async function fapi(path, weight) {
  await spendWeight(weight);
  try {
    return await getJson(`${FAPI}${path}`);
  } catch (err) {
    if (!/^(429|418) /.test(err.message)) throw err;
    await sleep(30e3);
    return getJson(`${FAPI}${path}`);
  }
}

const klineWeight = (limit) => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);

const toCandle = (k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7] });

let symbolCache = null;
export async function loadSymbols() {
  if (symbolCache) return symbolCache;
  const info = await fapi('/fapi/v1/exchangeInfo', 1);
  symbolCache = info.symbols
    .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map((s) => {
      const tick = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      const tickSize = tick ? parseFloat(tick.tickSize) : 0.0001;
      return { symbol: s.symbol, base: s.baseAsset, kind: s.underlyingType, tickSize, decimals: Math.max(0, Math.round(-Math.log10(tickSize))) };
    });
  return symbolCache;
}

// "sol", "SOL/USDT", "solusdt", "pepe" -> matching perpetual contract meta
export function resolveSymbol(input, symbols) {
  const raw = String(input || '').toUpperCase().replace(/[\s/:_-]/g, '').replace(/(USDT|PERP)+$/, '');
  if (!raw) return null;
  return (
    symbols.find((s) => s.base === raw) ||
    symbols.find((s) => s.base === `1000${raw}`) ||
    symbols.find((s) => s.base === `1000000${raw}`) ||
    symbols.find((s) => s.symbol === `${raw}USDT`) ||
    null
  );
}

export async function klines(symbol, interval, limit = 300, startTime) {
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (startTime) q.set('startTime', String(startTime));
  return (await fapi(`/fapi/v1/klines?${q}`, klineWeight(limit))).map(toCandle);
}

// Stablecoins and gold tokens track something else (the dollar, gold) rather than the crypto market;
// index contracts (BTCDOM...) and stocks/commodities are excluded by their contract type.
const STABLES = new Set(['USDC', 'FDUSD', 'BUSD', 'TUSD', 'USDP', 'DAI', 'USDE', 'USDS', 'PYUSD', 'RLUSD', 'USD1', 'EUR', 'XUSD', 'PAXG', 'XAUT']);

// The n most traded crypto perpetuals by 24h USDT volume, each with its 24h ticker.
export async function topCoins(n = 100) {
  const [symbols, tickers] = await Promise.all([loadSymbols(), fapi('/fapi/v1/ticker/24hr', 40)]);
  const bySymbol = new Map(symbols.filter((s) => s.kind === 'COIN' && !STABLES.has(s.base)).map((s) => [s.symbol, s]));
  return tickers
    .filter((t) => bySymbol.has(t.symbol))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, n)
    .map((t) => ({ meta: bySymbol.get(t.symbol), ticker: t }));
}

async function optional(promise) {
  try { return await promise; } catch { return null; }
}

// Market-wide sources change slowly and CoinGecko rate-limits hard, so reuse them for 5 minutes.
const slowCache = new Map();
async function cached(key, urls, ttlMs = 5 * 60e3) {
  const hit = slowCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  try {
    const data = await firstJson([urls].flat());
    slowCache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return hit ? hit.data : null;
  }
}

// On GitHub Pages, news and the macro calendar are files that GitHub Actions refreshes every 30 minutes
// (feeds/*.json, relative to the page). The local server answers the same data under /api.
async function firstJson(urls) {
  let lastErr;
  for (const url of urls) {
    try { return await getJson(url, 20000); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

export async function fetchNews() {
  try {
    const res = await firstJson(['feeds/news.json', '/api/news']);
    return res.items || [];
  } catch {
    return null;
  }
}

// Data that is the same for every coin: BTC as the market reference, sentiment, news and the macro calendar.
export async function fetchShared(style) {
  const [btcMain, btcHtf, fng, global, news, events] = await Promise.all([
    optional(klines('BTCUSDT', style.tf, 1500)),
    optional(klines('BTCUSDT', style.htf, 1500)),
    cached('fng', 'https://api.alternative.me/fng/?limit=7'),
    cached('global', 'https://api.coingecko.com/api/v3/global'),
    fetchNews(),
    cached('events', ['feeds/events.json', '/api/events'], 30 * 60e3),
  ]);
  return { btcMain, btcHtf, fng, global: global?.data || null, news, events: events?.items || null };
}

// `shared` and `ticker` can be passed in when scanning many coins so they are fetched only once.
export async function fetchMarketBundle(meta, style, shared, ticker) {
  const { symbol } = meta;
  const isBtc = symbol === 'BTCUSDT';
  const p = style.period;
  // 1500 candles: the last 300 drive the live analysis, the full series feeds the history check.
  const [k, hk, tick, premium, oiHist, lsr, taker, common] = await Promise.all([
    klines(symbol, style.tf, 1500),
    klines(symbol, style.htf, 1500),
    ticker || optional(fapi(`/fapi/v1/ticker/24hr?symbol=${symbol}`, 1)),
    optional(fapi(`/fapi/v1/premiumIndex?symbol=${symbol}`, 1)),
    optional(getJson(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${p}&limit=30`)),
    optional(getJson(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${p}&limit=30`)),
    optional(getJson(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${p}&limit=30`)),
    shared || fetchShared(style),
  ]);
  const btcMain = isBtc ? null : common.btcMain;
  const btcHtf = isBtc ? null : common.btcHtf;
  const tail = (arr) => (arr ? arr.slice(-300) : null);
  return {
    k: tail(k), hk: tail(hk), btcMain: tail(btcMain), btcHtf: tail(btcHtf),
    ticker: tick, premium, oiHist, lsr, taker, fng: common.fng, global: common.global, news: common.news, events: common.events,
    fetchedAt: Date.now(),
    hist: { k, hk, btc: btcMain, btcH: btcHtf },
  };
}
