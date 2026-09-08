"""Read NHIS/MOHW boards and relevant Bizinfo announcements daily."""
from __future__ import annotations

import argparse
from datetime import date, datetime, time as day_time, timedelta
import hashlib
from html.parser import HTMLParser
import json
import logging
import os
from pathlib import Path
import re
import threading
import urllib.parse
import urllib.request

from competitor_news import KST, connect, normalized, timestamp

ROOT = Path(__file__).resolve().parent
SOURCES = json.loads((ROOT / 'data/agency_news_sources.json').read_text(encoding='utf-8'))
SCHEDULE = '매일 09:10 (한국시간)'
MAX_PAGES = 40
BOOTSTRAP_PAGES = 2
MAX_BYTES = 2_000_000
LOG = logging.getLogger('agency_news')
SYNC_LOCK = threading.Lock()
ALLOWED_HOSTS = {'www.longtermcare.or.kr', 'www.mohw.go.kr', 'www.bizinfo.go.kr'}


class Node:
    def __init__(self, tag='', attrs=None):
        self.tag, self.attrs, self.children = tag, dict(attrs or []), []

    def all(self, tag=None):
        for child in self.children:
            if isinstance(child, Node):
                if tag is None or child.tag == tag:
                    yield child
                yield from child.all(tag)

    def text(self):
        if self.tag in {'script', 'style', 'noscript'} or {'sr_only', 'sr-only'} & set(self.attrs.get('class', '').split()):
            return ''
        return re.sub(r'\s+', ' ', ' '.join(child.text() if isinstance(child, Node) else child for child in self.children)).strip()

    def has_class(self, name):
        return name in self.attrs.get('class', '').split()


class Document(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        # The NHIS pinned-row markup contains <td ... /> followed by </td>.
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        for index in range(len(self.stack)-1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def checked_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc not in ALLOWED_HOSTS:
        raise ValueError('Unexpected board destination')
    return url


class BoardRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        checked_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch_html(url):
    request = urllib.request.Request(checked_url(url), headers={
        'User-Agent': 'TheVidaKnowledgeBase/1.0 (daily public board reader)', 'Accept': 'text/html'})
    with urllib.request.build_opener(BoardRedirect()).open(request, timeout=20) as response:
        raw = response.read(MAX_BYTES+1)
        charset = response.headers.get_content_charset() or 'utf-8'
    if len(raw) > MAX_BYTES:
        raise ValueError('Board response too large')
    return raw.decode(charset)


def listing_url(source):
    if source['kind'] == 'mohw':
        return source['url']
    return 'https://www.longtermcare.or.kr/npbs/cms/board/board/Board.jsp?' + urllib.parse.urlencode({
        'communityKey': source['board'], 'act': 'LIST', 'pageNum': 1, 'pageSize': 10})


def valid_post_url(href, source, base):
    url = checked_url(urllib.parse.urljoin(base, href))
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query)
    if source['kind'] == 'nhis':
        if parsed.netloc != 'www.longtermcare.or.kr' or parsed.path != '/npbs/cms/board/board/Board.jsp' or query.get('communityKey') != [source['board']] or query.get('act') != ['VIEW']:
            raise ValueError('Unexpected NHIS post link')
        post_id = query.get('boardId', [''])[0]
        keep = {'communityKey': source['board'], 'boardId': post_id, 'act': 'VIEW'}
    else:
        if parsed.netloc != 'www.mohw.go.kr' or parsed.path != '/board.es' or query.get('bid') != [source['board']] or query.get('act') != ['view']:
            raise ValueError('Unexpected MOHW post link')
        post_id = query.get('list_no', [''])[0]
        keep = {'mid': urllib.parse.parse_qs(urllib.parse.urlsplit(source['url']).query)['mid'][0],
                'bid': source['board'], 'act': 'view', 'list_no': post_id}
    if not post_id.isdigit():
        raise ValueError('Missing post identifier')
    return source['id'] + ':' + post_id, urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(keep), ''))


