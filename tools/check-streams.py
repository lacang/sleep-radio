#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探活 stations.json 里所有电台流。

用法：
    python3 tools/check-streams.py            # 只报结果
    python3 tools/check-streams.py --strict   # 有失效就退出码 1（给 CI 用）

判活标准：HTTP 2xx 且 Content-Type 是音频（audio/*、application/octet-stream）。
超时 12 秒，取前 3KB 就断开（不下载整段）。
"""
import argparse
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TIMEOUT = 12
UA = 'Mozilla/5.0 (compatible; sleep-radio-check/1.0)'


def probe(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Range': 'bytes=0-3000'})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            ctype = (r.headers.get('Content-Type') or '').lower()
            ok = r.status in (200, 206) and ('audio' in ctype or 'octet-stream' in ctype or 'mpeg' in ctype)
            return ok, r.status, ctype
    except Exception as e:
        return False, 0, type(e).__name__


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--strict', action='store_true')
    args = ap.parse_args()

    data = json.load(open('stations.json', encoding='utf-8'))
    items = []
    for g in data['groups']:
        for st in g['stations']:
            items.append((g['name'], st['name'], st['url']))

    with ThreadPoolExecutor(max_workers=12) as ex:
        results = list(ex.map(lambda x: probe(x[2]), items))

    dead = []
    for (gname, sname, url), (ok, code, ctype) in zip(items, results):
        if not ok:
            dead.append((gname, sname, url, code, ctype))

    print(f'[check] 共 {len(items)} 个流，失效 {len(dead)} 个')
    for gname, sname, url, code, ctype in dead:
        print(f'  ❌ {gname} / {sname}  http={code} {ctype}  {url}')

    if dead and args.strict:
        sys.exit(1)


if __name__ == '__main__':
    main()
