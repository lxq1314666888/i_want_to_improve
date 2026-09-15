#!/usr/bin/env python3
"""校验 config/ 下的采集配置，在部署前给出可读的报错。

改完 config/*.json 先跑这个：它逐项检查并指出「哪个文件、哪一项、什么问题」，
比等 wrangler 部署失败再回头排查快得多。

用法：
    python scripts/validate_config.py
退出码 0 表示全部通过，1 表示存在问题。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from collect import (  # noqa: E402
    CONFIG_DIR,
    MAX_SOURCES,
    SOURCE_TYPES,
    canonical_url,
    load_config,
    load_limits,
    load_topic_ids,
    valid_release_url,
)

PROBLEMS = []
NOTES = []


def problem(message):
    PROBLEMS.append(message)


def relative(path):
    try:
        return str(Path(path).relative_to(CONFIG_DIR.parent))
    except ValueError:
        return str(path)


def check_sources():
    path = CONFIG_DIR / "sources.json"
    document = load_config(path)
    if document is None:
        problem(f"{relative(path)}：无法读取或不是合法 JSON")
        return []
    if not isinstance(document, list):
        problem(f"{relative(path)}：顶层必须是数组，实际是 {type(document).__name__}")
        return []

    topic_ids = load_topic_ids() or set()
    limits = load_limits()
    ceiling = limits.get("max_sources", MAX_SOURCES)
    enabled = []
    seen = {}

    for index, source in enumerate(document):
        where = f"{relative(path)} 第 {index + 1} 项"
        if not isinstance(source, dict):
            problem(f"{where}：必须是对象")
            continue
        name = source.get("name")
        if not isinstance(name, str) or not name.strip():
            problem(f"{where}：缺少 name")
            continue
        if name in seen:
            problem(f"{where}：name 「{name}」与第 {seen[name] + 1} 项重复")
        seen[name] = index

        if source.get("enabled") is False:
            NOTES.append(f"已停用：{name}（不计入采集）")
            continue
        enabled.append(name)

        kind = source.get("type")
        if kind not in SOURCE_TYPES:
            problem(f"{where}（{name}）：type 「{kind}」不在 {list(SOURCE_TYPES)}")
        if not canonical_url(source.get("url")):
            problem(f"{where}（{name}）：url 不是合法的 http(s) 绝对地址")
        elif kind == "github_releases" and not valid_release_url(source["url"]):
            problem(f"{where}（{name}）：github_releases 的 url 必须形如 "
                    "https://api.github.com/repos/<owner>/<repo>/releases")

        category = source.get("category")
        if category is None:
            problem(f"{where}（{name}）：缺少 category")
        elif topic_ids and category not in topic_ids:
            problem(f"{where}（{name}）：category 「{category}」未在 topics.json 中定义，"
                    f"可用值 {sorted(topic_ids)}")

        lang = source.get("lang")
        if lang is not None and lang not in ("zh", "en"):
            problem(f"{where}（{name}）：lang 只能是 zh 或 en，实际是 「{lang}」")

        host = source.get("canonical_host")
        if host is not None and (not isinstance(host, str) or not host.strip()
                                 or "/" in host or " " in host):
            problem(f"{where}（{name}）：canonical_host 应是纯主机名（如 x.com），实际是 「{host}」")

        keywords = source.get("include_keywords")
        if keywords is not None and (not isinstance(keywords, list)
                                     or not all(isinstance(k, str) and k for k in keywords)):
            problem(f"{where}（{name}）：include_keywords 必须是非空字符串数组")

    if len(enabled) > ceiling:
        problem(f"{relative(path)}：启用 {len(enabled)} 个源，超过上限 {ceiling}"
                f"（可在 settings.json 的 collection.max_sources 调整）")
    if not enabled:
        problem(f"{relative(path)}：至少要启用一个源")
    return enabled


def check_topics():
    path = CONFIG_DIR / "topics.json"
    document = load_config(path)
    if document is None:
        problem(f"{relative(path)}：无法读取或不是合法 JSON")
        return
    topics = document.get("topics")
    if not isinstance(topics, list) or not topics:
        problem(f"{relative(path)}：topics 必须是非空数组")
        return
    seen = set()
    for index, topic in enumerate(topics):
        where = f"{relative(path)} 第 {index + 1} 项"
        if not isinstance(topic, dict):
            problem(f"{where}：必须是对象")
            continue
        for field in ("id", "name"):
            if not isinstance(topic.get(field), str) or not topic[field].strip():
                problem(f"{where}：缺少 {field}")
        if topic.get("id") in seen:
            problem(f"{where}：id 「{topic.get('id')}」重复")
        seen.add(topic.get("id"))


def check_settings():
    path = CONFIG_DIR / "settings.json"
    document = load_config(path)
    if document is None:
        problem(f"{relative(path)}：无法读取或不是合法 JSON")
        return
    rules = document.get("filter")
    if rules is not None and not isinstance(rules, dict):
        problem(f"{relative(path)}：filter 必须是对象")
        return
    if isinstance(rules, dict):
        for key in ("include_keywords", "exclude_keywords"):
            value = rules.get(key)
            if value is not None and not isinstance(value, list):
                problem(f"{relative(path)}：filter.{key} 必须是数组")
        overlap = set(rules.get("include_keywords") or []) & set(rules.get("exclude_keywords") or [])
        if overlap:
            problem(f"{relative(path)}：关键词同时出现在 include 和 exclude 中：{sorted(overlap)}")
    section = document.get("collection")
    if isinstance(section, dict):
        cron = section.get("schedule_cron")
        if cron is not None and (not isinstance(cron, str) or len(cron.split()) != 5):
            problem(f"{relative(path)}：collection.schedule_cron 必须是 5 段式 cron 表达式")


def main():
    print(f"配置目录：{CONFIG_DIR}")
    enabled = check_sources()
    check_topics()
    check_settings()
    for note in NOTES:
        print("  note  " + note)
    if PROBLEMS:
        print(f"\n发现 {len(PROBLEMS)} 个问题：")
        for item in PROBLEMS:
            print("  ✗ " + item)
        print("\n修正后重新运行本脚本。")
        return 1
    print(f"\n✓ 配置校验通过：{len(enabled)} 个启用的源，"
          f"{len(load_topic_ids() or [])} 个主题")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
