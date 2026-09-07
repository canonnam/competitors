#!/usr/bin/env python3
"""Railway service for static competitor dashboard and feedback intake."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import hashlib, hmac, json, os, re, sqlite3, time, urllib.request

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("FEEDBACK_DB_PATH", "/data/feedback.db"))
MAX_BODY = 12_000


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
            category TEXT NOT NULL, message TEXT NOT NULL, page TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'received'
        )""")


def post_json(url, payload, headers=None):
    if not url:
        return False
    request = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", **(headers or {})}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


class App(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/feedback":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            self.send_error(400, "Invalid request size")
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            category = str(body.get("category", "general"))[:40]
            message = re.sub(r"\s+", " ", str(body.get("message", "")).strip())
            page = str(body.get("page", "competitors"))[:120]
            if len(message) < 5 or len(message) > 4000:
                raise ValueError("Message must be 5-4000 characters")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            self.send_error(400, str(exc))
            return
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with sqlite3.connect(DB_PATH) as db:
            cur = db.execute("INSERT INTO feedback(created_at,category,message,page) VALUES (?,?,?,?)",
                            (created_at, category, message, page))
            feedback_id = cur.lastrowid
        event = {"feedback_id": feedback_id, "created_at": created_at, "category": category,
                 "message": message, "page": page}
        slack_url = os.getenv("SLACK_FEEDBACK_WEBHOOK_URL", "")
        slack_ok = post_json(slack_url, {"text": f"📥 경쟁사 분석 개선요청 #{feedback_id}\n분류: {category}\n의견: {message}"})
        hermes_url = os.getenv("HERMES_FEEDBACK_WEBHOOK_URL", "")
        secret = os.getenv("HERMES_FEEDBACK_WEBHOOK_SECRET", "")
        raw = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()
        headers = {}
        if secret:
            headers["X-Hermes-Signature-256"] = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        hermes_ok = False
        if hermes_url:
            request = urllib.request.Request(hermes_url, data=raw, headers={"Content-Type": "application/json", **headers}, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    hermes_ok = 200 <= response.status < 300
            except Exception:
                hermes_ok = False
        self.send_response(201)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps({"id": feedback_id, "received": True, "slack_notified": slack_ok,
                                     "automation_triggered": hermes_ok}, ensure_ascii=False).encode())


if __name__ == "__main__":
    init_db()
    port = int(os.getenv("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), App).serve_forever()
