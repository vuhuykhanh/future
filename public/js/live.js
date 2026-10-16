// Live market data over the Binance USDT-M Futures WebSocket (one shared connection).
// The legacy /stream path accepts subscriptions but no longer pushes data, so /market/stream comes first.
const URLS = ['wss://fstream.binance.com/market/stream', 'wss://fstream.binance.com/stream'];
const SILENCE_MS = 15000;

export class LiveFeed {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.handlers = new Map(); // stream -> Set<fn>
    this.active = new Set();
    this.ws = null;
    this.urlIdx = 0;
    this.retry = 0;
    this.reqId = 1;
    this.lastMsg = 0;
    this.status = 'idle';
  }

  setStatus(s) {
    if (s !== this.status) { this.status = s; this.onStatus(s); }
  }

  // Returns an unsubscribe function.
  on(stream, fn) {
    const key = stream.toLowerCase();
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key).add(fn);
    this.scheduleSync();
    return () => {
      const set = this.handlers.get(key);
      if (!set) return;
      set.delete(fn);
      if (!set.size) this.handlers.delete(key);
      this.scheduleSync();
    };
  }

  scheduleSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), 30);
  }

  sync() {
    const want = new Set(this.handlers.keys());
    if (!this.ws || this.ws.readyState > 1) {
      if (want.size) this.connect();
      return;
    }
    if (this.ws.readyState === 0) return; // onopen syncs
    const add = [...want].filter((s) => !this.active.has(s));
    const rem = [...this.active].filter((s) => !want.has(s));
    if (add.length) this.send('SUBSCRIBE', add);
    if (rem.length) this.send('UNSUBSCRIBE', rem);
    this.active = want;
    if (!want.size) this.setStatus('idle');
  }

  send(method, params) {
    this.ws.send(JSON.stringify({ method, params, id: this.reqId++ }));
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    const url = URLS[this.urlIdx % URLS.length];
    const ws = new WebSocket(url);
    this.ws = ws;
    this.active = new Set();
    this.gotData = false;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.lastMsg = Date.now();
      this.sync();
      this.armWatchdog();
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg.stream) return;
      this.lastMsg = Date.now();
      this.gotData = true;
      this.setStatus('live');
      const set = this.handlers.get(msg.stream);
      if (set) for (const fn of set) { try { fn(msg.data); } catch (err) { console.error(err); } }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.watchdog);
      this.setStatus('down');
      if (this.handlers.size) {
        const delay = Math.min(30000, 1000 * 2 ** this.retry++);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };
  }

  // Reconnect when the socket goes quiet; switch endpoint if this one never delivered data.
  armWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (!this.handlers.size || !this.ws) return;
      if (Date.now() - this.lastMsg > SILENCE_MS) {
        if (!this.gotData) this.urlIdx++;
        this.ws.close();
      }
    }, 5000);
  }
}
