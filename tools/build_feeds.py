#!/usr/bin/env python3
"""Writes the crypto news and the FOMC/CPI/PPI calendar to public/feeds/*.json.

GitHub Pages only serves static files, so GitHub Actions runs this every 30 minutes and publishes the result
next to the app. It reuses the same fetching code as the local server (server.py).
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

OUT = os.path.join(ROOT, "public", "feeds")


def write(name, payload):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)


def main():
    os.makedirs(OUT, exist_ok=True)
    news = server.get_news()
    events = server.get_events()
    write("news.json", {"items": news["items"], "fetchedAt": int(news["at"] * 1000), "errors": news["errors"]})
    write("events.json", {"items": events["items"], "fetchedAt": int(events["at"] * 1000), "errors": events["errors"]})
    print(f"news: {len(news['items'])} items, errors: {news['errors']}")
    print(f"events: {len(events['items'])} items, errors: {events['errors']}")
    # A run that got nothing at all should fail loudly instead of publishing empty feeds.
    if not news["items"] and not events["items"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
