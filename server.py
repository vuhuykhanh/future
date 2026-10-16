#!/usr/bin/env python3
"""Radar Futures local server.

- Serves the web app in ./public
- /api/news  : gom tin tuc crypto tu RSS (Cointelegraph, Decrypt, CoinDesk, Bitcoin.com), cache 10 phut
- /api/state : doc/ghi nhat ky lenh + trang thai hoc vao ./data/state.json
- /api/events: lich FOMC (federalreserve.gov) va CPI/PPI (ALFRED, St. Louis Fed), cache 6 gio

Chay: python3 server.py   ->  http://127.0.0.1:8765
Dien thoai cung Wi-Fi mo duong link co ?key=... in ra khi khoi dong (hoac quet ma QR trong app tren may tinh).
Moi yeu cau /api/* tu may khac phai kem ma khoa nay; may tinh chay server thi khong can.
"""
import hmac
import html
import json
import secrets
import socket
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DATA_DIR = os.path.join(ROOT, "data")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
KEY_FILE = os.path.join(DATA_DIR, "access_key")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8765"))

FEEDS = [
    ("Cointelegraph", "https://cointelegraph.com/rss"),
    ("Decrypt", "https://decrypt.co/feed"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Bitcoin.com", "https://news.bitcoin.com/feed/"),
]
NEWS_TTL = 600
MAX_STATE_BYTES = 20 * 1024 * 1024

_news = {"at": 0, "items": [], "errors": []}
_news_lock = threading.Lock()
_state_lock = threading.Lock()
_TAG = re.compile(r"<[^>]+>")


def fetch_url(url, depth=0, timeout=12, ua="Mozilla/5.0 (RadarFutures local)"):
    req = Request(url, headers={"User-Agent": ua} if ua else {})
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except HTTPError as err:
        location = err.headers.get("Location") if err.headers else None
        if err.code in (301, 302, 303, 307, 308) and location and depth < 3:
            return fetch_url(urljoin(url, location), depth + 1, timeout, ua)
        raise


def clean(text, limit=320):
    text = html.unescape(_TAG.sub(" ", text or ""))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def parse_feed(source, raw):
    root = ET.fromstring(raw)
    items = []
    for item in root.iter("item"):
        title = clean(item.findtext("title"), 300)
        if not title:
            continue
        pub = item.findtext("pubDate")
        try:
            ts = int(parsedate_to_datetime(pub).timestamp() * 1000) if pub else 0
        except (TypeError, ValueError):
            ts = 0
        items.append({
            "source": source,
            "title": title,
            "link": (item.findtext("link") or "").strip(),
            "summary": clean(item.findtext("description")),
            "published": ts,
        })
    return items


def load_feed(feed):
    source, url = feed
    try:
        return parse_feed(source, fetch_url(url)), None
    except Exception as exc:  # one bad feed must not break the others
        return [], f"{source}: {exc}"


def get_news():
    with _news_lock:
        if time.time() - _news["at"] < NEWS_TTL and _news["items"]:
            return _news
        with ThreadPoolExecutor(max_workers=len(FEEDS)) as pool:
            results = list(pool.map(load_feed, FEEDS))
        seen, items, errors = set(), [], []
        for feed_items, error in results:
            if error:
                errors.append(error)
            for it in feed_items:
                key = it["title"].lower()
                if key not in seen:
                    seen.add(key)
                    items.append(it)
        items.sort(key=lambda it: it["published"], reverse=True)
        _news.update(at=time.time(), items=items[:250], errors=errors)
        return _news


# ---------- macro calendar ----------
# BLS blocks automated requests, so CPI/PPI dates come from the St. Louis Fed's ALFRED calendar,
# whose times are US Central. FOMC decisions are announced at 2:00 pm US Eastern on the meeting's last day.
FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
ALFRED_URL = "https://alfred.stlouisfed.org/releases/calendar?rid={rid}&y={year}"
MACRO_RELEASES = [("CPI", 10, "Mỹ công bố lạm phát CPI"), ("PPI", 46, "Mỹ công bố chỉ số giá sản xuất PPI")]
EASTERN, CENTRAL = ZoneInfo("America/New_York"), ZoneInfo("America/Chicago")
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
EVENTS_TTL = 6 * 3600
# ALFRED stalls requests with a browser-like or unknown User-Agent but serves Python's default one;
# federalreserve.gov is the opposite and needs the browser-like one.
ALFRED_UA = None

_events = {"at": 0, "items": [], "errors": []}
_events_lock = threading.Lock()


def parse_fomc(raw, years):
    page = raw.decode("utf-8", "ignore")
    heads = list(re.finditer(r"(\d{4}) FOMC Meetings", page))
    events = []
    for idx, head in enumerate(heads):
        year = int(head.group(1))
        if year not in years:
            continue
        end = heads[idx + 1].start() if idx + 1 < len(heads) else len(page)
        seg = page[head.end():end]
        months = re.findall(r"fomc-meeting__month[^>]*>\s*(?:<strong>)?\s*([^<]+)", seg)
        days = re.findall(r"fomc-meeting__date[^>]*>\s*([^<]+)", seg)
        for mon, day in zip(months, days):
            day = day.strip()
            if not day[:1].isdigit() or "unscheduled" in day.lower() or "notation" in day.lower():
                continue
            month = MONTHS.get(mon.split("/")[-1].strip().lower()[:3])  # "Apr/May" -> May
            if not month:
                continue
            last_day = int(re.findall(r"\d+", day)[-1])
            at = datetime(year, month, last_day, 14, 0, tzinfo=EASTERN)
            events.append({"type": "FOMC", "title": "Fed công bố lãi suất (FOMC)", "at": int(at.timestamp() * 1000), "source": "federalreserve.gov"})
    return events


def parse_alfred(raw, kind, title):
    page = raw.decode("utf-8", "ignore")
    rows = re.findall(r"<span>\s*\w+day (\w+) (\d{1,2}), (\d{4})\s*</span>(?:(?!<span>\s*\w+day ).)*?(\d{1,2}):(\d{2}) (am|pm)", page, re.S)
    events = []
    for mon, day, year, hh, mm, ampm in rows:
        month = MONTHS.get(mon.lower()[:3])
        if not month:
            continue
        hour = int(hh) % 12 + (12 if ampm == "pm" else 0)
        at = datetime(int(year), month, int(day), hour, int(mm), tzinfo=CENTRAL)
        events.append({"type": kind, "title": title, "at": int(at.timestamp() * 1000), "source": "St. Louis Fed (ALFRED)"})
    return events


def fetch_retry(url, attempts=3, **kwargs):
    # ALFRED sometimes stalls a request; a fresh attempt usually goes straight through.
    for attempt in range(attempts):
        try:
            return fetch_url(url, **kwargs)
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2)


