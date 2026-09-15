#!/usr/bin/env python3
"""导出最近一次采集的全部条目到本地。

与 ai-topic-brief 技能里的 fetch_candidates.py 的区别：
  fetch_candidates.py  按主题取样（受 per_topic / per_source 限制），用于出选题
  本脚本               **全量导出、不做任何筛选**，用于本地存档或导入外部工具

输出到 <项目>/data/：
  raw-YYYY-MM-DD-all.json   完整字段
  raw-YYYY-MM-DD-all.csv    便于 Excel 打开

用法：python scripts/export_run.py [--limit N]
"""

import argparse
import csv
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ACCOUNT = "cd7607f705657299c33125b58bb017c7"
DATABASE = "21499267-06c3-482e-8faf-332d5519cb6a"
MCP_CONFIG = Path(os.path.expanduser("~/.workbuddy/mcp.json"))
PROJECT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT / "data"
QUERY_URL = (f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"
             f"/d1/database/{DATABASE}/query")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def load_token():
    cfg = json.loads(MCP_CONFIG.read_text(encoding="utf-8"))
    header = cfg["mcpServers"]["cloudflare-api"]["headers"]["Authorization"]
    if not header.startswith("Bearer "):
        raise SystemExit("mcp.json 里没有 Bearer token")
    return header[7:].strip()


TOKEN = load_token()


def query(sql, attempts=3):
    payload = json.dumps({"sql": sql}).encode("utf-8")
    request = urllib.request.Request(
        QUERY_URL, method="POST", data=payload,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    last = None
    for attempt in range(attempts):
        try:
            with OPENER.open(request, timeout=90) as response:
                doc = json.loads(response.read().decode("utf-8"))
            result = doc.get("result") or []
            return result[0].get("results") if result and isinstance(result, list) else []
        except urllib.error.HTTPError as exc:
            raise SystemExit(f"Cloudflare API HTTP {exc.code}："
                             f"{exc.read()[:200].decode('utf-8', 'replace')}")
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
        if attempt < attempts - 1:
            time.sleep(2 + attempt * 2)
    raise SystemExit(f"D1 查询失败：{last}")


def iso_shift(iso_text, seconds):
    moment = dt.datetime.fromisoformat(iso_text.replace("Z", "+00:00"))
    moment += dt.timedelta(seconds=seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="只导前 N 条（0=全部）")
    args = parser.parse_args()

    run = query("SELECT run_id, started_at, finished_at, item_count, filtered_out, "
                "succeeded_sources, failed_sources FROM collection_runs "
                "ORDER BY received_at DESC LIMIT 1")[0]
    print(f"最近采集：{run['started_at']} → {run['finished_at']}")
    print(f"  报告 {run['item_count']} 条，合规过滤 {run.get('filtered_out', 0)} 条，"
          f"成功 {run['succeeded_sources']} 源 / 失败 {run['failed_sources']} 源")

    # 两个坑：
    # ① 不要用 datetime() 包 ISO 字符串 —— SQLite 只认 'YYYY-MM-DD HH:MM:SS'，
    #    遇到带 T/Z 的会返回 NULL，条件静默不成立，查出来是 0 条。
    #    ISO 8601 的字典序等于时间序，直接做字符串比较即可。
    # ② 用 last_seen_at 而不是 first_seen_at —— 后者是「首次见到」，
    #    本次采集的多数条目以前就采到过，first_seen_at 还是旧值。
    #    实测按 first_seen_at 只拿到 93/666。
    lo = iso_shift(run["started_at"], -300)
    hi = iso_shift(run["finished_at"], +300)
    sql = (f"SELECT * FROM articles WHERE last_seen_at >= '{lo}' "
           f"AND last_seen_at <= '{hi}' ORDER BY last_seen_at DESC, source")
    if args.limit:
        sql += f" LIMIT {args.limit}"
    rows = query(sql)
    print(f"导出 {len(rows)} 条（窗口 {lo} ~ {hi}）")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = run["started_at"][:10]
    json_path = OUT_DIR / f"raw-{stamp}-all.json"
    csv_path = OUT_DIR / f"raw-{stamp}-all.csv"

    json_path.write_text(json.dumps(
        {"exported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
         "run": run, "count": len(rows), "items": rows},
        ensure_ascii=False, indent=1), encoding="utf-8")

    fields = list(rows[0].keys()) if rows else \
        ["id", "url", "title", "source", "published_at", "excerpt",
         "first_seen_at", "last_seen_at"]
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in fields})

    print(f"\nJSON → {json_path}")
    print(f"CSV  → {csv_path}")

    from collections import Counter
    dist = Counter(r["source"] for r in rows)
    print(f"\n按来源分布（{len(dist)} 个源）：")
    for name, count in dist.most_common(20):
        print(f"  {name:<26} {count:>3}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
