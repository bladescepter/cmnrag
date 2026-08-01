#!/usr/bin/env python3
"""Discover Hindsight API endpoints"""
import json, os, urllib.request
from pathlib import Path

# .env 位于本项目根目录（与 enrich_regions.py 一致）
env_path = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / ".env"
env = env_path.read_text()
key = next(x.split("=",1)[1].strip() for x in env.splitlines() if x.startswith("HINDSIGHT_API_KEY="))

base = "http://hindsight:8888"
endpoints = [
    "/v1/default/banks",
    "/v1/default/banks/xiyuan",
    "/v1/default/banks/xiyuan/recall",
    "/v1/default/banks/xiyuan/search",
    "/v1/default/banks/xiyuan/query",
    "/v1/rerank",
    "/v1/default/rerank",
    "/v1/default/banks/xiyuan/rerank",
    "/health",
    "/v1/default/health",
]

for ep in endpoints:
    try:
        req = urllib.request.Request(f"{base}{ep}", headers={"Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = r.read()[:500]
            print(f"200 {ep}")
    except urllib.request.HTTPError as e:
        if e.code != 404:
            print(f"{e.code} {ep} (body: {e.read()[:200]})")
    except Exception as e:
        print(f"ERR {ep}: {e}")
