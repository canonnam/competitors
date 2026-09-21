"""Record Naver pages observed through Computer Use, without fetching search pages."""
from datetime import datetime, timedelta
import json
import urllib.parse
import uuid

from competitor_news import KST, connect, timestamp


def text(body, key, limit, required=False):
    value = body.get(key, '')
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f'{key} 내용을 확인해주세요.')
    return value.strip()


def submit(path, body, now=None, ad_path=None):
    import search_visibility as v
    now = now or datetime.now(KST)
    allowed = {'provider', 'keyword', 'branch', 'request_id', 'observed_at', 'status', 'capture_method',
               'session_context', 'reason', 'complete_search', 'pages'}
    if set(body) - allowed:
        raise ValueError('관측 기록에 필요한 항목만 제출해주세요.')
    request_id = text(body, 'request_id', 36, True)
    with connect(path) as db:
        previous = db.execute('SELECT payload FROM web_search_observations WHERE request_id=?', (request_id,)).fetchone()
    if previous:
        if json.loads(previous['payload']).get('submission') != body:
            raise ValueError('이미 다른 내용으로 저장한 요청입니다.')
        return {'saved': True, 'request_id': body['request_id'], 'status': body['status']}
    config = v.settings()
    queries, inventory = v.naver_queries(ad_path or v.naver_ads.db_path(), now, config, show_stale=True)
    query = next((q for q in queries if q['keyword'] == body.get('keyword') and q['branch'] == body.get('branch')), None)
    if body.get('provider') != 'naver' or not query:
        raise LookupError('현재 등록된 네이버 점검 키워드를 선택해주세요.')
    try:
        uuid.UUID(request_id)
        observed = datetime.fromisoformat(text(body, 'observed_at', 40, True))
        if observed.tzinfo is None or not now-timedelta(days=30) <= observed <= now+timedelta(minutes=5):
            raise ValueError()
    except ValueError as exc:
        raise ValueError('확인 시각은 시간대가 포함된 최근 30일 이내 시각이어야 합니다.') from exc
    status = body.get('status')
    if status not in {'ready', 'blocked'} or body.get('capture_method') != 'browser':
        raise ValueError('실제 브라우저 확인 결과만 저장할 수 있습니다.')
    session = text(body, 'session_context', 300, True)
    reason = text(body, 'reason', 1500, status == 'blocked')
    pages, matches = [], []
    if status == 'blocked' and body.get('pages'):
        raise ValueError('확인 실패 기록에는 검색 결과를 넣지 마세요.')
    if status == 'ready':
        if query['source'] == 'ad_account' and inventory.get('stale'):
            raise ValueError('ON 키워드 목록 갱신이 필요합니다. 목록 확인 실패 사유를 기록해주세요.')
        if body.get('complete_search') is not True:
            raise ValueError('정해진 페이지 범위 전체를 확인해주세요.')
        raw_pages = body.get('pages')
        if not isinstance(raw_pages, list) or not 1 <= len(raw_pages) <= config['max_pages']:
            raise ValueError('확인한 검색 페이지를 순서대로 기록해주세요.')
        for number, page in enumerate(raw_pages, 1):
            if not isinstance(page, dict) or type(page.get('page')) is not int or page['page'] != number:
                raise ValueError('페이지는 1페이지부터 빠짐없이 순서대로 기록해주세요.')
            url = text(page, 'url', 2000, True)
            parsed = urllib.parse.urlsplit(url)
            params = urllib.parse.parse_qs(parsed.query)
            if (not v.safe_url(url) or parsed.scheme != 'https' or parsed.netloc != 'search.naver.com'
                    or parsed.path != '/search.naver' or params.get('query') != [query['keyword']]
                    or params.get('page', ['1']) != [str(number)]):
                raise ValueError('해당 키워드와 페이지의 실제 네이버 검색 주소를 기록해주세요.')
            content = text(page, 'text', 100000, True)
            if len(content) < 20 or type(page.get('has_next')) is not bool:
                raise ValueError('검색 결과 본문과 다음 페이지 존재 여부를 기록해주세요.')
            if number < len(raw_pages) and not page['has_next']:
                raise ValueError('다음 페이지 확인 기록이 일치하지 않습니다.')
            rows = page.get('results')
            if not isinstance(rows, list) or len(rows) > 150:
                raise ValueError('페이지별 검색 항목을 기록해주세요.')
            if not rows and v.brand_mentioned(content, config):
                raise ValueError('본문에 표시된 브랜드 검색 항목을 누락하지 마세요.')
            clean_rows = []
            positions = set()
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError('검색 항목 형식을 확인해주세요.')
                area = row.get('area')
                position = row.get('position')
                title, target = text(row, 'title', 500, True), text(row, 'url', 12000, True)
                snippet = text(row, 'snippet', 5000)
                if (area not in {'web', 'place', 'ad', 'place_ad'} or type(position) is not int
                        or not 1 <= position <= 150 or (area, position) in positions or not v.safe_url(target)):
                    raise ValueError('검색 영역·영역 내 순서·주소를 확인해주세요.')
                if v.normalized(title) not in v.normalized(content):
                    raise ValueError('항목 제목이 해당 페이지의 관측 본문에 없습니다.')
                positions.add((area, position))
                clean = {'area': area, 'position': position, 'title': title, 'url': target,
                         'snippet': snippet, 'page': number}
                clean_rows.append(clean)
                owned = v.is_owned(target, config)
                if owned or v.brand_mentioned(title+' '+snippet, config):
                    matches.append({**clean, 'owned': owned})
            pages.append({'page': number, 'url': url, 'text': content, 'has_next': page['has_next'], 'results': clean_rows})
        if len(pages) < config['max_pages'] and pages[-1]['has_next']:
            raise ValueError('다음 페이지가 남아 있습니다. 부분 결과를 정상 측정으로 저장할 수 없습니다.')
    organic = [r for r in matches if r['area'] in {'web', 'place'}]
    payload = {'provider': 'naver', 'keyword': query['keyword'], 'branch': query['branch'],
               'request_id': request_id, 'observed_at': observed.astimezone(KST).isoformat(),
               'status': status, 'reason': reason, 'capture_method': 'browser', 'session_context': session,
               'measurement_type': 'consumer_web', 'query': query, 'pages': pages, 'matches': matches,
               'evidence': [{'page': p['page'], 'url': p['url']} for p in pages], 'pages_checked': len(pages),
               'mentioned': bool(organic), 'first_page': min((r['page'] for r in organic), default=None),
               'ad_coverage_complete': status == 'ready', 'method': 'Computer Use · 실제 네이버 검색 화면'}
    # Inventory metadata can change between delivery retries; deduplicate the submitted content itself.
    payload['submission'] = body
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    with connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT payload FROM web_search_observations WHERE request_id=?', (request_id,)).fetchone()
        if previous:
            if json.loads(previous['payload']).get('submission') != body:
                raise ValueError('이미 다른 내용으로 저장한 요청입니다.')
        else:
            db.execute('INSERT INTO web_search_observations VALUES (?,?,?,?,?,?,?)',
                       (request_id, 'naver', query['keyword'], query['branch'], payload['observed_at'], now.isoformat(), raw))
    return {'saved': True, 'request_id': request_id, 'status': status}


