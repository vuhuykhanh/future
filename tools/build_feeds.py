#!/usr/bin/env python3
"""Writes the crypto news and the FOMC/CPI/PPI calendar to public/feeds/*.json.

GitHub Pages only serves static files, so GitHub Actions runs this every 30 minutes and publishes the result
next to the app. It reuses the same fetching code as the local server (server.py).
"""
import json
import os
import sys
import time
from urllib.request import urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

OUT = os.path.join(ROOT, "public", "feeds")


def write(name, payload):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)


def previous_events():
    # The calendar currently published on the site, used when a source fails during this run.
    url = os.environ.get("PREVIOUS_EVENTS_URL")
    if not url:
        return []
    try:
        with urlopen(url, timeout=15) as resp:
            return json.load(resp).get("items", [])
    except Exception:
        return []


def main():
    os.makedirs(OUT, exist_ok=True)
    news = server.get_news()
    events = server.get_events()
    # Keep last run's dates for any source (FOMC/CPI/PPI) that failed this time instead of dropping them.
    failed = {err.split(":")[0] for err in events["errors"]}
    if failed:
        now_ms = int(time.time() * 1000)
        kept = [e for e in previous_events() if e.get("type") in failed and e.get("at", 0) >= now_ms - 2 * 86400e3]
        events["items"] = sorted(events["items"] + kept, key=lambda e: e["at"])
        if kept:
            print(f"kept {len(kept)} {sorted(failed)} events from the previous run")
    write("news.json", {"items": news["items"], "fetchedAt": int(news["at"] * 1000), "errors": news["errors"]})
    write("events.json", {"items": events["items"], "fetchedAt": int(events["at"] * 1000), "errors": events["errors"]})
    print(f"news: {len(news['items'])} items, errors: {news['errors']}")
    print(f"events: {len(events['items'])} items, errors: {events['errors']}")
    # A run that got nothing at all should fail loudly instead of publishing empty feeds.
    if not news["items"] and not events["items"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
