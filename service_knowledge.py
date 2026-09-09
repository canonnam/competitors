"""Read-only chat evidence from the dashboard's public, aggregated datasets.

No user-provided SQL, file paths, URLs, credentials, or transaction records enter
these adapters. Source collectors remain responsible for refreshing their data.
"""
from collections import defaultdict
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
import calendar
import hashlib
import json
import re
import sqlite3

ROOT = Path(__file__).resolve().parent
KST = timezone(timedelta(hours=9))
LABELS = {"competitors": "경쟁사 분석", "competitor_news": "경쟁사 뉴스", "operating": "더비다 운영분석"}
PAGES = {"competitors": "/competitors.html", "competitor_news": "/competitor-news.html", "operating": "/operating-costs.html"}
METRICS = {"revenue": "운영수입", "cost": "운영비용", "profit": "운영손익(입출금 기준)",
           "cashChange": "자금증감", "financing": "차입·원금상환 순액", "investment": "시설투자 순액"}
ALIASES = {"easy": ["이지케어", "이지엠소프트"], "carefor": ["케어포", "한강시스템"],
           "ecm": ["ecm", "누리뜰"], "angel": ["엔젤시스템", "엔젤"], "allcare": ["올케어"],
           "salary": ["케어샐러리"], "planner": ["케어플래너"], "well": ["웰파트너스"],
           "happy": ["행복커넥트"], "skt": ["누구오팔", "skt"], "maeum": ["마음손"],
           "aicareplus": ["아이케어플러스"], "caredoc": ["케어닥", "shos"],
           "cleverus": ["클레버러스", "비클레버", "be:clever"],
           "inzinious": ["인지니어스", "incare24"],
           "spacebank": ["스페이스뱅크", "aiot wright", "휴먼케어"]}


def compact(text):
    return re.sub(r"\s+", "", text.lower())


def load_json(name):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8"))


class RevenueParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.key, self.depth = {}, None, 0

    def handle_starttag(self, tag, attrs):
        identity = dict(attrs).get("id", "")
        if tag == "div" and identity.startswith("revenue-"):
            self.key, self.depth = identity[8:], 1
            self.rows[self.key] = []
        elif self.key:
            if tag == "div":
                self.depth += 1
            if tag in {"br", "p", "span"}:
                self.rows[self.key].append(" ")

    def handle_endtag(self, tag):
        if self.key and tag == "div":
            self.depth -= 1
            if not self.depth:
                self.key = None

    def handle_data(self, text):
        if self.key:
            self.rows[self.key].append(text)


def competitor_catalog():
    data = load_json("competitor_knowledge.json")
    source = (ROOT / "assets" / "competitors-data.js").read_text(encoding="utf-8")
    if data["sourceHash"] != hashlib.sha256(source.encode()).hexdigest():
        raise ValueError("Stale competitor export")
    parser = RevenueParser()
    parser.feed((ROOT / "competitors.html").read_text(encoding="utf-8"))
    for row in data["items"]:
        row["revenue"] = re.sub(r"\s+", " ", "".join(parser.rows.get(row["id"], []))).strip()
    return data["items"]


def matched_companies(question, catalog):
    q = compact(question)
    return [row for row in catalog if any(compact(name) in q for name in
        [row["name"].split(" / ")[0], *ALIASES.get(row["id"], [])])]


def evidence(kind, title, content, updated="", status="active", url=None):
    return {"kind": "service", "dataset": kind, "title": title, "content": content,
            "updated": updated, "status": status, "url": url or PAGES[kind], "sourceLabel": LABELS[kind]}


def unavailable(kind):
    return evidence(kind, LABELS[kind] + " 조회 상태", "해당 서비스 데이터를 현재 읽을 수 없습니다. 자료 없음이나 금액 0으로 해석하지 말고 조회 불가라고 안내하세요.", status="needs-review")


def tokens(text):
    return set(re.findall(r"[가-힣]{2,}|[a-z0-9]+", text.lower()))


