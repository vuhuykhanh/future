#!/bin/bash
# Nhấp đúp file này để chạy Radar Futures và mở trình duyệt.
cd "$(dirname "$0")"
(sleep 1 && open "http://127.0.0.1:8765") &
python3 server.py
