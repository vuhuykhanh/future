import { loadSymbols, resolveSymbol, fetchMarketBundle, topCoins } from './data.js';
import { analyze, STYLES, FACTORS, makeFmt, pnlFor, BREAKEVEN_P } from './engine.js';
import { backtest } from './backtest.js';
import { scanTop, passes, sortResults } from './scanner.js';
import { LiveFeed } from './live.js';
import * as J from './journal.js';
import { captureKey } from './api.js';

captureKey();

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
const sPct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d)}%`);
const usd = (v, sign = true) => (v == null || !isFinite(v) ? '—' : `${sign ? (v >= 0 ? '+' : '−') : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const time = (ts) => new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const PREFS_KEY = 'radar-futures-prefs';

let symbols = [];
let state = J.defaultState();
let current = null;
let autoRefresh = true;
const charts = {};

const LIVE_LABEL = { idle: 'Live: tắt', connecting: 'Đang kết nối live…', live: 'Live', down: 'Mất kết nối live, đang thử lại…' };
const feed = new LiveFeed((s) => {
  const el = $('#liveStatus');
  el.dataset.state = s;
  el.lastElementChild.textContent = LIVE_LABEL[s] || s;
});

// ---------- helpers ----------
function toast(msg, ms = 3800) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const tzShift = -new Date().getTimezoneOffset() * 60;
const chartTime = (ms) => Math.floor(ms / 1000) + tzShift;

function baseChart(el) {
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: cssVar('--surface') }, textColor: cssVar('--muted'), fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
    grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
    rightPriceScale: { borderColor: cssVar('--line') },
    timeScale: { borderColor: cssVar('--line'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
  });
  return chart;
}

function destroyChart(key) {
  if (charts[key]) { charts[key].remove(); delete charts[key]; }
}

// ---------- prefs ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (!p) return;
    if (p.coin) $('#coin').value = p.coin;
    if (p.leverage) { $('#leverage').value = p.leverage; $('#leverageRange').value = p.leverage; }
    if (p.margin) $('#margin').value = p.margin;
    if (p.style) {
      const r = document.querySelector(`input[name="style"][value="${p.style}"]`); if (r) r.checked = true;
      const sr = document.querySelector(`input[name="scanStyle"][value="${p.style}"]`); if (sr) sr.checked = true;
    }
    if (p.autoRefresh === false) autoRefresh = false;
  } catch { /* ignore */ }
}
function savePrefs(p) {
  try {
    const prev = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prev, ...p }));
  } catch { /* ignore */ }
}

// ---------- tabs ----------
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const v of ['analyze', 'scan', 'stats']) $(`#view-${v}`).hidden = name !== v;
  if (name === 'stats') renderStats();
  if (name === 'scan') renderScan();
  window.scrollTo(0, 0);
}

// ---------- analysis ----------
async function runAnalysis(e) {
  e?.preventDefault();
  const fd = new FormData($('#form'));
  const coin = String(fd.get('coin') || '').trim();
  const leverage = Math.round(Number(fd.get('leverage')));
  const margin = Number(fd.get('margin'));
  const style = STYLES[fd.get('style')] || STYLES.intraday;
  const forcedSide = fd.get('side') || null;
  const out = $('#result');

  if (!(leverage >= 1 && leverage <= 125)) { out.innerHTML = `<div class="error">Đòn bẩy phải từ 1x đến 125x.</div>`; return; }
  if (!(margin > 0)) { out.innerHTML = `<div class="error">Nhập số tiền vào lệnh lớn hơn 0 USDT.</div>`; return; }
  if (!symbols.length) {
    try { symbols = await loadSymbols(); }
    catch (err) { out.innerHTML = `<div class="error"><b>Không kết nối được Binance Futures.</b> ${esc(err.message)}. Kiểm tra mạng (một số nhà mạng/quốc gia chặn Binance, có thể cần VPN).</div>`; return; }
  }
  const meta = resolveSymbol(coin, symbols);
  if (!meta) { out.innerHTML = `<div class="error">Không tìm thấy hợp đồng <b>${esc(coin.toUpperCase())}</b>/USDT trên Binance Futures. Thử mã khác như BTC, ETH, SOL, PEPE.</div>`; return; }

  savePrefs({ coin, leverage, margin, style: style.key });
  await analyzeWith({ meta, style, leverage, margin, forcedSide });
}

// silent: re-run in place (candle close) without the loading screen; reports when the signal changed.
let analyzing = false;
async function analyzeWith(params, { silent = false } = {}) {
  if (analyzing) return;
  analyzing = true;
  const out = $('#result');
  const prev = current;
  $('#submitBtn').disabled = true;
  if (!silent) {
    stopLiveAnalysis();
    out.innerHTML = `<div class="loading"><div class="spinner"></div><span class="loading-step">Đang tải dữ liệu ${esc(params.meta.symbol)} (giá, phái sinh, BTC, tin tức)…</span></div>`;
  }
  try {
    const data = await fetchMarketBundle(params.meta, params.style);
    const stats = J.computeStats(state.trades);
    const side = params.forcedSide || analyze({ ...params, data, learning: state.learning, calib: null }).side;
    if (!silent) $('#result .loading-step').textContent = `Đang kiểm tra tín hiệu ${side} trên ${data.hist.k.length} nến quá khứ của ${params.meta.base}…`;
    let history = null;
    try {
      history = await backtest({ meta: params.meta, style: params.style, side, hist: data.hist, learning: state.learning });
    } catch (err) { console.warn('backtest', err); }
    current = analyze({ ...params, forcedSide: side, data, learning: state.learning, calib: stats.calib, history });
    current.forcedSide = params.forcedSide;
    const y = window.scrollY;
    renderResult(current);
    if (silent) window.scrollTo(0, y);
    else collapseForm(current);
    $('#dataStatus').textContent = `Phân tích lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${data.news ? '' : ' · tin tức: tắt'}`;
    if (silent && prev) {
      const was = `${prev.side} ${prev.verdict.label}`, now = `${current.side} ${current.verdict.label}`;
      toast(was !== now
        ? `${current.meta.base}: tín hiệu đã đổi từ "${was}" sang "${now}".`
        : `${current.meta.base}: đã phân tích lại khi đóng nến ${current.style.tf}, tín hiệu giữ nguyên.`);
      if (was !== now) $('.verdict')?.classList.add('flash');
    }
  } catch (err) {
    console.error(err);
    if (silent) toast(`Tự phân tích lại thất bại: ${err.message}`);
    else out.innerHTML = `<div class="error"><b>Phân tích thất bại.</b> ${esc(err.message)}. Thử lại sau vài giây.</div>`;
  } finally {
    analyzing = false;
    $('#submitBtn').disabled = false;
  }
}

// ---------- live price on the analysis page ----------
const live = { unsubs: [], price: null, at: 0, candleClose: null, raf: 0, reanalyzeTimer: 0 };

function stopLiveAnalysis() {
  live.unsubs.forEach((u) => u());
  live.unsubs = [];
  clearTimeout(live.reanalyzeTimer);
}

function startLiveAnalysis(r) {
  stopLiveAnalysis();
  const sym = r.meta.symbol.toLowerCase();
  live.price = r.price;
  live.at = r.at;
  live.lastShown = null;
  const lastK = r.candles.at(-1);
  live.candleClose = lastK.t + r.style.tfMs;
  live.unsubs.push(feed.on(`${sym}@kline_${r.style.tf}`, (d) => {
    if (current !== r) return;
    const k = d.k;
    live.price = +k.c;
    live.at = Date.now();
    live.candleClose = k.T + 1;
    if (k.x && autoRefresh) {
      // Give the REST API a moment to include the closed candle.
      clearTimeout(live.reanalyzeTimer);
      live.reanalyzeTimer = setTimeout(() => analyzeWith(paramsOf(current), { silent: true }), 2000);
    }
    scheduleLiveUi();
  }));
}

