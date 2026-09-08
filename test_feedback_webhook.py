import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer


APP_PATH = Path(__file__).with_name("app.py")


class FakeResponse:
    status = 202

    def read(self):
        return b""

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FeedbackWebhookTest(unittest.TestCase):
    def test_hermes_callback_uses_gateway_compatible_signature_and_user_agent(self):
        old_env = dict(os.environ)
        original_urlopen = urllib.request.urlopen
        captured = []
        with tempfile.TemporaryDirectory() as tempdir:
            os.environ.update({
                "FEEDBACK_DB_PATH": str(Path(tempdir) / "feedback.db"),
                "SLACK_FEEDBACK_WEBHOOK_URL": "https://slack.example/feedback",
                "HERMES_FEEDBACK_WEBHOOK_URL": "https://hooks.example/webhooks/competitors-feedback",
                "HERMES_FEEDBACK_WEBHOOK_SECRET": "test-secret",
            })
            spec = importlib.util.spec_from_file_location("competitors_app_test", APP_PATH)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.init_db()

            def fake_urlopen(request, timeout):
                captured.append(request)
                return FakeResponse()

            urllib.request.urlopen = fake_urlopen
            server = ThreadingHTTPServer(("127.0.0.1", 0), module.App)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps({"category": "ui", "message": "Remove obsolete matrix", "page": "test"}).encode()
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", "/api/feedback", body=body, headers={"Content-Type": "application/json"})
                response = connection.getresponse()
                result = json.loads(response.read())
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                urllib.request.urlopen = original_urlopen
                os.environ.clear()
                os.environ.update(old_env)

        self.assertTrue(result["automation_triggered"])
        hermes_request = captured[1]
        raw = hermes_request.data
        expected = "sha256=" + hmac.new(b"test-secret", raw, hashlib.sha256).hexdigest()
        self.assertEqual(hermes_request.get_header("X-hub-signature-256"), expected)
        self.assertEqual(hermes_request.get_header("User-agent"), "competitors-feedback/1.0")
        self.assertIsNone(hermes_request.get_header("X-hermes-signature-256"))

    def test_feedback_event_preserves_page_title_url_and_context(self):
        old_env = dict(os.environ)
        original_urlopen = urllib.request.urlopen
        captured = []
        with tempfile.TemporaryDirectory() as tempdir:
            os.environ.update({
                "FEEDBACK_DB_PATH": str(Path(tempdir) / "feedback.db"),
                "HERMES_FEEDBACK_WEBHOOK_URL": "https://hooks.example/webhooks/competitors-feedback",
            })
            spec = importlib.util.spec_from_file_location("competitors_app_context_test", APP_PATH)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.init_db()

            def fake_urlopen(request, timeout):
                captured.append(request)
                return FakeResponse()

            urllib.request.urlopen = fake_urlopen
            server = ThreadingHTTPServer(("127.0.0.1", 0), module.App)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps({
                    "category": "content", "message": "서비스 비교 근거를 보완해 주세요.",
                    "page": "장기요양기관 ERP·AI 경쟁사 분석",
                    "page_url": "https://example.test/competitors.html#carefor",
                    "context": "케어포 상세 분석",
                }).encode()
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", "/api/feedback", body=body, headers={"Content-Type": "application/json"})
                response = connection.getresponse()
                response.read()
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                urllib.request.urlopen = original_urlopen
                os.environ.clear()
                os.environ.update(old_env)

        event = json.loads(captured[0].data)
        self.assertEqual(event["page_title"], "장기요양기관 ERP·AI 경쟁사 분석")
        self.assertEqual(event["page_url"], "https://example.test/competitors.html#carefor")
        self.assertEqual(event["context"], "케어포 상세 분석")

    def test_feedback_forms_send_current_page_url(self):
        for filename in ("index.html", "competitor-news.html", "ai-hub-data.html", "competitors.html"):
            html = Path(__file__).with_name(filename).read_text()
            self.assertIn("page_url:location.href", html, filename)
        competitors_html = Path(__file__).with_name("competitors.html").read_text()
        self.assertIn("feedbackContext=x.n+' 상세 분석'", competitors_html)


if __name__ == "__main__":
    unittest.main()
