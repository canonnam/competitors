"""Actual consumer-web observations. No AI inference APIs or backend scraping."""
from datetime import datetime, timedelta
import json
import urllib.parse
import uuid

from competitor_news import KST, connect, timestamp

PROVIDERS = {
    'chatgpt_web': {'name': 'ChatGPT 웹', 'url': 'https://chatgpt.com/'},
    'gemini_web': {'name': 'Gemini 웹', 'url': 'https://gemini.google.com/app'},
}


def init_db(path):
    with connect(path) as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS web_search_observations (
                request_id TEXT PRIMARY KEY, provider TEXT NOT NULL, keyword TEXT NOT NULL,
                branch TEXT NOT NULL, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
                payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS web_search_history
                ON web_search_observations(provider,keyword,branch,observed_at DESC);
        ''')


def submit(path, body, now=None):
    import search_visibility as v
    now = now or datetime.now(KST)
    if not isinstance(body, dict):
        raise ValueError('웹 결과 요청 형식을 확인해주세요.')
    for field, limit in (('provider', 30), ('keyword', 300), ('branch', 40), ('request_id', 36),
                         ('answer', 50000), ('reason', 1500), ('session_context', 300), ('model', 100),
                         ('conversation_url', 2000), ('observed_at', 40), ('capture_method', 20), ('status', 20)):
        if not isinstance(body.get(field, ''), str) or len(body.get(field, '')) > limit:
            raise ValueError('입력 내용이 너무 길거나 올바르지 않습니다.')
    provider = body.get('provider')
    config = v.settings()
    query = next((q for q in config['ai_queries'][:config['ai_limit']]
                  if q['keyword'] == body.get('keyword') and q.get('branch') == body.get('branch')), None)
    if provider not in PROVIDERS or not query:
        raise LookupError('등록된 웹 서비스와 질문을 선택해주세요.')
    try:
        uuid.UUID(body.get('request_id', ''))
        observed = datetime.fromisoformat(body.get('observed_at', ''))
        if observed.tzinfo is None or not now-timedelta(days=30) <= observed <= now+timedelta(minutes=5):
            raise ValueError()
    except ValueError as exc:
        raise ValueError('확인 시각은 시간대가 포함된 최근 30일 이내 시각이어야 합니다.') from exc
    if body.get('status') not in {'ready', 'blocked'} or body.get('capture_method') not in {'manual', 'browser'}:
        raise ValueError('웹 확인 상태와 확인 방식을 선택해주세요.')
    answer = body.get('answer', '').strip()
    reason = body.get('reason', '').strip()
    if body['status'] == 'ready' and (len(answer) < 20 or body.get('search_confirmed') is not True
                                    or body.get('complete_answer') is not True or not body.get('session_context', '').strip()):
        raise ValueError('실제 웹 검색 여부·전체 답변 확인과 검색 환경을 기록해주세요.')
    if body['status'] == 'blocked' and not reason:
        raise ValueError('로그인·접근 제한 등 확인하지 못한 이유를 입력해주세요.')
    url = body.get('conversation_url', '').strip()
    hosts = {'chatgpt_web': {'chatgpt.com'}, 'gemini_web': {'gemini.google.com', 'g.co'}}
    if url and (not v.safe_url(url) or urllib.parse.urlsplit(url).hostname not in hosts[provider]):
        raise ValueError('선택한 웹 서비스의 대화 또는 공유 주소를 입력해주세요.')
    sources = body.get('sources', [])
    if not isinstance(sources, list) or len(sources) > 30:
        raise ValueError('출처는 최대 30개까지 기록할 수 있습니다.')
    clean_sources = []
    for source in sources:
        if not isinstance(source, dict) or not v.safe_url(source.get('url')) or len(source['url']) > 2000:
            raise ValueError('출처 주소를 확인해주세요.')
        title = source.get('title', source['url'])
        if not isinstance(title, str) or len(title) > 500:
            raise ValueError('출처 제목을 확인해주세요.')
        clean_sources.append({'url': source['url'], 'title': title})
    surfaces = body.get('surfaces', [])
    if not isinstance(surfaces, list) or not surfaces or any(not isinstance(s, str) or s not in {'answer', 'places'} for s in surfaces):
        raise ValueError('확인한 범위를 선택해주세요.')
    payload = {key: body.get(key, '') for key in ('request_id', 'provider', 'keyword', 'branch', 'status',
                                                'session_context', 'model', 'capture_method')}
    payload.update(answer=answer if body['status'] == 'ready' else '', reason=reason,
                   observed_at=observed.astimezone(KST).isoformat(), conversation_url=url,
                   citations=clean_sources, surfaces=sorted(set(surfaces)), measurement_type='consumer_web',
                   query=query, prompt=query['keyword'], search_confirmed=body.get('search_confirmed') is True)
    payload['mentioned'] = v.brand_mentioned(payload['answer'], config) if body['status'] == 'ready' else False
    payload['owned_cited'] = any(v.is_owned(c['url'], config) for c in clean_sources)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    with connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT payload FROM web_search_observations WHERE request_id=?', (body['request_id'],)).fetchone()
        if previous and previous['payload'] != raw:
            raise ValueError('이미 다른 내용으로 저장한 요청입니다.')
        db.execute('INSERT OR IGNORE INTO web_search_observations VALUES (?,?,?,?,?,?,?)',
                   (body['request_id'], provider, query['keyword'], query['branch'], payload['observed_at'], now.isoformat(), raw))
    return {'saved': True, 'request_id': body['request_id'], 'status': body['status']}


def reports(path, queries, config, now, summary=False):
    import search_visibility as v
    with connect(path) as db:
        records = [json.loads(row['payload']) for row in db.execute(
            'SELECT payload FROM web_search_observations WHERE observed_at>=? ORDER BY observed_at DESC,recorded_at DESC',
            ((now-timedelta(days=30)).isoformat(),))]
    result = []
    for provider, metadata in PROVIDERS.items():
        items = []
        for query in queries:
            history = [r for r in records if r['provider'] == provider and r['keyword'] == query['keyword'] and r['branch'] == query['branch']]
            latest = history[0] if history else {}
            successes = [r for r in history if r['status'] == 'ready']
            observation = successes[0] if successes else {}
            fresh = bool(observation and latest.get('status') == 'ready' and timestamp(observation['observed_at']) >= v.due_at(now))
            status = 'ready' if fresh else 'error' if latest.get('status') == 'blocked' else 'pending'
            item = {**observation, 'keyword': query['keyword'], 'branch': query['branch'], 'query': query,
                    'status': status, 'stale': not fresh, 'measurement_type': 'consumer_web',
                    'error': latest.get('reason', '') if latest.get('status') == 'blocked' else '',
                    'last_attempt': latest.get('observed_at'), 'service_url': metadata['url'],
                    'history': [{'at': r['observed_at'], 'mentioned': r['mentioned']} for r in successes[:30]]}
            branch_result = v.branch_observation(observation, query['branch'], config)
            branch_result['history'] = [{'at': r['observed_at'], 'mentioned': v.branch_observation(r, query['branch'], config)['mentioned']} for r in successes[:30]]
            item['branch_result'] = branch_result
            if summary:
                item = {k: item.get(k) for k in ('keyword', 'branch', 'status', 'stale', 'mentioned', 'branch_result', 'observed_at', 'measurement_type')}
            items.append(item)
        checked = [i for i in items if i['status'] == 'ready']
        result.append({'id': provider, **metadata, 'kind': 'ai', 'configured': True, 'collection': 'consumer_web',
                       'model': '웹 화면에서 확인한 모드', 'expected': len(items), 'checked': len(checked),
                       'mentioned': sum(bool(i.get('mentioned')) for i in checked), 'first_page': 0, 'items': items})
    return result