def competitor_evidence(question, catalog, selected):
    q = compact(question)
    pricing = any(word in q for word in ("가격", "요금", "비용", "저렴", "이용료"))
    revenue = any(word in q for word in ("매출", "시장규모", "실적"))
    rows = selected or catalog
    if not selected or len(selected) > 6:
        # Overview rows retain every company; this avoids ranking a partial sample as the entire market.
        lines = []
        for row in rows:
            price = row["price50"]
            detail = f"50인 비교: {price['m']}; 적용 조건: {price['u']}" if pricing else f"{row['type']}; {row['note']}"
            if revenue:
                detail += "; 운영사 매출: " + row["revenue"]
            lines.append(f"{row['name']}: {detail}")
        return [evidence("competitors", f"경쟁사 {len(rows)}개 비교 ({'50인 가격' if pricing else '사업·기능'})",
            "서비스에 등록된 비교 자료이며 실시간 견적이 아닙니다. 50인 외 인원 가격은 환산하지 마세요. 과금 기준이 다른 상품은 단순 순위 비교할 수 없습니다.\n" + "\n".join(lines),
            max(row["price50"]["checked"] for row in rows))]
    result = []
    for row in rows[:6]:
        price = row["price50"]
        lines = [row["type"], *(f"{key}: {value}" for key, value in row["facts"]), "분석 메모: " + row["note"], "운영사 매출: " + row["revenue"]]
        lines.extend(f"{label}: {price[key]}" for key, label in
                     [("m", "50인 월 요금"), ("o", "초기 비용"), ("u", "적용 조건"), ("b", "산정 근거"), ("v", "검증 범위")])
        lines.append("조사 시점의 정보입니다. 매출은 각 회계연도 운영사 전체 기준이며 해당 서비스 단독 매출과 다릅니다. 가격은 50인 비교 조건에 한정하며 다른 인원·유형으로 임의 환산하지 않습니다.")
        result.append(evidence("competitors", row["name"] + " 기능·가격", "\n".join(lines), price["checked"]))
    return result


def shift_month(month, offset):
    year, m = map(int, month.split("-"))
    value = year * 12 + m - 1 + offset
    return f"{value // 12:04d}-{value % 12 + 1:02d}"


def month_span(start, end):
    if start > end:
        raise ValueError("Invalid period")
    result = [start]
    while result[-1] < end:
        if len(result) >= 60:
            raise ValueError("Period too long")
        result.append(shift_month(result[-1], 1))
    return result


