"""Daily observed search visibility. Unavailable checks never mean not mentioned."""
from __future__ import annotations

from datetime import datetime, time as day_time, timedelta
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from agency_news import Document
from competitor_news import KST, connect, normalized, timestamp
import naver_ads

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger('search_visibility')
SCHEDULE = '매일 10:50 (한국시간)'
VERSION = 'visibility-v1'
NAVER_ORIGIN = 'https://search.naver.com'
PROVIDERS = {
    'naver': {'name': '네이버 검색', 'kind': 'search'},
    'openai': {'name': 'OpenAI 검색 답변', 'kind': 'ai'},
    'gemini': {'name': 'Gemini 검색 답변', 'kind': 'ai'},
    'perplexity': {'name': 'Perplexity 검색 답변', 'kind': 'ai'},
}
PROVIDER_KEYS = {'openai': 'OPENAI_API_KEY', 'gemini': 'GEMINI_API_KEY', 'perplexity': 'PERPLEXITY_API_KEY'}
LOCKS = {provider: threading.Lock() for provider in PROVIDERS}
OPENAI_MAX_SEARCHES = 3


class SearchAccessLimited(ValueError):
    pass


def settings():
    config = json.loads((ROOT / 'data/search_visibility.json').read_text(encoding='utf-8'))
    config.update(json.loads(os.getenv('SEARCH_VISIBILITY_CONFIG_JSON', '{}')))
    config['max_pages'] = max(1, min(10, int(os.getenv('SEARCH_VISIBILITY_MAX_PAGES', '5'))))
    config['ai_limit'] = max(1, min(12, int(os.getenv('SEARCH_VISIBILITY_AI_LIMIT', '6'))))
    return config


def db_path():
    return Path(os.getenv('SEARCH_VISIBILITY_DB_PATH', '/data/search-visibility.db'))


def enabled():
    return os.getenv('SEARCH_VISIBILITY_SYNC_ENABLED', 'true').lower() not in {'false', '0', 'no'}


def configured(provider):
    return provider == 'naver' or bool(os.getenv(PROVIDER_KEYS[provider], '').strip())


def model_for(provider):
    defaults = {'openai': 'gpt-5.4-mini', 'gemini': 'gemini-3.6-flash', 'perplexity': 'sonar'}
    return os.getenv('SEARCH_' + provider.upper() + '_MODEL', defaults.get(provider, 'PC 공개 검색'))


