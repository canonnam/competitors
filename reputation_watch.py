"""Daily public-source screening. A detected claim is never a verified incident."""
from datetime import datetime, time as day_time, timedelta
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import threading
import urllib.error
import urllib.parse

import competitor_news as news
import search_visibility as visibility

KST, connect, timestamp = news.KST, news.connect, news.timestamp
LOG = logging.getLogger('reputation_watch')
LOCK = threading.Lock()
SCHEDULE = '매일 09:30 (한국시간)'
CLASSIFIER_VERSION = 'reputation-rules-1'
BATCH_SIZE, MAX_DOCUMENTS, MAX_CALLS = 16, 96, 8
CATEGORIES = {'care': '돌봄·안전', 'staff': '직원·응대', 'billing': '비용·계약',
              'facility': '시설·위생', 'administration': '행정·운영', 'other': '기타', 'none': '해당 없음'}
SEARCHES = ['더비다요양원', '더비다 요양원 후기', '더비다요양원 인천 불만',
            '더비다요양원 안양 후기', '더비다요양원 사고']
SOURCES = [{'id': 'naver-'+str(i), 'kind': 'naver', 'name': '네이버 · '+q, 'query': q,
            'url': visibility.search_url(q)} for i, q in enumerate(SEARCHES)] + [
    {'id': 'google-news', 'kind': 'news', 'name': 'Google 뉴스 · 브랜드 기사',
     'query': '"더비다요양원" OR "더비다 요양원"', 'aliases': ['더비다요양원', '더비다 요양원']}]
SOURCES[-1]['url'] = news.feed_url(SOURCES[-1])


def db_path():
    return Path(os.getenv('REPUTATION_DB_PATH', '/data/reputation-watch.db'))


def enabled():
    return os.getenv('REPUTATION_SYNC_ENABLED', 'true').lower() not in {'false', '0', 'no'}


def model():
    return '규칙 기반 선별 v1'


def due_at(now):
    today = datetime.combine(now.astimezone(KST).date(), day_time(9, 30), KST)
    return today if now >= today else today-timedelta(days=1)


