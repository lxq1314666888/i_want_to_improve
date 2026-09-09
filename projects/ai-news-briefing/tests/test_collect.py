import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("collect", ROOT / "scripts" / "collect.py")
c = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(c)
NOW = datetime(2025, 9, 9, 12, tzinfo=timezone.utc)
FIXTURES = Path(__file__).parent / "fixtures"
SOURCES = [{"name": "Good", "type": "feed", "url": "https://example.com/feed"},
           {"name": "Bad", "type": "feed", "url": "https://example.net/feed"}]


class FeedTests(unittest.TestCase):
    def rows(self, fixture):
        return c.parse_feed((FIXTURES / fixture).read_bytes())

    def test_rss_guid_permalink_fallback(self):
        rows = self.rows("rss.xml")
        item = c.normalize(rows[0], "Feed", NOW)
        self.assertEqual(item["url"], "https://example.com/post?model=small")
        self.assertEqual(item["id"], hashlib.sha256(item["url"].encode()).hexdigest())
        self.assertEqual(item["title"], "Hello AI")
        self.assertEqual(item["excerpt"], "Brief & useful. More.")
        self.assertEqual(item["published_at"], "2025-09-09T07:00:00Z")
        self.assertIsNone(c.normalize(rows[1], "Feed", NOW))

    def test_atom_alternate_and_publication_not_update(self):
        rows = self.rows("atom.xml")
        item = c.normalize(rows[0], "Atom", NOW)
        self.assertEqual(item["url"], "https://example.com/release?version=2")
        self.assertEqual(item["published_at"], "2025-09-09T07:00:00Z")
        self.assertEqual(item["excerpt"], "Public summary. End.")
        item2 = c.normalize(rows[1], "Atom", NOW)
        self.assertIsNone(item2["published_at"])
        self.assertEqual(item2["excerpt"], "An update")

    def test_invalid_future_and_timezone_free_dates(self):
        for value in (None, "", "bad", "2099-01-01T00:00:00Z", "2025-09-09",
                      "2025-09-09T00:00:00", True, float("inf"), 10**30):
            with self.subTest(value=value):
                self.assertIsNone(c.publication_date(value, NOW))
        self.assertEqual(c.publication_date(NOW.timestamp(), NOW), NOW)
        rows = self.rows("rss.xml")
        self.assertIsNone(c.normalize(rows[2], "Feed", NOW)["published_at"])
        self.assertIsNone(c.normalize(rows[3], "Feed", NOW)["published_at"])

    def test_30_day_horizon(self):
        raw = {"url": "https://example.com/", "title": "Title"}
        raw["published_at"] = c.iso_date(NOW - timedelta(days=30, seconds=1))
        self.assertIsNone(c.normalize(raw, "Feed", NOW))
        raw["published_at"] = c.iso_date(NOW - timedelta(days=30))
        self.assertIsNotNone(c.normalize(raw, "Feed", NOW))
        raw["published_at"] = "invalid"
        self.assertIsNotNone(c.normalize(raw, "Feed", NOW))

    def test_tracking_only_removed_semantic_query_preserved(self):
        url = "HTTPS://Example.COM/path?x=a%2Fb&UTM_source=a&x=2&fbclid=x&gclid=y&%75tm_campaign=z&ref=hn#part"
        self.assertEqual(c.canonical_url(url), "https://example.com/path?x=a%2Fb&x=2&ref=hn")
        self.assertEqual(c.canonical_url("https://example.com"), "https://example.com/")
        self.assertNotEqual(c.canonical_url("https://example.com/?v=1"),
                            c.canonical_url("https://example.com/?v=2"))
        self.assertEqual(c.canonical_url("https://[::1]:8443/a"), "https://[::1]:8443/a")

    def test_invalid_urls(self):
        for url in (None, 1, "", "/relative", "//example.com", "ftp://example.com",
                    "javascript:alert(1)", "https://", "https://user:pass@example.com",
                    "https://user@example.com", "https://example.com:99999/",
                    "https://exa mple.com", "https://example.com/\npath",
                    "https://example.com\\@evil.com", "https://[broken]/", "https://%65xample.com/"):
            with self.subTest(url=url):
                self.assertIsNone(c.canonical_url(url))

    def test_html_and_field_bounds(self):
        self.assertEqual(c.clean_text("<style>bad</style><p>A &amp; B</p><script>bad</script><br>C\x00", 500), "A & B C")
        raw = {"url": "https://example.com", "title": "T" * 400, "excerpt": "E" * 900}
        item = c.normalize(raw, "S" * 100, NOW)
        self.assertEqual(len(item["title"]), 300)
        self.assertEqual(len(item["source"]), 64)
        self.assertEqual(len(item["excerpt"]), 500)
        self.assertEqual(set(item), {"id", "url", "title", "source", "published_at", "excerpt"})
        self.assertIsNone(c.normalize({"url": "https://example.com", "title": "<script>bad</script>"}, "Feed", NOW))
        self.assertIsNone(c.canonical_url("https://example.com/" + "a" * 8192))
        self.assertIsNone(c.normalize({"url": "https://example.com/" + "a" * 2048, "title": "Too long"}, "Feed", NOW))

    def test_rejects_dtd_entities_and_malformed_xml(self):
        inputs = [b'<!DOCTYPE rss [<!ENTITY x "expanded">]><rss><channel>&x;</channel></rss>',
                  b'<!DOCTYPE rss SYSTEM "file:///etc/passwd"><rss/>',
                  b'<!DOCTYPE rss [<!ENTITY x SYSTEM "https://example.com/">]><rss>&x;</rss>',
                  b'<rss>', b'<html>not a feed</html>']
        for data in inputs:
            with self.subTest(data=data), self.assertRaises(c.CollectorError):
                c.parse_feed(data)

    def test_size_and_per_source_limits_and_dedupe(self):
        with self.assertRaises(c.CollectorError):
            c.parse_feed(b" " * (c.MAX_RESPONSE_BYTES + 1))
        entries = [f'<item><title>Item {i}</title><link>https://example.com/{i}?utm_source=feed</link></item>' for i in range(50)]
        entries.insert(0, '<item><title>Duplicate</title><link>https://example.com/0</link></item>')
        client = Mock()
        client.request.return_value = ("<rss><channel>" + "".join(entries) + "</channel></rss>").encode()
        items = c.collect_source(SOURCES[0], client, NOW)
        self.assertEqual(len(items), 25)
        self.assertEqual(len({item["id"] for item in items}), 25)

    def test_newest_items_selected(self):
        rows = [{"url": f"https://example.com/{i}", "title": "A", "published_at": c.iso_date(NOW - timedelta(hours=40-i))} for i in range(40)]
        with patch.object(c, "parse_feed", return_value=rows):
            items = c.collect_source(SOURCES[0], Mock(), NOW)
        self.assertEqual(len(items), 25)
        self.assertEqual(items[0]["url"], "https://example.com/39")


