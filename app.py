#!/usr/bin/env python3
"""Railway service for static competitor dashboard and feedback intake."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from contextlib import closing
import hashlib, hmac, json, os, re, sqlite3, time, urllib.request
import urllib.parse
import naver_ads
import competitor_news
import wiki_chat
import agency_news
import search_visibility
import reputation_watch

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("FEEDBACK_DB_PATH", "/data/feedback.db"))
MAX_BODY = 12_000
RATE_LIMIT_SECONDS = 30
LAST_FEEDBACK_BY_IP = {}


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(DB_PATH)) as db, db:
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
        # Applies to HTML, images, API responses and errors, including HEAD/304.
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path == "/api/reputation-watch":
            self.send_reputation()
            return
        if urllib.parse.urlsplit(self.path).path == "/api/search-visibility":
            self.send_visibility()
            return
        if wiki_chat.handle(self, "GET"):
            return
        if urllib.parse.urlsplit(self.path).path == "/api/agency-news":
            self.send_agency_news()
            return
        if urllib.parse.urlsplit(self.path).path == "/api/competitor-news":
            self.send_news_report()
            return
        if urllib.parse.urlsplit(self.path).path in {"/api/maps-config", "/api/nearby-facilities"}:
            self.send_map_payload()
            return
        if urllib.parse.urlsplit(self.path).path == "/api/operating-report":
            self.send_operating_report()
            return
        if urllib.parse.urlsplit(self.path).path in {"/api/naver-ads", "/api/naver-ad-keywords"}:
            self.send_ad_report()
            return
        super().do_GET()

    def do_HEAD(self):
        if urllib.parse.urlsplit(self.path).path == "/api/reputation-watch":
            self.send_reputation(head_only=True)
            return
        if urllib.parse.urlsplit(self.path).path == "/api/search-visibility":
            self.send_visibility(head_only=True)
            return
        if wiki_chat.handle(self, "HEAD"):
            return
        if urllib.parse.urlsplit(self.path).path == "/api/agency-news":
            self.send_agency_news(head_only=True)
            return
        if urllib.parse.urlsplit(self.path).path == "/api/competitor-news":
            self.send_news_report(head_only=True)
            return
        if urllib.parse.urlsplit(self.path).path in {"/api/maps-config", "/api/nearby-facilities"}:
            self.send_map_payload(head_only=True)
            return
        if urllib.parse.urlsplit(self.path).path == "/api/operating-report":
            self.send_operating_report(head_only=True)
            return
        if urllib.parse.urlsplit(self.path).path in {"/api/naver-ads", "/api/naver-ad-keywords"}:
            self.send_ad_report(head_only=True)
            return
        super().do_HEAD()

    def send_map_payload(self, head_only=False):
        route = urllib.parse.urlsplit(self.path).path
        status = 200
        if route == "/api/maps-config":
            # This is a browser key. Never expose REST, admin, or other service variables.
            key = os.getenv("KAKAO_JAVASCRIPT_KEY", "").strip()
            if re.fullmatch(r"[0-9a-fA-F]{32}", key):
                payload = {"kakaoJavascriptKey": key}
            else:
                status, payload = 503, {"error": "지도를 불러올 수 없습니다."}
            raw = json.dumps(payload, ensure_ascii=False).encode()
        else:
            try:
                raw = (ROOT / "data" / "nearby_facilities.json").read_bytes()
            except OSError:
                status = 503
                raw = json.dumps({"error": "시설목록을 불러올 수 없습니다."}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store" if route == "/api/maps-config" else "public, max-age=300")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def send_operating_report(self, head_only=False):
        try:
            raw = (ROOT / "data" / "operating_report.json").read_bytes()
            status = 200
        except OSError:
            raw = json.dumps({"error": "운영비 자료를 불러오지 못했습니다."}, ensure_ascii=False).encode()
            status = 503
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def send_ad_report(self, head_only=False):
        try:
            reporter = naver_ads.keyword_report if urllib.parse.urlsplit(self.path).path == "/api/naver-ad-keywords" else naver_ads.report
            payload = reporter(naver_ads.db_path())
            status = 200
        except (sqlite3.Error, OSError, ValueError):
            payload = {"error": "광고 보고서를 불러올 수 없습니다. 잠시 후 다시 시도해주세요."}
            status = 503
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def send_news_report(self, head_only=False):
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            payload = competitor_news.report(competitor_news.db_path(), summary=query.get("summary") == ["1"])
            status = 200
        except (sqlite3.Error, OSError, ValueError):
            payload = {"error": "뉴스를 불러오지 못했습니다. 기존 기사를 확인해주세요."}
            status = 503
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def send_agency_news(self, head_only=False):
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            payload = agency_news.report(agency_news.db_path(), summary=query.get("summary") == ["1"])
            status = 200
        except (sqlite3.Error, OSError, ValueError):
            payload = {"error": "공공기관 소식을 불러오지 못했습니다. 원문 게시판에서 확인해주세요."}
            status = 503
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def send_visibility(self, head_only=False):
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            payload = search_visibility.report(search_visibility.db_path(), summary=query.get('summary') == ['1'])
            status = 200
        except (sqlite3.Error, OSError, ValueError):
            payload, status = {'error': '검색노출 현황을 불러오지 못했습니다. 잠시 후 다시 확인해주세요.'}, 503
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def send_reputation(self, head_only=False):
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            payload = reputation_watch.report(reputation_watch.db_path(), summary=query.get('summary') == ['1'])
            status = 200
        except (sqlite3.Error, OSError, ValueError):
            payload, status = {'error': '평판 점검 결과를 불러올 수 없습니다.'}, 503
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def send_head(self):
        # Only public pages/assets are served; never source, local env or report DBs.
        path = Path(self.translate_path(self.path)).resolve()
        public_pages = {"index.html", "competitors.html", "competitor-news.html", "agency-news.html", "ai-hub-data.html", "naver-ads.html", "search-visibility.html", "reputation-watch.html", "operating-costs.html", "nearby-facilities.html", "statistics.html", "knowledge.html"}
        if path == ROOT:
            self.path = "/index.html"
            path = ROOT / "index.html"
        allowed_page = path.parent == ROOT and path.name in public_pages
        allowed_root_asset = path.parent == ROOT and path.name in {"robots.txt", "favicon.ico"}
        allowed_asset = path.is_relative_to(ROOT / "assets") and path.suffix.lower() in {".css", ".js", ".mjs", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".woff2"}
        if not (allowed_page or allowed_root_asset or allowed_asset) or not path.is_file():
            self.send_error(404)
            return None
        return super().send_head()

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path == "/api/agency-news/support-preference":
            self.save_support_preference()
            return
        if wiki_chat.handle(self, "POST"):
            return
        if self.path != "/api/feedback":
            self.send_error(404)
            return
        client_ip = self.client_address[0]
        now = time.monotonic()
        if now - LAST_FEEDBACK_BY_IP.get(client_ip, 0) < RATE_LIMIT_SECONDS:
            self.send_error(429, "Please wait before sending another request")
            return
        LAST_FEEDBACK_BY_IP[client_ip] = now
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
        with closing(sqlite3.connect(DB_PATH)) as db, db:
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
            headers["X-Hub-Signature-256"] = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        hermes_ok = False
        if hermes_url:
            request = urllib.request.Request(hermes_url, data=raw, headers={"Content-Type": "application/json", "User-Agent": "competitors-feedback/1.0", **headers}, method="POST")
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

    def save_support_preference(self):
        import business_support
        try:
            wiki_chat.check_origin(self)
            body = wiki_chat.read_json(self, 8192)
            if not isinstance(body, dict):
                raise ValueError('요청 형식이 올바르지 않습니다.')
            if 'reason' in body and not isinstance(body['reason'], str):
                raise ValueError('관심없는 이유를 글자로 입력해주세요.')
            feedback = business_support.save_preference(agency_news.db_path(), body.get('article_id'),
                                             body.get('preference'), agency_news.datetime.now(agency_news.KST),
                                             reason=body.get('reason'))
        except wiki_chat.ChatError as exc:
            wiki_chat.send_json(self, exc.status, {'error': str(exc)})
            return
        except (ValueError, LookupError) as exc:
            wiki_chat.send_json(self, 404 if isinstance(exc, LookupError) else 400, {'error': str(exc)})
            return
        except (sqlite3.Error, OSError):
            wiki_chat.send_json(self, 503, {'error': '관심 선택을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.'})
            return
        result = {'article_id': body['article_id'], 'preference': body['preference']}
        if 'reason' in body:
            result['feedback'] = feedback
        wiki_chat.send_json(self, 200, result)


if __name__ == "__main__":
    init_db()
    wiki_chat.init_db()
    naver_ads.init_db(naver_ads.db_path())
    scheduler_stop = naver_ads.start_scheduler(naver_ads.db_path())
    competitor_news.init_db(competitor_news.db_path())
    news_scheduler_stop = competitor_news.start_scheduler(competitor_news.db_path())
    agency_news.init_db(agency_news.db_path())
    agency_scheduler_stop = agency_news.start_scheduler(agency_news.db_path())
    search_visibility.init_db(search_visibility.db_path())
    visibility_scheduler_stop = search_visibility.start_scheduler(search_visibility.db_path())
    reputation_watch.init_db(reputation_watch.db_path())
    reputation_scheduler_stop = reputation_watch.start_scheduler(reputation_watch.db_path())
    port = int(os.getenv("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), App)
    print(f"Local: http://localhost:{port}", flush=True)
    try:
        server.serve_forever()
    finally:
        scheduler_stop.set()
        news_scheduler_stop.set()
        agency_scheduler_stop.set()
        visibility_scheduler_stop.set()
        reputation_scheduler_stop.set()
        server.server_close()