def report(path, legacy, config, now, summary=False, inventory_stale=False):
    """Keep older server observations visible, but count only current browser observations."""
    import search_visibility as v
    with connect(path) as db:
        records = [json.loads(row['payload']) for row in db.execute(
            "SELECT payload FROM web_search_observations WHERE provider='naver' AND observed_at>=? ORDER BY observed_at DESC,recorded_at DESC",
            ((now-timedelta(days=30)).isoformat(),))]
    items = []
    for old in legacy['items']:
        history = [r for r in records if r['keyword'] == old['keyword'] and r['branch'] == old['branch']]
        latest = history[0] if history else {}
        successes = [r for r in history if r['status'] == 'ready']
        observation = successes[0] if successes else old
        fresh = bool(successes and latest['status'] == 'ready' and timestamp(observation['observed_at']) >= v.due_at(now))
        if old['query']['source'] == 'ad_account' and inventory_stale:
            fresh = False
        blocked = latest.get('status') == 'blocked'
        item = {**observation, 'query': old['query'], 'status': 'ready' if fresh else 'error' if blocked else 'pending',
                'stale': not fresh, 'error': latest.get('reason', '') if blocked else '',
                'last_attempt': latest.get('observed_at'), 'last_attempt_request_id': latest.get('request_id'),
                'history': [{'at': r['observed_at'], 'mentioned': r['mentioned'], 'first_page': r['first_page']} for r in successes] + old.get('history', [])}
        item.pop('submission', None)
        branch = v.branch_observation(observation, old['branch'], config)
        branch['history'] = [{'at': r['observed_at'], **{k: value for k, value in v.branch_observation(r, old['branch'], config).items() if k in {'mentioned', 'first_page'}}} for r in successes] + old.get('branch_result', {}).get('history', [])
        item['branch_result'] = branch
        if summary:
            item = {k: item.get(k) for k in ('keyword', 'branch', 'status', 'stale', 'mentioned', 'first_page', 'observed_at', 'error', 'last_attempt', 'branch_result')}
        items.append(item)
    checked = [i for i in items if i['status'] == 'ready']
    return {**legacy, 'model': 'Computer Use · 실제 네이버 검색 화면', 'collection': 'consumer_web',
            'server_collection': False, 'collection_paused': False, 'collection_error': '', 'items': items,
            'checked': len(checked), 'mentioned': sum(bool(i.get('mentioned')) for i in checked),
            'first_page': sum(i.get('first_page') == 1 for i in checked)}
