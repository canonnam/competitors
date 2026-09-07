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


if __name__ == "__main__":
    unittest.main()