def requested_months(question, today, available):
    """Calendar dates are resolved before the model sees any accounting totals."""
    q = compact(question)
    current = today.strftime("%Y-%m")
    year = today.year - (1 if "작년" in q or "지난해" in q else 0)
    years = sorted(set(int(y) for y in re.findall(r"(20\d{2})년?", q)))
    if years:
        year = years[0]
    short_range = re.search(r"(?<!\d)(\d{1,2})월?(?:~|∼|부터|-)(\d{1,2})월", q)
    if short_range:
        start, end = map(int, short_range.groups())
        if not 1 <= start <= end <= 12:
            raise ValueError("Invalid month range")
        return month_span(f"{year}-{start:02d}", f"{year}-{end:02d}")
    # ISO months and Korean months, including cross-year comparisons.
    normalized = re.sub(r"(20\d{2})년(\d{1,2})월", r"\1-\2월", q)
    explicit = re.findall(r"(20\d{2})[-./](\d{1,2})(?:월|(?=[^\d]|$))", normalized)
    if explicit:
        months = [f"{int(y):04d}-{int(m):02d}" for y, m in explicit]
        if any(not 1 <= int(m[-2:]) <= 12 for m in months):
            raise ValueError("Invalid month")
        if len(months) == 2 and any(x in q for x in ("부터", "까지", "~", "∼")):
            return month_span(months[0], months[1])
        trailing = [int(m) for m in re.findall(r"(?<!\d)(\d{1,2})월", q)]
        if len(explicit) == 1 and len(trailing) > 1:
            months = [f"{year}-{m:02d}" for m in trailing]
            if any(x in q for x in ("부터", "까지", "~", "∼")):
                return month_span(months[0], months[-1])
        return sorted(set(months))
    if "지난달" in q or "전월" in q and not any(x in q for x in ("대비", "비교")):
        return [shift_month(current, -1)]
    if "이번달" in q or "당월" in q:
        return [current]
    recent = re.search(r"최근(\d{1,2})개월", q)
    if recent:
        count = int(recent[1])
        if not 1 <= count <= 24:
            raise ValueError("Invalid duration")
        return month_span(shift_month(current, -count + 1), current)
    simple = [int(m) for m in re.findall(r"(?<!\d)(\d{1,2})월", q)]
    shorthand = re.search(r"(?<!\d)(\d{1,2})[~∼-](\d{1,2})월", q)
    if shorthand:
        simple = [int(shorthand[1]), int(shorthand[2])]
    if simple:
        if any(not 1 <= m <= 12 for m in simple):
            raise ValueError("Invalid month")
        months = [f"{year}-{m:02d}" for m in simple]
        if len(months) == 2 and any(x in q for x in ("부터", "까지", "~", "∼", "-")):
            return month_span(months[0], months[1])
        return sorted(set(months))
    quarter = re.search(r"([1-4])분기", q)
    if quarter or "상반기" in q or "하반기" in q:
        first, last = ((int(quarter[1]) - 1) * 3 + 1, int(quarter[1]) * 3) if quarter else ((1, 6) if "상반기" in q else (7, 12))
        return month_span(f"{year}-{first:02d}", f"{year}-{last:02d}")
    if years or any(x in q for x in ("올해", "금년", "작년", "지난해", "연간")):
        return [f"{y}-{m:02d}" for y in (years or [year]) for m in range(1, 13)]
    if any(x in q for x in ("전체기간", "누적", "월별", "추이")):
        return month_span(min(available), max(available))
    return [max(available)]


def amounts(row):
    return "; ".join(f"{label} {row[key]:,}원" for key, label in METRICS.items())


def account_totals(rows):
    totals = defaultdict(lambda: {"income": 0, "expense": 0})
    for row in rows:
        for account in row.get("accounts", []):
            for key in ("income", "expense"):
                totals[account["group"]][key] += account[key]
    return totals