const paramsOf = (r) => ({ meta: r.meta, style: r.style, leverage: r.leverage, margin: r.margin, forcedSide: r.forcedSide });

// Binance pushes ~4 updates a second; repainting once a second keeps the numbers readable.
const LIVE_PAINT_MS = 1000;
function scheduleLiveUi() {
  if (live.raf) return;
  const wait = Math.max(0, LIVE_PAINT_MS - (Date.now() - (live.paintedAt || 0)));
  live.raf = setTimeout(() => { live.raf = 0; live.paintedAt = Date.now(); updateLiveUi(); }, wait);
}

function updateLiveUi() {
  const r = current;
  const el = $('#livePrice');
  if (!r || !el || live.price == null) return;
  const fmt = makeFmt(r.meta.decimals);
  const { plan } = r;
  const p = live.price;
  // No flashing: the price just takes the colour of its last move.
  if (live.lastShown != null && p !== live.lastShown) {
    el.classList.toggle('price-up', p > live.lastShown);
    el.classList.toggle('price-down', p < live.lastShown);
  }
  el.textContent = fmt(p);
  live.lastShown = p;

  $('#liveToSl').textContent = pct(Math.max(0, (p - plan.sl) * plan.dir) / p);
  $('#liveToTp').textContent = pct(Math.max(0, (plan.tp1 - p) * plan.dir) / p);

  // Is the plan still valid at the live price?
  const a = r.atr;
  let warn = null;
  if ((p - plan.sl) * plan.dir <= 0) {
    warn = { lvl: 'crit', text: `Giá đã chạm Stop Loss ${fmt(plan.sl)}. Kế hoạch này không còn hiệu lực.` };
  } else if ((p - plan.tp1) * plan.dir >= 0) {
    warn = { lvl: 'warn', text: `Giá đã chạy tới TP1 ${fmt(plan.tp1)}. Vào lúc này là đuổi giá, R:R không còn như tính toán.` };
  } else if (plan.mode === 'market' && Math.abs(p - plan.entry) > 0.5 * a) {
    warn = { lvl: 'warn', text: `Giá đã lệch ${sPct((p - plan.entry) / plan.entry)} khỏi entry (${(Math.abs(p - plan.entry) / a).toFixed(1)} ATR). Entry, SL, TP cần tính lại.` };
  } else if (plan.mode === 'limit' && (p - plan.entry) * plan.dir <= 0) {
    warn = { lvl: 'ok', text: `Giá đã về vùng entry limit ${fmt(plan.entry)}.` };
  }
  const w = $('#liveWarn');
  if (warn) {
    w.hidden = false;
    w.className = `live-warn live-warn-${warn.lvl}`;
    if (w.dataset.text !== warn.text) {
      w.dataset.text = warn.text;
      w.innerHTML = `<span>${esc(warn.text)}</span>${warn.lvl === 'ok' ? '' : '<button class="btn btn-sm" type="button" data-reanalyze>Phân tích lại</button>'}`;
    }
  } else if (!w.hidden) {
    w.hidden = true;
    w.dataset.text = '';
  }
  updateLiveClock();
}