def parse_list(html, source, base):
    root = Document(html).root
    rows = []
    for row in root.all('tr'):
        cells = list(row.all('td'))
        title_cell = next((cell for cell in cells if cell.attrs.get('headers') == 'board_title' or cell.attrs.get('data-label') == '제목'), None)
        if title_cell is None:
            continue
        link = next((a for a in title_cell.all('a') if 'boardId=' in a.attrs.get('href', '') or 'list_no=' in a.attrs.get('href', '')), None)
        date_cell = next((cell for cell in cells if cell.attrs.get('headers') == 'board_create' or cell.attrs.get('data-label') == '등록일'), None)
        if link is None or date_cell is None:
            raise ValueError('Incomplete board row')
        identity, url = valid_post_url(link.attrs['href'], source, base)
        published = date.fromisoformat(date_cell.text()[:10]).isoformat()
        title = title_cell.attrs.get('title', '').strip() or link.text()
        if not title:
            raise ValueError('Missing post title')
        pinned = any(node.has_class('noti') or node.has_class('notice') for node in row.all()) or any(cell.text() == '공지' for cell in cells)
        department = next((cell.text() for cell in cells if cell.attrs.get('headers') in {'board_branch', 'board_korname'} or cell.attrs.get('data-label') == '담당부서'), '')
        rows.append({'id': identity, 'url': url, 'title': title, 'published_at': published,
                     'pinned': pinned, 'department': department, 'source_id': source['id'],
                     'source': source['name'], 'agency': source['agency']})
    if not rows:
        raise ValueError('No board rows found; previous records retained')
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(base).query)
    page_key = 'pageNum' if source['kind'] == 'nhis' else 'nPage'
    current_page = int(query.get(page_key, ['1'])[0])
    next_url = None
    for link in root.all('a'):
        href = link.attrs.get('href', '')
        parsed = urllib.parse.urlsplit(urllib.parse.urljoin(base, href))
        params = urllib.parse.parse_qs(parsed.query)
        if params.get(page_key) != [str(current_page+1)] or params.get('act', ['LIST'])[0].lower() == 'view':
            continue
        board_key = 'communityKey' if source['kind'] == 'nhis' else 'bid'
        if parsed.netloc == urllib.parse.urlsplit(base).netloc and parsed.path == urllib.parse.urlsplit(base).path and params.get(board_key) == [source['board']]:
            next_url = checked_url(urllib.parse.urlunsplit(parsed))
            break
    return rows, next_url


def mohw_detail(html):
    root = Document(html).root
    view = next((node for node in root.all('article') if node.has_class('board_view')), None)
    if view is None:
        raise ValueError('Missing MOHW article')
    heading = next((node for node in view.all('h2') if node.has_class('title')), None)
    content = next((node for node in view.all('div') if node.has_class('contents')), None)
    if heading is None or content is None:
        raise ValueError('Incomplete MOHW article')
    return heading.text(), content.text()


CARE_TERMS = ('장기요양', '노인요양', '요양원', '요양시설', '노인의료복지시설', '시설급여', '재가급여',
              '요양보호사', '통합돌봄', '노인돌봄', '지역돌봄', '방문요양', '방문간호', '주야간보호',
              '치매', '고령친화', '복지용구', '노인학대', '사회복지시설', '요양병원')


def matches(text, terms):
    value = normalized(text)
    return any(bool(re.search(r'(?<![a-z])' + re.escape(term) + r'(?![a-z])', text, re.I))
               if term.isascii() and term.isalpha() else normalized(term) in value for term in terms)


def relevance(title, body, source):
    # Dedicated long-term-care boards already define the relevant subject area.
    basis = '게시판' if source.get('topic') else ''
    if not basis and not matches(title, CARE_TERMS) and matches(title, ('아동학대', '아동수당', '어린이집', '노숙인', '국민연금', '기념식', '정부포상', '임용시험')):
        return [], ''
    if not basis and source['kind'] == 'nhis' and matches(title, ('감염관리', '낙상예방', '안전관리', '급식위생')):
        basis = '제목'
    if not basis:
        for text, label in ((title, '제목'), (body, '본문')):
            terms = CARE_TERMS if label == '제목' else tuple(term for term in CARE_TERMS if term != '요양병원')
            if matches(text, terms) or (label == '제목' and matches(text, ('돌봄', '시니어')) and matches(text, ('기업', '기술', '디지털', '로봇', 'AI', '사회서비스'))):
                basis = label
                break
    if not basis:
        return [], ''
    text = title + ' ' + (body if basis == '본문' else '')
    topics = [source['topic']] if source.get('topic') else []
    for label, terms in [
        ('평가·점검', ('평가', '점검', '현지조사')),
        ('인력·교육', ('요양보호사', '종사자', '교육', '인력', '보수교육')),
        ('수가·청구·회계', ('수가', '급여비용', '청구', '재무', '회계', '본인부담')),
        ('돌봄 정책', ('통합돌봄', '노인돌봄', '치매', '노인학대', '재가서비스')),
        ('돌봄 기술·사업', ('기술', '디지털', '로봇', 'AI', '투자', '시범사업')),
        ('안전·건강', ('안전', '낙상', '감염', 'CCTV', '폐쇄회로'))]:
        if matches(text, terms) and label not in topics:
            topics.append(label)
    return topics or ['장기요양·기관 운영'], basis


