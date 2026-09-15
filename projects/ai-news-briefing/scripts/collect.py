#!/usr/bin/env python3
"""Collect public feed metadata and send it to the private briefing service."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
from html.parser import HTMLParser
import http.client
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from defusedxml import ElementTree

MAX_RESPONSE_BYTES = 3 * 1024 * 1024
MAX_ITEMS = 25
MAX_SOURCES = 60
COLLECTION_WORKERS = 4
HN_ITEMS = 15
TIMEOUT = 20
INTERVAL = 0.3
USER_AGENT = "PersonalAINewsBriefing/1.0 (public RSS/API metadata collector)"
CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
DEFAULT_SOURCES = CONFIG_DIR / "sources.json"
DEFAULT_TOPICS = CONFIG_DIR / "topics.json"
DEFAULT_SETTINGS = CONFIG_DIR / "settings.json"
SOURCE_TYPES = ("feed", "arxiv", "github_releases", "hackernews", "ainews", "hot_api", "html_scrape")
UTC = timezone.utc


class CollectorError(Exception):
    """An error whose message is safe to include in a run report."""


def utc_now():
    return datetime.now(UTC)


def iso_date(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


class PlainText(HTMLParser):
    def __init__(self, limit):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.parts = []
        self.remaining = limit * 4

    def add(self, text):
        if not self.hidden and self.remaining > 0:
            self.parts.append(text[:self.remaining])
            self.remaining -= len(self.parts[-1])

    def handle_starttag(self, tag, attrs):
        tag = tag.rsplit(":", 1)[-1]
        if tag in ("script", "style"):
            self.hidden.append(tag)
        elif tag in ("p", "br", "div", "li", "h1", "h2", "h3", "tr"):
            self.add(" ")

    def handle_endtag(self, tag):
        tag = tag.rsplit(":", 1)[-1]
        if self.hidden and tag == self.hidden[-1]:
            self.hidden.pop()
        elif tag in ("p", "div", "li", "tr"):
            self.add(" ")

    def handle_data(self, data):
        self.add(data)


def clean_text(value, limit):
    parser = PlainText(limit)
    parser.feed(str(value or ""))
    parser.close()
    text = "".join(parser.parts)
    text = "".join(c for c in text if c.isprintable() or c.isspace())
    return " ".join(text.split())[:limit].strip()


def canonical_url(value):
    if not isinstance(value, str) or not value or len(value) > 8192:
        return None
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value) or "\\" in value:
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        host = parsed.hostname.encode("idna").decode("ascii").lower()
        if not re.fullmatch(r"[a-z0-9.:-]+", host):
            return None
        port = parsed.port
        if ":" in host:
            host = "[" + host + "]"
        netloc = host + (":" + str(port) if port is not None else "")
        query = []
        for part in parsed.query.split("&"):
            key = urllib.parse.unquote_plus(part.split("=", 1)[0]).lower()
            if not key.startswith("utm_") and key not in ("fbclid", "gclid"):
                query.append(part)
        return urllib.parse.urlunsplit((parsed.scheme.lower(), netloc,
                                        parsed.path or "/", "&".join(query), ""))
    except (ValueError, UnicodeError):
        return None


def publication_date(value, now):
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            result = datetime.fromtimestamp(value, UTC)
        elif isinstance(value, str) and value.strip():
            try:
                result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            except ValueError:
                result = parsedate_to_datetime(value.strip())
            if result.tzinfo is None:
                return None
            result = result.astimezone(UTC)
        else:
            return None
        return result if result <= now else None
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def rewrite_host(url, host):
    """把条目 URL 的 host 换成指定值。

    镜像站场景专用：同一内容经不同镜像（如各个 Nitter 实例）返回的 URL 不同，
    不归一化的话，跨实例的同一推文会被当成不同条目、无法去重，多实例冗余也就失去意义。
    归一化后既让冗余真正生效，也让用户拿到原站链接而不是镜像链接。
    """
    if not host or not url:
        return url
    parsed = urllib.parse.urlsplit(url)
    if not parsed.hostname or parsed.hostname.lower() == host.lower():
        return url
    # 统一用 https：镜像站的 <link> 常写成 http（如 Nitter），
    # 但目标是知名原站，http 形式既不规范也会被部分客户端拒收
    return urllib.parse.urlunsplit(
        ("https", host, parsed.path, parsed.query, parsed.fragment))


def normalize(raw, source, now, canonical_host=None):
    url = canonical_url(raw.get("url"))
    title = clean_text(raw.get("title"), 300)
    if not url or len(url) > 2048 or not title:
        return None
    url = rewrite_host(url, canonical_host)
    published = publication_date(raw.get("published_at"), now)
    if published and published < now - timedelta(days=30):
        return None
    return {
        "id": hashlib.sha256(url.encode("utf-8")).hexdigest(),
        "url": url,
        "title": title,
        "source": clean_text(source, 64),
        "published_at": iso_date(published) if published else None,
        "excerpt": clean_text(raw.get("excerpt"), 500),
    }


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def child(element, name):
    return next((node for node in element if local_name(node.tag) == name), None)


def child_text(element, name):
    node = child(element, name)
    return "".join(node.itertext()).strip() if node is not None else ""


def markup_text(element, name):
    node = child(element, name)
    if node is None:
        return ""
    return (node.text or "") + "".join(
        ElementTree.tostring(n, encoding="unicode") for n in node)


def parse_feed(data, include_content=False):
    if len(data) > MAX_RESPONSE_BYTES:
        raise CollectorError("response exceeds size limit")
    try:
        root = ElementTree.fromstring(data, forbid_dtd=True, forbid_entities=True,
                                      forbid_external=True)
    except Exception:
        raise CollectorError("invalid or unsafe XML") from None
    kind = local_name(root.tag)
    if kind not in ("rss", "RDF", "feed"):
        raise CollectorError("unsupported feed format")
    rows = []
    for entry in root.iter():
        entry_kind = local_name(entry.tag)
        if entry_kind not in ("item", "entry"):
            continue
        url = ""
        if entry_kind == "entry":
            for link in entry:
                if local_name(link.tag) == "link" and link.get("rel", "alternate") == "alternate":
                    if canonical_url(link.get("href")):
                        url = link.get("href")
                        break
            date = child_text(entry, "published")
            excerpt = markup_text(entry, "summary") or markup_text(entry, "content")
        else:
            url = child_text(entry, "link")
            guid = child(entry, "guid")
            if not canonical_url(url) and guid is not None and guid.get("isPermaLink", "true").lower() != "false":
                url = "".join(guid.itertext()).strip()
            date = child_text(entry, "pubDate") or child_text(entry, "date")
            excerpt = markup_text(entry, "description")
        rows.append({"url": url, "title": markup_text(entry, "title"),
                     "published_at": date, "excerpt": excerpt,
                     "announce_type": child_text(entry, "announce_type")})
        if include_content:
            rows[-1]["content"] = (markup_text(entry, "content") if entry_kind == "entry"
                                   else child_text(entry, "encoded"))
    return rows


class SocialRecap(HTMLParser):
    """Read only named recap sections from the publisher's public RSS body."""

    SECTIONS = {"ai twitter recap": "X", "ai reddit recap": "Reddit"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.section = None
        self.section_level = 0
        self.heading = None
        self.hidden = []
        self.parts = {name: [] for name in self.SECTIONS.values()}
        self.remaining = {name: 1000 for name in self.parts}

    def add(self, text):
        if self.section and self.remaining[self.section] > 0:
            value = text[:self.remaining[self.section]]
            self.parts[self.section].append(value)
            self.remaining[self.section] -= len(value)

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden.append(tag)
        if self.hidden:
            return
        if re.fullmatch(r"h[1-6]", tag):
            self.heading = (int(tag[1]), [])
        elif tag in ("p", "br", "div", "li"):
            self.add(" ")

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
            return
        if re.fullmatch(r"h[1-6]", tag) and self.heading:
            level, parts = self.heading
            text = " ".join("".join(parts).split())
            if text.casefold() in self.SECTIONS:
                self.section = self.SECTIONS[text.casefold()]
                self.section_level = level
            elif level <= self.section_level:
                self.section = None
            else:
                self.add(text + ". ")
            self.heading = None
        elif tag in ("p", "div", "li"):
            self.add(" ")

    def handle_data(self, text):
        if self.hidden:
            return
        if self.heading:
            self.heading[1].append(text)
        else:
            self.add(text)


def social_excerpt(content):
    parser = SocialRecap()
    parser.feed(content or "")
    parser.close()
    excerpts = [(name, clean_text("".join(parts), 215)) for name, parts in parser.parts.items()]
    return " | ".join(f"{name} via AINews: {text}" for name, text in excerpts if text)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, authenticated=False):
        super().__init__()
        self.authenticated = authenticated

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Ingestion endpoints are fixed; even same-host redirects are unnecessary.
        if self.authenticated:
            raise CollectorError("authenticated redirect refused")
        if not canonical_url(newurl):
            raise CollectorError("unsafe source redirect refused")
        if urllib.parse.urlsplit(req.full_url).scheme == "https" and urllib.parse.urlsplit(newurl).scheme != "https":
            raise CollectorError("insecure source redirect refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class HTTPClient:
    def __init__(self, interval=INTERVAL, sleep=time.sleep):
        self.public = urllib.request.build_opener(SafeRedirect())
        self.private = urllib.request.build_opener(SafeRedirect(authenticated=True))
        self.interval = interval
        self.sleep = sleep
        self.last_request = None

    def request(self, url, payload=None, token=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json, application/rss+xml, application/atom+xml, application/xml;q=0.9", "Accept-Encoding": "identity"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        opener = self.private if token is not None else self.public
        for attempt in range(2):
            if self.last_request is not None:
                self.sleep(max(0, self.interval - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            request = urllib.request.Request(url, data=body, headers=headers)
            delay = 1
            try:
                with opener.open(request, timeout=TIMEOUT) as response:
                    declared = response.headers.get("Content-Length")
                    if declared and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
                        raise CollectorError("response exceeds size limit")
                    result = response.read(MAX_RESPONSE_BYTES + 1)
                    if len(result) > MAX_RESPONSE_BYTES:
                        raise CollectorError("response exceeds size limit")
                    return result
            except urllib.error.HTTPError as exc:
                status = exc.code
                retry_after = exc.headers.get("Retry-After", "") if exc.headers else ""
                exc.close()
                if attempt or status not in (408, 429, 500, 502, 503, 504):
                    raise CollectorError("HTTP " + str(status)) from None
                if retry_after:
                    try:
                        delay = max(1, int(retry_after))
                    except ValueError:
                        try:
                            delay = max(1, (parsedate_to_datetime(retry_after) - utc_now()).total_seconds())
                        except (ValueError, TypeError, OverflowError):
                            delay = 1
                    if delay > 60:
                        raise CollectorError("HTTP " + str(status) + "; retry deferred") from None
            except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException):
                if attempt:
                    raise CollectorError("network request failed") from None
            self.sleep(delay)
        raise CollectorError("network request failed")

    def get_json(self, url, token=None):
        try:
            return json.loads(self.request(url, token=token) if token else self.request(url))
        except (ValueError, UnicodeError):
            raise CollectorError("invalid JSON response") from None


def valid_release_url(url):
    return isinstance(url, str) and re.fullmatch(
        r"https://api\.github\.com/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases", url) is not None


def valid_hot_api_url(url):
    return isinstance(url, str) and re.fullmatch(r"https://[A-Za-z0-9.\-]+(:\d+)?(/[^\s]*)?", url) is not None


def collect_hot_api(config, client, now):
    """热搜类 JSON 接口：约定 {"data": [{"title": ..., "link"?: ..., "hot_value"?: ...}]}。

    这类条目没有独立发布时间与正文摘要，因此 published_at 记为 null（不伪造时间），
    热度数值放进 excerpt 供排序参考。条目缺少 link 时可用 link_template 的 {title} 占位符构造。
    """
    payload = client.get_json(config["url"])
    if not isinstance(payload, dict):
        raise CollectorError("invalid hot list response")
    rows = payload.get("data")
    if not isinstance(rows, list):
        rows = payload.get("result") if isinstance(payload.get("result"), list) else None
    if not isinstance(rows, list):
        raise CollectorError("invalid hot list payload")
    template = config.get("link_template") or ""
    raw = []
    for entry in rows[:MAX_ITEMS]:
        if not isinstance(entry, dict):
            continue
        title = entry.get("title") or entry.get("name") or entry.get("word")
        link = entry.get("link") or entry.get("url") or entry.get("mobileUrl")
        if not link and template and title:
            link = template.replace("{title}", urllib.parse.quote(str(title)))
        hot = entry.get("hot_value") or entry.get("hot_value_desc") or entry.get("heat")
        raw.append({"url": link, "title": title,
                    "published_at": entry.get("published_at") or entry.get("event_time_at"),
                    "excerpt": ("热度 " + str(hot)) if hot else ""})
    return raw


LINK_PATTERN = re.compile(r'<a\s[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.I | re.S)


def collect_html_scrape(config, client, now):
    """静态 HTML 列表页：抽取链接与锚文本。

    只适用于服务端渲染、链接直接出现在 HTML 里的页面。依赖 JavaScript 渲染的站点
    （36氪、机器之心等）拿到的只是空壳，本适配器无效——这类站点需要单独适配其数据接口。
    """
    html = client.request(config["url"]).decode("utf-8", "replace")
    base = config.get("base_url") or config["url"]
    minimum = config.get("min_title_length") or 6
    host = urllib.parse.urlsplit(base).hostname or ""
    raw = []
    for href, inner in LINK_PATTERN.findall(html):
        title = clean_text(inner, 300)
        if len(title) < minimum:
            continue
        url = urllib.parse.urljoin(base, href)
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            continue
        # 站点内部链接优先，外链保留但排在后面由上游统一截断
        raw.append((parsed.hostname != host, {"url": url, "title": title,
                                              "published_at": None, "excerpt": ""}))
        if len(raw) >= MAX_ITEMS * 3:
            break
    return [row for _, row in sorted(raw, key=lambda pair: pair[0])[:MAX_ITEMS * 2]]


def collect_source(config, client, now):
    if config["type"] in ("feed", "arxiv"):
        raw = parse_feed(client.request(config["url"]))
        if config["type"] == "arxiv":
            raw = [row for row in raw if row["announce_type"] == "new"]
    elif config["type"] == "ainews":
        entries = parse_feed(client.request(config["url"]), include_content=True)
        raw = []
        for row in entries:
            if not clean_text(row["title"], 300).startswith("[AINews]"):
                continue
            excerpt = social_excerpt(row["content"])
            if excerpt:
                raw.append(dict(row, excerpt=excerpt))
        if entries and not raw:
            raise CollectorError("AINews public recap sections unavailable")
    elif config["type"] == "github_releases":
        if not valid_release_url(config["url"]):
            raise CollectorError("invalid GitHub releases endpoint")
        releases = client.get_json(config["url"] + "?per_page=25", token=os.environ.get("GITHUB_TOKEN") or None)
        if not isinstance(releases, list):
            raise CollectorError("invalid release list")
        raw = [{"url": release.get("html_url"),
                "title": release.get("name") or release.get("tag_name"),
                "published_at": release.get("published_at"),
                "excerpt": release.get("body", "")}
               for release in releases[:MAX_ITEMS] if isinstance(release, dict)
               and not release.get("draft") and not release.get("prerelease")]
    elif config["type"] == "hackernews":
        base = config["url"].rstrip("/") + "/"
        ids = client.get_json(base + "topstories.json")
        if not isinstance(ids, list):
            raise CollectorError("invalid story list")
        raw = []
        for item_id in ids[:HN_ITEMS]:
            if not isinstance(item_id, int) or isinstance(item_id, bool) or item_id <= 0:
                continue
            item = client.get_json(base + "item/" + str(item_id) + ".json")
            if not isinstance(item, dict) or item.get("deleted") or item.get("dead") or item.get("type") != "story":
                continue
            raw.append({"url": item.get("url") or "https://news.ycombinator.com/item?id=" + str(item_id),
                        "title": item.get("title"), "published_at": item.get("time"),
                        "excerpt": item.get("text", "")})
    elif config["type"] == "hot_api":
        raw = collect_hot_api(config, client, now)
    elif config["type"] == "html_scrape":
        raw = collect_html_scrape(config, client, now)
    else:
        raise CollectorError("unsupported source type")
    unique = {}
    canonical_host = config.get("canonical_host")
    for row in raw:
        item = normalize(row, config["name"], now, canonical_host)
        if item is not None:
            unique.setdefault(item["id"], item)
    return sorted(unique.values(), key=lambda item: item["published_at"] or "", reverse=True)[:MAX_ITEMS]


def apply_filters(items, filters):
    """按关键词与标题长度过滤。过滤只影响入库内容，不改写来源元数据。"""
    if not filters:
        return items
    include, exclude, minimum = filters
    if not include and not exclude and not minimum:
        return items
    kept = []
    for item in items:
        title = item.get("title") or ""
        if minimum and len(title) < minimum:
            continue
        if exclude and any(word in title for word in exclude):
            continue
        if include and not any(word in title for word in include):
            continue
        kept.append(item)
    return kept


def load_limits(path=DEFAULT_SETTINGS):
    """从 settings.json 读取采集上限。未配置的项不返回，由调用方用常量兜底。"""
    document = load_config(path)
    section = document.get("collection") if isinstance(document, dict) else None
    if not isinstance(section, dict):
        return {}
    return {key: section[key] for key in ("max_sources", "max_items_per_source")
            if isinstance(section.get(key), int) and section[key] > 0}


def collect(sources, client, now=None, workers=1, filters=None):
    now = now or utc_now()
    report = {"run_id": str(uuid.uuid4()), "started_at": iso_date(now), "sources": []}

    def fetch_source(source):
        name = clean_text(source["name"], 64)
        try:
            source_client = client if workers == 1 else HTTPClient()
            rows = collect_source(source, source_client, now)
            # 源级关键词收窄。热搜类来源没有主题边界，不收窄就会把社会娱乐内容灌进选题池
            keywords = source.get("include_keywords")
            if isinstance(keywords, list) and keywords:
                rows = [row for row in rows
                        if any(word in (row.get("title") or "") for word in keywords
                               if isinstance(word, str) and word)]
            return rows, {"source": name, "status": "ok", "count": len(rows)}
        except Exception as exc:
            error = str(exc) if isinstance(exc, CollectorError) else "source processing failed"
            return [], {"source": name, "status": "error", "count": 0, "error": error[:160]}

    if workers == 1:
        results = [fetch_source(source) for source in sources]
    else:
        with ThreadPoolExecutor(max_workers=min(max(1, workers), COLLECTION_WORKERS)) as pool:
            results = list(pool.map(fetch_source, sources))
    merged = {}
    for rows, source_report in results:
        report["sources"].append(source_report)
        for item in rows:
            merged.setdefault(item["id"], item)
    collected = list(merged.values())
    items = apply_filters(collected, filters)
    report["filtered_out"] = len(collected) - len(items)
    report["finished_at"] = iso_date(utc_now())
    return items, report


def validate_api_base(base):
    if not canonical_url(base):
        raise CollectorError("invalid API_BASE_URL")
    parsed = urllib.parse.urlsplit(base)
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise CollectorError("API_BASE_URL must be an origin without a path or query")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")):
        raise CollectorError("API_BASE_URL must use HTTPS")
    return base.rstrip("/")


def upload(client, base, token, items, report):
    base = validate_api_base(base)
    if not token or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in token):
        raise CollectorError("missing or invalid INGEST_TOKEN")
    for start in range(0, len(items), MAX_ITEMS):
        client.request(base + "/api/ingest", {"items": items[start:start + MAX_ITEMS]}, token)
    report["finished_at"] = iso_date(utc_now())
    client.request(base + "/api/runs", report, token)


def load_config(path):
    """读取可选配置文件。缺失或损坏时返回 None，由调用方回退到默认行为。"""
    try:
        with open(path, "rb") as handle:
            data = handle.read(256 * 1024 + 1)
        if len(data) > 256 * 1024:
            return None
        return json.loads(data)
    except (OSError, ValueError, TypeError):
        return None


def load_topic_ids(path=DEFAULT_TOPICS):
    """返回合法 category id 集合。配置不可读时返回 None，表示不校验分类。"""
    document = load_config(path)
    topics = document.get("topics") if isinstance(document, dict) else None
    if not isinstance(topics, list):
        return None
    ids = {topic["id"] for topic in topics
           if isinstance(topic, dict) and isinstance(topic.get("id"), str) and topic["id"]}
    return ids or None


def load_filters(path=DEFAULT_SETTINGS):
    """返回 (include_keywords, exclude_keywords, min_title_length)。

    exclude 命中标题即丢弃，用于合规过滤与降噪；include 非空时只保留命中的条目。
    """
    document = load_config(path)
    rules = document.get("filter") if isinstance(document, dict) else None
    if not isinstance(rules, dict):
        return (), (), 0

    def words(key):
        value = rules.get(key)
        return tuple(word for word in value if isinstance(word, str) and word) if isinstance(value, list) else ()

    minimum = rules.get("min_title_length")
    return (words("include_keywords"), words("exclude_keywords"),
            minimum if isinstance(minimum, int) and minimum > 0 else 0)


def load_sources(path, allowed_topics=None, max_sources=None):
    # 未显式指定时跟随 settings.json，避免配置调高了上限、这里还卡在旧常量上
    if max_sources is None:
        max_sources = load_limits().get("max_sources", MAX_SOURCES)
    try:
        with open(path, "rb") as handle:
            data = handle.read(256 * 1024 + 1)
        if len(data) > 256 * 1024:
            raise ValueError()
        sources = json.loads(data)
        if not isinstance(sources, list):
            raise ValueError()
        # 先剔除显式停用的源，再校验数量，避免停用项占用配额
        sources = [source for source in sources
                   if not (isinstance(source, dict) and source.get("enabled") is False)]
        if not 1 <= len(sources) <= max_sources:
            raise ValueError()
        names = set()
        for source in sources:
            if not isinstance(source, dict) or not isinstance(source.get("name"), str):
                raise ValueError()
            name = clean_text(source["name"], 64)
            if not name or name in names or source.get("type") not in SOURCE_TYPES or not canonical_url(source.get("url")):
                raise ValueError()
            if source["type"] == "github_releases" and not valid_release_url(source["url"]):
                raise ValueError()
            category = source.get("category")
            if category is not None and allowed_topics is not None and category not in allowed_topics:
                raise ValueError()
            host = source.get("canonical_host")
            if host is not None and (not isinstance(host, str)
                                     or not re.fullmatch(r"[a-z0-9.-]+", host)):
                raise ValueError()
            names.add(name)
        return sources
    except (OSError, ValueError, TypeError):
        raise CollectorError("invalid or unreadable sources configuration") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    parser.add_argument("--dry-run", action="store_true", help="collect without credentials or remote writes")
    parser.add_argument("--output", type=Path, help="write dry-run metadata JSON here instead of stdout")
    args = parser.parse_args(argv)
    if args.output and not args.dry_run:
        parser.error("--output requires --dry-run")
    try:
        limits = load_limits()
        sources = load_sources(args.sources, allowed_topics=load_topic_ids(),
                               max_sources=limits.get("max_sources", MAX_SOURCES))
        filters = load_filters()
        if not args.dry_run:
            base = validate_api_base(os.environ.get("API_BASE_URL", ""))
            token = os.environ.get("INGEST_TOKEN", "")
            if not token or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in token):
                raise CollectorError("missing or invalid INGEST_TOKEN")
        client = HTTPClient()
        items, report = collect(sources, client, workers=COLLECTION_WORKERS, filters=filters)
        if args.dry_run:
            document = json.dumps({"items": items, "run": report}, ensure_ascii=False, indent=2) + "\n"
            if args.output:
                args.output.write_text(document, encoding="utf-8")
            else:
                sys.stdout.write(document)
        else:
            upload(client, base, token, items, report)
        for source in report["sources"]:
            label = "WARNING" if source["status"] == "error" else "OK"
            print(f"{label}: {source['source']}: {source['count']} items" +
                  (" (" + source["error"] + ")" if "error" in source else ""), file=sys.stderr if args.dry_run else sys.stdout)
        return 0 if any(source["status"] == "ok" for source in report["sources"]) else 1
    except Exception as exc:
        error = str(exc) if isinstance(exc, CollectorError) else "collector operation failed"
        print("ERROR: " + error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