def operating_evidence(question, today, period_question=None):
    report = load_json("operating_report.json")
    branches = report["branches"]
    available = sorted({m["month"] for b in branches for m in b["months"]})
    if not available:
        return [unavailable("operating")]
    try:
        months = requested_months(period_question or question, today, available)
    except ValueError:
        return [evidence("operating", "운영분석 조회 기간 확인", "조회 기간을 해석할 수 없습니다. 연도와 월 또는 시작·종료 월을 확인해주세요.")]
    selected = [b for b in branches if b["name"].replace("점", "") in question] or branches
    period = ", ".join(months) if len(months) <= 3 else f"{months[0]}~{months[-1]}"
    result = [evidence("operating", "운영분석 기준·조회 범위", f"기준일 {today.isoformat()}; 자료 갱신일 {report['sourceDate']}; 보유 월 {available[0]}~{available[-1]}; 요청 기간 {period}.\n"
        "단위 원(KRW). 운영손익은 실제 입출금 기준의 운영수입-운영비용이며 발생주의 순이익이 아닙니다. 차입·원금상환, 시설투자 등은 운영손익과 별도입니다. "
        "자료가 없는 월은 0원이 아니며 추정하지 않습니다. 수입 감소나 지출 증가는 관측 사실이지 입소율·인원 변동 등 미확인 원인을 증명하지 않습니다. "
        "직원·입소자 개인정보, 개별 급여와 거래 메모는 이 조회 대상에 없습니다.", report["sourceDate"])]
    sets = []
    for branch in selected:
        indexed = {m["month"]: m for m in branch["months"]}
        rows = [indexed[m] for m in months if m in indexed]
        missing = [m for m in months if m not in indexed]
        sets.append(indexed)
        lines = [f"대상 {branch['name']}; 요청 기간 {period}; 자료 없는 월: {', '.join(missing) or '없음'}"]
        lines.extend(f"{row['month']}: {amounts(row)}" for row in rows)
        if rows:
            totals = {key: sum(row[key] for row in rows) for key in METRICS}
            lines.append(f"보유 {len(rows)}개월 합계 (누락 월 제외): {amounts(totals)}")
            for year in sorted({row["month"][:4] for row in rows}):
                annual = [row for row in rows if row["month"].startswith(year)]
                lines.append(f"{year}년 조회 범위 내 보유 {len(annual)}개월 합계: " + amounts({k: sum(r[k] for r in annual) for k in METRICS}))
            for group, values in account_totals(rows).items():
                lines.append(f"계정군 합계 {group}: 수입 {values['income']:,}원; 비용 {values['expense']:,}원")
            if any(word in question for word in ("계정", "직접비", "간접비", "급여", "식재료", "생계비", "퇴직", "보험")):
                accounts = defaultdict(lambda: {"income": 0, "expense": 0})
                for row in rows:
                    for account in row.get("accounts", []):
                        for key in ("income", "expense"):
                            accounts[account["account"]][key] += account[key]
                lines.extend(f"세부 계정 {name}: 수입 {values['income']:,}원; 비용 {values['expense']:,}원" for name, values in accounts.items())
            if len(rows) == 2:
                lines.append(f"두 조회 월 증감 ({rows[-1]['month']}-{rows[0]['month']}): " + amounts({k: rows[-1][k] - rows[0][k] for k in METRICS}))
            for row in rows:
                lines.extend(f"{row['month']} 주의사항: {f['message']}" for f in row.get("flags", []))
            if len(rows) == 1:
                current = rows[0]
                previous = indexed.get(shift_month(current["month"], -1))
                if previous:
                    lines.append(f"비교 전월 {previous['month']}: {amounts(previous)}")
                    lines.append("전월 대비 증감 (당월-전월): " + amounts({k: current[k] - previous[k] for k in METRICS}))
                    before, after = account_totals([previous]), account_totals([current])
                    changes = []
                    for group in before.keys() | after.keys():
                        for key, label, sign in [("income", "수입", 1), ("expense", "비용", -1)]:
                            delta = after[group][key] - before[group][key]
                            if delta:
                                changes.append((abs(delta), f"{group} {label} 증감 {delta:,}원; 손익 영향 {delta * sign:,}원"))
                    lines.extend(text for _, text in sorted(changes, reverse=True)[:8])
                else:
                    lines.append("직전 달 자료가 없어 전월 대비 계산 불가.")
        result.append(evidence("operating", f"더비다 {branch['name']} {period}", "\n".join(lines), report["sourceDate"]))
    if len(sets) == 2:
        common = [m for m in months if all(m in s for s in sets)]
        lines = ["두 지점 자료가 모두 있는 동일 월만 합산·비교합니다.", "합산 불가 월: " + (", ".join(m for m in months if m not in common) or "없음")]
        for month in common:
            lines.append(f"{month} 두 지점 합계: " + amounts({k: sum(s[month][k] for s in sets) for k in METRICS}))
        if common:
            lines.append("공통 월 전체 합계: " + amounts({k: sum(s[m][k] for s in sets for m in common) for k in METRICS}))
            lines.append(f"공통 월 지점 차이 ({selected[0]['name']}-{selected[1]['name']}): " + amounts({k: sum(sets[0][m][k] - sets[1][m][k] for m in common) for k in METRICS}))
        result.append(evidence("operating", "더비다 지점 합산·비교", "\n".join(lines), report["sourceDate"]))
    return result


