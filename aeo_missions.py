"""Evidence-based, sequential AEO tasks with durable shared progress.

Plans use published search guidance, not additional paid model calls. A completed
task records the user's work; it never changes measured search visibility.
"""
from datetime import datetime
import hashlib
import json
import uuid

from competitor_news import KST, connect

VERSION = 'aeo-v1'
GOOGLE = {'title': 'Google 검색의 AI 기능 안내', 'url': 'https://developers.google.com/search/docs/appearance/ai-features'}
BING = {'title': 'Bing AI 노출 측정 안내', 'url': 'https://www.bing.com/webmasters/help/ai-performance-9f8e7d6c'}
REASONS = {'access': '수정 권한 없음', 'website': '공식 페이지 없음', 'information': '자료·사실 확인 필요',
           'time': '시간·인력 부족', 'technical': '방법·기술 지원 필요', 'other': '기타'}
TRACKS = {'improve': '미언급 개선', 'maintain': '노출 유지·상위 노출 확대', 'verify': '측정·지점 확인'}


class Conflict(ValueError):
    pass


def init_db(path):
    with connect(path) as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS aeo_plans (
                id TEXT PRIMARY KEY, track TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS aeo_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL,
                request_id TEXT NOT NULL UNIQUE, mission_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('complete','blocked')),
                reason_code TEXT NOT NULL, reason TEXT NOT NULL, note TEXT NOT NULL,
                evidence_url TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS aeo_plan_events ON aeo_events(plan_id,id);
        ''')


def plan_id(provider, item):
    raw = json.dumps([VERSION, provider, item.get('branch'), item['keyword']], ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def track_for(item):
    evidence = item.get('branch_result', item)
    if item.get('status') != 'ready' or item.get('stale') or evidence.get('branch_unconfirmed'):
        return 'verify'
    return 'maintain' if evidence.get('mentioned') else 'improve'


def mission_catalog(item, branch_name):
    keyword = item['keyword']
    return {
        'measure': {'title': '측정 상태와 지점부터 확인하기', 'minutes': 10,
            'why': '오류·미연결·지점 미확인은 미노출로 판정할 수 없습니다.',
            'steps': ['위 답변의 확인 시각과 연결·오류 안내를 확인하세요.',
                      f'검색을 켠 AI 서비스에서 “{keyword}”를 질문하고 서비스명·날짜·답변 출처를 기록하세요.',
                      f'답변의 시설이 {branch_name}인지 주소와 공식 안내를 대조하세요. 연결 오류는 운영 담당자에게 확인을 요청하세요.'],
            'done': '측정 오류 또는 지점 혼동의 확인 결과와 후속 조치를 메모했습니다.', 'source': BING},
        'access': {'title': '공개된 지점 안내 페이지 확인하기', 'minutes': 15,
            'why': '검색이 읽을 수 있는 공개 페이지가 있어야 시설 정보를 출처로 연결할 수 있습니다.',
            'steps': [f'{branch_name}의 홈페이지 또는 공식 블로그에서 로그인 없이 읽을 수 있는 지점 안내 글 한 개를 정하세요.',
                      '시설명·주소·연락처·제공 서비스가 이미지에만 있지 않고 본문 글자로도 있는지 확인하세요.',
                      '홈페이지가 있다면 관리 담당자에게 해당 공개 페이지의 검색 수집·색인·스니펫 허용 여부를 확인받으세요. 내부 지식 창고는 점검 대상이 아닙니다.'],
            'done': '확인한 공개 페이지 주소와 검색 접근 확인 결과를 기록했습니다.', 'source': GOOGLE},
        'identity': {'title': '지점 이름과 기본 정보 맞추기', 'minutes': 20,
            'why': '브랜드 언급이 해당 지점으로 연결되도록 위치와 시설 정보를 명확하게 제시합니다.',
            'steps': [f'공식 안내 글에서 “더비다요양원 {branch_name}” 표기와 실제 주소·전화번호를 확인하세요.',
                      '관리하는 플레이스·사업자 프로필과 공개 안내 페이지의 기본 정보가 일치하도록 수정하세요.',
                      '제공하는 서비스만 기재하고, 다른 지점의 정보가 섞여 있으면 바로잡으세요.'],
            'done': '수정한 정보 또는 모두 일치함을 확인한 결과를 기록했습니다.', 'source': GOOGLE},
        'answer': {'title': '이 질문에 답하는 안내 글 한 편 만들기', 'minutes': 30,
            'why': '보호자의 질문에 바로 답하는 구체적인 글을 검색에서 발견할 수 있게 만듭니다.',
            'steps': [f'“{keyword}”를 검색한 보호자가 궁금해할 입소 조건·비용 확인 방법·위치 중 한 주제를 고르세요.',
                      f'{branch_name}의 확인된 사실로 짧은 답변과 문답 3개를 작성하고 공식 페이지에 게시하세요.',
                      '확인일·담당 부서와 근거 링크를 넣고, 실제 제공하지 않는 치료·효과·서비스 표현은 제외하세요.'],
            'done': '공개한 안내 글 주소와 답변한 질문을 기록했습니다.', 'source': GOOGLE},
        'evidence': {'title': '안내 글을 공식 근거와 연결하기', 'minutes': 20,
            'why': '정보의 출처와 최신성을 확인할 수 있어야 보호자가 내용을 검증할 수 있습니다.',
            'steps': ['안내 글의 수치·시설 정보에 확인 가능한 공식 출처와 확인일을 붙이세요.',
                      '홈페이지의 지점 소개·서비스 안내에서 새 글로 연결되는 링크를 추가하세요.',
                      '관리 권한이 있는 검색 도구에서 색인 상태를 확인하고, 변경한 공개 페이지의 재수집을 요청하세요.'],
            'done': '추가한 출처·내부 링크 또는 재수집 요청 결과를 기록했습니다.', 'source': GOOGLE},
        'preserve': {'title': '언급된 출처의 강점과 최신성 확인하기', 'minutes': 15,
            'why': '이미 확인된 언급의 근거를 유지하면서 더 많은 관련 질문으로 노출을 넓힙니다.',
            'steps': ['위 실제 답변과 인용 출처에서 더비다를 설명한 내용을 확인하세요.',
                      f'{branch_name}의 주소·서비스·연락처가 현재 사실과 같은지 대조하고, 관리하는 출처의 오래된 내용을 수정하세요.',
                      '답변에 반영된 질문·설명과 유지할 근거를 메모하세요. API 언급을 앱의 고정 순위로 해석하지 마세요.'],
            'done': '유지할 내용과 수정·확인한 출처를 기록했습니다.', 'source': BING},
        'expand': {'title': '연관 질문 한 개까지 답변 넓히기', 'minutes': 30,
            'why': '현재 답변에 부족한 보호자 질문을 보완해 관련 검색에서 발견될 기회를 만듭니다.',
            'steps': [f'“{keyword}”와 관련된 방문 상담·입소 준비·생활 안내 질문 중 한 개를 고르세요.',
                      '기존 글의 반복 대신 확인된 사례·절차·문답으로 구체적인 답변을 추가하세요.',
                      '관련 지점 안내 글끼리 링크를 연결하고 새로 확인한 날짜를 표시하세요.'],
            'done': '보완한 질문과 공개 페이지를 기록했습니다.', 'source': GOOGLE},
        'review': {'title': '7일 관측으로 변화 비교하기', 'minutes': 15,
            'why': '미션 완료와 실제 검색노출 개선은 따로 확인해야 합니다.',
            'steps': ['게시·수정 후 7일 동안 이 화면의 같은 서비스·질문·지점 기록을 확인하세요. 수집 오류는 미언급 횟수에서 빼세요.',
                      '변경 전후의 언급과 공식 출처 인용 여부를 비교해 메모하세요. 아직 7일이 지나지 않았다면 미완료 사유로 남기세요.',
                      '변화가 없다면 해당 AI 답변이 인용한 출처와 내 안내 글을 대조해 부족한 질문·정보 한 가지를 후속 작업으로 적으세요.'],
            'done': '관측 기간과 전후 언급·인용 변화, 후속 보완점을 기록했습니다.', 'source': BING},
    }


def sequence(track):
    if track == 'maintain':
        return ['preserve', 'expand', 'evidence', 'review']
    base = ['access', 'identity', 'answer', 'evidence', 'review']
    return ['measure', *base] if track == 'verify' else base


def view(db, provider, item, branch_name):
    key = plan_id(provider, item)
    plan = db.execute('SELECT * FROM aeo_plans WHERE id=?', (key,)).fetchone()
    track = plan['track'] if plan else track_for(item)
    events = [dict(row) for row in db.execute('SELECT * FROM aeo_events WHERE plan_id=? ORDER BY id', (key,))]
    completed = {event['mission_id'] for event in events if event['action'] == 'complete'}
    ids = sequence(track)
    current_id = next((mid for mid in ids if mid not in completed), None)
    catalog = mission_catalog(item, branch_name)
    current = {'id': current_id, **catalog[current_id]} if current_id else None
    blocked = next((e for e in reversed(events) if e['mission_id'] == current_id), None)
    if current and blocked and blocked['action'] == 'blocked':
        current['blocker'] = {k: blocked[k] for k in ('reason_code', 'reason', 'created_at')}
        current['retry'] = {
            'access': '관리 담당자에게 전달할 수정 요청 초안을 작성하세요. 대상 주소·현재 내용·바꿀 내용을 정리한 뒤, 실제 반영 여부까지 확인하면 이 미션을 완료할 수 있습니다.',
            'website': '먼저 기존 공식 블로그나 관리 중인 지점 프로필에서 공개 안내를 만들 수 있는지 확인하세요. 게시할 곳이 없다면 담당자와 공개 경로를 정한 뒤 같은 미션을 이어가세요.',
            'information': '확인되지 않은 부분을 목록으로 만들고 지점 담당자에게 확인하세요. 답변받은 사실만 반영한 뒤 완료하세요.',
            'time': '오늘은 첫 번째 행동만 10분 동안 진행하세요. 나머지 작업 시간을 정해 같은 미션을 이어가고, 완료 기준까지 마친 뒤 체크하세요.',
            'technical': '대상 주소와 막힌 화면·오류를 정리해 관리 담당자에게 전달하세요. 수정 후 공개 페이지와 처리 결과를 확인하세요.',
            'other': '제출한 사유에서 먼저 해결할 조건 한 가지와 가능한 실행 방법을 정리하세요. 조건이 해결되면 같은 미션을 다시 진행하세요.',
        }[blocked['reason_code']]
    history = [{**{k: e[k] for k in ('action', 'reason_code', 'reason', 'note', 'evidence_url', 'created_at')},
                'title': catalog[e['mission_id']]['title']} for e in events]
    return {'id': key, 'track': track, 'track_label': TRACKS[track], 'revision': plan['revision'] if plan else 0,
            'completed': len(completed), 'total': len(ids), 'current': current, 'history': history,
            'roadmap': [{'id': mid, 'title': catalog[mid]['title'], 'complete': mid in completed} for mid in ids],
            'reason_options': REASONS}


def attach(path, providers, branches):
    names = {b['id']: b['name'] for b in branches}
    with connect(path) as db:
        for provider in providers:
            if provider['kind'] == 'ai':
                for item in provider['items']:
                    item['mission'] = view(db, provider['id'], item, names.get(item.get('branch'), '해당 지점'))


def submit(path, body):
    import search_visibility as visibility
    if not isinstance(body, dict):
        raise ValueError('요청 형식이 올바르지 않습니다.')
    for field in ('provider', 'keyword', 'branch', 'mission_id', 'action', 'request_id'):
        if not isinstance(body.get(field), str) or not body[field] or len(body[field]) > 300:
            raise ValueError('미션 요청 항목을 확인해주세요.')
    try:
        uuid.UUID(body['request_id'])
    except ValueError as exc:
        raise ValueError('저장 요청 번호가 올바르지 않습니다.') from exc
    if type(body.get('revision')) is not int or body['revision'] < 0:
        raise ValueError('미션 상태를 새로고침해주세요.')
    if body['action'] not in {'complete', 'blocked'}:
        raise ValueError('완료 여부를 선택해주세요.')
    for field, limit in (('reason_code', 30), ('reason', 1500), ('note', 1500), ('evidence_url', 2000)):
        value = body.get(field, '')
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError('입력 내용이 너무 길거나 올바르지 않습니다.')
        body[field] = value.strip()
    if body['action'] == 'blocked' and (body['reason_code'] not in REASONS or not body['reason']):
        raise ValueError('미완료 사유의 종류와 구체적인 이유를 입력해주세요.')
    if body['evidence_url'] and not visibility.safe_url(body['evidence_url']):
        raise ValueError('결과 주소는 http 또는 https 주소로 입력해주세요.')
    # Read current measured state, without running a collection or paid API call.
    report = visibility.report(path, summary=True)
    item = next((i for p in report['providers'] if p['id'] == body['provider'] and p['kind'] == 'ai'
                 for i in p['items'] if i['keyword'] == body['keyword'] and i.get('branch') == body['branch']), None)
    if item is None:
        raise LookupError('현재 등록된 AI 질문의 미션만 저장할 수 있습니다.')
    name = next((b['name'] for b in report['branches'] if b['id'] == item['branch']), '해당 지점')
    with connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        state = view(db, body['provider'], item, name)
        previous = db.execute('SELECT * FROM aeo_events WHERE request_id=?', (body['request_id'],)).fetchone()
        if previous:
            if previous['plan_id'] != state['id'] or any(previous[k] != body[k] for k in ('mission_id', 'action', 'reason_code', 'reason', 'note', 'evidence_url')):
                raise Conflict('다른 내용으로 사용된 저장 요청입니다. 새로고침 후 다시 시도해주세요.')
            return state
        if state['revision'] != body['revision'] or not state['current'] or state['current']['id'] != body['mission_id']:
            raise Conflict('미션이 이미 변경되었습니다. 새로고침 후 현재 미션을 확인해주세요.')
        db.execute('INSERT OR IGNORE INTO aeo_plans(id,track) VALUES (?,?)', (state['id'], state['track']))
        db.execute('''INSERT INTO aeo_events(plan_id,request_id,mission_id,action,reason_code,reason,note,evidence_url,created_at)
                      VALUES (?,?,?,?,?,?,?,?,?)''', (state['id'], body['request_id'], body['mission_id'], body['action'],
                      body['reason_code'], body['reason'], body['note'], body['evidence_url'], datetime.now(KST).isoformat()))
        db.execute('UPDATE aeo_plans SET revision=revision+1 WHERE id=?', (state['id'],))
        return view(db, body['provider'], item, name)
