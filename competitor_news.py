"""Daily public news headlines, with a persistent archive and reviewed seed stories."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, time as day_time, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
from html.parser import HTMLParser
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import threading
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
KST = timezone(timedelta(hours=9))
SCHEDULE = "매일 09:00 (한국시간)"
MAX_FEED_BYTES = 2_000_000
LOG = logging.getLogger("competitor_news")
SYNC_LOCK = threading.Lock()
TARGETS = json.loads((ROOT / "data/news_targets.json").read_text(encoding="utf-8"))


def db_path():
    return Path(os.getenv("COMPETITOR_NEWS_DB_PATH", "/data/competitor-news.db"))


def enabled():
    return os.getenv("COMPETITOR_NEWS_SYNC_ENABLED", "true").lower() not in {"0", "false", "no"}


@contextmanager
def connect(path):
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


def normalized(value):
    return re.sub(r"[^a-z0-9가-힣]", "", value.casefold())


def title_key(title, published_at):
    return published_at[:10] + ":" + normalized(title)


def put_article(db, item):
    # Never overwrite the human-reviewed summary when RSS rediscovers an article.
    key = title_key(item["title"], item["published_at"])
    if db.execute("SELECT 1 FROM articles WHERE url=? OR title_key=?", (item["url"], key)).fetchone():
        return 0
    db.execute("INSERT INTO articles(id,url,title_key,published_at,reviewed,payload) VALUES(?,?,?,?,?,?)",
               (item["id"], item["url"], key, item["published_at"], int(item["reviewed"]),
                json.dumps(item, ensure_ascii=False)))
    return 1


def init_db(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS articles (
                id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, title_key TEXT NOT NULL,
                published_at TEXT NOT NULL, reviewed INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS news_title ON articles(title_key);
            CREATE INDEX IF NOT EXISTS news_date ON articles(published_at DESC);
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        if not db.execute("SELECT 1 FROM state WHERE key='seeded'").fetchone():
            for item in json.loads((ROOT / "data/competitor_news_seed.json").read_text(encoding="utf-8")):
                put_article(db, item)
            db.execute("INSERT INTO state VALUES('seeded','true')")


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def clean_text(value):
    parser = PlainText()
    parser.feed(value or "")
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()


def relevant(title, target):
    text = normalized(title)
    return (any(normalized(term) in text for term in target["aliases"])
            and (not target.get("context") or any(normalized(term) in text for term in target["context"]))
            and not any(normalized(term) in text for term in target.get("exclude", [])))


def feed_url(target):
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode({
        "q": target["query"] + " when:30d", "hl": "ko", "gl": "KR", "ceid": "KR:ko"})


def fetch_feed(target):
    request = urllib.request.Request(feed_url(target), headers={
        "User-Agent": "TheVidaKnowledgeBase/1.0 (daily news RSS reader)",
        "Accept": "application/rss+xml, application/xml, text/xml"})
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read(MAX_FEED_BYTES + 1)
    if len(raw) > MAX_FEED_BYTES:
        raise ValueError("Oversized news feed")
    return raw


def parse_feed(raw, target, now):
    if len(raw) > MAX_FEED_BYTES or b"<!doctype" in raw.lower() or b"<!entity" in raw.lower():
        raise ValueError("Unsupported feed")
    root = ET.fromstring(raw)
    channel = root.find("channel")
    if root.tag != "rss" or channel is None or channel.find("title") is None:
        raise ValueError("Expected a news RSS channel")
    items = []
    valid = 0
    nodes = channel.findall("item")
    for node in nodes[:100]:
        title = clean_text(node.findtext("title"))
        source = clean_text(node.findtext("source"))
        while source and title.endswith(" - " + source):
            title = title[:-(len(source) + 3)].strip()
        try:
            published = parsedate_to_datetime(node.findtext("pubDate", ""))
            if published.tzinfo is None:
                continue
            published = published.astimezone(KST)
            url = urllib.parse.urlsplit(node.findtext("link", ""))
            if (url.scheme != "https" or url.netloc != "news.google.com"
                    or not url.path.startswith("/rss/articles/") or not title or not source
                    or len(title) > 500 or len(source) > 150 or len(url.path) > 2500):
                continue
        except (TypeError, ValueError, OverflowError):
            continue
        valid += 1
        if not now - timedelta(days=30) <= published <= now or not relevant(title, target):
            continue
        link = urllib.parse.urlunsplit(("https", "news.google.com", url.path, "", ""))
        items.append({"id": hashlib.sha256(link.encode()).hexdigest(), "title": title,
                      "summary": "", "competitor": target["name"], "competitor_id": target["id"],
                      "source": source, "url": link, "published_at": published.isoformat(),
                      "collected_at": now.isoformat(), "reviewed": False,
                      "kind": "자동 수집", "via": "Google 뉴스"})
    if nodes and not valid:
        raise ValueError("Feed contains no valid news records")
    return items


def read_state(db):
    return {row["key"]: json.loads(row["value"]) for row in db.execute("SELECT * FROM state")}


def write_state(db, key, value):
    db.execute("INSERT OR REPLACE INTO state VALUES(?,?)", (key, json.dumps(value, ensure_ascii=False)))


def timestamp(value):
    return datetime.fromisoformat(value) if value else None


def due_at(now):
    today = datetime.combine(now.astimezone(KST).date(), day_time(9), KST)
    return today if now >= today else today - timedelta(days=1)


def next_run(state, now):
    if state.get("errors") and state.get("last_attempt"):
        return timestamp(state["last_attempt"]) + timedelta(minutes=30)
    last = timestamp(state.get("last_success"))
    if last is None or last < due_at(now):
        return now
    return due_at(now) + timedelta(days=1)


def sync(path, now=None, fetcher=fetch_feed, targets=None, stop=None):
    now = now or datetime.now(KST)
    targets = TARGETS if targets is None else targets
    if not SYNC_LOCK.acquire(blocking=False):
        return None
    try:
        stories, errors = [], []
        for target in targets:
            if stop and stop.is_set():
                return None
            try:
                stories.extend(parse_feed(fetcher(target), target, now))
            except Exception:
                errors.append(target["name"])
                LOG.warning("News feed unavailable: %s", target["id"])
            if stop and stop.wait(0.4):
                return None
        with connect(path) as db:
            added = sum(put_article(db, item) for item in stories)
            write_state(db, "last_attempt", now.isoformat())
            write_state(db, "errors", errors)
            write_state(db, "last_added", added)
            if not errors:
                write_state(db, "last_success", now.isoformat())
        LOG.info("News sync completed: %s added, %s failed feeds", added, len(errors))
        return {"added": added, "errors": errors}
    finally:
        SYNC_LOCK.release()


def report(path, now=None, summary=False):
    now = now or datetime.now(KST)
    with connect(path) as db:
        state = read_state(db)
        total = db.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
        latest = db.execute("SELECT MAX(published_at) FROM articles").fetchone()[0]
        article_ids = [row[0] for row in db.execute("SELECT id FROM articles ORDER BY id")]
        rows = [] if summary else [json.loads(row[0]) for row in db.execute(
            "SELECT payload FROM articles ORDER BY published_at DESC, reviewed DESC, id")]
    last = timestamp(state.get("last_success"))
    active = enabled()
    result = {"total": total, "latest_published_at": latest, "article_ids": article_ids,
              "updated_at": state.get("last_success"),
              "sync": {"enabled": active, "schedule": SCHEDULE,
                       "stale": last is None or last < due_at(now),
                       "errors": state.get("errors", []),
                       "last_attempt": state.get("last_attempt"),
                       "last_added": state.get("last_added", 0),
                       "next_run": next_run(state, now).isoformat() if active else None,
                       "target_count": len(TARGETS)}}
    if not summary:
        result["items"] = rows
    return result


def run_scheduler(path, stop):
    while not stop.is_set():
        try:
            now = datetime.now(KST)
            with connect(path) as db:
                state = read_state(db)
            if now >= next_run(state, now):
                sync(path, now=now, stop=stop)
        except Exception:
            LOG.exception("News scheduler will retry; stored stories retained")
            if stop.wait(1800):
                break
        stop.wait(30)


def start_scheduler(path):
    stop = threading.Event()
    if enabled():
        threading.Thread(target=run_scheduler, args=(path, stop), name="competitor-news-sync", daemon=True).start()
    return stop


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sync", action="store_true")
    args = parser.parse_args()
    init_db(db_path())
    if args.sync:
        result = sync(db_path())
        print(json.dumps(result, ensure_ascii=False))
        if result and result["errors"]:
            raise SystemExit(1)
    else:
        print(json.dumps(report(db_path(), summary=True), ensure_ascii=False, indent=2))