function updateLiveClock() {
  const r = current;
  const ageEl = $('#liveAge');
  if (!r || !ageEl) return;
  const age = Math.round((Date.now() - live.at) / 1000);
  ageEl.textContent = feed.status === 'live' && age <= 5 ? 'cập nhật liên tục' : `cập nhật ${age}s trước`;
  ageEl.classList.toggle('neg', age > 15);
  const left = Math.max(0, live.candleClose - Date.now());
  const h = Math.floor(left / 3600e3), mnt = Math.floor((left % 3600e3) / 60e3), s = Math.floor((left % 60e3) / 1000);
  $('#candleLeft').textContent = `${h ? `${h}:` : ''}${String(mnt).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// "41/112 tín hiệu SHORT tương tự · 15m · 46 ngày gần nhất"
function historyNote(r) {
  const h = r.history;
  const days = Math.max(1, Math.round((h.to - h.from) / 86400e3));
  const scope = h.scope === 'similar' ? `tín hiệu ${r.side} tương tự` : h.scope === 'side' ? `tín hiệu ${r.side}` : 'tín hiệu';
  return `${h.wins}/${h.n} ${scope} chạm TP1 trước SL · nến ${r.style.tf} · ${days} ngày gần nhất`;
}

const RISK_LABEL = { critical: 'Nghiêm trọng', high: 'Cao', medium: 'Vừa', low: 'Thấp' };

// Only what is needed to decide and place the trade; the full factor analysis stays in the engine.
function renderResult(r) {
  const fmt = makeFmt(r.meta.decimals);
  const { plan } = r;
  const m = plan.money;
  const sideCls = r.side === 'LONG' ? 'long' : 'short';
  const breakeven = BREAKEVEN_P;
  const probColor = r.prob > breakeven ? 'var(--long)' : 'var(--short)';

  const levels = [
    { key: 'tp', label: 'TP2', sub: 'chốt 50% còn lại', price: plan.tp2, pnl: m.pnlTp2 / 2 + m.pnlTp1 / 2 },
    { key: 'tp', label: 'TP1', sub: 'chốt 50%, dời SL', price: plan.tp1, pnl: m.pnlTp1 },
    { key: 'entry', label: 'Entry', sub: plan.mode === 'limit' ? 'đặt lệnh limit' : 'giá thị trường', price: plan.entry, pnl: null },
    { key: 'sl', label: 'Stop Loss', sub: 'cắt lỗ', price: plan.sl, pnl: m.pnlSl },
    { key: 'liq', label: 'Thanh lý', sub: `${r.leverage}x isolated`, price: plan.liq, pnl: -r.margin },
  ];
  if (plan.mode === 'limit') levels.push({ key: 'now', label: 'Giá hiện tại', sub: 'chưa vào', price: r.price, pnl: null });
  levels.sort((a, b) => b.price - a.price);
  const risks = r.risks.filter((x) => x.level !== 'low');

  $('#result').innerHTML = `
  <div class="verdict verdict--${r.verdict.code}">
    <div>
      <div class="verdict-top">
        <span class="pill pill-${sideCls}">${r.side}</span>
        <span class="pill pill-${r.verdict.code}">${r.verdict.code === 'GO' ? 'Vào lệnh' : r.verdict.code === 'WAIT' ? 'Chờ' : 'Bỏ qua'}</span>
        <h2>${esc(r.verdict.label)}</h2>
      </div>
      <p>${esc(r.verdict.reason)}${r.forcedSide && r.forcedSide !== r.autoSide ? ` Hệ thống tự động sẽ chọn <b>${r.autoSide}</b>.` : ''}</p>
      <div class="verdict-meta">
        <span><b>${esc(r.meta.symbol)}</b> · ${esc(r.style.label)}</span>
        <span>${r.agree}/${r.activeCount} yếu tố ủng hộ · ${r.against} phản đối</span>
      </div>
      <div class="live-strip">
        <span class="live-cell"><span class="eyebrow">Giá live</span><b class="num live-price" id="livePrice">${fmt(r.price)}</b></span>
        <span class="live-cell"><span class="eyebrow">Tới SL · TP1</span><span class="num"><span class="neg" id="liveToSl">—</span> · <span class="pos" id="liveToTp">—</span></span></span>
        <span class="live-cell"><span class="eyebrow">Nến ${esc(r.style.tf)} đóng</span><span class="num" id="candleLeft">—</span></span>
        <span class="note" id="liveAge"></span>
      </div>
      <div class="live-warn" id="liveWarn" hidden></div>
      <label class="toggle verdict-toggle"><input type="checkbox" id="autoRefresh" ${autoRefresh ? 'checked' : ''}><span>Tự phân tích lại mỗi khi đóng nến ${esc(r.style.tf)}</span></label>
    </div>
    <div class="gauge">
      <span class="eyebrow">${r.history ? 'Tỷ lệ thắng trong quá khứ' : 'Xác suất ước tính (chưa kiểm chứng)'}</span>
      <span class="gauge-num" style="color:${probColor}">${Math.round(r.prob * 100)}%</span>
      <div class="gauge-bar" title="Vạch dọc: mức hòa vốn ${Math.round(breakeven * 100)}%"><i style="width:${r.prob * 100}%;background:${probColor}"></i><b style="left:${breakeven * 100}%"></b></div>
      ${r.history ? `<span class="note">${historyNote(r)}</span>` : ''}
      <div class="gauge-row"><span>Cần thắng tối thiểu để hòa vốn</span><span class="num">${Math.round(breakeven * 100)}%</span></div>
      <div class="gauge-row"><span>Kỳ vọng mỗi lệnh</span><span class="num ${cls(r.evUsd)}">${usd(r.evUsd)} USDT (${r.evR >= 0 ? '+' : ''}${r.evR.toFixed(2)}R)</span></div>
      ${r.calibNote ? `<span class="note">${esc(r.calibNote)}</span>` : ''}
    </div>
  </div>

  <div class="desk">
    <div class="col">
      <section class="card">
        <div class="card-head"><h3>Kế hoạch lệnh</h3><span class="sub">% so với entry · lãi/lỗ</span></div>
        <div class="ladder">
          ${levels.map((l) => `<div class="rung ${l.key}">
            <div class="rung-label">${l.label}<small>${esc(l.sub)}</small></div>
            <div class="rung-price">${fmt(l.price)}</div>
            <div class="rung-delta ${l.key === 'entry' || l.key === 'now' ? '' : cls(l.pnl)}">${l.key === 'entry' ? '' : sPct((l.price - plan.entry) / plan.entry)}${l.pnl != null ? `<small>${usd(l.pnl)} USDT</small>` : ''}</div>
          </div>`).join('')}
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Rủi ro</h3><span class="sub">${risks.length ? `${risks.length} mục` : 'không có rủi ro lớn'}</span></div>
        ${risks.length ? `<ul class="risks">${risks.map((x) => `<li class="risk risk-${x.level}">
          <span class="lvl lvl-${x.level}">${RISK_LABEL[x.level]}</span><strong>${esc(x.title)}</strong><p>${esc(x.detail)}</p></li>`).join('')}</ul>`
          : '<p class="note">Ngoài rủi ro thị trường thông thường, không phát hiện điểm bất lợi đáng kể.</p>'}
      </section>
    </div>
    <div class="col">
      <section class="card">
        <div class="card-head"><h3>Tiền & lợi nhuận</h3><span class="sub">đã trừ phí 0.05%/chiều</span></div>
        <dl class="kv">
          <dt>Ký quỹ × đòn bẩy</dt><dd>${usd(r.margin, false)} × ${r.leverage} = ${usd(m.notional, false)} USDT</dd>
          <dt>Lãi nếu chốt hết ở TP1</dt><dd class="pos">${usd(m.pnlTp1)} USDT · ${sPct(m.roeTp1, 1)}</dd>
          <dt><b>Lãi theo kế hoạch</b> (50% TP1 + 50% TP2)</dt><dd class="pos big">${usd(m.pnlPlan)} USDT · ${sPct(m.roePlan, 1)}</dd>
          <dt><b>Lỗ nếu chạm SL</b></dt><dd class="neg big">${usd(m.pnlSl)} USDT · ${sPct(m.roeSl, 1)}</dd>
          <dt>Đòn bẩy an toàn tối đa</dt><dd>${plan.maxSafeLev}x</dd>
        </dl>
      </section>
      <section class="card">
        <div class="card-head"><h3>Khi nào bán</h3></div>
        <ol class="steps">${r.exitPlan.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      </section>
    </div>
  </div>

  <section class="card enter-card" id="enterCard">
    <div class="enter-row">
      <div>
        <h3>Đã đặt lệnh này trên sàn?</h3>
        <p class="note">Lệnh chỉ được ghi vào lịch sử khi bạn bấm xác nhận, và chỉ kết thúc khi bạn bấm Đóng lệnh.</p>
      </div>
      <button class="btn btn-enter btn-enter-${sideCls}" id="enterBtn" type="button">Đã vào lệnh ${r.side}</button>
    </div>
    <form class="enter-form" id="enterForm" hidden>
      ${r.verdict.code === 'NO' ? `<p class="live-warn live-warn-crit">Hệ thống khuyên không vào lệnh này: ${esc(r.verdict.reason)}</p>` : ''}
      <div class="enter-fields">
        <div class="field"><label for="fillEntry">Giá vào thực tế</label><input id="fillEntry" name="entry" type="number" step="any" min="0" required value="${fmt(live.price ?? r.price).replace(/,/g, '')}"></div>
        <div class="field"><label for="fillMargin">Số tiền vào lệnh</label><div class="suffix-input"><input id="fillMargin" name="margin" type="number" step="any" min="0" required value="${r.margin}"><span>USDT</span></div></div>
        <div class="field"><label for="fillLev">Đòn bẩy</label><div class="suffix-input"><input id="fillLev" name="leverage" type="number" step="1" min="1" max="125" required value="${r.leverage}"><span>x</span></div></div>
        <button class="btn btn-primary" type="submit">Xác nhận vào lệnh</button>
        <button class="btn" type="button" id="enterCancel">Hủy</button>
      </div>
      <p class="note">Stop Loss ${fmt(plan.sl)} · TP1 ${fmt(plan.tp1)} · TP2 ${fmt(plan.tp2)} được giữ theo kế hoạch. Hãy đặt các mức này trên sàn.</p>
    </form>
  </section>`;

  $('#autoRefresh').addEventListener('change', (e) => { autoRefresh = e.target.checked; savePrefs({ autoRefresh }); });
  $('#liveWarn').addEventListener('click', (e) => { if (e.target.closest('[data-reanalyze]')) analyzeWith(paramsOf(current)); });
  $('#enterBtn').addEventListener('click', () => {
    $('#fillEntry').value = String(live.price ?? r.price);
    $('#enterForm').hidden = false;
    $('#enterBtn').hidden = true;
    $('#fillEntry').focus();
  });
  $('#enterCancel').addEventListener('click', () => { $('#enterForm').hidden = true; $('#enterBtn').hidden = false; });
  $('#enterForm').addEventListener('submit', confirmEntry);
  startLiveAnalysis(r);
  updateLiveUi();
}

async function confirmEntry(e) {
  e.preventDefault();
  const r = current;
  if (!r) return;
  const fd = new FormData(e.target);
  const entry = Number(fd.get('entry')), margin = Number(fd.get('margin')), leverage = Math.round(Number(fd.get('leverage')));
  if (!(entry > 0) || !(margin > 0) || !(leverage >= 1 && leverage <= 125)) { toast('Kiểm tra lại giá vào, số tiền và đòn bẩy.'); return; }
  if ((entry - r.plan.sl) * r.plan.dir <= 0) { toast('Giá vào đã vượt qua Stop Loss của kế hoạch. Hãy phân tích lại trước khi vào lệnh.'); return; }
  const t = J.tradeFromAnalysis(r, { entry, margin, leverage });
  state.trades.push(t);
  await J.saveState(state);
  updateBadge();
  $('#enterCard').innerHTML = `<p class="enter-done">Đã ghi lệnh <b>${esc(t.base)} ${t.side}</b> vào lịch sử lúc ${time(t.createdAt)}. Theo dõi và đóng lệnh ở mục <b>Lệnh đang mở</b> phía trên.</p>`;
  toast(`Đã ghi lệnh ${t.base} ${t.side} tại ${makeFmt(t.decimals)(entry)}.`);
}

// ---------- open positions ----------
const STATUS = { open: 'Đang mở', win: 'Thắng', loss: 'Thua', breakeven: 'Hòa vốn' };
const isActive = (t) => t.status === 'open';
const tradeLive = { prices: new Map(), unsubs: new Map(), alerted: new Set(), paintedAt: new Map() };

function liveCell(t, p) {
  const dir = t.side === 'LONG' ? 1 : -1;
  const pnl = pnlFor(t, [{ frac: 1, price: p }]);
  const toSl = ((p - t.sl) * dir) / p;
  const hint = toSl <= 0 ? '<span class="neg">đã qua SL</span>'
    : (p - t.tp2) * dir >= 0 ? '<span class="pos">đã tới TP2</span>'
      : (p - t.tp1) * dir >= 0 ? '<span class="pos">đã tới TP1</span>'
        : `SL còn ${pct(toSl, 1)}`;
  return `<span class="${cls(pnl)}">${usd(pnl)}</span> <span class="note">${sPct(pnl / t.margin, 1)}</span><br><span class="note"><span class="live-dot-sm"></span>${hint}</span>`;
}

const closeButton = '<div class="inline-close"><button class="btn btn-sm btn-close" data-act="close" type="button">Đóng lệnh</button></div>';

function renderPositions() {
  const el = $('#positions');
  const open = state.trades.filter(isActive).sort((a, b) => b.createdAt - a.createdAt);
  el.hidden = !open.length;
  if (!open.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<section class="card positions">
    <div class="card-head"><h3>Lệnh đang mở</h3><span class="sub">${open.length} lệnh · lãi/lỗ cập nhật live</span></div>
    <div class="table-wrap"><table class="cards-table">
      <thead><tr><th>Coin</th><th>Vào lúc</th><th class="n">Vốn × ĐB</th><th class="n">Entry</th><th class="n">SL</th><th class="n">TP1 / TP2</th><th class="n">Giá live</th><th class="n">Lãi / lỗ</th><th></th></tr></thead>
      <tbody>${open.map((t) => {
        const f = makeFmt(t.decimals ?? 4);
        const p = tradeLive.prices.get(t.symbol);
        return `<tr data-id="${t.id}">
          <td class="card-title"><b>${esc(t.base)}</b> <span class="pill pill-${t.side === 'LONG' ? 'long' : 'short'}">${t.side}</span></td>
          <td class="n" style="text-align:left" data-label="Vào lúc">${time(t.createdAt)}</td>
          <td class="n" data-label="Vốn × đòn bẩy">${usd(t.margin, false)} × ${t.leverage}</td>
          <td class="n" data-label="Entry">${f(t.entry)}</td>
          <td class="n neg" data-label="Stop Loss">${f(t.sl)}</td>
          <td class="n pos" data-label="TP1 / TP2">${f(t.tp1)}<br><span class="note">${f(t.tp2)}</span></td>
          <td class="n" data-label="Giá live" data-live-price="${t.id}">${p == null ? '…' : f(p)}</td>
          <td class="n card-pnl" data-label="Lãi / lỗ" data-live="${t.id}">${p == null ? '<span class="note">đang chờ giá…</span>' : liveCell(t, p)}</td>
          <td class="card-actions">${closeButton}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </section>`;
}

// One 1m kline stream per symbol with open trades.
function syncTradeStreams() {
  const syms = new Set(state.trades.filter(isActive).map((t) => t.symbol));
  for (const [sym, unsub] of tradeLive.unsubs) {
    if (!syms.has(sym)) { unsub(); tradeLive.unsubs.delete(sym); tradeLive.prices.delete(sym); }
  }
  for (const sym of syms) {
    if (!tradeLive.unsubs.has(sym)) tradeLive.unsubs.set(sym, feed.on(`${sym.toLowerCase()}@kline_1m`, (d) => onTradeKline(sym, d.k)));
  }
}

// Updates live cells and warns once per level; closing is always the user's action.
function onTradeKline(sym, k) {
  const p = +k.c;
  tradeLive.prices.set(sym, p);
  for (const t of state.trades) {
    if (t.symbol !== sym || !isActive(t)) continue;
    const dir = t.side === 'LONG' ? 1 : -1;
    // The bar that contains the entry moment also has prices from before it, so only trust its close.
    const fresh = k.t >= t.createdAt;
    const best = fresh ? (dir > 0 ? +k.h : +k.l) : p;
    const worst = fresh ? (dir > 0 ? +k.l : +k.h) : p;
    const f = makeFmt(t.decimals ?? 4);
    const checks = [
      ['liq', (worst - t.liq) * dir <= 0, `chạm giá thanh lý ${f(t.liq)}. Kiểm tra vị thế trên sàn`],
      ['sl', (worst - t.sl) * dir <= 0, `chạm Stop Loss ${f(t.sl)}. Nên đóng lệnh`],
      ['tp2', (best - t.tp2) * dir >= 0, `chạm TP2 ${f(t.tp2)}. Chốt phần còn lại`],
      ['tp1', (best - t.tp1) * dir >= 0, `chạm TP1 ${f(t.tp1)}. Chốt 50% và dời SL về entry`],
    ];
    const hit = checks.find(([key, cond]) => cond && !tradeLive.alerted.has(`${t.id}:${key}`));
    if (hit) {
      for (const [key, cond] of checks) if (cond) tradeLive.alerted.add(`${t.id}:${key}`);
      toast(`${t.base} ${t.side}: giá đã ${hit[2]}. Bấm Đóng lệnh khi bạn đã thoát trên sàn.`, 8000);
    }
    // Level alerts above check every tick; the numbers on screen repaint at most once a second.
    if (Date.now() - (tradeLive.paintedAt.get(t.id) || 0) < LIVE_PAINT_MS) continue;
    tradeLive.paintedAt.set(t.id, Date.now());
    for (const cell of document.querySelectorAll(`[data-live="${t.id}"]`)) cell.innerHTML = liveCell(t, p);
    for (const cell of document.querySelectorAll(`[data-live-price="${t.id}"]`)) cell.textContent = f(p);
  }
}

function onTradeAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('tr[data-id]');
  const t = state.trades.find((x) => x.id === row?.dataset.id);
  if (!t) return;
  const wrap = btn.closest('.inline-close');
  if (btn.dataset.act === 'close') {
    const p = tradeLive.prices.get(t.symbol);
    wrap.innerHTML = `<input type="number" step="any" min="0" placeholder="Giá đóng" aria-label="Giá đóng lệnh ${esc(t.base)}" class="num" value="${p ?? ''}">
      <button class="btn btn-sm btn-primary" data-act="confirmClose" type="button">Xác nhận</button>
      <button class="btn btn-sm" data-act="cancelClose" type="button">Hủy</button>`;
    wrap.querySelector('input').select();
  } else if (btn.dataset.act === 'cancelClose') {
    wrap.outerHTML = closeButton;
  } else if (btn.dataset.act === 'confirmClose') {
    const price = Number(wrap.querySelector('input').value);
    if (!(price > 0)) { toast('Nhập giá đóng lệnh (giá thoát trung bình trên sàn).'); return; }
    J.closeTrade(t, price);
    afterClose(t);
  } else if (btn.dataset.act === 'del') {
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Chắc chắn?'; return; }
    state.trades = state.trades.filter((x) => x.id !== t.id);
    state.deleted = [...(state.deleted || []), t.id];
    J.saveState(state);
    renderStats();
    updateBadge();
  }
}

async function afterClose(t) {
  const learned = J.learn(state);
  await J.saveState(state);
  if (!$('#view-stats').hidden) renderStats();
  updateBadge();
  const msg = `Đã đóng ${t.base} ${t.side}: ${STATUS[t.status]} ${usd(t.pnl)} USDT (${sPct(t.pnl / t.margin, 1)}).`;
  toast(learned && learned.trigger !== 'relax' ? `${msg} ${learned.title}: hệ thống đã tự điều chỉnh, xem tab Thống kê.` : msg, 7000);
}

// ---------- statistics ----------
function updateBadge() {
  syncTradeStreams();
  renderPositions();
  const s = J.computeStats(state.trades);
  const alert = state.learning.protective || s.curConsecLoss >= 3;
  for (const b of document.querySelectorAll('.stats-badge')) {
    b.hidden = !alert && !s.open;
    b.textContent = alert ? '!' : s.open;
    b.title = alert ? 'Đang có chuỗi thua' : `${s.open} lệnh đang mở`;
    b.classList.toggle('badge-info', !alert);
  }
}

function breakdownTable(title, groups, order) {
  const rows = Object.entries(groups);
  if (order) rows.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  if (!rows.length) return '';
  return `<div><span class="eyebrow">${title}</span><div class="table-wrap"><table>
    <thead><tr><th></th><th class="n">Lệnh</th><th class="n">Thắng</th><th class="n">PnL</th></tr></thead>
    <tbody>${rows.map(([k, g]) => `<tr><td>${esc(k)}</td><td class="n">${g.n}</td><td class="n">${pct(g.wins / g.n, 0)}</td><td class="n ${cls(g.pnl)}">${usd(g.pnl)}</td></tr>`).join('')}</tbody>
  </table></div></div>`;
}

function rulesList(L) {
  const r = L.rules || {};
  const out = [];
  if (r.blockCounterBtc) out.push('Không vào lệnh ngược xu hướng BTC');
  if (r.maxLev) out.push(`Đòn bẩy khuyến nghị ≤ ${r.maxLev}x`);
  if (r.minAdx) out.push(`Chỉ vào khi ADX ≥ ${r.minAdx}`);
  if (r.blockAgainstNews) out.push('Không vào lệnh ngược chiều tin tức');
  for (const [side, v] of Object.entries(r.sidePenalty || {})) out.push(`Lệnh ${side} cần tín hiệu mạnh hơn ${Math.round(v * 100)} điểm`);
  for (const k of Object.keys(r.styleWarn || {})) out.push(`Cảnh báo khi dùng ${STYLES[k]?.label || k}`);
  return out;
}

function renderStats() {
  const s = J.computeStats(state.trades);
  const L = state.learning;
  const root = $('#stats');
  destroyChart('equity');

  const toolbar = `<div class="toolbar">
    <span class="note">Lưu tại: ${{ file: 'máy tính (dùng chung với điện thoại)', browser: 'ngay trên thiết bị này. Nhớ Xuất JSON định kỳ để sao lưu', locked: 'thiết bị này (thiếu mã truy cập)' }[J.storageMode] || 'bộ nhớ tạm'}</span>
    <span class="spacer"></span>
    <button class="btn btn-sm" id="exportBtn" type="button">Xuất JSON</button>
    <button class="btn btn-sm" id="importBtn" type="button">Nhập JSON</button>
    <button class="btn btn-sm btn-danger" id="resetLearnBtn" type="button">Đặt lại phần tự học</button>
  </div>`;

  if (!state.trades.length) {
    root.innerHTML = `${toolbar}<div class="card empty">
      <h3>Chưa có lệnh nào trong nhật ký</h3>
      <p>Sau khi đặt lệnh trên sàn, bấm <b>Đã vào lệnh</b> ở trang phân tích. Khi thoát lệnh, bấm <b>Đóng lệnh</b> và nhập giá đóng.
      Lệnh đã đóng sẽ được thống kê tỷ lệ thắng, chuỗi thua, và hệ thống tự điều chỉnh khi thua từ 3 lệnh trở lên.</p>
      <button class="btn btn-primary" type="button" data-goto="analyze">Đến trang phân tích</button>
    </div>`;
    bindStatsToolbar();
    return;
  }

  const latest = L.log[0];
  let alert = '';
  if (L.protective && latest) {
    alert = `<div class="alert">
      <h3>Cảnh báo: ${esc(latest.title)}. Hệ thống đã tự phân tích và điều chỉnh</h3>
      <div><span class="eyebrow">Nguyên nhân tìm thấy</span><ul>${latest.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
      <div><span class="eyebrow">Đã thay đổi</span><ul>${latest.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
      <p class="note">Chế độ phòng thủ tự tắt khi bạn thắng 2 lệnh liên tiếp.</p>
    </div>`;
  } else if (s.closed >= 5 && s.winRate >= 0.5 && s.curConsecLoss === 0) {
    alert = `<div class="alert calm"><h3>Phân tích đang hoạt động ổn định</h3><p class="note">Tỷ lệ thắng ${pct(s.winRate, 0)} trên ${s.closed} lệnh đã đóng.</p></div>`;
  }

  const calibRows = ['<45%', '45–55%', '55–65%', '≥65%'].map((b) => {
    const g = s.calib[b];
    if (!g) return `<tr><td>${b}</td><td class="n">0</td><td class="n">—</td><td class="n">—</td><td></td></tr>`;
    const pred = g.sumP / g.n, act = g.wins / g.n;
    const diff = act - pred;
    return `<tr><td>${b}</td><td class="n">${g.n}</td><td class="n">${pct(pred, 0)}</td><td class="n">${pct(act, 0)}</td>
      <td class="${Math.abs(diff) < 0.08 ? 'pos' : diff < 0 ? 'neg' : ''}">${g.n < 3 ? 'chưa đủ mẫu' : Math.abs(diff) < 0.08 ? 'sát dự đoán' : diff < 0 ? 'đang dự đoán quá cao' : 'đang dự đoán quá thấp'}</td></tr>`;
  }).join('');

  const rules = rulesList(L);
  const mults = Object.entries(L.weightMult || {}).filter(([, v]) => v !== 1);

  const trades = [...state.trades].sort((a, b) => b.createdAt - a.createdAt);
  root.innerHTML = `
  ${toolbar}
  ${alert}
  <div class="kpis">
    <div class="kpi"><span class="eyebrow">Tổng lệnh</span><span class="v">${s.total}</span><span class="d">${s.open} đang mở</span></div>
    <div class="kpi"><span class="eyebrow">Tỷ lệ thắng</span><span class="v ${s.winRate == null ? '' : s.winRate >= 0.5 ? 'pos' : 'neg'}">${s.winRate == null ? '—' : pct(s.winRate, 0)}</span><span class="d">${s.wins} thắng · ${s.losses} thua</span></div>
    <div class="kpi"><span class="eyebrow">Lãi / lỗ ròng</span><span class="v ${cls(s.pnl)}">${usd(s.pnl)}</span><span class="d">USDT</span></div>
    <div class="kpi"><span class="eyebrow">Profit factor</span><span class="v">${s.pf == null ? '—' : s.pf === Infinity ? '∞' : s.pf.toFixed(2)}</span><span class="d">lãi gộp / lỗ gộp</span></div>
    <div class="kpi"><span class="eyebrow">R trung bình</span><span class="v ${cls(s.avgR)}">${s.avgR == null ? '—' : `${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R`}</span><span class="d">so với rủi ro mỗi lệnh</span></div>
    <div class="kpi"><span class="eyebrow">Chuỗi thua</span><span class="v ${s.curConsecLoss >= 3 ? 'neg' : ''}">${s.curConsecLoss}</span><span class="d">dài nhất ${s.maxConsecLoss} · ${s.last5Losses}/5 lệnh gần nhất thua</span></div>
  </div>

  <div class="pair">
    <section class="card">
      <div class="card-head"><h3>Đường vốn</h3><span class="sub">lãi/lỗ cộng dồn (USDT)</span></div>
      ${s.equity.length >= 2 ? '<div class="chart chart-sm" id="equityChart"></div>' : '<p class="note">Cần ít nhất 2 lệnh đã đóng để vẽ đường vốn.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h3>Dự đoán có chính xác không?</h3><span class="sub">xác suất dự đoán so với thực tế</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Nhóm dự đoán</th><th class="n">Lệnh</th><th class="n">Dự đoán</th><th class="n">Thực tế</th><th>Đánh giá</th></tr></thead>
        <tbody>${calibRows}</tbody>
      </table></div>
      <p class="note">Nhóm nào có từ 3 lệnh trở lên sẽ được dùng để hiệu chỉnh xác suất cho các lần phân tích sau.</p>
    </section>
  </div>

  <div class="pair">
    <section class="card">
      <div class="card-head"><h3>Hiệu quả theo nhóm</h3></div>
      ${breakdownTable('Theo hướng', s.bySide)}
      ${breakdownTable('Theo phong cách', s.byStyle)}
      ${breakdownTable('Theo đòn bẩy', s.byLev, ['1–5x', '6–10x', '11–20x', '>20x'])}
      ${breakdownTable('Theo coin', s.bySymbol)}
      ${s.closed ? '' : '<p class="note">Chưa có lệnh nào đóng.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h3>Hệ thống đã tự học</h3><span class="sub">${L.protective ? '<span class="neg">chế độ phòng thủ</span>' : 'bình thường'}</span></div>
      <dl class="kv">
        <dt>Ngưỡng tín hiệu tối thiểu</dt><dd>${Math.round(L.threshold * 100)} / 100</dd>
        <dt>Quy tắc đang áp dụng</dt><dd>${rules.length}</dd>
      </dl>
      ${rules.length ? `<ul class="steps" style="list-style:disc">${rules.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${mults.length ? `<div><span class="eyebrow">Trọng số đã điều chỉnh</span><p class="note">${mults.map(([k, v]) => `${esc(FACTORS[k]?.name || k)} ×${v}`).join(' · ')}</p></div>` : ''}
      <span class="eyebrow">Nhật ký tự học</span>
      ${L.log.length ? `<ul class="log">${L.log.slice(0, 8).map((e) => `<li class="${e.trigger}">
        <b>${esc(e.title)}</b> <span class="note">${time(e.at)}</span>
        ${e.findings.length ? `<ul>${e.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${e.changes.length ? `<ul>${e.changes.map((c) => `<li>→ ${esc(c)}</li>`).join('')}</ul>` : ''}
      </li>`).join('')}</ul>` : '<p class="note">Chưa có điều chỉnh. Khi thua 3 lệnh liên tiếp hoặc 3 trong 5 lệnh gần nhất, hệ thống sẽ phân tích nguyên nhân, giảm trọng số yếu tố hay sai, thêm quy tắc chặn và tăng ngưỡng tín hiệu.</p>'}
    </section>
  </div>

  <section class="card">
    <div class="card-head"><h3>Nhật ký lệnh</h3><span class="sub">${s.total} lệnh</span></div>
    <div class="table-wrap"><table class="cards-table">
      <thead><tr><th>Thời gian</th><th>Coin</th><th>Hướng</th><th>Kiểu</th><th class="n">Vốn × ĐB</th><th class="n">Entry</th><th class="n">SL</th><th class="n">TP1 / TP2</th><th class="n">Dự đoán</th><th>Trạng thái</th><th class="n">PnL (live)</th><th></th></tr></thead>
      <tbody>${trades.map((t) => {
        const f = makeFmt(t.decimals ?? 4);
        const open = isActive(t);
        return `<tr data-id="${t.id}">
          <td class="n" style="text-align:left" data-label="Vào lúc">${time(t.createdAt)}</td>
          <td class="card-title"><b>${esc(t.base)}</b> <span class="pill pill-${t.side === 'LONG' ? 'long' : 'short'} only-mobile">${t.side}</span></td>
          <td class="only-desktop"><span class="pill pill-${t.side === 'LONG' ? 'long' : 'short'}">${t.side}</span></td>
          <td data-label="Kiểu">${esc(STYLES[t.style]?.label || t.style)}</td>
          <td class="n" data-label="Vốn × đòn bẩy">${usd(t.margin, false)} × ${t.leverage}</td>
          <td class="n" data-label="Entry">${f(t.entry)}</td>
          <td class="n" data-label="Stop Loss">${f(t.sl)}</td>
          <td class="n" data-label="TP1 / TP2">${f(t.tp1)}<br><span class="note">${f(t.tp2)}</span></td>
          <td class="n" data-label="Dự đoán">${Math.round(t.prob * 100)}%</td>
          <td data-label="Trạng thái"><span class="st st-${t.status}">${STATUS[t.status] || t.status}</span>${t.closedAt ? `<div class="fnote">đóng ${time(t.closedAt)} @ ${f(t.exitPrice)}</div>` : ''}</td>
          ${open
            ? `<td class="n card-pnl" data-label="Lãi / lỗ" data-live="${t.id}">${tradeLive.prices.has(t.symbol) ? liveCell(t, tradeLive.prices.get(t.symbol)) : '<span class="note">đang chờ giá…</span>'}</td>`
            : `<td class="n card-pnl ${cls(t.pnl)}" data-label="Lãi / lỗ">${t.pnl == null ? '—' : usd(t.pnl)}${t.r != null ? `<br><span class="note">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R</span>` : ''}</td>`}
          <td class="card-actions"><div class="row-actions">${open ? closeButton : ''}<div class="inline-close"><button class="btn btn-sm btn-danger" data-act="del" type="button">Xóa</button></div></div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </section>`;

  bindStatsToolbar();
  if (s.equity.length >= 2) renderEquity(s.equity);
}

function bindStatsToolbar() {
  $('#exportBtn')?.addEventListener('click', exportJson);
  $('#importBtn')?.addEventListener('click', () => $('#importFile').click());
  $('#resetLearnBtn')?.addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Bấm lần nữa để đặt lại'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Đặt lại phần tự học'; }, 4000); return; }
    state.learning = J.defaultLearning();
    J.saveState(state);
    toast('Đã đặt lại trọng số, ngưỡng và quy tắc về mặc định. Nhật ký lệnh được giữ nguyên.');
    renderStats(); updateBadge();
  });
  for (const b of document.querySelectorAll('[data-goto]')) b.addEventListener('click', () => showTab(b.dataset.goto));
}

function renderEquity(eq) {
  const el = $('#equityChart');
  if (!el || !window.LightweightCharts) return;
  const chart = baseChart(el);
  charts.equity = chart;
  const s = chart.addBaselineSeries({
    baseValue: { type: 'price', price: 0 },
    topLineColor: cssVar('--long'), topFillColor1: cssVar('--long-soft'), topFillColor2: cssVar('--long-soft'),
    bottomLineColor: cssVar('--short'), bottomFillColor1: cssVar('--short-soft'), bottomFillColor2: cssVar('--short-soft'),
    lineWidth: 2,
  });
  let prev = 0;
  s.setData(eq.map((p) => { let tt = chartTime(p.t); if (tt <= prev) tt = prev + 1; prev = tt; return { time: tt, value: +p.v.toFixed(2) }; }));
  chart.timeScale().fitContent();
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `radar-futures-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data.trades) ? data.trades : [];
    const ids = new Set(state.trades.map((t) => t.id));
    const added = incoming.filter((t) => t && t.id && !ids.has(t.id));
    state.trades.push(...added);
    if (data.learning && !state.learning.log.length) state.learning = { ...J.defaultLearning(), ...data.learning };
    await J.saveState(state);
    toast(`Đã nhập ${added.length} lệnh mới.`);
    renderStats(); updateBadge();
  } catch {
    toast('File không đúng định dạng JSON của Radar Futures.');
  }
  e.target.value = '';
});

// ---------- Gợi ý: the 2 best of the top 50 coins by past win rate ----------
const SCAN_COUNT = 50;
const SCAN_SHOW = 2;
const scan = { running: null, last: null, renderTimer: 0 };
const SCAN_KEY = (styleKey) => `radar-futures-scan-${styleKey}`;
const clock = (ts) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const scanStyle = () => STYLES[document.querySelector('input[name="scanStyle"]:checked')?.value] || STYLES.intraday;
// A scan stays valid until the candle it was computed on closes.
const candleEnd = (style, at) => Math.floor(at / style.tfMs) * style.tfMs + style.tfMs;

function loadScan(styleKey) {
  try { const x = JSON.parse(localStorage.getItem(SCAN_KEY(styleKey))); return x?.results ? x : null; } catch { return null; }
}
function storeScan(res) {
  try { localStorage.setItem(SCAN_KEY(res.style), JSON.stringify(res)); } catch { /* not remembered */ }
}

const VERDICT_SHORT = { GO: 'Vào lệnh', WAIT: 'Đặt lệnh chờ', NO: 'Bỏ qua' };

function scanItem(x, i) {
  const ok = passes(x);
  // A high rate that still gets "Bỏ qua" needs its reason (weak signal now, liquidation risk, a learned rule...).
  const why = !ok && x.verified && x.p > BREAKEVEN_P ? `<span class="scan-why">${esc(x.reason)}</span>` : '';
  return `<li class="scan-item${ok ? '' : ' dim'}" tabindex="0" role="button" data-coin="${esc(x.base)}" aria-label="Phân tích ${esc(x.base)}">
    <span class="scan-rank">${i + 1}</span>
    <span class="scan-coin"><b>${esc(x.base)}</b><span class="pill pill-${x.side === 'LONG' ? 'long' : 'short'}">${x.side}</span></span>
    <span class="scan-win"><b class="${ok ? 'pos' : x.p > BREAKEVEN_P ? '' : 'neg'}">${x.verified ? `${Math.round(x.p * 100)}%` : '—'}</b>
      <small>${x.verified ? `${x.wins}/${x.n} lần` : 'chưa kiểm chứng'}</small></span>
    <span class="scan-sub"><span class="v-${x.verdict}">${VERDICT_SHORT[x.verdict]}</span> · kỳ vọng ${x.evR >= 0 ? '+' : ''}${x.evR.toFixed(2)}R · 24h ${sPct(x.change24h / 100, 1)}</span>
    ${why}
  </li>`;
}

function renderScan() {
  const style = scanStyle();
  const running = scan.running?.style === style.key;
  const res = running ? scan.running.partial : scan.last?.style === style.key ? scan.last : loadScan(style.key);
  const out = $('#scanResults');
  if (!res || (running && !res.results.length)) {
    out.innerHTML = running ? '' : `<div class="card empty"><h3>Chưa có kết quả cho khung ${esc(style.tf)}</h3>
      <p>Bấm <b>Quét top ${SCAN_COUNT}</b>. Kết quả dùng được tới khi nến ${esc(style.tf)} hiện tại đóng.</p></div>`;
    return;
  }
  const list = sortResults(res.results);
  const picks = list.filter(passes);
  const expired = !running && Date.now() >= candleEnd(style, res.at);
  const when = running ? 'đang quét' : `quét lúc ${clock(res.at)}${expired ? ', <span class="neg">đã cũ vì nến mới đã đóng, nên quét lại</span>' : `, dùng được tới ${clock(candleEnd(style, res.at))}`}`;
  // Coins that qualify come first; if fewer than two do, the next best fill in, clearly marked "Bỏ qua".
  const shown = [...picks, ...list.filter((x) => !passes(x))].slice(0, SCAN_SHOW);
  const banner = running ? '' : !picks.length
    ? `<div class="alert"><h3>Chưa coin nào đủ điều kiện vào lệnh</h3>
      <p class="note">Không coin nào có tỷ lệ thắng quá khứ trên 40% kèm kỳ vọng dương. Hai coin dưới đây chỉ là gần nhất, không nên vào lệnh.</p></div>`
    : picks.length < SCAN_SHOW ? `<p class="note">Chỉ ${picks.length} coin đạt điều kiện; coin còn lại chỉ để tham khảo.</p>` : '';
  out.innerHTML = `<section class="card">
    <div class="scan-summary"><b>Top ${SCAN_SHOW} trong ${res.total} coin</b>
      <span class="note">Khung ${esc(style.tf)} · ${picks.length} coin đạt điều kiện · ${when}${running ? ` (${list.length}/${res.total})` : ''}${res.failed ? ` · ${res.failed} coin lỗi` : ''}</span></div>
    ${banner}
    <ul class="scan-list">${shown.map(scanItem).join('')}</ul>
    <p class="note">Bấm vào coin để xem phân tích chi tiết. Tỷ lệ thắng là của các tín hiệu tương tự trong quá khứ, không đảm bảo cho lần này;
      coin có ít mẫu kém tin cậy, và chênh vài % giữa các coin thường chỉ là ngẫu nhiên.</p>
  </section>`;
}

function scheduleScanRender() {
  if (scan.renderTimer) return;
  scan.renderTimer = setTimeout(() => { scan.renderTimer = 0; if (!$('#view-scan').hidden) renderScan(); }, 1000);
}

async function startScan() {
  if (scan.running) { scan.running.ctrl.abort(); return; } // the button doubles as "stop"
  const style = scanStyle();
  const leverage = Math.round(Number($('#leverage').value)) || 10;
  const margin = Number($('#margin').value) || 100;
  const ctrl = new AbortController();
  scan.running = { style: style.key, ctrl, partial: { at: Date.now(), style: style.key, total: SCAN_COUNT, failed: 0, results: [] } };
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* phone may still dim the screen */ }
  $('#scanBtn').textContent = 'Dừng quét';
  $('#scanProgress').hidden = false;
  $('#scanBar').style.width = '0%';
  $('#scanProgressText').textContent = `Đang lấy danh sách top ${SCAN_COUNT}…`;
  renderScan();
  try {
    const res = await scanTop({
      style, leverage, margin, learning: state.learning, calib: J.computeStats(state.trades).calib, signal: ctrl.signal, count: SCAN_COUNT,
      onProgress: ({ done, total, failed, results }) => {
        Object.assign(scan.running.partial, { total, failed, results: [...results] });
        $('#scanBar').style.width = `${(done / total) * 100}%`;
        $('#scanProgressText').textContent = `Đã quét ${done}/${total} coin…`;
        scheduleScanRender();
      },
    });
    scan.last = res;
    if (!res.aborted) storeScan(res);
    const picks = res.results.filter(passes).length;
    toast(res.aborted ? `Đã dừng, có kết quả ${res.results.length} coin.` : `Quét xong: ${picks} coin đạt điều kiện.`);
  } catch (err) {
    toast(`Quét thất bại: ${err.message}. Thử lại sau ít phút.`);
  } finally {
    scan.running = null;
    wakeLock?.release?.().catch(() => {});
    $('#scanBtn').textContent = `Quét top ${SCAN_COUNT}`;
    $('#scanProgress').hidden = true;
    renderScan();
  }
}

function openCoin(base) {
  $('#coin').value = base;
  const st = document.querySelector(`input[name="style"][value="${scanStyle().key}"]`);
  if (st) st.checked = true;
  document.querySelector('input[name="side"][value=""]').checked = true;
  showTab('analyze');
  runAnalysis();
}

$('#scanBtn').addEventListener('click', startScan);
$('#scanStyleSeg').addEventListener('change', renderScan);
$('#scanResults').addEventListener('click', (e) => {
  const item = e.target.closest('[data-coin]');
  if (item) openCoin(item.dataset.coin);
});
$('#scanResults').addEventListener('keydown', (e) => {
  const item = e.target.closest('[data-coin]');
  if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCoin(item.dataset.coin); }
});

// ---------- wiring ----------
// ---------- coin suggestions while typing (the browser's own datalist does not show on iPhone) ----------
const coinAc = { volumeRank: null, items: [], active: -1 };

async function loadVolumeRank() {
  if (coinAc.volumeRank) return;
  coinAc.volumeRank = new Map();
  try { (await topCoins(1000)).forEach((c, i) => coinAc.volumeRank.set(c.meta.base, i + 1)); } catch { /* fall back to A–Z */ }
}

function coinMatches(query) {
  const q = query.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  const rank = (s) => coinAc.volumeRank?.get(s.base) ?? 9999;
  const name = (s) => s.base.replace(/^1000+/, ''); // 1000PEPE is found by typing "pepe"
  return symbols
    .filter((s) => s.kind === 'COIN')
    .map((s) => ({ s, score: !q ? 0 : name(s).startsWith(q) || s.base.startsWith(q) ? 0 : name(s).includes(q) ? 1 : 2 }))
    .filter((x) => x.score < 2)
    .sort((a, b) => a.score - b.score || rank(a.s) - rank(b.s) || a.s.base.localeCompare(b.s.base))
    .slice(0, 8)
    .map((x) => x.s);
}

function showSuggest() {
  const list = $('#coinSuggest');
  coinAc.items = coinMatches($('#coin').value);
  coinAc.active = -1;
  list.innerHTML = coinAc.items.map((s, i) => `<li role="option" id="coin-opt-${i}" data-base="${esc(s.base)}">
    <b>${esc(s.base)}</b>${coinAc.volumeRank?.has(s.base) ? `<small>khối lượng hạng ${coinAc.volumeRank.get(s.base)}</small>` : ''}</li>`).join('');
  list.hidden = !coinAc.items.length;
  $('#coin').setAttribute('aria-expanded', String(!list.hidden));
}

function hideSuggest() {
  $('#coinSuggest').hidden = true;
  $('#coin').setAttribute('aria-expanded', 'false');
}

function pickCoin(base) {
  $('#coin').value = base;
  hideSuggest();
}

$('#coin').addEventListener('focus', () => { loadVolumeRank().then(() => { if (document.activeElement === $('#coin')) showSuggest(); }); showSuggest(); });
$('#coin').addEventListener('input', showSuggest);
$('#coin').addEventListener('blur', () => setTimeout(hideSuggest, 150));
$('#coin').addEventListener('keydown', (e) => {
  if ($('#coinSuggest').hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    coinAc.active = (coinAc.active + (e.key === 'ArrowDown' ? 1 : -1) + coinAc.items.length) % coinAc.items.length;
    for (const [i, li] of [...$('#coinSuggest').children].entries()) li.classList.toggle('active', i === coinAc.active);
    $('#coin').setAttribute('aria-activedescendant', `coin-opt-${coinAc.active}`);
  } else if (e.key === 'Enter' && coinAc.active >= 0) {
    e.preventDefault();
    pickCoin(coinAc.items[coinAc.active].base);
  } else if (e.key === 'Escape') {
    hideSuggest();
  }
});
// pointerdown fires before the input loses focus, so the tap is not swallowed by the blur handler.
$('#coinSuggest').addEventListener('pointerdown', (e) => {
  const li = e.target.closest('[data-base]');
  if (!li) return;
  e.preventDefault();
  pickCoin(li.dataset.base);
});

$('#leverageRange').addEventListener('input', (e) => { $('#leverage').value = e.target.value; });
$('#leverage').addEventListener('input', (e) => { $('#leverageRange').value = e.target.value; });
$('#form').addEventListener('submit', runAnalysis);
$('#stats').addEventListener('click', onTradeAction);
$('#positions').addEventListener('click', onTradeAction);
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onThemeChanged);

// ---------- theme: auto (follows the phone) / light / dark ----------
const THEME_KEY = 'radar-futures-theme';
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Giao diện: tự động theo máy', light: 'Giao diện: sáng', dark: 'Giao diện: tối' };
function currentTheme() {
  try { return THEMES.includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : 'auto'; } catch { return 'auto'; }
}
function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const btn = $('#themeBtn');
  btn.dataset.mode = theme;
  btn.setAttribute('aria-label', THEME_LABEL[theme]);
  btn.title = THEME_LABEL[theme];
  onThemeChanged();
}
function onThemeChanged() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = cssVar('--bg');
  if (!$('#view-stats').hidden) renderStats();
}
$('#themeBtn').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  try { localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
  applyTheme(next);
  toast(THEME_LABEL[next]);
});

// ---------- open on the phone (QR code, shown only on the computer running the server) ----------
async function setupPhoneButton() {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return; // only the computer running the server can show it
  try {
    const res = await fetch('/api/phone');
    if (!res.ok) return;
    const { url } = await res.json();
    if (!url) return;
    $('#phoneBtn').hidden = false;
    $('#phoneBtn').addEventListener('click', () => {
      $('#phoneUrl').textContent = url;
      const box = $('#phoneQr');
      box.innerHTML = '';
      if (window.QRCode) new QRCode(box, { text: url, width: 220, height: 220, colorDark: '#000000', colorLight: '#ffffff' });
      else box.textContent = 'Không tải được thư viện mã QR, hãy nhập đường link bên dưới trên điện thoại.';
      $('#phoneModal').hidden = false;
    });
  } catch { /* not on the server machine */ }
}
$('#phoneModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('#phoneModal').hidden = true; });
$('#copyPhoneUrl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#phoneUrl').textContent); toast('Đã sao chép đường link.'); }
  catch { getSelection().selectAllChildren($('#phoneUrl')); }
});

// ---------- compact form on phones: collapse to a one-line summary after analysing ----------
const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
function collapseForm(r) {
  if (!isPhone() || !r) return;
  $('#consoleSummaryText').textContent = `${r.meta.base} · ${r.leverage}x · ${r.margin} USDT · ${r.style.tf} · ${r.forcedSide || 'Tự động'}`;
  $('#form').classList.add('collapsed');
}
$('#consoleSummary').addEventListener('click', () => {
  $('#form').classList.remove('collapsed');
  $('#coin').focus();
});

// ---------- pick up trades entered on the other device when coming back to the app ----------
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (await J.syncState(state)) {
    updateBadge();
    if (!$('#view-stats').hidden) renderStats();
  }
});

(async function init() {
  applyTheme(currentTheme());
  loadPrefs();
  state = await J.loadState();
  if (J.storageMode === 'locked') $('#notice').hidden = false;
  // The journal lives in this browser when there is no server (GitHub Pages): ask the browser not to evict it.
  if (J.storageMode === 'browser') navigator.storage?.persist?.().catch(() => {});
  updateBadge();
  setupPhoneButton();
  try {
    symbols = await loadSymbols();
    $('#dataStatus').textContent = `${symbols.length} hợp đồng USDT-M`;
  } catch {
    $('#dataStatus').textContent = 'Không kết nối được Binance';
  }
  if (['#stats', '#scan'].includes(location.hash)) showTab(location.hash.slice(1));
  runAnalysis();
  setInterval(updateLiveClock, 1000);
})();