class CollectionTests(unittest.TestCase):
    def test_hn_bounded_sequential_and_skips(self):
        client = Mock()
        base = "https://hacker-news.firebaseio.com/v0/"
        def response(url):
            if url.endswith("topstories.json"):
                return list(range(1, 101))
            item_id = int(url.rsplit("/", 1)[1].split(".")[0])
            item = {"type": "story", "title": "Story", "time": int(NOW.timestamp())}
            if item_id == 1:
                item["deleted"] = True
            if item_id == 2:
                item["dead"] = True
            if item_id == 3:
                item["type"] = "comment"
            if item_id == 4:
                return None
            return item
        client.get_json.side_effect = response
        items = c.collect_source({"name": "HN", "type": "hackernews", "url": base}, client, NOW)
        self.assertEqual(len(items), 11)
        self.assertEqual(client.get_json.call_count, 16)
        self.assertEqual(items[0]["url"], "https://news.ycombinator.com/item?id=5")

    def test_partial_failure_and_global_dedupe(self):
        item = c.normalize({"url": "https://example.com/a", "title": "A"}, "Good", NOW)
        with patch.object(c, "collect_source", side_effect=[[item], c.CollectorError("HTTP 403"), [item]]):
            items, report = c.collect(SOURCES + [dict(SOURCES[0], name="Duplicate")], Mock(), NOW)
        self.assertEqual(items, [item])
        self.assertEqual([s["status"] for s in report["sources"]], ["ok", "error", "ok"])
        self.assertEqual([s["count"] for s in report["sources"]], [1, 0, 1])
        self.assertEqual(report["sources"][1]["error"], "HTTP 403")
        uuid.UUID(report["run_id"])
        self.assertTrue(report["finished_at"].endswith("Z"))

    def test_unexpected_errors_sanitized(self):
        with patch.object(c, "collect_source", side_effect=ValueError("secret-token https://user:pass@host")):
            _, report = c.collect(SOURCES, Mock(), NOW)
        self.assertNotIn("secret-token", json.dumps(report))
        self.assertNotIn("user:pass", json.dumps(report))

    def invoke(self, statuses, dry=False, upload_error=False):
        report = {"run_id": str(uuid.uuid4()), "started_at": c.iso_date(NOW), "finished_at": c.iso_date(NOW),
                  "sources": [{"source": str(i), "status": s, "count": 0} for i, s in enumerate(statuses)]}
        out, err = io.StringIO(), io.StringIO()
        with patch.object(c, "collect", return_value=([], report)), patch.object(c, "upload") as uploader, \
             patch.dict("os.environ", {"API_BASE_URL": "https://example.com", "INGEST_TOKEN": "secret-token"}), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if upload_error:
                uploader.side_effect = c.CollectorError("HTTP 503")
            result = c.main(["--dry-run"] if dry else [])
        return result, uploader, out.getvalue(), err.getvalue()

    def test_all_fail_reports_then_exits_nonzero(self):
        result, uploader, out, err = self.invoke(["error", "error"])
        self.assertEqual(result, 1)
        uploader.assert_called_once()
        self.assertIn("WARNING", out)
        self.assertNotIn("secret-token", out + err)

    def test_partial_failure_exit_success(self):
        result, uploader, out, _ = self.invoke(["ok", "error"])
        self.assertEqual(result, 0)
        uploader.assert_called_once()
        self.assertIn("WARNING", out)

    def test_upload_failure_exits_nonzero(self):
        result, _, out, err = self.invoke(["ok"], upload_error=True)
        self.assertEqual(result, 1)
        self.assertIn("HTTP 503", err)
        self.assertNotIn("OK", out)

    def test_dry_run_json_no_writes_or_secret_required(self):
        result, uploader, out, _ = self.invoke(["ok"], dry=True)
        self.assertEqual(result, 0)
        uploader.assert_not_called()
        self.assertEqual(set(json.loads(out)), {"items", "run"})
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {}, clear=True), \
             patch.object(c, "collect", return_value=([], {"sources": [{"source": "A", "status": "ok", "count": 0}]})), \
             patch.object(c, "upload") as uploader, contextlib.redirect_stderr(io.StringIO()):
            output = Path(directory) / "metadata.json"
            self.assertEqual(c.main(["--dry-run", "--output", str(output)]), 0)
            self.assertEqual(json.loads(output.read_text())["items"], [])
            uploader.assert_not_called()

    def test_default_sources_relative_to_script(self):
        sources = c.load_sources(c.DEFAULT_SOURCES)
        self.assertEqual([s["name"] for s in sources], ["OpenAI", "Hugging Face", "Hacker News"])
        self.assertEqual(c.DEFAULT_SOURCES, ROOT / "sources.json")