def fingerprint(item):
    return hashlib.sha256((item['title'] + item['published_at']).encode()).hexdigest()


def collect(source, seen, now, fetcher=fetch_html, stop=None):
    if source['kind'] == 'bizinfo':
        import business_support
        return business_support.collect(source, seen, now, fetcher, stop)
    url = listing_url(source)
    selected, scanned = {}, {}
    cutoff = (now - timedelta(days=90)).date().isoformat()
    for page in range(1, MAX_PAGES+1):
        if stop and stop.is_set():
            raise InterruptedError()
        rows, following = parse_list(fetcher(url), source, url)
        reached_seen = any(not row['pinned'] and row['id'] in seen for row in rows)
        for row in rows:
            if row['published_at'] > now.date().isoformat() or row['id'] in scanned:
                continue
            signature = fingerprint(row)
            scanned[row['id']] = signature
            if seen.get(row['id']) == signature:
                continue
            # Bootstrap recent posts and pinned guidance; subsequent runs collect every new post.
            if not seen and row['published_at'] < cutoff and not row['pinned']:
                continue
            body = ''
            if source['kind'] == 'mohw':
                row['title'], body = mohw_detail(fetcher(row['url']))
            topics, basis = relevance(row['title'], body, source)
            if topics:
                row.update(topics=topics, match_basis=basis, collected_at=now.isoformat())
                selected[row['id']] = row
            if stop and stop.wait(0.15):
                raise InterruptedError()
        if not following or (not seen and page >= BOOTSTRAP_PAGES) or (seen and reached_seen):
            return list(selected.values()), scanned
        url = following
    raise ValueError('Pagination limit reached before previous records; retry required')


def db_path():
    return Path(os.getenv('AGENCY_NEWS_DB_PATH', '/data/agency-news.db'))


def enabled():
    return os.getenv('AGENCY_NEWS_SYNC_ENABLED', 'true').lower() not in {'0', 'false', 'no'}


