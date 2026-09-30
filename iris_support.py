"""Collect relevant, currently open IRIS research announcements."""
from __future__ import annotations

from datetime import date, datetime, time
import hashlib
import json
import re
import urllib.parse
import urllib.request

import business_support
from agency_news import BoardRedirect, Document, KST, MAX_BYTES, checked_url, fetch_html, matches

LIST_URL = 'https://www.iris.go.kr/contents/retrieveBsnsAncmBtinSituList.do'
DETAIL_URL = 'https://www.iris.go.kr/contents/retrieveBsnsAncmView.do'
MAX_PAGES = 100
BOOTSTRAP_PAGES = 10
POLICY_REVISION = '2026-09-30-iris-agetech'
# The title is the project's scope. A broad AX call can include an energy RFP
# without making the entire call an energy-only announcement.
OUT_OF_SCOPE_TITLES = (
    '우주', '양자', '태양광', '재생에너지', '전력정보화', '소재부품',
    '자율주행', '모빌리티', '국방', '방산', '원전', '첨단재생의료',
)


def detail_url(identity):
    if not re.fullmatch(r'\d{1,12}', str(identity)):
        raise ValueError('Unexpected IRIS announcement identifier')
    return DETAIL_URL + '?' + urllib.parse.urlencode({'ancmId': identity, 'ancmPrg': ''})


def fetch_page(page):
    if not isinstance(page, int) or not 1 <= page <= MAX_PAGES:
        raise ValueError('Unexpected IRIS page')
    body = urllib.parse.urlencode({'ancmPrg': 'ancmIng', 'pageIndex': page}).encode('ascii')
    request = urllib.request.Request(checked_url(LIST_URL), data=body, headers={
        'User-Agent': 'TheVidaKnowledgeBase/1.0 (daily public board reader)',
        'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'})
    with urllib.request.build_opener(BoardRedirect()).open(request, timeout=20) as response:
        raw = response.read(MAX_BYTES+1)
    if len(raw) > MAX_BYTES:
        raise ValueError('IRIS list response too large')
    return json.loads(raw.decode('utf-8'))


def iso_date(value):
    return date.fromisoformat(str(value).strip().replace('.', '-')).isoformat()


def parse_page(payload, page, source):
    if not isinstance(payload, dict) or payload.get('ancmPrg') != 'ancmIng':
        raise ValueError('Unexpected IRIS list response')
    pagination = payload.get('paginationInfo')
    rows = payload.get('listBsnsAncmBtinSitu')
    if not isinstance(pagination, dict) or not isinstance(rows, list):
        raise ValueError('Incomplete IRIS list response')
    pages = pagination.get('totalPageCount')
    if pagination.get('currentPageNo') != page or not isinstance(pages, int) or not 0 <= pages <= MAX_PAGES:
        raise ValueError('Unexpected IRIS pagination')
    selected = []
    for row in rows:
        identity = str(row.get('ancmId', ''))
        title = row.get('ancmTl', '')
        if not re.fullmatch(r'\d{1,12}', identity) or not isinstance(title, str) or not title.strip():
            raise ValueError('Incomplete IRIS announcement')
        published = iso_date(row.get('ancmDe'))
        start = iso_date(row.get('rcveStrDe'))
        end = iso_date(row.get('rcveEndDe'))
        selected.append({
            'id': source['id'] + ':' + identity, 'title': title.strip(),
            'url': detail_url(identity), 'published_at': published,
            'application_period': start + ' ~ ' + end,
            'department': str(row.get('blngGovdSeNm') or ''),
            'operator': str(row.get('sorgnNm') or ''),
            'source_id': source['id'], 'source': source['name'],
            'agency': source['agency'], 'kind': 'support', 'pinned': False,
        })
    if pages and not selected:
        raise ValueError('IRIS list is unexpectedly empty')
    return selected, pages


def parse_detail(html):
    root = Document(html).root
    fields = {}
    for item in root.all('li'):
        if not item.has_class('write'):
            continue
        label = next((node for node in item.children if getattr(node, 'tag', '') == 'strong'), None)
        value = next((node for node in item.children if getattr(node, 'tag', '') == 'span'), None)
        if label is not None and value is not None:
            fields[label.text()] = value.text()
    body = next((node.text() for node in root.all('div') if node.has_class('se-contents')), '')
    if not fields.get('공고명') or not fields.get('접수기간') or not body:
        raise ValueError('Incomplete IRIS announcement detail')
    return {'title': fields['공고명'], 'application_period': fields['접수기간'],
            'overview': body, 'department': fields.get('소관부처', ''),
            'operator': fields.get('전문기관', '')}