def init_db(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS observations (
                provider TEXT NOT NULL, keyword TEXT NOT NULL, day TEXT NOT NULL,
                signature TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(provider,keyword,day,signature));
            CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS visibility_history ON observations(day DESC);
        ''')


def due_at(now):
    today = datetime.combine(now.astimezone(KST).date(), day_time(10, 50), KST)
    return today if now >= today else today - timedelta(days=1)


def next_daily(now):
    return due_at(now) + timedelta(days=1)


def safe_url(value):
    if not isinstance(value, str):
        return ''
    try:
        parsed = urllib.parse.urlsplit(value)
        return value if parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username and not parsed.password else ''
    except ValueError:
        return ''


def is_owned(url, config):
    if not safe_url(url):
        return False
    value = urllib.parse.urlsplit(url)
    if value.hostname in {'map.naver.com', 'm.place.naver.com', 'pcmap.place.naver.com', 'place.naver.com'}:
        place = re.search(r'/(?:place|hospital|nursinghome)/(\d+)(?:/|$)', value.path)
        if place and place.group(1) in config.get('place_ids', []):
            return True
    for entry in config.get('owned_urls', []):
        if not safe_url(entry):
            continue
        owned = urllib.parse.urlsplit(entry)
        host = value.hostname.removeprefix('www.').removeprefix('m.')
        if host != owned.hostname.removeprefix('www.').removeprefix('m.'):
            continue
        base = owned.path.rstrip('/')
        if host == 'blog.naver.com' and value.path.endswith('PostView.naver'):
            if urllib.parse.parse_qs(value.query).get('blogId') == [base.strip('/')]:
                return True
        if value.path == base or value.path.startswith(base + '/') or not base:
            return True
    return False


def brand_mentioned(text, config):
    value = normalized(text)
    return any(normalized(alias) in value for alias in config['aliases'])


def fetch_html(url):
    # Read public results only; do not follow advertising click links.
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'search.naver.com' or parsed.path != '/search.naver':
        raise ValueError('Unexpected search page')
    if os.getenv('SERPAPI_KEY'):
        return fetch_serp_html(url)
    time.sleep(3)
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9'})
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read(3_000_001)
        if len(raw) > 3_000_000:
            raise ValueError('Search page too large')
        return raw.decode('utf-8')


def fetch_serp_html(url):
    params = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    page = int(params.get('page', ['1'])[0])
    query = {'engine': 'naver', 'query': params['query'][0], 'page': page,
             'where': 'nexearch' if page == 1 else 'web', 'device': 'desktop', 'api_key': os.environ['SERPAPI_KEY']}
    request = urllib.request.Request('https://serpapi.com/search.json?' + urllib.parse.urlencode(query))
    with urllib.request.urlopen(request, timeout=100) as response:
        data = json.load(response)
    if data.get('search_metadata', {}).get('status') != 'Success' or data.get('error'):
        raise ValueError('Search provider did not return a successful page')
    raw_url = data.get('search_metadata', {}).get('raw_html_file', '')
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme != 'https' or parsed.netloc != 'serpapi.com' or not parsed.path.startswith('/searches/') or not parsed.path.endswith('.html'):
        raise ValueError('Missing search page evidence')
    with urllib.request.urlopen(raw_url, timeout=30) as response:
        raw = response.read(3_000_001)
        if len(raw) > 3_000_000:
            raise ValueError('Search page too large')
        return raw.decode('utf-8')


def post_json(url, payload, headers):
    request = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
                                     headers={'Content-Type': 'application/json', **headers}, method='POST')
    with urllib.request.urlopen(request, timeout=100) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('API response too large')
        return json.loads(raw)


def search_url(keyword):
    return NAVER_ORIGIN + '/search.naver?' + urllib.parse.urlencode({'where': 'nexearch', 'query': keyword})


def public_result_links(doc):
    # Naver marks ordinary web results as .link and indexed PDF results as .pdf.
    links = [a for a in doc.all('a') if a.attrs.get('data-heatmap-target') in {'.link', '.pdf'} and safe_url(a.attrs.get('href'))]
    if len(links) < 2:
        raise ValueError('Search result layout changed')
    return links


def parse_naver(html, url, expected_page=1):
    root = Document(html).root
    text = root.text()
    if any(marker in text for marker in ('자동입력 방지', '비정상적인 접근', '접근이 제한', '보안 확인을 완료')):
        raise SearchAccessLimited('Search access unavailable')
    current = next((a for a in root.all('a') if a.attrs.get('aria-current') == 'page'
                    and re.fullmatch(r'\d+\s*페이지', a.attrs.get('aria-label') or a.text())), None)
    if expected_page > 1 and not current:
        raise ValueError('Search page number is not verifiable')
    page = int(re.search(r'\d+', current.attrs.get('aria-label') or current.text()).group()) if current else expected_page
    if page != expected_page:
        raise ValueError('Search returned a different page')
    results = []
    for doc in root.all('div'):
        if not doc.has_class('fds-web-doc-root'):
            continue
        links = public_result_links(doc)
        title = links[1].text().removesuffix(' 새 창 열림')
        results.append({'area': 'web', 'title': title, 'url': links[1].attrs['href'],
                        'snippet': doc.text()[:1200], 'position': len(results)+1, 'page': page})
    # Place cards have a separate order from web documents and paid text advertisements.
    place_root = next((n for n in root.all() if n.has_class('place-app-root')), None)
    if place_root:
        place_links = [a for a in place_root.all('a') if a.has_class('U70Fj')]
        if not place_links:
            raise ValueError('Place result layout changed or did not load')
        for a in place_links:
            href = a.attrs.get('href', '')
            area = 'place_ad' if urllib.parse.urlsplit(href).hostname in {'ader.naver.com', 'adcr.naver.com'} else 'place'
            if not safe_url(href):
                continue
            position = 1 + sum(row['area'] == area for row in results)
            # A search-page evidence link avoids chargeable ad redirects.
            results.append({'area': area, 'title': a.text(), 'url': url if area == 'place_ad' else href,
                            'snippet': a.text(), 'position': position, 'page': page})
    for a in root.all('a'):
        if a.has_class('lnk_tit') and a.text():
            results.append({'area': 'ad', 'title': a.text(), 'snippet': a.text(), 'url': url,
                            'position': 1 + sum(row['area'] == 'ad' for row in results), 'page': page})
    if not any(row['area'] == 'web' for row in results) and not any(marker in text for marker in ('검색결과가 없습니다', '검색 결과가 없습니다')):
        raise ValueError('Web results not present in returned page')
    following = next((a.attrs.get('href') for a in root.all('a') if a.has_class('btn_next') and a.attrs.get('aria-disabled') != 'true'), None)
    next_url = urllib.parse.urljoin(url, following) if following else None
    if next_url:
        parsed = urllib.parse.urlsplit(next_url)
        params = urllib.parse.parse_qs(parsed.query)
        original = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('query')
        corrected = params.get('query', [])
        current_query = urllib.parse.parse_qs(urllib.parse.urlsplit(current.attrs.get('href', '')).query).get('query') if current else None
        explicit_correction = (page == 1 and len(corrected) == 1 and current_query == corrected
                               and normalized(corrected[0]+'으로 검색한 결과입니다') in normalized(text))
        if (parsed.scheme != 'https' or parsed.netloc != 'search.naver.com' or parsed.path != '/search.naver'
                or params.get('page') != [str(page+1)] or corrected != original and not explicit_correction):
            raise ValueError('Unexpected search pagination')
    return results, next_url


def collect_naver(query, config, fetcher=fetch_html, stop=None):
    url, matches, evidence, visited = search_url(query['keyword']), [], [], set()
    correction = None
    for page in range(1, config['max_pages']+1):
        if stop and stop.is_set():
            raise InterruptedError()
        if url in visited:
            raise ValueError('Repeated search page')
        visited.add(url)
        rows, following = parse_naver(fetcher(url), url, page)
        evidence.append({'page': page, 'url': url, 'web_results': sum(row['area'] == 'web' for row in rows)})
        for row in rows:
            owned = is_owned(row['url'], config)
            if owned or brand_mentioned(row['title']+' '+row['snippet'], config):
                matches.append({**row, 'owned': owned})
        if not following:
            break
        corrected = urllib.parse.parse_qs(urllib.parse.urlsplit(following).query)['query'][0]
        if page == 1 and corrected != query['keyword']:
            correction = {'from': query['keyword'], 'to': corrected}
        url = following
        if stop and stop.wait(0.4):
            raise InterruptedError()
    organic = [row for row in matches if row['area'] in {'web', 'place'}]
    return {'matches': matches, 'evidence': evidence, 'pages_checked': len(evidence), 'search_correction': correction,
            'mentioned': bool(organic), 'first_page': min((row['page'] for row in organic), default=None),
            'method': 'PC 비로그인 공개 검색 · 웹문서 및 첫 화면 플레이스 · 광고 별도 표시'}


AI_INSTRUCTIONS = ('한국어로 답하세요. 최신 웹 정보를 검색해 보호자가 비교할 수 있는 실제 입소형 요양원 최대 5곳을 알려주세요. '
                   '각 시설 이름과 지역, 비교할 특징을 간단히 적고 확인한 출처를 인용하세요. '
                   '요양병원과 재가 방문요양은 제외하고 특정 업체를 우선하지 마세요. 근거가 부족하면 확인이 어렵다고 말해주세요.')


def ai_prompt(query):
    # Never include our brand, owned URLs, or company profile in the probe prompt.
    return query['keyword'] + '\n' + AI_INSTRUCTIONS


def parse_openai(data):
    if data.get('status') != 'completed':
        raise ValueError('AI response incomplete')
    output = data.get('output', [])
    searched = any(row.get('type') == 'web_search_call' and row.get('status') == 'completed' for row in output)
    parts = [part for row in output if row.get('type') == 'message' for part in row.get('content', []) if part.get('type') == 'output_text']
    text, citations = '', []
    for part in parts:
        offset = len(text)
        text += part.get('text', '') + '\n'
        for item in part.get('annotations', []):
            if item.get('type') == 'url_citation' and safe_url(item.get('url')):
                citations.append({'url': item['url'], 'title': item.get('title', item['url']),
                                  'start': offset + item.get('start_index', len(text)),
                                  'end': offset + item.get('end_index', len(text))})
    if not searched or not text.strip():
        raise ValueError('No completed search answer')
    return text.rstrip(), citations, []


def parse_gemini(data):
    candidate = next(iter(data.get('candidates', [])), {})
    if candidate.get('finishReason') != 'STOP':
        raise ValueError('AI response incomplete')
    text = ''.join(part.get('text', '') for part in candidate.get('content', {}).get('parts', []) if not part.get('thought'))
    grounding = candidate.get('groundingMetadata', {})
    chunks = grounding.get('groundingChunks', [])
    citations = []
    # Gemini segment offsets are bytes; convert to character offsets for rendering.
    for support in grounding.get('groundingSupports', []):
        segment = support.get('segment', {})
        for index in support.get('groundingChunkIndices', []):
            if not isinstance(index, int) or not 0 <= index < len(chunks):
                continue
            web = chunks[index].get('web', {})
            if safe_url(web.get('uri')):
                citations.append({'url': web['uri'], 'title': web.get('title', web['uri']),
                                  'start': len(text.encode()[:segment.get('startIndex', 0)].decode('utf-8', errors='ignore')),
                                  'end': len(text.encode()[:segment.get('endIndex', 0)].decode('utf-8', errors='ignore'))})
    if not grounding.get('webSearchQueries') or not text.strip():
        raise ValueError('No grounded answer with sources')
    # Preserve the provider's required search suggestions in an isolated, script-free iframe.
    suggestions = grounding.get('searchEntryPoint', {}).get('renderedContent', '')
    return text, citations, [{'html': suggestions}] if suggestions else []


def parse_perplexity(data):
    choices = data.get('choices', [])
    if not choices or choices[0].get('finish_reason') != 'stop':
        raise ValueError('AI response incomplete')
    text = choices[0].get('message', {}).get('content', '')
    citations = [{'url': url, 'title': url, 'start': 0, 'end': len(text)} for url in data.get('citations', []) if safe_url(url)]
    if not text.strip():
        raise ValueError('No cited search answer')
    return text, citations, []


def collect_ai(provider, query, config, requester=post_json):
    model, prompt = model_for(provider), ai_prompt(query)
    key = os.environ[PROVIDER_KEYS[provider]]
    if provider == 'openai':
        data = requester('https://api.openai.com/v1/responses', {
            'model': model, 'input': query['keyword'], 'instructions': AI_INSTRUCTIONS, 'store': False, 'max_output_tokens': 1600,
            'tools': [{'type': 'web_search', 'search_context_size': 'medium', 'user_location': {
                'type': 'approximate', 'country': 'KR', 'city': query.get('city', 'Incheon'), 'timezone': 'Asia/Seoul'}}],
            'tool_choice': {'type': 'web_search'}, 'max_tool_calls': OPENAI_MAX_SEARCHES,
        }, {'Authorization': 'Bearer ' + key})
        text, citations, suggestions = parse_openai(data)
    elif provider == 'gemini':
        if not re.fullmatch(r'[a-zA-Z0-9._-]+', model):
            raise ValueError('Invalid Gemini model')
        generation = {'maxOutputTokens': 4096}
        if model.startswith('gemini-3'):
            generation['thinkingConfig'] = {'thinkingLevel': 'low'}
        data = requester('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent', {
            'contents': [{'parts': [{'text': prompt}]}], 'tools': [{'google_search': {}}],
            'generationConfig': generation,
        }, {'x-goog-api-key': key})
        text, citations, suggestions = parse_gemini(data)
    else:
        data = requester('https://api.perplexity.ai/v1/sonar', {
            'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': 1600,
        }, {'Authorization': 'Bearer ' + key})
        text, citations, suggestions = parse_perplexity(data)
    return {'answer': text, 'citations': citations, 'search_suggestions': suggestions, 'grounded': bool(citations),
            'mentioned': brand_mentioned(text, config), 'owned_cited': any(is_owned(c['url'], config) for c in citations),
            'model': data.get('model', data.get('modelVersion', model)), 'prompt': prompt,
            'method': '웹 검색을 사용한 API 답변 · 개인화된 소비자 서비스 화면과 다를 수 있음'}


def keyword_queries(ad_path, now):
    report = naver_ads.keyword_report(ad_path, now)
    # Configuration failures must not silently turn an old keyword inventory into a fresh check.
    if not report.get('updated_at') or report.get('stale'):
        return [], report
    queries = {}
    for item in report['items']:
        keyword = str(item['keyword']).strip()
        if keyword:
            queries.setdefault(keyword, {'keyword': keyword, 'groups': [], 'average_ad_rank': item.get('average_rank'), 'eligible': False})
            queries[keyword]['groups'].append(item['group'])
            queries[keyword]['eligible'] |= item['eligible']
    return list(queries.values()), report


def naver_queries(ad_path, now, config, show_stale=False):
    queries, inventory = keyword_queries(ad_path, now)
    if show_stale and not queries:
        queries = [{'keyword': item['keyword'], 'average_ad_rank': item.get('average_rank'),
                    'eligible': item['eligible'], 'groups': [item['group']]} for item in inventory.get('items', [])]
    combined = {(q['keyword'], 'incheon'): {**q, 'branch': 'incheon', 'source': 'ad_account'} for q in queries}
    for query in config.get('naver_queries', []):
        keyword, branch = query['keyword'].strip(), query['branch']
        if keyword:
            combined.setdefault((keyword, branch), {**query, 'keyword': keyword, 'source': 'regional',
                                                    'groups': [], 'average_ad_rank': None, 'eligible': None})
    return list(combined.values()), inventory


def evidence_branch(text, url, config):
    """Use evidence identity, never the search keyword, to identify a branch."""
    branches = config.get('branches', [])
    if safe_url(url):
        place = [b['id'] for b in branches if is_owned(url, {'place_ids': b.get('place_ids', [])})]
        if len(place) == 1:
            return place[0]
    if not brand_mentioned(text, config):
        return None
    # Other facilities elsewhere in the answer must not supply our branch's city.
    aliases = '|'.join(re.escape(normalized(alias)) for alias in config['aliases'])
    found = set()
    for line in text.splitlines():
        value = normalized(line)
        for match in re.finditer(aliases, value):
            context = value[max(0, match.start()-40):match.end()+80]
            found.update(b['id'] for b in branches if any(normalized(term) in context for term in b['location_terms']))
    return next(iter(found)) if len(found) == 1 else None


def branch_observation(observation, branch, config):
    """Derive a branch view from saved evidence without repeating paid checks."""
    if 'matches' in observation:
        matches, unknown = [], []
        for row in observation.get('matches', []):
            identity = evidence_branch(row['title'], row['url'], config)
            if not identity:
                identity = evidence_branch(row['title']+'\n'+row.get('snippet', ''), row['url'], config)
            if identity == branch:
                matches.append(row)
            elif not identity:
                unknown.append(row)
        organic = [row for row in matches if row['area'] in {'web', 'place'}]
        return {'matches': matches, 'unconfirmed_matches': unknown, 'mentioned': bool(organic),
                'first_page': min((row['page'] for row in organic), default=None),
                'branch_unconfirmed': any(row['area'] in {'web', 'place'} for row in unknown)}
    identity = evidence_branch(observation.get('answer', ''), '', config)
    return {'mentioned': bool(observation.get('mentioned') and identity == branch),
            'branch_unconfirmed': bool(observation.get('mentioned') and not identity),
            'owned_cited': any(is_owned(c['url'], {'place_ids': b['place_ids']})
                               for b in config.get('branches', []) if b['id'] == branch
                               for c in observation.get('citations', []))}


def query_signature(provider, query, config):
    fields = [VERSION, provider, query['keyword'], query.get('city') if provider != 'naver' else None, model_for(provider), config['aliases'], config.get('owned_urls'), config.get('place_ids'),
              ['public-pages-v2', config['max_pages'], bool(os.getenv('SERPAPI_KEY'))] if provider == 'naver' else [ai_prompt(query), OPENAI_MAX_SEARCHES if provider == 'openai' else None]]
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False).encode()).hexdigest()


def check_id(provider, query, config):
    return provider + ':' + query_signature(provider, query, config)


def safe_error(exc):
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 429:
            try:
                message = json.loads(exc.read(16000)).get('error', {}).get('message', '').lower()
                if 'prepayment credits are depleted' in message:
                    return 'Gemini API 크레딧 부족 · Google AI Studio에서 충전 필요'
            except (ValueError, OSError, AttributeError):
                pass
        return f'연결 확인 필요 (HTTP {exc.code})'
    if isinstance(exc, (TimeoutError, urllib.error.URLError)):
        return '응답 지연 · 재시도 대기'
    return '측정 결과를 확인할 수 없어 저장하지 않았습니다'


def sync_provider(path, provider, queries, config, now=None, fetcher=fetch_html, requester=post_json, stop=None):
    live_clock = now is None
    now = now or datetime.now(KST)
    if not configured(provider) or not LOCKS[provider].acquire(blocking=False):
        return []
    results = []
    try:
        with connect(path) as db:
            blocked = db.execute('SELECT payload FROM checks WHERE id=?', (provider+':cooldown',)).fetchone()
        block_state = json.loads(blocked[0]) if blocked else {}
        if block_state and block_state.get('serpapi', False) == bool(os.getenv('SERPAPI_KEY')) and timestamp(block_state['until']) > now:
            return []
        for query in queries:
            if stop and stop.is_set():
                break
            identity = check_id(provider, query, config)
            with connect(path) as db:
                row = db.execute('SELECT payload FROM checks WHERE id=?', (identity,)).fetchone()
            previous = json.loads(row[0]) if row else {}
            last = timestamp(previous.get('last_success'))
            if last and last >= due_at(now):
                continue
            # At most two attempts per scheduled day; persist attempts before paid calls.
            cycle = due_at(now).date().isoformat()
            attempts = previous.get('attempts', 0) if previous.get('cycle') == cycle else 0
            attempt_at = timestamp(previous.get('last_attempt'))
            # Resume an interrupted free public-page read after a deployment. Paid
            # provider attempts remain counted because the request may have completed.
            if provider == 'naver' and not os.getenv('SERPAPI_KEY') and previous.get('running'):
                attempts = max(0, attempts-1)
                attempt_at = None
            if attempts >= 2 or (attempts and attempt_at and now < attempt_at + timedelta(minutes=30)):
                continue
            state = {**previous, 'provider': provider, 'keyword': query['keyword'], 'cycle': cycle,
                     'attempts': attempts+1, 'last_attempt': now.isoformat(), 'error': '', 'running': True}
            with connect(path) as db:
                db.execute('INSERT OR REPLACE INTO checks VALUES(?,?)', (identity, json.dumps(state, ensure_ascii=False)))
            try:
                payload = collect_naver(query, config, fetcher, stop) if provider == 'naver' else collect_ai(provider, query, config, requester)
                observed = datetime.now(KST) if live_clock else now
                payload.update(provider=provider, keyword=query['keyword'], observed_at=observed.isoformat(),
                               signature=query_signature(provider, query, config), query=query)
                completed = {**state, 'last_success': observed.isoformat(), 'error': '', 'running': False}
                with connect(path) as db:
                    db.execute('INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?)',
                               (provider, query['keyword'], cycle, payload['signature'], json.dumps(payload, ensure_ascii=False)))
                    db.execute('INSERT OR REPLACE INTO checks VALUES(?,?)', (identity, json.dumps(completed, ensure_ascii=False)))
                state = completed
                LOG.info('Visibility checked: %s %s', provider, query['keyword'])
            except InterruptedError:
                break
            except Exception as exc:
                state.update(error=safe_error(exc), running=False)
                with connect(path) as db:
                    db.execute('INSERT OR REPLACE INTO checks VALUES(?,?)', (identity, json.dumps(state, ensure_ascii=False)))
                LOG.warning('Visibility check failed: %s %s %s', provider, query['keyword'], state['error'])
                if provider == 'naver' and (isinstance(exc, SearchAccessLimited) or isinstance(exc, urllib.error.HTTPError) and exc.code in {403, 429}):
                    with connect(path) as db:
                        db.execute('INSERT OR REPLACE INTO checks VALUES(?,?)', (provider+':cooldown', json.dumps({
                            'until': next_daily(now).isoformat(), 'serpapi': bool(os.getenv('SERPAPI_KEY')),
                            'error': '검색 제공처의 조회 제한 · 다음 정기 점검까지 중단'})))
                    results.append(state)
                    break
            results.append(state)
        return results
    finally:
        LOCKS[provider].release()


def report(path, ad_path=None, now=None, summary=False):
    now, config = now or datetime.now(KST), settings()
    search_queries, ad_report = naver_queries(ad_path or naver_ads.db_path(), now, config, show_stale=True)
    ai_queries = config['ai_queries'][:config['ai_limit']]
    with connect(path) as db:
        states = {row['id']: json.loads(row['payload']) for row in db.execute('SELECT * FROM checks')}
        history = [json.loads(row['payload']) for row in db.execute('SELECT payload FROM observations WHERE day>=? ORDER BY day DESC', ((now-timedelta(days=30)).date().isoformat(),))]
    providers = []
    for provider, metadata in PROVIDERS.items():
        queries = search_queries if provider == 'naver' else ai_queries
        connected = configured(provider)
        items = []
        for query in queries:
            signature = query_signature(provider, query, config)
            records = [row for row in history if row['provider'] == provider and row['keyword'] == query['keyword'] and row['signature'] == signature]
            observation = records[0] if records else {}
            state = states.get(check_id(provider, query, config), {})
            fresh = bool(connected and observation and timestamp(observation['observed_at']) >= due_at(now) and not state.get('error')
                         and (provider == 'naver' or observation.get('grounded')))
            if provider == 'naver' and query['source'] == 'ad_account' and ad_report.get('stale'):
                fresh = False
            status = 'ready' if fresh else 'unconfigured' if not connected else 'error' if state.get('error') else 'running' if state.get('running') else 'pending'
            if observation and provider != 'naver' and not observation.get('grounded') and not state.get('error'):
                status = 'unverified'
            cooldown = states.get(provider+':cooldown', {})
            if not fresh and cooldown and cooldown.get('serpapi', False) == bool(os.getenv('SERPAPI_KEY')) and timestamp(cooldown['until']) > now:
                status = 'error'
                state = {**state, 'error': cooldown['error']}
            branch = query.get('branch') or next((b['id'] for b in config.get('branches', []) if b['city'] == query.get('city')), None)
            branch_result = branch_observation(observation, branch, config)
            branch_result['history'] = [{'at': row['observed_at'], **{k: value for k, value in branch_observation(row, branch, config).items()
                                                                   if k in {'mentioned', 'first_page'}}}
                                        for row in records[:30] if provider == 'naver' or row.get('grounded')]
            item = {**observation, 'keyword': query['keyword'], 'query': query, 'branch': branch, 'branch_result': branch_result, 'status': status, 'stale': not fresh,
                    'error': state.get('error', ''), 'last_attempt': state.get('last_attempt'),
                    'history': [{'at': row['observed_at'], 'mentioned': row['mentioned'], 'first_page': row.get('first_page')} for row in records[:30] if provider == 'naver' or row.get('grounded')]}
            if summary:
                item = {key: item.get(key) for key in ('keyword', 'branch', 'status', 'stale', 'mentioned', 'first_page', 'observed_at')}
                item['branch_result'] = {k: value for k, value in branch_result.items() if k in {'mentioned', 'first_page', 'branch_unconfirmed'}}
            items.append(item)
        checked = [item for item in items if item['status'] == 'ready']
        providers.append({'id': provider, **metadata, 'configured': connected, 'model': model_for(provider),
                          'expected': len(queries), 'checked': len(checked), 'mentioned': sum(bool(item.get('mentioned')) for item in checked),
                          'first_page': sum(item.get('first_page') == 1 for item in checked), 'items': items})
    return {'brand': config['brand'], 'schedule': SCHEDULE, 'enabled': enabled(), 'next_run': next_daily(now).isoformat(),
            'naver_collection': 'SerpApi' if os.getenv('SERPAPI_KEY') else '공개 검색 페이지',
            'max_pages': config['max_pages'], 'owned_urls': config.get('owned_urls', []), 'providers': providers,
            'branches': [{'id': b['id'], 'name': b['name']} for b in config.get('branches', [])],
            'keyword_source': {'updated_at': ad_report.get('updated_at'), 'stale': ad_report.get('stale'), 'total': len(search_queries),
                               'ad_count': sum(q['source'] == 'ad_account' for q in search_queries),
                               'regional_count': sum(q['source'] == 'regional' for q in search_queries),
                               'method': '인천 광고 계정 등록 키워드와 안양 지역 점검 키워드'},
            'ai_queries': ai_queries, 'generated_at': now.isoformat()}


def start_scheduler(path, ad_path=None):
    stop = threading.Event()

    def run(provider):
        while not stop.is_set():
            try:
                config = settings()
                queries = naver_queries(ad_path or naver_ads.db_path(), datetime.now(KST), config)[0] if provider == 'naver' else config['ai_queries'][:config['ai_limit']]
                sync_provider(path, provider, queries, config, stop=stop)
            except Exception:
                LOG.warning('Visibility scheduler retry: %s', provider)
            stop.wait(60)

    if enabled():
        for provider in PROVIDERS:
            threading.Thread(target=run, args=(provider,), daemon=True, name='visibility-'+provider).start()
    return stop