def news_evidence(question, selected, today):
    # Use the collector's path contract, but never initialize or sync from a chat query.
    import competitor_news
    path = competitor_news.db_path()
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=3)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        records = competitor_news.active_articles(db)
        state = {r[0]: json.loads(r[1]) for r in db.execute("SELECT key,value FROM state")}
    ids = {row["id"] for row in selected}
    if ids:
        records = [row for row in records if row.get("competitor_id") in ids]
    q = compact(question)
    start, end = None, today
    if "오늘" in q:
        start = today
    elif "어제" in q:
        start = end = today - timedelta(days=1)
    elif "최근" in q and (match := re.search(r"최근(\d{1,3})일", q)):
        start = today - timedelta(days=max(1, min(int(match[1]), 366)) - 1)
    elif "이번주" in q:
        start = today - timedelta(days=today.weekday())
    elif "지난주" in q:
        end = today - timedelta(days=today.weekday() + 1)
        start = end - timedelta(days=6)
    elif re.search(r"\d월|\d분기|상반기|하반기|이번달|지난달|올해|작년|20\d{2}|최근\d+개월", q):
        periods = requested_months(question, today, [today.strftime("%Y-%m")])
        start = date.fromisoformat(periods[0] + "-01")
        y, m = map(int, periods[-1].split("-"))
        end = min(today, date(y, m, calendar.monthrange(y, m)[1]))
        records = [r for r in records if r.get("published_at", "")[:7] in periods]
    records = [r for r in records if (not start or r.get("published_at", "")[:10] >= start.isoformat()) and r.get("published_at", "")[:10] <= end.isoformat()]
    count = len(records)
    # Retain recency for general questions; specific topics may reorder the shortlist.
    ignore = {"경쟁사", "뉴스", "소식", "최근", "최신", "알려주세요", "요약", "동향", "관련", "기사", "보도"}
    keywords = {word for word in tokens(question) - ignore if not word.isdigit()}
    ranked = sorted(enumerate(records), key=lambda pair: (-sum(word in (pair[1].get("title", "") + " " + pair[1].get("summary", "")).lower() for word in keywords), pair[0]))
    limit_match = re.search(r"(\d{1,2})\s*(?:개|건)", question)
    limit = min(6, max(1, int(limit_match[1]))) if limit_match else 5
    updated = str(state.get("last_success") or "수집 성공 시각 미확인")
    header = f"조회일 {today.isoformat()}; 저장된 기사 중 {' / '.join(r['name'] for r in selected) or '전체 경쟁사'}; 게시일 범위 {start or '전체'}~{end}; 범위 내 {count}건 중 최대 {limit}건 발췌. "
    header += f"마지막 수집 성공 {updated}. 수집 장애 여부: {'있음' if state.get('errors') else '기록된 오류 없음'}. 인터넷 전체를 실시간 검색한 결과가 아닙니다. "
    header += "아래 발췌 밖의 내용을 추정하지 마세요. 기사 제목만 있으면 제목 수준의 소식으로 표시하고, 회사 발표·계획을 검증된 성과로 바꾸지 마세요."
    result = [evidence("competitor_news", "경쟁사 뉴스 조회 범위", header, updated)]
    for _, row in ranked[:limit]:
        content = f"경쟁사: {row.get('competitor', '')}\n기사 게시일(실제 사건일이 아님): {row.get('published_at', '')}\n출처: {row.get('source', '')}\n제목: {row['title']}\n"
        content += "검토된 요약: " + row["summary"] if row.get("summary") and row.get("reviewed") else "제목만 수집됨. 기사 본문 및 세부 내용은 미확인."
        item = evidence("competitor_news", row["title"], content, row.get("published_at", ""),
                        "active" if row.get("reviewed") else "needs-review", safe_url(row.get("url")) or PAGES["competitor_news"])
        item["newsSummary"] = row["summary"] if row.get("summary") and row.get("reviewed") else "제목만 수집된 기사로, 본문 내용은 확인되지 않았습니다."
        result.append(item)
    return result


def news_list_answer(question, items):
    """Preserve reviewed wording for news listings: plans must not become events."""
    if not items or any(r.get("dataset") != "competitor_news" for r in items):
        return None
    if any(word in compact(question) for word in ("분석", "영향", "전략", "왜", "비교", "원인", "의미", "가격", "기능", "자세", "본문", "전망", "가산", "법규")):
        return None
    if items[0]["status"] == "needs-review":
        return None
    def plain(text):
        return re.sub(r"([\\`*_{}\[\]<>#])", r"\\\1", str(text))
    scope = items[0]["content"].split("아래 발췌", 1)[0]
    lines = [plain(scope) + f" [{items[0]['number']}]"]
    for item in items[1:]:
        lines.append(f"**{plain(item['title'])}**\n\n게시일: {plain(item['updated'][:10])}\n\n{plain(item['newsSummary'])} [{item['number']}]")
    if len(items) == 1:
        lines.append("이 범위에 해당하는 저장된 기사가 없습니다. 인터넷 전체에 관련 보도가 없다는 뜻은 아닙니다.")
    return "\n\n".join(lines)