def deadline_at(period, body):
    end = business_support.period_status(period, date.max)['deadline']
    if end is None:
        return None
    match = re.search(r'(?:마감일|마감시간)\s*(\d{1,2})\s*시', body)
    if match:
        hour = int(match.group(1))
    else:
        match = re.search(r'(?:전산접수기간|접수기간).{0,160}?오후\s*(\d{1,2})\s*시', body)
        hour = int(match.group(1)) + 12 if match and int(match.group(1)) < 12 else None
    if hour is None or not 0 <= hour <= 23:
        return None
    return datetime.combine(date.fromisoformat(end), time(hour, tzinfo=KST)).isoformat()


def period_status(item, now):
    result = business_support.period_status(item['application_period'], now.date())
    deadline = item.get('deadline_at')
    if deadline and now >= datetime.fromisoformat(deadline):
        result.update(active=False, label='마감', days_left=0)
    return result


def assess(row, detail, now):
    title = detail['title']
    if matches(title, OUT_OF_SCOPE_TITLES) and not matches(title, business_support.CARE + business_support.AGE_TECH):
        return None
    # IRIS has a broad program notice and separate RFPs. Its body is not a
    # structured applicant/benefit field, so do not infer eligibility from it.
    age_tech_hint = '에이지테크' if matches(detail['overview'][:3000], business_support.AGE_TECH) else ''
    candidate = business_support.assess(
        row, {'title': title, 'target': age_tech_hint, 'benefit': '',
              'overview': detail['overview'][:3000],
              'application_period': detail['application_period']}, now.date())
    if candidate is None:
        return None
    candidate.update(
        target='과제별 신청 자격은 IRIS 공고문과 제안요청서(RFP)에서 확인',
        benefit=detail['overview'][:600],
        match_basis='IRIS 공고명·본문',
        deadline_at=deadline_at(detail['application_period'], detail['overview']),
    )
    candidate['application_status'] = period_status(
        {**row, **candidate, 'application_period': detail['application_period']}, now)
    candidate['checks'].insert(0, '통합 공고에 분야가 여러 개일 수 있습니다. 해당 과제의 RFP와 주관·공동연구기관 자격을 따로 확인하세요.')
    return candidate


def fingerprint(row):
    fields = [row['title'], row['published_at'], row['application_period']]
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False).encode('utf-8')).hexdigest()


def collect(source, seen, now, list_fetcher=fetch_page, detail_fetcher=fetch_html,
            stop=None, review=False, archive=()):
    selected, scanned = {}, {}

    def consider(row):
        detail = parse_detail(detail_fetcher(row['url']))
        row = {**row, 'title': detail['title'], 'department': detail['department'] or row['department'],
               'operator': detail['operator'] or row['operator']}
        match = assess(row, detail, now)
        if match:
            row.update(match, application_period=detail['application_period'],
                       withdrawn=False, collected_at=now.isoformat(), first_seen_at=now.isoformat())
            selected[row['id']] = row
        elif row['id'] in seen or row.get('collected_at'):
            row.update(withdrawn=True, application_period=detail['application_period'],
                       collected_at=now.isoformat())
            selected[row['id']] = row
        if stop and stop.wait(0.15):
            raise InterruptedError()

    for page in range(1, MAX_PAGES+1):
        if stop and stop.is_set():
            raise InterruptedError()
        rows, pages = parse_page(list_fetcher(page), page, source)
        reached_seen = bool(rows) and all(row['id'] in seen for row in rows)
        for row in rows:
            if row['published_at'] > now.date().isoformat() or row['id'] in scanned:
                continue
            signature = fingerprint(row)
            scanned[row['id']] = signature
            if not review and seen.get(row['id']) == signature:
                continue
            consider(row)
        if pages == 0 or page >= pages or (not seen and page >= BOOTSTRAP_PAGES) or (
                seen and page >= (BOOTSTRAP_PAGES if review else 2) and reached_seen):
            for old in archive if review else ():
                if old['id'] not in scanned:
                    consider(old)
            return list(selected.values()), scanned
    raise ValueError('IRIS pagination limit reached before previous records; retry required')