@contextlib.contextmanager
def server(callback):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            callback(self)
        def do_GET(self):
            callback(self)
        def log_message(self, *args):
            pass
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(httpd.server_port)
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


class UploadAndHTTPTests(unittest.TestCase):
    def test_batch_sizes_contract_and_run_last(self):
        client = Mock()
        report = {"run_id": str(uuid.uuid4()), "started_at": c.iso_date(NOW), "sources": []}
        items = [{"id": str(i)} for i in range(61)]
        c.upload(client, "https://example.com/", "private-token", items, report)
        calls = client.request.call_args_list
        self.assertEqual([len(call.args[1]["items"]) for call in calls[:-1]], [25, 25, 11])
        self.assertEqual(calls[-1].args, ("https://example.com/api/runs", report, "private-token"))
        self.assertTrue(report["finished_at"].endswith("Z"))

    def test_failed_batch_never_records_run(self):
        client = Mock()
        client.request.side_effect = [b"{}", c.CollectorError("HTTP 503")]
        with self.assertRaises(c.CollectorError):
            c.upload(client, "https://example.com", "token", [{}] * 26, {})
        self.assertEqual(client.request.call_count, 2)
        self.assertTrue(all(call.args[0].endswith("/api/ingest") for call in client.request.call_args_list))

    def test_origin_and_token_validation(self):
        for base in ("http://example.com", "http://localhost.evil", "https://user:pass@example.com",
                     "https://example.com/api", "https://example.com?key=secret", "https://example.com#frag"):
            with self.subTest(base=base), self.assertRaises(c.CollectorError):
                c.validate_api_base(base)
        for base in ("https://example.com", "http://localhost:8888", "http://127.0.0.1:8888"):
            self.assertEqual(c.validate_api_base(base), base)
        for token in ("", "bad\r\nheader", "bad token"):
            with self.subTest(token=token), self.assertRaises(c.CollectorError):
                c.upload(Mock(), "https://example.com", token, [], {})

    def test_redirect_never_forwards_token(self):
        received = []
        origin_received = []
        def target(handler):
            received.append(dict(handler.headers))
            handler.send_response(200)
            handler.end_headers()
        with server(target) as target_url:
            def redirect(handler):
                origin_received.append(handler.headers.get("Authorization"))
                handler.send_response(302)
                handler.send_header("Location", target_url + "/capture")
                handler.end_headers()
            with server(redirect) as origin:
                client = c.HTTPClient(interval=0, sleep=lambda _: None)
                with self.assertRaisesRegex(c.CollectorError, "redirect refused"):
                    client.request(origin + "/api/ingest", {"items": []}, "private-token")
        self.assertEqual(origin_received, ["Bearer private-token"])
        self.assertEqual(received, [])

    def test_redirect_downgrade_and_credentials_blocked(self):
        handler = c.SafeRedirect()
        request = urllib.request.Request("https://example.com/feed")
        for target in ("http://example.com/feed", "https://user:password@example.com/feed", "file:///etc/passwd"):
            with self.subTest(target=target), self.assertRaises(c.CollectorError):
                handler.redirect_request(request, None, 302, "Moved", {}, target)

    def test_http_retry_limits_and_identifying_headers(self):
        for status, attempts in ((403, 1), (401, 1), (429, 2), (503, 2)):
            hits = []
            def fail(handler):
                hits.append(dict(handler.headers))
                handler.send_response(status)
                handler.send_header("Retry-After", "1")
                handler.end_headers()
            with self.subTest(status=status), server(fail) as url:
                client = c.HTTPClient(interval=0, sleep=lambda _: None)
                with self.assertRaisesRegex(c.CollectorError, "HTTP " + str(status)):
                    client.request(url)
            self.assertEqual(len(hits), attempts)
            self.assertEqual(hits[0]["User-Agent"], c.USER_AGENT)
            self.assertEqual(hits[0]["Accept-Encoding"], "identity")

    def test_long_retry_after_defers_instead_of_ignoring_backpressure(self):
        client = c.HTTPClient(interval=0, sleep=Mock())
        client.public = Mock()
        client.public.open.side_effect = urllib.error.HTTPError("https://example.com", 429, "rate limited", {"Retry-After": "120"}, None)
        with self.assertRaisesRegex(c.CollectorError, "retry deferred"):
            client.request("https://example.com")
        self.assertEqual(client.public.open.call_count, 1)

    def test_response_limit_declared_and_streamed(self):
        for declared in (str(c.MAX_RESPONSE_BYTES + 1), None):
            response = Mock()
            response.headers = {"Content-Length": declared} if declared else {}
            response.read.return_value = b"a" * (c.MAX_RESPONSE_BYTES + 1)
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            client = c.HTTPClient(interval=0)
            client.public = Mock()
            client.public.open.return_value = response
            with self.subTest(declared=declared), self.assertRaisesRegex(c.CollectorError, "size limit"):
                client.request("https://example.com")
            if declared:
                response.read.assert_not_called()
            else:
                response.read.assert_called_once_with(c.MAX_RESPONSE_BYTES + 1)

    def test_network_failures_retry_without_leaking_credentials(self):
        client = c.HTTPClient(interval=0, sleep=lambda _: None)
        client.private = Mock()
        client.private.open.side_effect = urllib.error.URLError("secret-token https://user:pass@host")
        with self.assertRaisesRegex(c.CollectorError, "^network request failed$"):
            client.request("https://example.com/api/runs", {}, "secret-token")
        self.assertEqual(client.private.open.call_count, 2)

    def test_empty_collection_still_uploads_run(self):
        client = Mock()
        report = {"run_id": str(uuid.uuid4()), "sources": [{"source": "A", "status": "error", "count": 0}]}
        c.upload(client, "https://example.com", "token", [], report)
        client.request.assert_called_once_with("https://example.com/api/runs", report, "token")

    def test_bad_json_is_sanitized(self):
        client = c.HTTPClient()
        with patch.object(client, "request", return_value=b"not JSON secret-token"):
            with self.assertRaisesRegex(c.CollectorError, "^invalid JSON response$"):
                client.get_json("https://example.com")

    def test_retry_uses_same_run_id_and_payload(self):
        client = c.HTTPClient(interval=0, sleep=lambda _: None)
        client.private = Mock()
        response = Mock()
        response.headers = {}
        response.read.return_value = b"{}"
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        client.private.open.side_effect = [urllib.error.HTTPError("https://example.com", 503, "fail", {}, None), response]
        report = {"run_id": str(uuid.uuid4())}
        client.request("https://example.com/api/runs", report, "token")
        calls = client.private.open.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].args[0].data, calls[1].args[0].data)
        self.assertEqual(json.loads(calls[1].args[0].data)["run_id"], report["run_id"])
        self.assertEqual(calls[0].kwargs["timeout"], c.TIMEOUT)


if __name__ == "__main__":
    unittest.main()
