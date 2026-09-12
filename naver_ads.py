"""Read-only Naver Search Ads collection, persistent reports and KST scheduler."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import date, datetime, time as day_time, timedelta, timezone
import gzip
import hashlib
import hmac
import json
import logging
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
KST = timezone(timedelta(hours=9))
START = date(2025, 2, 1)
CHANNELS = {"WEB_SITE": "파워링크", "PLACE": "플레이스", "POWER_CONTENTS": "파워컨텐츠"}
METRICS = ("impressions", "clicks", "cost")
LOG = logging.getLogger("naver_ads")


def load_config():
    values = {}
    env_file = os.getenv("NAVER_ADS_ENV_FILE")
    if env_file:
        for line in Path(env_file).read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("\"'")
    values.update(os.environ)
    return values


def configured(config):
    return all(config.get("NAVER_INCHEON_" + key) for key in ("CUSTOMER_ID", "ACCESS_LICENSE", "SECRET_KEY"))


def db_path():
    return Path(os.getenv("NAVER_ADS_DB_PATH", "/data/naver-ads.db"))


@contextmanager
def connect(path):
    db = sqlite3.connect(path, timeout=30, uri=True)
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


def init_db(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY, level TEXT NOT NULL, channel TEXT NOT NULL,
                title TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS metrics (
                entity_id TEXT NOT NULL, day TEXT NOT NULL,
                impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, cost REAL NOT NULL,
                PRIMARY KEY(entity_id, day)
            );
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        seed = ROOT / "data" / "naver_ads_seed.json.gz"
        if not db.execute("SELECT 1 FROM state WHERE key='through'").fetchone() and seed.exists():
            data = json.loads(gzip.decompress(seed.read_bytes()))
            db.executemany("INSERT OR IGNORE INTO entities VALUES (?,?,?,?,?)", data["entities"])
            db.executemany("INSERT OR IGNORE INTO metrics VALUES (?,?,?,?,?)", data["metrics"])
            db.executemany("INSERT OR IGNORE INTO state VALUES (?,?)", data["state"])


def state_dict(db):
    return dict(db.execute("SELECT key,value FROM state").fetchall())


def set_state(db, **values):
    db.executemany("INSERT OR REPLACE INTO state VALUES (?,?)", [(key, str(value)) for key, value in values.items()])


class NaverClient:
    def __init__(self, config):
        if not configured(config):
            raise ValueError("Naver Incheon credentials are not configured")
        self.customer = config["NAVER_INCHEON_CUSTOMER_ID"]
        self.license = config["NAVER_INCHEON_ACCESS_LICENSE"]
        self.secret = config["NAVER_INCHEON_SECRET_KEY"]

    def get(self, uri, params=None):
        query = "?" + urllib.parse.urlencode(params, doseq=True) if params else ""
        for attempt in range(4):
            timestamp = str(int(time.time() * 1000))
            signature = base64.b64encode(hmac.new(self.secret.encode(), f"{timestamp}.GET.{uri}".encode(), hashlib.sha256).digest()).decode()
            request = urllib.request.Request("https://api.searchad.naver.com" + uri + query, headers={
                "X-Timestamp": timestamp, "X-API-KEY": self.license,
                "X-Customer": self.customer, "X-Signature": signature,
                "Content-Type": "application/json", "User-Agent": "thevida-ad-report/1.0",
            })
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    result = json.load(response)
                time.sleep(0.12)
                return result
            except urllib.error.HTTPError as exc:
                code = exc.code
                exc.close()
                if code != 429 and code < 500:
                    raise RuntimeError(f"Naver API HTTP {code}") from None
                if attempt == 3:
                    raise RuntimeError(f"Naver API HTTP {code}") from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 3:
                    raise RuntimeError("Naver API connection failed") from None
            time.sleep(2 ** attempt)


def entity_list(response, key):
    if not isinstance(response, list) or any(not isinstance(row, dict) or not row.get(key) for row in response):
        raise ValueError("Unexpected Naver entity response")
    return [row for row in response if str(row.get("delFlag", "false")).lower() not in {"true", "1", "y"}]


def discover(client):
    entities = []
    for campaign in entity_list(client.get("/ncc/campaigns"), "nccCampaignId"):
        channel = CHANNELS.get(campaign.get("campaignTp"), campaign.get("campaignTp") or "기타")
        entities.append((campaign["nccCampaignId"], "campaign", channel, campaign.get("name", channel), 1))
        groups = entity_list(client.get("/ncc/adgroups", {"nccCampaignId": campaign["nccCampaignId"]}), "nccAdgroupId")
        for group in groups:
            for ad in entity_list(client.get("/ncc/ads", {"nccAdgroupId": group["nccAdgroupId"]}), "nccAdId"):
                payload = ad.get("ad") or {}
                title = payload.get("headline") or (payload.get("info") or {}).get("name") or group.get("name") or "소재"
                description = payload.get("description")
                if description:
                    title += " | " + description
                entities.append((ad["nccAdId"], "creative", channel, title, 1))
    if not any(row[1] == "campaign" for row in entities):
        raise ValueError("No accessible campaigns; report was not overwritten")
    return entities


def date_ranges(start, end, size=90):
    while start <= end:
        until = min(end, start + timedelta(days=size - 1))
        yield start, until
        start = until + timedelta(days=1)


def daily_stats(client, entity_id, start, end):
    response = client.get("/stats", {"id": entity_id, "fields": json.dumps(["impCnt", "clkCnt", "salesAmt"]),
        "timeRange": json.dumps({"since": start.isoformat(), "until": end.isoformat()}), "timeIncrement": "1"})
    if not isinstance(response, dict):
        raise ValueError("Unexpected Naver statistics response")
    body = response.get("dailyStatResponse", response)
    if not isinstance(body, dict) or not isinstance(body.get("data"), list):
        raise ValueError("Missing daily statistics; existing report retained")
    cycle = str(body.get("cycleBaseTm") or body.get("compTm") or "")
    if cycle and len(cycle) >= 8 and cycle[:8].isdigit() and cycle[:8] < end.strftime("%Y%m%d"):
        raise ValueError("Naver statistics are not ready for the requested date")
    rows = {}
    for item in body["data"]:
        day = str(item.get("dateStart") or item.get("dateEnd") or "")[:10]
        if not day or not start.isoformat() <= day <= end.isoformat() or day in rows:
            raise ValueError("Invalid or duplicate statistics date")
        if not all(key in item and item[key] is not None for key in ("impCnt", "clkCnt", "salesAmt")):
            raise ValueError("Incomplete statistics row")
        imp, clicks, cost = int(item["impCnt"]), int(item["clkCnt"]), float(item["salesAmt"])
        if min(imp, clicks, cost) < 0:
            raise ValueError("Negative statistics value")
        rows[day] = (entity_id, day, imp, clicks, cost)
    # Naver may omit days without delivery. Only a valid data envelope permits zero filling.
    return [rows.get(day.isoformat(), (entity_id, day.isoformat(), 0, 0, 0))
            for day, _ in date_ranges(start, end, 1)]


def sync(path, client, now=None):
    now = now or datetime.now(KST)
    end = now.astimezone(KST).date() - timedelta(days=1)
    init_db(path)
    with connect(path) as db:
        previous = state_dict(db)
        old_ids = {row[0] for row in db.execute("SELECT id FROM entities")}
    start = max(START, date.fromisoformat(previous["through"]) - timedelta(days=5)) if previous.get("through") else START
    entities = discover(client)
    collected = []
    for entity in entities:
        since = start if entity[0] in old_ids else START
        for first, last in date_ranges(since, end):
            collected.extend(daily_stats(client, entity[0], first, last))
    # Publish a whole successful collection atomically; failed requests never replace good data.
    with connect(path) as db:
        db.execute("UPDATE entities SET active=0")
        db.executemany("INSERT OR REPLACE INTO entities VALUES (?,?,?,?,?)", entities)
        db.executemany("INSERT OR REPLACE INTO metrics VALUES (?,?,?,?,?)", collected)
        set_state(db, through=end.isoformat(), since=START.isoformat(), updated_at=now.isoformat(),
                  last_attempt=now.isoformat(), last_error="", source="live")
    LOG.info("Naver report updated through %s (%s rows)", end, len(collected))


def due_target(now):
    local = now.astimezone(KST)
    days_back = 1 if local.time() >= day_time(10, 30) else 2
    return (local.date() - timedelta(days=days_back)).isoformat()


def delivery_eligible(entity):
    return entity.get("status") == "ELIGIBLE" and str(entity.get("userLock", False)).lower() not in {"true", "1", "y"}


def switched_on(entity):
    if 'userLock' not in entity:
        return entity.get('status') == 'ELIGIBLE'
    return str(entity.get('userLock', False)).lower() not in {'true', '1', 'y'} and entity.get('status') != 'PAUSED'


def sync_keywords(path, client, now=None):
    """Seven-day reported rank, not a live SERP position or a bid estimate."""
    now = now or datetime.now(KST)
    end = now.astimezone(KST).date() - timedelta(days=1)
    start = end - timedelta(days=6)
    items = []
    for campaign in entity_list(client.get("/ncc/campaigns"), "nccCampaignId"):
        if campaign.get("campaignTp") != "WEB_SITE":
            continue
        for group in entity_list(client.get("/ncc/adgroups", {"nccCampaignId": campaign["nccCampaignId"]}), "nccAdgroupId"):
            for keyword in entity_list(client.get("/ncc/keywords", {"nccAdgroupId": group["nccAdgroupId"]}), "nccKeywordId"):
                items.append({"id": keyword["nccKeywordId"], "keyword": keyword.get("keyword", ""),
                              "campaign": campaign.get("name", ""), "group": group.get("name", ""),
                              "eligible": all(delivery_eligible(row) for row in (campaign, group, keyword)),
                              "enabled": all(switched_on(row) for row in (campaign, group, keyword)),
                              "campaign_status": campaign.get("status", "UNKNOWN"),
                              "group_status": group.get("status", "UNKNOWN"),
                              "keyword_status": keyword.get("status", "UNKNOWN"),
                              "impressions": 0, "clicks": 0, "cost": 0, "average_rank": None})
    by_id = {item["id"]: item for item in items}
    if len(by_id) != len(items):
        raise ValueError("Duplicate keyword IDs")
    for offset in range(0, len(items), 50):
        batch_ids = {item["id"] for item in items[offset:offset + 50]}
        response = client.get("/stats", {"ids": ",".join(sorted(batch_ids)),
            "fields": json.dumps(["impCnt", "clkCnt", "salesAmt", "avgRnk"]),
            "timeRange": json.dumps({"since": start.isoformat(), "until": end.isoformat()}), "timeIncrement": "allDays"})
        if not isinstance(response, dict) or not isinstance(response.get("data"), list):
            raise ValueError("Missing keyword statistics")
        cycle = str(response.get("cycleBaseTm") or response.get("compTm") or "")
        if len(cycle) >= 8 and cycle[:8].isdigit() and cycle[:8] < end.strftime("%Y%m%d"):
            raise ValueError("Keyword statistics are not ready")
        seen = set()
        for row in response["data"]:
            if not isinstance(row, dict) or row.get("id") not in batch_ids or row["id"] in seen:
                raise ValueError("Unexpected keyword statistics row")
            seen.add(row["id"])
            values = [float(row[field]) for field in ("impCnt", "clkCnt", "salesAmt")]
            rank = float(row["avgRnk"]) if row.get("avgRnk") is not None else 0
            if not all(math.isfinite(value) and value >= 0 for value in values + [rank]) or 0 < rank < 1:
                raise ValueError("Invalid keyword statistics")
            imp, clicks, cost = values
            by_id[row["id"]].update(impressions=int(imp), clicks=int(clicks), cost=cost,
                                    average_rank=rank if rank >= 1 and imp > 0 else None)
    snapshot = {"since": start.isoformat(), "through": end.isoformat(), "updated_at": now.isoformat(), "items": items}
    with connect(path) as db:
        set_state(db, keyword_snapshot=json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
                  keyword_attempt=now.isoformat(), keyword_error="")
    LOG.info("Naver keyword ranks updated through %s (%s keywords)", end, len(items))


def refresh_keywords(path, client, now):
    try:
        sync_keywords(path, client, now)
        return True
    except Exception:
        LOG.warning("Naver keyword refresh failed; last successful snapshot retained")
        with connect(path) as db:
            set_state(db, keyword_attempt=now.isoformat(), keyword_error="키워드 수집 실패: 마지막 정상 순위입니다. 30분 후 재시도합니다.")
        return False


def keyword_report(path, now=None, state=None):
    now = now or datetime.now(KST)
    if state is None:
        with connect(path) as db:
            state = state_dict(db)
    snapshot = json.loads(state.get("keyword_snapshot", "{}"))
    items = snapshot.get("items", [])
    error = state.get("keyword_error", "")
    stale = bool(error) or snapshot.get("through", "") < due_target(now)
    ranked = [row for row in items if row["average_rank"] is not None]
    top = [row for row in ranked if row["average_rank"] <= 3]
    return {**snapshot, "items": items, "stale": stale, "error": error, "threshold": 3,
            "target_date": due_target(now), "next_check": next_run(now),
            "total": len(items), "ranked_count": len(ranked), "top_count": len(top),
            "eligible_top_count": sum(row["eligible"] for row in top),
            "method": "파워링크 등록 키워드 · 전일까지 최근 7일 평균 광고 노출순위 (avgRnk)",
            "source": "https://github.com/naver/searchad-apidoc/wiki/FAQ-stat"}


def next_run(now):
    local = now.astimezone(KST)
    scheduled = datetime.combine(local.date(), day_time(10, 30), KST)
    return (scheduled if local < scheduled else scheduled + timedelta(days=1)).isoformat()


def run_scheduler(path, config, stop):
    client = NaverClient(config)
    while not stop.is_set():
        now = datetime.now(KST)
        with connect(path) as db:
            state = state_dict(db)
        retry_ready = not state.get("last_attempt") or (now - datetime.fromisoformat(state["last_attempt"])).total_seconds() >= 1800
        if state.get("through", "") < due_target(now) and retry_ready:
            try:
                sync(path, client, now)
            except Exception:
                # Do not log request URLs, raw API bodies or credentials.
                LOG.warning("Naver report refresh failed; retry in 30 minutes")
                with connect(path) as db:
                    set_state(db, last_attempt=now.isoformat(), last_error="수집 실패: 마지막 정상 데이터를 표시합니다. 30분 후 재시도합니다.")
        keyword_due = keyword_report(path, now, state)["stale"]
        keyword_retry = not state.get("keyword_attempt") or (now - datetime.fromisoformat(state["keyword_attempt"])).total_seconds() >= 1800
        if keyword_due and keyword_retry:
            refresh_keywords(path, client, now)
        stop.wait(30)


def start_scheduler(path):
    config = load_config()
    stop = threading.Event()
    if configured(config) and config.get("NAVER_ADS_SYNC_ENABLED", "true").lower() == "true":
        threading.Thread(target=run_scheduler, args=(path, config, stop), name="naver-ads-sync", daemon=True).start()
    return stop


def report(path, now=None):
    now = now or datetime.now(KST)
    with connect(path) as db:
        db.execute("BEGIN")
        state = state_dict(db)
        daily = [dict(row) for row in db.execute("""SELECT m.day AS date,e.level,e.channel,
            CASE WHEN e.level='creative' THEN e.id ELSE e.channel END AS entity,
            CASE WHEN e.level='creative' THEN e.title ELSE e.channel END AS title,
            SUM(m.impressions) AS impressions,SUM(m.clicks) AS clicks,SUM(m.cost) AS cost
            FROM metrics m JOIN entities e ON e.id=m.entity_id
            GROUP BY m.day,e.level,entity,title ORDER BY m.day,e.level,entity""")]
    config = load_config()
    enabled = configured(config) and config.get("NAVER_ADS_SYNC_ENABLED", "true").lower() == "true"
    archive_file = ROOT / "data" / "naver_ads_history.json"
    archive = json.loads(archive_file.read_text(encoding="utf-8")) if archive_file.exists() else {}
    return {"branch": "더비다요양원 인천점", "timezone": "Asia/Seoul", "currency": "KRW", "today": now.astimezone(KST).date().isoformat(),
            "since": state.get("since"), "through": state.get("through"), "updated_at": state.get("updated_at"),
            "daily": daily, "history": archive, "keywords": keyword_report(path, now, state),
            "sync": {"enabled": enabled, "next_run": next_run(now) if enabled else None,
                     "stale": state.get("through", "") < due_target(now), "error": state.get("last_error", ""),
                     "schedule": "매일 10:30 (한국시간)", "target_date": due_target(now)},
            "notes": ["광고비는 부가세 포함이며 CTR·CPC는 합산 지표에서 계산합니다.",
                      "조회 가능한 캠페인 기준입니다. 수집 전에 삭제된 항목은 누락될 수 있습니다.",
                      "소재 합계는 삭제·확장소재 및 집계 반올림으로 캠페인 합계와 다를 수 있습니다.",
                      "상담·입소 전환은 추적되지 않아 클릭 효율만 비교합니다.",
                      "최근 7일은 매일 다시 조회해 지연 집계와 정정값을 반영합니다."]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sync", action="store_true")
    parser.add_argument("--export-seed", type=Path)
    args = parser.parse_args()
    path = db_path()
    init_db(path)
    if args.sync:
        try:
            sync(path, NaverClient(load_config()))
        except Exception as exc:
            raise SystemExit(f"Collection failed ({type(exc).__name__}); previous report retained") from None
        if not refresh_keywords(path, NaverClient(load_config()), datetime.now(KST)):
            raise SystemExit("Metrics updated; keyword refresh failed and its last good snapshot was retained")
    if args.export_seed:
        with connect(path) as db:
            data = {table: [list(row) for row in db.execute(f"SELECT * FROM {table}")] for table in ("entities", "metrics", "state")}
        args.export_seed.parent.mkdir(parents=True, exist_ok=True)
        args.export_seed.write_bytes(gzip.compress(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