def safe_url(value):
    from urllib.parse import urlsplit
    if not isinstance(value, str) or len(value) > 3000 or re.search(r"[\s\\\x00-\x1f]", value):
        return None
    if value in PAGES.values():
        return value
    try:
        parsed = urlsplit(value)
        return value if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password else None
    except ValueError:
        return None


def retrieve(question, history=None, today=None):
    today = today or datetime.now(KST).date()
    q = compact(question)
    try:
        catalog = competitor_catalog()
    except (OSError, ValueError, KeyError):
        catalog = []
    selected = matched_companies(question, catalog)
    is_news = any(x in q for x in ("뉴스", "소식", "기사", "보도", "동향"))
    is_operating = any(x in q for x in ("운영분석", "운영비", "운영수입", "운영손익", "현금흐름", "안양", "인천")) or (
        any(x in q for x in ("더비다", "우리", "저희")) and any(x in q for x in ("매출", "손익", "비용", "수입", "이익", "실적", "지출", "인건비", "식비", "적자", "흑자", "월", "분기", "상반기", "하반기", "누적")))
    is_competitor = bool(selected) or "경쟁사" in q or "erp" in q or any(compact(a) in q for values in ALIASES.values() for a in values)
    prior_turns = [m["content"] for m in reversed(history or []) if m["role"] == "user"]
    if not (is_news or is_operating or is_competitor) and any(x in q for x in ("그럼", "그러면", "전월", "지난달", "이번달", "비교", "차이", "얼마", "월은", "월도")):
        prior = next((text for text in prior_turns if any(x in compact(text) for x in ("더비다", "안양", "인천", "운영", "경쟁사", "뉴스", "소식", "기사")) or matched_companies(text, catalog)), "")
        if prior:
            # Use prior turns only to infer domain/company, never old dates or old assistant claims.
            previous = compact(prior)
            selected = matched_companies(prior, catalog)
            is_operating = any(x in previous for x in ("더비다", "안양", "인천", "운영손익", "운영분석"))
            is_news = any(x in previous for x in ("뉴스", "소식", "기사"))
            is_competitor = bool(selected) or "경쟁사" in previous
            if is_operating:
                question += " " + " ".join(x for x in ("안양", "인천") if x in previous)
    if selected and not is_news and not any(x in q for x in ("가격", "기능", "요금", "매출", "erp")) and prior_turns:
        is_news = any(x in compact(prior_turns[0]) for x in ("뉴스", "소식", "기사"))
    period_question = None
    if is_operating and any(x in q for x in ("전월대비", "전월과", "전달과")) and not re.search(r"\d월|20\d{2}|지난달|이번달", q):
        period_question = next((text for text in prior_turns if re.search(r"\d월|20\d{2}|지난달|이번달", compact(text))), None)
    result = []
    if is_operating:
        try:
            result.extend(operating_evidence(question, today, period_question))
        except (OSError, ValueError, KeyError, TypeError):
            result.append(unavailable("operating"))
    if is_news:
        try:
            result.extend(news_evidence(question, selected, today))
        except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
            result.append(unavailable("competitor_news"))
    if is_competitor and (not is_news or any(x in q for x in ("가격", "기능", "비교", "요금"))):
        result.extend(competitor_evidence(question, catalog, selected) if catalog else [unavailable("competitors")])
    return result


def status():
    import competitor_news
    paths = {"competitors": ROOT / "data/competitor_knowledge.json", "operating": ROOT / "data/operating_report.json",
             "competitor_news": competitor_news.db_path()}
    return [{"id": key, "label": label, "available": paths[key].is_file()} for key, label in LABELS.items()]
