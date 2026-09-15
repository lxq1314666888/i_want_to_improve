#!/usr/bin/env python3
"""把最近一次采集的全量条目导出为 Markdown。

这是本项目唯一保留的元数据格式——直接可读，不依赖 Excel / 编辑器。

输出：data/raw-YYYY-MM-DD.md

用法：
  python scripts/export_markdown.py            # 生成
  python scripts/export_markdown.py --clean    # 生成成功后删掉同目录的 json/csv
  python scripts/export_markdown.py --excerpt 160
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ACCOUNT = "cd7607f705657299c33125b58bb017c7"
DATABASE = "21499267-06c3-482e-8faf-332d5519cb6a"
MCP_CONFIG = Path(os.path.expanduser("~/.workbuddy/mcp.json"))
PROJECT = Path(__file__).resolve().parent.parent
CONFIG_DIR = PROJECT / "config"
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


def local_time(iso_text):
    """UTC 时间戳转北京时间显示。"""
    if not iso_text:
        return "时间未知"
    try:
        moment = dt.datetime.fromisoformat(iso_text.replace("Z", "+00:00"))
        return moment.astimezone(dt.timezone(dt.timedelta(hours=8))).strftime("%m-%d %H:%M")
    except ValueError:
        return iso_text


def clean(text, limit):
    if not text:
        return ""
    return " ".join(str(text).split())[:limit]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--excerpt", type=int, default=120, help="摘要截断长度")
    parser.add_argument("--clean", action="store_true", help="生成后删除同目录 json/csv")
    args = parser.parse_args()

    run = query("SELECT run_id, started_at, finished_at, item_count, filtered_out, "
                "succeeded_sources, failed_sources, sources_json FROM collection_runs "
                "ORDER BY received_at DESC LIMIT 1")[0]

    # 用 last_seen_at：first_seen_at 是「首次见到」，本次采集的多数条目是以前采到过的，
    # 按它查只能拿到本次新增的一小部分（实测 93/666）。
    # 另外不要用 datetime() 包 ISO 字符串——SQLite 只认 'YYYY-MM-DD HH:MM:SS'，
    # 会静默返回 0 条。ISO 8601 的字典序等于时间序，直接字符串比较即可。
    lo = iso_shift(run["started_at"], -300)
    hi = iso_shift(run["finished_at"], +300)
    rows = query(f"SELECT source, title, url, published_at, excerpt, first_seen_at "
                 f"FROM articles WHERE last_seen_at >= '{lo}' AND last_seen_at <= '{hi}' "
                 f"ORDER BY last_seen_at DESC, source")

    failures = [(s["source"], s.get("error", ""))
                for s in json.loads(run["sources_json"]) if s["status"] != "ok"]

    by_source = defaultdict(list)
    for row in rows:
        by_source[row["source"]].append(row)
    order = sorted(by_source, key=lambda name: (-len(by_source[name]), name))

    stamp = run["started_at"][:10]
    out_path = OUT_DIR / f"raw-{stamp}.md"
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    lines = [
        f"# 采集原料 · {stamp}",
        "",
        f"> 采集时间：{run['started_at']} → {run['finished_at']}（UTC）",
        f"> 共 **{len(rows)} 条** / {len(order)} 个来源 / 合规过滤 {run.get('filtered_out', 0)} 条",
        f"> 报告采集 {run['item_count']} 条，"
        f"{run['succeeded_sources']} 源成功 / {run['failed_sources']} 源失败",
        "",
        "原始字段：来源 / 发布时间 / 链接 / 摘要。未做任何筛选与加工，判断权在下游。",
        "",
    ]
    if failures:
        lines += ["## 失败源（数据不完整，需知悉）", ""]
        for name, error in failures:
            lines.append(f"- `{name}` — {error}")
        lines.append("")

    lines += ["## 目录", ""]
    for name in order:
        anchor = name.lower().replace(" ", "-").replace(".", "").replace("@", "")
        lines.append(f"- [{name}](#{anchor})（{len(by_source[name])} 条）")
    lines.append("")

    for name in order:
        items = by_source[name]
        lines += [f"## {name}", "", f"共 {len(items)} 条。", ""]
        for row in items:
            title = clean(row["title"], 160) or "（无标题）"
            stamp_text = local_time(row.get("published_at")) \
                if row.get("published_at") else f"采集于 {local_time(row.get('first_seen_at'))}"
            lines.append(f"- **{title}**")
            lines.append(f"  {stamp_text} · <{row['url']}>")
            excerpt = clean(row.get("excerpt"), args.excerpt)
            if excerpt and excerpt not in title:
                lines.append(f"  > {excerpt}")
        lines.append("")

    out_path.write_text("\n".join(lines), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(f"共 {len(rows)} 条 → {out_path}（{size_kb:.0f} KB，{len(lines)} 行）")
    if failures:
        print(f"失败源 {len(failures)} 个：" + "、".join(n for n, _ in failures))

    if args.clean:
        removed = []
        for pattern in (f"raw-{stamp}-all.json", f"raw-{stamp}-all.csv",
                        f"raw-{stamp}-all.md", "candidates.json"):
            target = OUT_DIR / pattern
            if target.exists():
                target.unlink()
                removed.append(pattern)
        print(f"已删除其它格式：{removed or '（无）'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