def init_db(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS assessments (hash TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, last_detected TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS history (day TEXT PRIMARY KEY, payload TEXT NOT NULL);
        ''')


def read_state(db):
    return {row['key']: json.loads(row['value']) for row in db.execute('SELECT * FROM state')}


def write_state(db, key, value):
    db.execute('INSERT OR REPLACE INTO state VALUES(?,?)', (key, json.dumps(value, ensure_ascii=False)))


def canonical_url(value):
    if not visibility.safe_url(value):
        return ''
    parts = urllib.parse.urlsplit(value)
    host = parts.hostname.lower()
    netloc, scheme = parts.netloc.lower(), parts.scheme
    if host in {'adcr.naver.com', 'ader.naver.com', 'search.naver.com'}:
        return ''
    path = parts.path.rstrip('/') or '/'
    params = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    if host in {'blog.naver.com', 'm.blog.naver.com'}:
        host = netloc = 'blog.naver.com'
        scheme = 'https'
        query = dict(params)
        if path.endswith('PostView.naver') and query.get('blogId') and query.get('logNo'):
            path, params = '/'+query['blogId']+'/'+query['logNo'], []
    if host == 'news.google.com' and path.startswith('/rss/articles/'):
        params = []
    params = [(k, v) for k, v in params if not k.lower().startswith('utm_') and k not in {'fbclid', 'gclid', 'referrer', 'from'}]
    return urllib.parse.urlunsplit((scheme, netloc, path, urllib.parse.urlencode(sorted(params)), ''))


def clean(value, limit=700):
    return re.sub(r'\s+', ' ', news.clean_text(value)).replace(' 새 창 열림', '').strip()[:limit]


def document(title, excerpt, url, source, published_at=None):
    url = canonical_url(url)
    title, excerpt = clean(title, 300), clean(excerpt)
    if not url or not title or not visibility.brand_mentioned(title+' '+excerpt, visibility.settings()):
        return None
    return {'id': hashlib.sha256(url.encode()).hexdigest(), 'title': title, 'excerpt': excerpt, 'url': url,
            'publisher': urllib.parse.urlsplit(url).hostname, 'source_ids': [source['id']],
            'published_at': published_at, 'basis': '기사 제목' if source['kind'] == 'news' else '공개 검색 제목·요약'}


def fetch_source(source, now, fetcher=visibility.fetch_html, feed_fetcher=news.fetch_feed, stop=None):
    if source['kind'] == 'news':
        articles = news.parse_feed(feed_fetcher(source), source, now)
        rows = [dict(item, publisher=a['source']) for a in articles
                if (item := document(a['title'], '', a['url'], source, a['published_at']))]
        return {'documents': [row for row in rows if row], 'scanned': len(articles), 'pages': 1}
    url, found, scanned = source['url'], {}, 0
    for page in range(1, 3):
        if stop and stop.is_set():
            raise InterruptedError()
        html = fetcher(url)
        # Share the already-validated Naver pagination and access-limit checks.
        rows, following = visibility.parse_naver(html, url, page)
        scanned += sum(row['area'] == 'web' for row in rows)
        for block in visibility.Document(html).root.all('div'):
            if not block.has_class('fds-web-doc-root'):
                continue
            links = visibility.public_result_links(block)
            # Do not use the publisher's AI-generated knowledge-panel description.
            item = document(links[1].text(), ' '.join(a.text() for a in links[2:]), links[1].attrs['href'], source)
            if item and (item['id'] not in found or len(item['excerpt']) > len(found[item['id']]['excerpt'])):
                found[item['id']] = item
        if not following:
            break
        url = following
    return {'documents': list(found.values()), 'scanned': scanned, 'pages': page}


# These patterns screen only the retained title and excerpt. They do not verify claims.
RISK_PATTERNS = {
    'care': r'학대|폭행|폭언|방임|방치|낙상|욕창|사망|사고|실종|상해',
    'staff': r'불친절|차별|강압|응대\s*불만|직원\s*태도|돌봄\s*미흡',
    'billing': r'부당\s*청구|과다\s*청구|횡령|환불\s*(?:거부|지연)|비용\s*불만|계약\s*위반',
    'facility': r'불결|악취|곰팡이|위생\s*불량|식중독|부실\s*급식',
    'administration': r'행정\s*처분|업무\s*정지|영업\s*정지|폐쇄\s*명령|지정\s*취소',
    'other': r'불만|불편|실망|비추천|후회|추천하지|문제\s*제기|피해',
}
BRANCH_TERMS = {'incheon': ('인천', '미추홀', '숭의동', '제물량로4번길', '032-891-0121'),
                'anyang': ('안양', '만안구', '명학역', '전파로 19-1', '031-464-5075')}
RULE_REASONS = {
    'direct_claim': '같은 문장에 더비다요양원과 구체적인 부정 평가·피해 주장이 있어 원문 확인이 필요합니다.',
    'context_required': '주의 표현이 있으나 대상·부정 여부·문맥을 규칙만으로 확정할 수 없습니다.',
    'source_summary': '수집 문구에 게시자 또는 검색 서비스의 AI 요약 안내가 섞여 있어 원문 확인이 필요합니다.',
    'identity_required': '인천점·안양점의 더비다요양원에 관한 글인지 확인이 필요합니다.',
    'information_only': '수집한 안내·채용·예방교육·긍정 평가 문구에서 부정 표현이 감지되지 않았습니다.',
    'insufficient_context': '수집한 제목·요약만으로 문맥을 판단하기 어려워 원문 확인이 필요합니다.',
    'other_region': '다른 지역의 동명 시설로 명시되어 있습니다.',
}
INFORMATION_PATTERN = re.compile(
    r'시설\s*(?:정보|안내|사진)|노인\s*요양\s*시설|요양\s*(?:시설|센터)|주소|전화|정원|위치|'
    r'등급|비용|모집|채용|구인|봉사|프로그램|예방|교육|훈련|안전\s*관리|'
    r'친절|만족|깨끗|감사|안심|편안|추천|문제\s*없')
CLAIM_PATTERN = re.compile(
    r'당했|당한|피해|발생|적발|신고|처분|거부|폭행했|폭행한|폭언했|방치했|'
    r'불친절(?:했|하다|해|함|한)|실망했|비추천|추천하지|후회했')
OTHER_CONTEXT_PATTERN = re.compile(r'다른\s*(?:시설|요양원)|타\s*요양원|일반\s*요양|요양\s*업계')


def assessment_hash(item):
    payload = [CLASSIFIER_VERSION, model(), item['id'], item['title'], item['excerpt']]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False).encode()).hexdigest()


def screen_document(item):
    title, excerpt = item['title'], item['excerpt']
    text = title+'\n'+excerpt
    branches = [branch for branch, terms in BRANCH_TERMS.items() if any(term in text for term in terms)]
    identity = branches[0] if len(branches) == 1 else 'brand'
    verdict, category, evidence = 'uncertain', 'other', ''
    rule = 'insufficient_context'
    brand = re.search(r'더비다\s*요양원', text)
    if not brand:
        identity, rule = 'unknown', 'identity_required'
    elif not branches and re.search(r'더비다\s*요양원\s*(?:서울|부산|대구|대전|광주|울산|제주)\s*(?:점|지점)', text):
        identity, verdict, category, rule = 'unknown', 'unrelated', 'none', 'other_region'
    else:
        candidates = []
        for field in (title, excerpt):
            for sentence in re.findall(r'[^.!?\n。！？]+[.!?。！？]?', field):
                for kind, pattern in RISK_PATTERNS.items():
                    for hit in re.finditer(pattern, sentence):
                        suffix = sentence[hit.end():]
                        # Mask only the matched expression, so a later claim in the
                        # same sentence still reaches the review queue.
                        prevention = re.match(r'\s*(?:예방|방지|신고\s*의무자\s*교육)', suffix)
                        negated = re.match(r'\s*(?:은|는|이|가|도|전혀|발생)?\s*(?:없|아니|0\s*건)', suffix)
                        negated = negated or re.match(r'(?:하지|하진)\s*않', suffix)
                        if prevention or negated:
                            continue
                        begin = max(0, min(hit.start()-45, len(sentence)-160))
                        quote = sentence[begin:begin+160].strip()
                        direct = bool(re.search(r'더비다\s*요양원', sentence)
                                      and CLAIM_PATTERN.search(sentence)
                                      and not OTHER_CONTEXT_PATTERN.search(sentence)
                                      and not re.search(r'인지|일까요|있나요|알려|여부|예방|교육', sentence))
                        candidates.append((direct, kind, quote))
        if candidates:
            direct, category, evidence = max(candidates, key=lambda candidate: candidate[0])
            verdict = 'concern' if direct else 'uncertain'
            rule = 'direct_claim' if direct else 'context_required'
        elif INFORMATION_PATTERN.search(text):
            verdict, category, rule = 'neutral', 'none', 'information_only'
        if re.search(r'AI\s*생성|AI\s*기반\s*검색|위\s*스니펫', text):
            verdict, category, rule = 'uncertain', 'other', 'source_summary'
            evidence = ''
    if verdict == 'uncertain' and not evidence:
        evidence = (excerpt if len(excerpt) >= 4 else title)[:160]
    return {'id': item['id'], 'verdict': verdict, 'category': category, 'identity': identity,
            'evidence': evidence, 'method': 'rules', 'rule': rule, 'reason': RULE_REASONS[rule]}


def classify(items):
    return [screen_document(item) for item in items]


def current_documents(states, now):
    merged = {}
    for source in SOURCES:
        state = states.get(source['id'], {})
        if not state.get('last_success') or timestamp(state['last_success']) < due_at(now):
            continue
        for item in state.get('documents', []):
            old = merged.get(item['id'])
            if old:
                sources = sorted(set(old['source_ids']+item['source_ids']))
                merged[item['id']] = {**(item if len(item['excerpt']) > len(old['excerpt']) else old), 'source_ids': sources,
                                      'observed_at': max(old.get('observed_at', ''), item.get('observed_at', ''))}
            else:
                merged[item['id']] = item
    return list(merged.values())


def save_assessments(db, items, results, now):
    by_id = {item['id']: item for item in items}
    for result in results:
        item = by_id[result['id']]
        assessed = {**result, 'model': model(), 'assessed_at': now.isoformat()}
        db.execute('INSERT OR REPLACE INTO assessments VALUES(?,?)', (assessment_hash(item), json.dumps(assessed, ensure_ascii=False)))
        old = db.execute('SELECT payload FROM findings WHERE id=?', (item['id'],)).fetchone()
        if result['verdict'] in {'concern', 'uncertain'}:
            previous = json.loads(old[0]) if old else {}
            revision = hashlib.sha256((item['id']+result['verdict']+result['evidence']).encode()).hexdigest()
            finding = {**item, **assessed, 'active': True, 'revision': revision,
                       'first_detected': previous.get('first_detected', now.isoformat()), 'last_detected': now.isoformat()}
            db.execute('INSERT OR REPLACE INTO findings VALUES(?,?,?)', (item['id'], now.isoformat(), json.dumps(finding, ensure_ascii=False)))
        elif old:
            finding = json.loads(old[0])
            finding.update(active=False, rechecked_at=now.isoformat())
            db.execute('UPDATE findings SET payload=? WHERE id=?', (json.dumps(finding, ensure_ascii=False), item['id']))


def sync(path, now=None, collector=fetch_source, classifier=classify, stop=None):
    live = now is None
    now = now or datetime.now(KST)
    if not LOCK.acquire(blocking=False):
        return
    try:
        with connect(path) as db:
            states = read_state(db)
        for source in SOURCES:
            if stop and stop.is_set():
                return
            state = states.get(source['id'], {})
            if state.get('last_success') and timestamp(state['last_success']) >= due_at(now) and not state.get('error'):
                continue
            cooldown = states.get('naver-cooldown', {})
            if source['kind'] == 'naver' and cooldown.get('until') and timestamp(cooldown['until']) > now:
                continue
            cycle = due_at(now).isoformat()
            attempts = state.get('attempts', 0) if state.get('cycle') == cycle else 0
            if state.get('running') and not os.getenv('SERPAPI_KEY'):
                attempts = max(0, attempts-1)
            if attempts >= 2 or attempts and state.get('last_attempt') and now < timestamp(state['last_attempt'])+timedelta(minutes=30):
                continue
            attempt = {**state, 'cycle': cycle, 'attempts': attempts+1, 'last_attempt': now.isoformat(), 'running': True}
            with connect(path) as db:
                write_state(db, source['id'], attempt)
            try:
                collected = collector(source, now, stop=stop)
                finished = datetime.now(KST) if live else now
                collected['documents'] = [{**item, 'observed_at': finished.isoformat()} for item in collected['documents']]
                completed = {**attempt, **collected, 'last_success': finished.isoformat(), 'error': '', 'running': False}
                with connect(path) as db:
                    write_state(db, source['id'], completed)
                states[source['id']] = completed
                LOG.info('Reputation source checked: %s (%s related)', source['id'], len(collected['documents']))
            except InterruptedError:
                return
            except Exception as exc:
                attempt.update(error=visibility.safe_error(exc), running=False)
                with connect(path) as db:
                    write_state(db, source['id'], attempt)
                    if source['kind'] == 'naver' and (isinstance(exc, visibility.SearchAccessLimited) or isinstance(exc, urllib.error.HTTPError) and exc.code in {403, 429}):
                        cooldown = {'until': (due_at(now)+timedelta(days=1)).isoformat(), 'error': '네이버 조회 제한 · 다음 정기 점검까지 중단'}
                        write_state(db, 'naver-cooldown', cooldown)
                        states['naver-cooldown'] = cooldown
                states[source['id']] = attempt
                LOG.warning('Reputation source unavailable: %s', source['id'])
        documents = current_documents(states, now)
        with connect(path) as db:
            known = {row[0] for row in db.execute('SELECT hash FROM assessments')}
        pending = [item for item in documents[:MAX_DOCUMENTS] if assessment_hash(item) not in known]
        analysis = states.get('analysis', {})
        cycle = due_at(now).isoformat()
        same_classifier = analysis.get('classifier_version') == CLASSIFIER_VERSION
        calls = analysis.get('calls', 0) if analysis.get('cycle') == cycle and same_classifier else 0
        retry_ready = not same_classifier or not (analysis.get('error') or analysis.get('running')) or not analysis.get('last_attempt') or now >= timestamp(analysis['last_attempt'])+timedelta(minutes=30)
        if pending and retry_ready and calls < MAX_CALLS:
            for offset in range(0, len(pending), BATCH_SIZE):
                if calls >= MAX_CALLS or stop and stop.is_set():
                    break
                batch = pending[offset:offset+BATCH_SIZE]
                calls += 1
                analysis = {'cycle': cycle, 'classifier_version': CLASSIFIER_VERSION,
                            'calls': calls, 'last_attempt': now.isoformat(), 'running': True, 'error': ''}
                with connect(path) as db:
                    write_state(db, 'analysis', analysis)
                try:
                    results = classifier(batch)
                    finished = datetime.now(KST) if live else now
                    with connect(path) as db:
                        save_assessments(db, batch, results, finished)
                        write_state(db, 'analysis', {**analysis, 'running': False, 'error': ''})
                    LOG.info('Reputation classified: %s documents', len(batch))
                except Exception as exc:
                    with connect(path) as db:
                        write_state(db, 'analysis', {**analysis, 'running': False, 'error': visibility.safe_error(exc)})
                    LOG.warning('Reputation classification unavailable')
                    break
        with connect(path) as db:
            states = read_state(db)
            assessed = {row[0] for row in db.execute('SELECT hash FROM assessments')}
            # Cached classification still counts as a new daily observation of the
            # same evidence, without another paid request or a new N marker.
            for item in documents:
                if assessment_hash(item) not in assessed:
                    continue
                result = json.loads(db.execute('SELECT payload FROM assessments WHERE hash=?', (assessment_hash(item),)).fetchone()[0])
                old = db.execute('SELECT payload FROM findings WHERE id=?', (item['id'],)).fetchone()
                if old and result['verdict'] in {'concern', 'uncertain'}:
                    finding = json.loads(old[0])
                    observed = max(item.get('observed_at', finding['last_detected']), finding['last_detected'])
                    finding.update({**item, **result, 'active': True, 'last_detected': observed,
                                    'revision': hashlib.sha256((item['id']+result['verdict']+result['evidence']).encode()).hexdigest()})
                    db.execute('UPDATE findings SET last_detected=?,payload=? WHERE id=?', (observed, json.dumps(finding, ensure_ascii=False), item['id']))
                elif old:
                    finding = json.loads(old[0])
                    finding.update(active=False, rechecked_at=item.get('observed_at', now.isoformat()))
                    db.execute('UPDATE findings SET payload=? WHERE id=?', (json.dumps(finding, ensure_ascii=False), item['id']))
            complete = all(states.get(s['id'], {}).get('last_success') and timestamp(states[s['id']]['last_success']) >= due_at(now)
                           and not states[s['id']].get('error') for s in SOURCES) and all(assessment_hash(item) in assessed for item in documents)
            if complete:
                previous = states.get('overall', {})
                if previous.get('cycle') != cycle:
                    finished = datetime.now(KST) if live else now
                    write_state(db, 'overall', {'cycle': cycle, 'last_success': finished.isoformat()})
                    verdicts = [json.loads(db.execute('SELECT payload FROM assessments WHERE hash=?', (assessment_hash(item),)).fetchone()[0])['verdict'] for item in documents]
                    payload = {'at': finished.isoformat(), 'documents': len(documents), 'concern': verdicts.count('concern'), 'uncertain': verdicts.count('uncertain')}
                    db.execute('INSERT OR REPLACE INTO history VALUES(?,?)', (cycle[:10], json.dumps(payload)))
    finally:
        LOCK.release()


def report(path, now=None, summary=False):
    now = now or datetime.now(KST)
    with connect(path) as db:
        states = read_state(db)
        assessments = {row['hash']: json.loads(row['payload']) for row in db.execute('SELECT * FROM assessments')}
        findings = [json.loads(row['payload']) for row in db.execute('SELECT payload FROM findings ORDER BY last_detected DESC')]
        history = [json.loads(row[0]) for row in db.execute('SELECT payload FROM history ORDER BY day DESC LIMIT 30')]
    sources = []
    cooldown = states.get('naver-cooldown', {})
    for source in SOURCES:
        state = states.get(source['id'], {})
        fresh = bool(state.get('last_success') and timestamp(state['last_success']) >= due_at(now) and not state.get('error'))
        error = state.get('error', '')
        if not fresh and source['kind'] == 'naver' and cooldown.get('until') and timestamp(cooldown['until']) > now:
            error = cooldown['error']
        sources.append({**source, 'fresh': fresh, 'error': error, 'running': state.get('running', False),
                        'last_success': state.get('last_success'), 'scanned': state.get('scanned', 0),
                        'related': len(state.get('documents', [])), 'pages': state.get('pages', 0)})
    docs = current_documents(states, now)
    pending = sum(assessment_hash(item) not in assessments for item in docs)
    checked = sum(s['fresh'] for s in sources)
    recent = [item for item in findings if timestamp(item['last_detected']) >= now-timedelta(days=30)]
    for finding in recent:
        finding['seen_in_latest_search'] = any(item['id'] == finding['id'] for item in docs)
    active = [item for item in recent if item['active']]
    complete = checked == len(SOURCES) and not pending
    result = {'brand': '더비다요양원', 'updated_at': states.get('overall', {}).get('last_success'),
              'sync': {'enabled': enabled(), 'schedule': SCHEDULE, 'complete': complete, 'checked_sources': checked,
                       'expected_sources': len(SOURCES), 'next_run': (due_at(now)+timedelta(days=1)).isoformat(),
                       'running': any(s['running'] for s in sources) or states.get('analysis', {}).get('running', False)},
              'analysis': {'connected': True, 'model': model(), 'method': 'rules',
                           'classifier_version': CLASSIFIER_VERSION, 'requires_api_key': False, 'pending': pending,
                           'criteria': RULE_REASONS,
                           'error': states.get('analysis', {}).get('error', '') if pending and states.get('analysis', {}).get('classifier_version') == CLASSIFIER_VERSION else '',
                           'limit': MAX_DOCUMENTS},
              'counts': {'documents': len(docs), 'reviewed': len(docs)-pending,
                         'concern': sum(item['verdict'] == 'concern' for item in active),
                         'uncertain': sum(item['verdict'] == 'uncertain' for item in active), 'archived': len(recent)-len(active)},
              'article_ids': [item['revision'] for item in active], 'sources': sources, 'generated_at': now.isoformat()}
    if not summary:
        result.update(items=recent, history=history,
                      documents=[{**item, 'verdict': assessments.get(assessment_hash(item), {}).get('verdict', 'pending'),
                                  'classification_reason': assessments.get(assessment_hash(item), {}).get('reason', '')}
                                 for item in docs])
    return result


def start_scheduler(path):
    stop = threading.Event()
    def run():
        while not stop.is_set():
            try:
                sync(path, stop=stop)
            except Exception:
                LOG.warning('Reputation scheduler will retry')
            stop.wait(60)
    if enabled():
        threading.Thread(target=run, daemon=True, name='reputation-watch').start()
    return stop