def init_db(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS articles(id TEXT PRIMARY KEY, published_at TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS seen(source_id TEXT NOT NULL, id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(source_id,id));
            CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS agency_date ON articles(published_at DESC);
        ''')


def due_at(now):
    today = datetime.combine(now.astimezone(KST).date(), day_time(9, 10), KST)
    return today if now >= today else today-timedelta(days=1)


def policy_revision(source):
    if source and source['kind'] == 'bizinfo':
        import business_support
        return business_support.POLICY_REVISION
    return None


def next_run(state, now, source=None):
    if state.get('error') and state.get('last_attempt'):
        return timestamp(state['last_attempt']) + timedelta(minutes=30)
    revision = policy_revision(source)
    if revision and state.get('policy_revision') != revision:
        return now
    last = timestamp(state.get('last_success'))
    return now if last is None or last < due_at(now) else due_at(now)+timedelta(days=1)


def states(db):
    return {row['id']: json.loads(row['payload']) for row in db.execute('SELECT * FROM sources')}


def sync(path, now=None, fetcher=fetch_html, sources=None, stop=None, force=True):
    now = now or datetime.now(KST)
    if not SYNC_LOCK.acquire(blocking=False):
        return None
    results = []
    try:
        for source in SOURCES if sources is None else sources:
            if stop and stop.is_set():
                break
            with connect(path) as db:
                state = states(db).get(source['id'], {})
                seen = {row['id']: row['signature'] for row in db.execute('SELECT id,signature FROM seen WHERE source_id=?', (source['id'],))}
                revision = policy_revision(source)
                review = bool(revision and state.get('policy_revision') != revision)
                archive = [json.loads(row[0]) for row in db.execute('SELECT payload FROM articles')] if review else []
                archive = [item for item in archive if item.get('source_id') == source['id']]
            if not force and now < next_run(state, now, source):
                continue
            state = {**state, 'last_attempt': now.isoformat(), 'error': '', 'last_added': 0}
            try:
                if revision:
                    import business_support
                    items, scanned = business_support.collect(source, seen, now, fetcher, stop, review=review, archive=archive)
                else:
                    items, scanned = collect(source, seen, now, fetcher, stop)
                added = 0
                with connect(path) as db:
                    for item in items:
                        exists = db.execute('SELECT payload FROM articles WHERE id=?', (item['id'],)).fetchone()
                        if item.get('withdrawn'):
                            if not exists:
                                continue
                            item = {**json.loads(exists[0]), **item,
                                    'recommendation': '추천 제외 · 현재 기준 미충족',
                                    'reasons': ['현재 회사 조건·추천 기준 또는 접수기간에 해당하지 않아 추천에서 제외했습니다.'],
                                    'checks': ['소재지, 사업 분야와 신청 조건은 원문에서 확인해주세요.']}
                        if exists and item.get('kind') == 'support':
                            previous = json.loads(exists[0])
                            item['first_seen_at'] = previous.get('first_seen_at', previous['collected_at'])
                        added += int(not exists)
                        db.execute('INSERT OR REPLACE INTO articles VALUES(?,?,?)',
                                   (item['id'], item['published_at'], json.dumps(item, ensure_ascii=False)))
                    db.executemany('INSERT OR REPLACE INTO seen VALUES(?,?,?)',
                                   [(source['id'], identity, signature) for identity, signature in scanned.items()])
                    completed = {**state, 'last_success': now.isoformat(), 'checked_posts': len(scanned), 'last_added': added}
                    if revision:
                        completed['policy_revision'] = revision
                    db.execute('INSERT OR REPLACE INTO sources VALUES(?,?)', (source['id'], json.dumps(completed)))
                state = completed
            except InterruptedError:
                break
            except Exception:
                LOG.exception('Board collection failed: %s', source['id'])
                state['error'] = '게시판 수집 지연 · 30분 후 재시도'
                with connect(path) as db:
                    db.execute('INSERT OR REPLACE INTO sources VALUES(?,?)', (source['id'], json.dumps(state)))
            results.append({'source': source['id'], **state})
        return results
    finally:
        SYNC_LOCK.release()


def report(path, now=None, summary=False):
    now = now or datetime.now(KST)
    with connect(path) as db:
        saved = states(db)
        total = db.execute('SELECT COUNT(*) FROM articles').fetchone()[0]
        latest = db.execute('SELECT MAX(published_at) FROM articles').fetchone()[0]
        items = [json.loads(row[0]) for row in db.execute('SELECT payload FROM articles ORDER BY published_at DESC,id DESC')]
    import business_support
    supports = []
    for item in items:
        if item.get('kind') == 'support':
            item['application_status'] = business_support.period_status(item['application_period'], now.date())
            if item.get('withdrawn'):
                item['application_status'].update(active=False, label='추천 제외')
            supports.append(item)
    source_status = []
    for source in SOURCES:
        state = saved.get(source['id'], {})
        last = timestamp(state.get('last_success'))
        revision = policy_revision(source)
        source_status.append({**source, **state, 'stale': last is None or last < due_at(now) or bool(revision and state.get('policy_revision') != revision),
                              'next_run': next_run(state, now, source).isoformat() if enabled() else None})
    successes = [row.get('last_success') for row in source_status]
    updated = min(successes) if all(successes) else None
    result = {'total': total, 'latest_published_at': latest, 'updated_at': updated, 'sources': source_status,
              'article_ids': [item['id'] for item in items if item.get('kind') != 'support' or item['application_status']['active']],
              'support': {'total': len(supports), 'active': sum(item['application_status']['active'] for item in supports),
                          'items': [{'id': item['id'], 'first_seen_at': item.get('first_seen_at', item['collected_at']),
                                     'active': item['application_status']['active']} for item in supports]},
              'sync': {'enabled': enabled(), 'schedule': SCHEDULE, 'target_count': len(SOURCES),
                       'stale': any(row['stale'] for row in source_status),
                       'errors': [row['agency']+' '+row['name'] for row in source_status if row.get('error')],
                       'next_run': min(row['next_run'] for row in source_status) if enabled() else None}}
    if not summary:
        result['items'] = items
    return result


def start_scheduler(path):
    stop = threading.Event()
    def run():
        while not stop.is_set():
            try:
                sync(path, stop=stop, force=False)
            except Exception:
                LOG.exception('Agency news scheduler will retry')
                if stop.wait(1800):
                    return
            stop.wait(30)
    if enabled():
        threading.Thread(target=run, name='agency-news-sync', daemon=True).start()
    return stop


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--sync', action='store_true')
    args = parser.parse_args()
    init_db(db_path())
    if args.sync:
        result = sync(db_path())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if any(row['error'] for row in result or []):
            raise SystemExit(1)
    else:
        print(json.dumps(report(db_path(), summary=True), ensure_ascii=False, indent=2))