def get_events():
    with _events_lock:
        if time.time() - _events["at"] < EVENTS_TTL and _events["items"]:
            return _events
        now = datetime.now(EASTERN)
        years = {now.year, now.year + 1} if now.month >= 11 else {now.year}
        jobs = [("FOMC", lambda: parse_fomc(fetch_retry(FOMC_URL), years))]
        for kind, rid, title in MACRO_RELEASES:
            for year in sorted(years):
                url = ALFRED_URL.format(rid=rid, year=year)
                jobs.append((kind, lambda url=url, kind=kind, title=title: parse_alfred(fetch_retry(url, timeout=15, ua=ALFRED_UA), kind, title)))
        items, errors = [], []
        with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            futures = [(name, pool.submit(fn)) for name, fn in jobs]
            for name, fut in futures:
                try:
                    items.extend(fut.result())
                except Exception as exc:
                    errors.append(f"{name}: {exc}")
        cutoff = int((time.time() - 2 * 86400) * 1000)
        items = sorted({(e["type"], e["at"]): e for e in items if e["at"] >= cutoff}.values(), key=lambda e: e["at"])
        # Keep an old calendar rather than nothing when every source failed.
        if items or not _events["items"]:
            _events.update(at=time.time(), items=items, errors=errors)
        return _events


# ---------- access from the phone ----------
def access_key():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(KEY_FILE):
        with open(KEY_FILE, "w") as fh:
            fh.write(secrets.token_urlsafe(12))
        os.chmod(KEY_FILE, 0o600)
    with open(KEY_FILE) as fh:
        return fh.read().strip()


def lan_ip():
    # Connecting a UDP socket sends nothing; it only asks the OS which interface would be used.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
        except OSError:
            return None


def phone_url():
    ip = lan_ip()
    return f"http://{ip}:{PORT}/?key={access_key()}" if ip and HOST != "127.0.0.1" else None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    # Static files are public; the API (journal, proxies) needs the key unless the request comes from this machine.
    def _authorized(self):
        if self._is_local():
            return True
        given = self.headers.get("X-Radar-Key", "")
        if given and hmac.compare_digest(given, access_key()):
            return True
        self._json(401, {"error": "missing or wrong access key"})
        return False

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/") and not self._authorized():
            return
        if path == "/api/phone":
            if self._is_local():
                self._json(200, {"url": phone_url()})
            else:
                self._json(403, {"error": "only available on the computer running the server"})
        elif path == "/api/news":
            try:
                news = get_news()
                self._json(200, {"items": news["items"], "fetchedAt": int(news["at"] * 1000), "errors": news["errors"]})
            except Exception as exc:
                self._json(502, {"error": str(exc)})
        elif path == "/api/events":
            try:
                ev = get_events()
                self._json(200, {"items": ev["items"], "fetchedAt": int(ev["at"] * 1000), "errors": ev["errors"]})
            except Exception as exc:
                self._json(502, {"error": str(exc)})
        elif path == "/api/state":
            with _state_lock:
                if os.path.exists(STATE_FILE):
                    with open(STATE_FILE, "r", encoding="utf-8") as fh:
                        self._json(200, json.load(fh))
                else:
                    self._json(200, {})
        else:
            super().do_GET()

    def do_PUT(self):
        if not self._authorized():
            return
        if urlparse(self.path).path != "/api/state":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_STATE_BYTES:
            self._json(413, {"error": "payload size invalid"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("state must be an object")
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        os.makedirs(DATA_DIR, exist_ok=True)
        with _state_lock:
            tmp = STATE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, STATE_FILE)
        self._json(200, {"ok": True})


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Radar Futures dang chay tai http://127.0.0.1:{PORT}  (Ctrl+C de dung)", flush=True)
    url = phone_url()
    if url:
        print(f"Tren dien thoai (cung Wi-Fi): {url}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
