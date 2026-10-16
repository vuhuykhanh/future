// Six ways to trade the same analysis. `signal` looks at one analysis result (engine.analyze) and returns the side
// to trade, or null when the strategy would stay out. tpR is the target in multiples of the risk (SL distance).
const MIN_SCORE = 0.15; // |factor score| needed before a trend strategy acts

const trendSide = (r) => (Math.abs(r.S) >= MIN_SCORE ? r.autoSide : null);

export const STRATEGIES = [
  {
    key: 'trend15', name: 'Theo xu hướng, chốt 1,5R', family: 'trend', tpR: 1.5,
    signal: (r) => trendSide(r),
  },
  {
    key: 'trend1', name: 'Theo xu hướng, chốt sớm 1R', family: 'trend', tpR: 1,
    signal: (r) => trendSide(r),
  },
  {
    key: 'trend2', name: 'Theo xu hướng, chốt xa 2R', family: 'trend', tpR: 2,
    signal: (r) => trendSide(r),
  },
  {
    // Only enters when price sits near EMA20 instead of chasing a move that already ran.
    key: 'pullback', name: 'Theo xu hướng, chỉ vào khi giá hồi về EMA20', family: 'trend', tpR: 1.5, entryMode: 'market',
    signal: (r) => {
      const side = trendSide(r);
      if (!side) return null;
      const dir = side === 'LONG' ? 1 : -1;
      const ext = ((r.price - r.ind.e20) * dir) / r.ind.a;
      return ext >= -0.3 && ext <= 0.6 ? side : null;
    },
  },
  {
    // Bets on a snap-back after an overstretched move: RSI extreme and price outside the Bollinger band.
    key: 'fade', name: 'Đánh ngược khi quá mua/quá bán', family: 'fade', tpR: 1.5, entryMode: 'market', slMode: 'extreme',
    signal: (r) => {
      if (r.ind.rsi >= 70 && r.ind.pb >= 1) return 'SHORT';
      if (r.ind.rsi <= 30 && r.ind.pb <= 0) return 'LONG';
      return null;
    },
  },
  {
    // Trend trades only when the market has a real trend (ADX ≥ 20) and BTC is not pulling the other way.
    key: 'confirmed', name: 'Theo xu hướng khi BTC cùng hướng và xu hướng rõ', family: 'trend', tpR: 1.5,
    signal: (r) => {
      const side = trendSide(r);
      if (!side || (r.ind.adx ?? 0) < 20) return null;
      return r.ind.btcS * (side === 'LONG' ? 1 : -1) >= 0 ? side : null;
    },
  },
];

export const breakeven = (strategy) => 1 / (1 + strategy.tpR);
