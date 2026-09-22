"""요양보호사 종사자 평가. 링크·대화·루브릭 점수는 서버에만 저장한다.

GEMINI_API_KEY는 서버에서만 읽고, 응답·로그·저장 본문에 넣지 않는다.
"""
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

KST = timezone(timedelta(hours=9))
PUBLIC = '/api/staff-eval/'
ADMIN = '/api/support/staff-eval'
COOKIE = 'staff_eval'
ROLE = '요양보호사'
BRANCHES = {'': '지점 미지정', 'incheon': '인천점', 'anyang': '안양점'}
STATUS_LABELS = {'pending': '미시작', 'in_progress': '진행중', 'completed': '완료', 'expired': '만료'}
DONE_TEXT = '제출 완료. 결과는 시설장 확인 후 안내됩니다.'
LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
LIVE_INSTRUCTION = (
    '당신은 요양원 요양보호사 지침 숙지 평가의 한국어 음성 진행자입니다. '
    '한 번에 상황 하나만 진행합니다. 점수, 정답, 키워드 목록은 말하지 마세요. '
    '사용자가 [읽기]로 시작하는 글을 보내면 그 글만 자연스러운 한국어로 읽어 주세요. 질문이나 설명을 덧붙이지 마세요. '
    '사용자가 말로 답하면 듣기만 하고, 다음 상황이나 채점은 서버가 정합니다. '
    '되묻기는 서버가 [읽기]로 준 문장이 있을 때만 읽으며, 한 상황을 두 번 넘게 되묻지 마세요.'
)

SCENARIOS = [
    {
        'id': 'fall', 'code': 'A2', 'title': '낙상',
        'prompt': '입소자가 식탁에서 일어서다 비틀거리며 주저앉으려 합니다. 주변에 다른 직원은 없습니다. 즉시 행동, 보고, 기록 순서로 어떻게 하시겠습니까?',
        'required': [
            {'id': 'secure', 'label': '즉시 안전 확보', 'keywords': ('부축', '앉히', '주저앉', '미끄', '위험물')},
            {'id': 'assess', 'label': '상태 확인', 'keywords': ('의식', '통증', '부상', '출혈', '골절')},
            {'id': 'report', 'label': '보고', 'keywords': ('보고', '간호사', '시설장')},
            {'id': 'record', 'label': '기록', 'keywords': ('기록', '일지', '사고')},
        ],
    },
    {
        'id': 'infection', 'code': 'B2', 'title': '감염',
        'prompt': '입소자가 아침부터 발열과 기침을 하고, 같은 방을 쓰는 분이 있습니다. 마스크·격리·보고를 포함해 어떻게 대응하시겠습니까?',
        'required': [
            {'id': 'ppe', 'label': '마스크·손위생', 'keywords': ('마스크', '손위생', '손씻', '손을 씻', '장갑')},
            {'id': 'isolate', 'label': '격리·분리', 'keywords': ('격리', '분리', '같은 방', '환기', '거리')},
            {'id': 'report', 'label': '보고', 'keywords': ('보고', '간호사', '시설장')},
            {'id': 'watch', 'label': '증상 관찰', 'keywords': ('체온', '발열', '증상', '기침')},
        ],
    },
    {
        'id': 'pressure', 'code': 'B3', 'title': '욕창',
        'prompt': '입소자 꼬리뼈 주변이 붉어져 있고, 눌러도 쉽게 사라지지 않습니다. 체위변경과 보고를 포함해 어떻게 하시겠습니까?',
        'required': [
            {'id': 'position', 'label': '체위변경', 'keywords': ('체위', '자세', '돌아눕', '압력', '쿠션')},
            {'id': 'skin', 'label': '피부 확인', 'keywords': ('피부', '발적', '붉어', '크기')},
            {'id': 'report', 'label': '보고', 'keywords': ('보고', '간호사', '시설장')},
            {'id': 'record', 'label': '기록', 'keywords': ('기록', '관찰', '일지')},
        ],
    },
    {
        'id': 'rights', 'code': 'D2', 'title': '인권',
        'prompt': '동료가 목욕을 거부하는 입소자를 억지로 욕실로 데려가려 합니다. 어떻게 대응하시겠습니까?',
        'required': [
            {'id': 'stop', 'label': '강요 중단', 'keywords': ('중단', '말리', '멈추', '제지', '억지로')},
            {'id': 'respect', 'label': '의사 존중', 'keywords': ('거부', '의사', '동의', '설명')},
            {'id': 'report', 'label': '보고', 'keywords': ('보고', '시설장', '인권')},
            {'id': 'alt', 'label': '대안 제안', 'keywords': ('나중에', '다른 방법', '대안', '시간을')},
        ],
    },
    {
        'id': 'emergency', 'code': 'C2', 'title': '응급',
        'prompt': '입소자가 호출에 반응이 없고 호흡이 고르지 않습니다. 119, 시설장 보고, 기록까지 어떤 순서로 하시겠습니까?',
        'required': [
            {'id': 'assess', 'label': '의식·호흡 확인', 'keywords': ('의식', '호흡', '맥박', '기도')},
            {'id': 'call', 'label': '119 연락', 'keywords': ('119', '구급', '응급구조')},
            {'id': 'report', 'label': '시설장·간호사 보고', 'keywords': ('시설장', '보고', '간호사')},
            {'id': 'record', 'label': '기록', 'keywords': ('기록', '시각', '발생')},
        ],
    },
    {
        'id': 'privacy', 'code': 'D3', 'title': '개인정보',
        'prompt': '보호자가 아닌 사람이 전화로 입소자 건강 상태와 방 번호를 요구합니다. 어떻게 대응하시겠습니까?',
        'required': [
            {'id': 'refuse', 'label': '정보 제공 거절', 'keywords': ('알려드리', '거절', '개인정보', '비밀', '제공하지')},
            {'id': 'identify', 'label': '신원 확인', 'keywords': ('보호자', '신원', '본인', '관계')},
            {'id': 'report', 'label': '보고', 'keywords': ('보고', '시설장')},
            {'id': 'record', 'label': '기록', 'keywords': ('기록', '상담')},
        ],
    },
]


def db_path():
    return Path(os.getenv('STAFF_EVAL_DB_PATH', '/data/staff-eval.db'))


def connect():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=20)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    with closing(connect()) as db, db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('''CREATE TABLE IF NOT EXISTS staff_evaluations (
            id TEXT PRIMARY KEY,
            token TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            assignee_name TEXT NOT NULL,
            branch TEXT NOT NULL DEFAULT '',
            birthdate TEXT NOT NULL DEFAULT '',
            employee_hint TEXT NOT NULL DEFAULT '',
            expires REAL NOT NULL,
            status TEXT NOT NULL,
            created TEXT NOT NULL,
            consent_at TEXT,
            verified INTEGER NOT NULL DEFAULT 0,
            verify_fails INTEGER NOT NULL DEFAULT 0,
            cookie_hash TEXT,
            scenario_index INTEGER NOT NULL DEFAULT 0,
            transcript TEXT NOT NULL DEFAULT '[]',
            answers TEXT NOT NULL DEFAULT '{}',
            auto_score INTEGER,
            confirmed_score INTEGER,
            confirmed_at TEXT,
            needs_human INTEGER NOT NULL DEFAULT 0,
            items TEXT NOT NULL DEFAULT '[]',
            gemini_score INTEGER,
            gemini_note TEXT NOT NULL DEFAULT '',
            submitted_at TEXT
        )''')


def now_iso():
    return datetime.now(KST).isoformat(timespec='seconds')


def stamp(epoch):
    return datetime.fromtimestamp(epoch, KST).isoformat(timespec='seconds')


def digits(value):
    return re.sub(r'\D', '', str(value or ''))


def clean_text(value, limit, label):
    if not isinstance(value, str):
        raise ValueError(f'{label}을 확인해 주세요.')
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', value).strip()
    if not text or len(text) > limit:
        raise ValueError(f'{label}을 확인해 주세요.')
    return text


def scrub(text):
    key = os.getenv('GEMINI_API_KEY', '').strip()
    if key and key in text:
        text = text.replace(key, '')
    return text


def scenario_by_index(index):
    if index < 0 or index >= len(SCENARIOS):
        return None
    return SCENARIOS[index]


def load(token=None, eval_id=None):
    init_db()
    with closing(connect()) as db:
        if token:
            row = db.execute('SELECT * FROM staff_evaluations WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        else:
            row = db.execute('SELECT * FROM staff_evaluations WHERE id=?', (eval_id,)).fetchone()
    if not row:
        raise LookupError('평가 링크를 확인해 주세요.')
    return row


def display_status(row, now=None):
    now = time.time() if now is None else now
    if row['status'] == 'completed':
        return 'completed'
    if row['expires'] <= now:
        return 'expired'
    if row['status'] == 'in_progress' or row['consent_at'] or row['verified']:
        return 'in_progress'
    return 'pending'


def step_hit(answer, step):
    folded = re.sub(r'\s+', '', answer).lower()
    return any(keyword.lower().replace(' ', '') in folded for keyword in step['keywords'])


def score_item(answer, scenario):
    steps = scenario['required']
    hits = [step_hit(answer, step) for step in steps]
    present = sum(hits)
    score = round(100 * present / len(steps))
    folded = re.sub(r'\s+', '', answer).lower()
    positions = []
    for step, hit in zip(steps, hits):
        if not hit:
            continue
        positions.append(min(folded.find(keyword.lower().replace(' ', '')) for keyword in step['keywords'] if keyword.lower().replace(' ', '') in folded))
    order_ok = positions == sorted(positions)
    if present > 1 and not order_ok:
        score = max(0, score - 20)
    return {
        'id': scenario['id'], 'code': scenario['code'], 'title': scenario['title'], 'score': score,
        'order_ok': order_ok or present <= 1,
        'steps': [{'id': step['id'], 'label': step['label'], 'met': hit} for step, hit in zip(steps, hits)],
    }


def score_answers(answers):
    items = [score_item(answers.get(scenario['id'], ''), scenario) for scenario in SCENARIOS]
    auto = round(sum(item['score'] for item in items) / len(items))
    needs = False
    for item, scenario in zip(items, SCENARIOS):
        answer = re.sub(r'\s+', '', answers.get(scenario['id'], ''))
        if len(answer) < 8 or not item['order_ok'] or not all(step['met'] for step in item['steps']) or item['score'] < 80:
            needs = True
    return {'auto_score': auto, 'items': items, 'needs_human': needs}


def birth_match(stored, given):
    left, right = digits(stored), digits(given)
    if not left or not right:
        return False
    return left == right or (len(left) == 8 and len(right) == 6 and left[2:] == right) or (len(right) == 8 and len(left) == 6 and right[2:] == left)


def hint_match(stored, given):
    left, right = digits(stored), digits(given)
    return bool(left) and bool(right) and len(right) >= len(left) and (right == left or right.endswith(left))


def create_session(body):
    if not isinstance(body, dict):
        raise ValueError('입력 형식을 확인해 주세요.')
    name = clean_text(body.get('name', ''), 40, '이름')
    branch = body.get('branch') or ''
    if branch not in BRANCHES:
        raise ValueError('지점을 확인해 주세요.')
    birthdate = digits(body.get('birthdate') or '')
    if birthdate and len(birthdate) not in (6, 8):
        raise ValueError('생년월일을 확인해 주세요.')
    hint = digits(body.get('employee_hint') or '')
    if hint and not 2 <= len(hint) <= 8:
        raise ValueError('직원번호 끝자리는 2~8자리로 입력해 주세요.')
    hours = body.get('expiry_hours', 72)
    if isinstance(hours, bool) or not isinstance(hours, (int, float)) or int(hours) != hours or not 1 <= int(hours) <= 168:
        raise ValueError('유효 시간은 1~168시간으로 선택해 주세요.')
    token = secrets.token_urlsafe(32)
    eval_id = uuid.uuid4().hex
    created = now_iso()
    expires = time.time() + int(hours) * 3600
    init_db()
    with closing(connect()) as db, db:
        db.execute('''INSERT INTO staff_evaluations
            (id, token, token_hash, assignee_name, branch, birthdate, employee_hint, expires, status, created)
            VALUES (?,?,?,?,?,?,?,?, 'pending', ?)''',
            (eval_id, token, hashlib.sha256(token.encode()).hexdigest(), name, branch, birthdate, hint, expires, created))
    return {'id': eval_id, 'url': '/staff-eval-session.html#' + token, 'expires': stamp(expires), 'name': name, 'branch': branch}


def listing(branch=''):
    if branch not in BRANCHES:
        raise ValueError('지점을 확인해 주세요.')
    init_db()
    with closing(connect()) as db:
        rows = db.execute('SELECT * FROM staff_evaluations ORDER BY created DESC').fetchall()
    items = []
    for row in rows:
        if branch and row['branch'] != branch:
            continue
        status = display_status(row)
        items.append({
            'id': row['id'], 'name': row['assignee_name'], 'branch': row['branch'], 'branch_label': BRANCHES[row['branch']],
            'role': ROLE, 'status': status, 'status_label': STATUS_LABELS[status],
            'auto_score': row['auto_score'], 'confirmed_score': row['confirmed_score'], 'needs_human': bool(row['needs_human']),
            'created': row['created'], 'expires': stamp(row['expires']), 'submitted_at': row['submitted_at'],
            'url': '/staff-eval-session.html#' + row['token'],
        })
    return {'evaluations': items, 'ai_ready': bool(os.getenv('GEMINI_API_KEY', '').strip()), 'role': ROLE}


def detail(eval_id):
    row = load(eval_id=eval_id)
    status = display_status(row)
    base = listing()
    item = next(entry for entry in base['evaluations'] if entry['id'] == row['id'])
    item.pop('url', None)
    return {
        **item,
        'url': '/staff-eval-session.html#' + row['token'],
        'status': status,
        'status_label': STATUS_LABELS[status],
        'items': json.loads(row['items']),
        'transcript': json.loads(row['transcript']),
        'gemini_score': row['gemini_score'],
        'gemini_note': row['gemini_note'],
        'confirmed_at': row['confirmed_at'],
        'has_birthdate': bool(row['birthdate']),
        'has_employee_hint': bool(row['employee_hint']),
        'ai_ready': base['ai_ready'],
    }


def save_fields(eval_id, **fields):
    keys = list(fields)
    assignments = ', '.join(f'{key}=?' for key in keys)
    with closing(connect()) as db, db:
        db.execute(f'UPDATE staff_evaluations SET {assignments} WHERE id=?', [*fields.values(), eval_id])


def consent(token):
    row = load(token=token)
    if display_status(row) == 'expired':
        raise PermissionError('평가 링크가 만료되었습니다. 시설장에게 새 링크를 요청해 주세요.')
    if row['status'] == 'completed':
        raise PermissionError('이미 제출된 평가입니다.')
    if not row['consent_at']:
        save_fields(row['id'], consent_at=now_iso(), status='in_progress')
    return public_state(load(token=token), False)


def identity_ok(row, body):
    if not isinstance(body, dict):
        raise ValueError('본인 확인 정보를 입력해 주세요.')
    birth_ok = bool(row['birthdate']) and birth_match(row['birthdate'], body.get('birthdate'))
    hint_ok = bool(row['employee_hint']) and hint_match(row['employee_hint'], body.get('employee_hint'))
    if row['birthdate'] or row['employee_hint']:
        return birth_ok or hint_ok
    given = body.get('name')
    return isinstance(given, str) and given.strip() == row['assignee_name']


def issue_cookie(row, secure):
    nonce = secrets.token_urlsafe(32)
    fields = {'verified': 1, 'status': 'in_progress', 'cookie_hash': hashlib.sha256(nonce.encode()).hexdigest(), 'verify_fails': 0}
    if not json.loads(row['transcript']):
        first = SCENARIOS[0]
        transcript = [{'role': 'assistant', 'text': prompt_text(first, 0), 'at': now_iso(), 'scenario_id': first['id']}]
        fields['transcript'] = json.dumps(transcript, ensure_ascii=False)
    save_fields(row['id'], **fields)
    header = f'{COOKIE}={nonce}; Path=/api/staff-eval/; Max-Age={max(60, int(row["expires"] - time.time()))}; HttpOnly; SameSite=Lax'
    if secure:
        header += '; Secure'
    return header


def verify(token, body, secure):
    row = load(token=token)
    if display_status(row) == 'expired':
        raise PermissionError('평가 링크가 만료되었습니다. 시설장에게 새 링크를 요청해 주세요.')
    if row['status'] == 'completed':
        raise PermissionError('이미 제출된 평가입니다.')
    if not row['consent_at']:
        raise PermissionError('평가 안내와 동의 후 본인을 확인해 주세요.')
    if row['verify_fails'] >= 8:
        raise PermissionError('확인 시도가 많습니다. 시설장에게 링크를 다시 요청해 주세요.')
    if not identity_ok(row, body):
        save_fields(row['id'], verify_fails=row['verify_fails'] + 1)
        raise PermissionError('본인 확인 정보가 일치하지 않습니다.')
    header = issue_cookie(row, secure)
    return public_state(load(token=token), True), header


def cookie_ok(handler, row):
    if not row['cookie_hash']:
        return False
    try:
        jar = SimpleCookie(handler.headers.get('Cookie', ''))
        value = jar[COOKIE].value
    except (KeyError, ValueError, AttributeError):
        return False
    digest = hashlib.sha256(value.encode()).hexdigest()
    return hmac.compare_digest(digest, row['cookie_hash'])


def prompt_text(scenario, index):
    return f"상황 {index + 1}/{len(SCENARIOS)} · {scenario['title']}\n{scenario['prompt']}"


def local_reply(scenario, answer, turns):
    missing = [step for step in scenario['required'] if not step_hit(answer, step)]
    if missing and turns < 2:
        return f"{missing[0]['label']}은 어떻게 하실지 한 문장으로 더 말씀해 주세요.", False
    return '확인했습니다.', True


def live_model_id():
    name = os.getenv('STAFF_EVAL_LIVE_MODEL', '').strip() or 'gemini-3.8-live'
    if name.startswith('models/'):
        name = name.split('/', 1)[1]
    if not re.fullmatch(r'[A-Za-z0-9._-]{3,80}', name):
        return 'gemini-3.8-live'
    return name


def last_assistant(row):
    for item in reversed(json.loads(row['transcript'])):
        if item.get('role') == 'assistant' and item.get('text'):
            return item['text']
    return ''


def live_setup():
    """Raw Live API schema (the SDK's LiveConnectConfig is not a wire message)."""
    return {
        'model': 'models/' + live_model_id(),
        'generationConfig': {
            'responseModalities': ['AUDIO'],
            'speechConfig': {'languageCode': 'ko-KR'},
        },
        'systemInstruction': {'parts': [{'text': LIVE_INSTRUCTION}]},
        'inputAudioTranscription': {},
        'outputAudioTranscription': {},
        # The UI has explicit start/end buttons, so pauses must not end a turn.
        'realtimeInputConfig': {'automaticActivityDetection': {'disabled': True}},
    }


def mint_live_token():
    """짧은 Live 토큰만 만든다. GEMINI_API_KEY는 이 요청 헤더에만 둔다."""
    key = os.getenv('GEMINI_API_KEY', '').strip()
    if not key:
        raise RuntimeError('missing')
    moment = datetime.now(timezone.utc)
    payload = {
        'uses': 1,
        'expireTime': (moment + timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'newSessionExpireTime': (moment + timedelta(minutes=2)).strftime('%Y-%m-%dT%H:%M:%SZ'),
        # REST AuthToken takes BidiGenerateContentSetup directly, not the
        # SDK-only liveConnectConstraints wrapper. Omitting fieldMask locks
        # the entire setup to this server-provided evaluation configuration.
        'bidiGenerateContentSetup': live_setup(),
    }
    request = urllib.request.Request(
        'https://generativelanguage.googleapis.com/v1beta/auth_tokens',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'x-goog-api-key': key},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        # Never log request headers, credentials, upstream bodies or answers.
        logging.getLogger(__name__).warning(
            'staff_eval live token failed: type=%s status=%s',
            type(exc).__name__, getattr(exc, 'code', None),
        )
        raise RuntimeError('live') from exc
    name = str(data.get('name') or '').strip() if isinstance(data, dict) else ''
    if not name.startswith('auth_tokens/') or key in name or len(name) > 500:
        raise RuntimeError('live')
    return name


def live_credentials(handler, token):
    row = load(token=token)
    if not cookie_ok(handler, row) or not row['verified']:
        raise wiki_chat_error(401, '본인 확인 후 이어서 답해 주세요.')
    status = display_status(row)
    if status == 'expired':
        raise PermissionError('평가 링크가 만료되었습니다.')
    if status != 'in_progress':
        raise PermissionError('이미 제출된 평가입니다. 다시 보려면 시설장에게 요청해 주세요.')
    try:
        ephemeral = mint_live_token()
    except RuntimeError as exc:
        raise wiki_chat_error(503, '음성 연결을 준비하지 못했습니다. 잠시 후 다시 시도하거나 글로 답해 주세요.') from exc
    return {
        'token': ephemeral,
        'model': 'models/' + live_model_id(),
        'setup': live_setup(),
        'websocket_url': LIVE_WS,
        'system_instruction': LIVE_INSTRUCTION,
        'speak': last_assistant(row),
        'input_rate': 16000,
        'output_rate': 24000,
    }


def wiki_chat_error(status, message):
    import wiki_chat
    return wiki_chat.ChatError(status, message)


def gemini_models():
    primary = os.getenv('STAFF_EVAL_GEMINI_MODEL') or os.getenv('SEARCH_GEMINI_MODEL') or 'gemini-2.5-flash'
    ordered = []
    for name in (primary, 'gemini-2.5-flash', 'gemini-2.0-flash'):
        if name and name not in ordered:
            ordered.append(name)
    return ordered


def gemini_json(system, prompt):
    key = os.getenv('GEMINI_API_KEY', '').strip()
    if not key:
        raise RuntimeError('missing')
    payload = {
        'systemInstruction': {'parts': [{'text': system}]},
        'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
        'generationConfig': {'temperature': 0.2, 'maxOutputTokens': 512},
    }
    raw = json.dumps(payload).encode()
    last_error = None
    for model in gemini_models():
        request = urllib.request.Request(
            f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
            data=raw,
            headers={'Content-Type': 'application/json', 'x-goog-api-key': key},
            method='POST',
        )
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                data = json.loads(response.read().decode())
            text = data['candidates'][0]['content']['parts'][0]['text']
            match = re.search(r'\{.*\}', text, re.S)
            if not match:
                raise ValueError('json')
            return json.loads(match.group(0))
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in (404, 400):
                break
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError, json.JSONDecodeError, IndexError) as exc:
            last_error = exc
            break
    raise RuntimeError('gemini') from last_error


def facilitate(scenario, answer, turns):
    if os.getenv('GEMINI_API_KEY', '').strip():
        try:
            data = gemini_json(
                '당신은 요양원 종사자 평가 진행자입니다. 점수를 말하지 말고, 정답 목록을 알려 주지 마세요. '
                '답변이 즉시 행동·보고·기록을 충분히 말하면 advance를 true로 하세요. 아니면 빠진 행동 하나만 짧게 되물으세요. '
                'JSON만 반환: {"reply":"한국어 한두 문장","advance":true}',
                f'상황: {scenario["prompt"]}\n답변: {answer}\n이미 받은 답변 수: {turns}',
            )
            reply = scrub(str(data.get('reply', '')).strip())[:500]
            if reply:
                advance = data.get('advance')
                if isinstance(advance, str):
                    advance = advance.strip().lower() == 'true'
                return reply, bool(advance) or turns >= 2
        except RuntimeError:
            pass
    return local_reply(scenario, answer, turns)


def gemini_score(answers, rubric):
    if not os.getenv('GEMINI_API_KEY', '').strip():
        return None, ''
    try:
        brief = [{'title': item['title'], 'code': item['code'], 'steps': [step['label'] for step in item['steps']], 'answer': answers.get(item['id'], '')} for item in rubric['items']]
        data = gemini_json(
            '요양보호사 상황판단 채점 보조입니다. 0~100 정수 총점과 20자 이내 메모만 JSON으로 반환하세요. {"score":80,"note":"..."}',
            json.dumps(brief, ensure_ascii=False),
        )
        score = int(data.get('score'))
        if not 0 <= score <= 100:
            raise ValueError('range')
        note = scrub(str(data.get('note', '')).strip())[:80]
        return score, note
    except (RuntimeError, ValueError, TypeError):
        return None, ''


def finalize(eval_id, transcript):
    row = load(eval_id=eval_id)
    answers = json.loads(row['answers'])
    rubric = score_answers(answers)
    gemini, note = gemini_score(answers, rubric)
    needs = rubric['needs_human']
    if gemini is not None and abs(gemini - rubric['auto_score']) >= 15:
        needs = True
    if os.getenv('GEMINI_API_KEY', '').strip() and gemini is None:
        needs = True
        note = note or '자동 채점 초안입니다. 사람 확인이 필요합니다.'
    save_fields(
        eval_id,
        status='completed',
        transcript=json.dumps(transcript, ensure_ascii=False),
        auto_score=rubric['auto_score'],
        items=json.dumps(rubric['items'], ensure_ascii=False),
        needs_human=1 if needs else 0,
        gemini_score=gemini,
        gemini_note=note,
        submitted_at=now_iso(),
        scenario_index=len(SCENARIOS) - 1,
    )


def append_message(token, text):
    row = load(token=token)
    status = display_status(row)
    if status == 'expired':
        raise PermissionError('평가 링크가 만료되었습니다.')
    if status == 'completed' or row['status'] == 'completed':
        raise PermissionError('이미 제출된 평가입니다. 다시 보려면 시설장에게 요청해 주세요.')
    scenario = scenario_by_index(row['scenario_index'])
    if scenario is None:
        raise PermissionError('이미 제출된 평가입니다.')
    message = clean_text(text, 2000, '답변')
    transcript = json.loads(row['transcript'])
    if len(transcript) > 40:
        raise ValueError('대화가 너무 깁니다. 시설장에게 알려 주세요.')
    transcript.append({'role': 'staff', 'text': message, 'at': now_iso(), 'scenario_id': scenario['id']})
    answers = json.loads(row['answers'])
    combined = (answers.get(scenario['id'], '') + '\n' + message).strip()
    answers[scenario['id']] = combined
    turns = sum(1 for item in transcript if item['role'] == 'staff' and item['scenario_id'] == scenario['id'])
    reply, advance = facilitate(scenario, combined, turns)
    if not advance:
        transcript.append({'role': 'assistant', 'text': reply, 'at': now_iso(), 'scenario_id': scenario['id']})
        save_fields(row['id'], transcript=json.dumps(transcript, ensure_ascii=False), answers=json.dumps(answers, ensure_ascii=False), status='in_progress')
        return
    index = row['scenario_index'] + 1
    if index >= len(SCENARIOS):
        transcript.append({'role': 'assistant', 'text': DONE_TEXT, 'at': now_iso(), 'scenario_id': scenario['id']})
        save_fields(row['id'], answers=json.dumps(answers, ensure_ascii=False), transcript=json.dumps(transcript, ensure_ascii=False))
        finalize(row['id'], transcript)
        return
    nxt = SCENARIOS[index]
    transcript.append({'role': 'assistant', 'text': reply + '\n\n' + prompt_text(nxt, index), 'at': now_iso(), 'scenario_id': nxt['id']})
    save_fields(
        row['id'], status='in_progress', scenario_index=index,
        transcript=json.dumps(transcript, ensure_ascii=False), answers=json.dumps(answers, ensure_ascii=False),
    )


def public_state(row, authenticated):
    status = display_status(row)
    payload = {
        'name': row['assignee_name'],
        'branch_label': BRANCHES.get(row['branch'], '지점 미지정'),
        'role': ROLE,
        'status': status,
        'status_label': STATUS_LABELS[status],
        'expires': stamp(row['expires']),
        'consented': bool(row['consent_at']),
        'verified': bool(row['verified']),
        'authenticated': authenticated,
        'needs_birthdate': bool(row['birthdate']),
        'needs_employee_hint': bool(row['employee_hint']),
        'needs_name': not row['birthdate'] and not row['employee_hint'],
        'progress': {'current': min(row['scenario_index'] + 1, len(SCENARIOS)) if status != 'pending' else 0, 'total': len(SCENARIOS)},
        'done_message': DONE_TEXT if status == 'completed' else '',
        'voice': {'preferred': True, 'available': bool(os.getenv('GEMINI_API_KEY', '').strip())},
    }
    if authenticated and row['verified'] and status != 'expired':
        payload['messages'] = json.loads(row['transcript'])
        payload['progress'] = {
            'current': len(SCENARIOS) if status == 'completed' else row['scenario_index'] + 1,
            'total': len(SCENARIOS),
        }
        payload['input_open'] = status == 'in_progress'
    else:
        payload['messages'] = []
        payload['input_open'] = False
    return payload


def state_for(handler, token):
    row = load(token=token)
    return public_state(row, cookie_ok(handler, row) and bool(row['verified']))


def confirm(body):
    if not isinstance(body, dict):
        raise ValueError('입력 형식을 확인해 주세요.')
    row = load(eval_id=str(body.get('id') or ''))
    if row['status'] != 'completed':
        raise ValueError('제출이 끝난 평가만 확정할 수 있습니다.')
    score = body.get('score', row['auto_score'])
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 100:
        raise ValueError('확정 점수는 0~100 정수로 입력해 주세요.')
    save_fields(row['id'], confirmed_score=score, confirmed_at=now_iso())
    return detail(row['id'])


def retake(body):
    if not isinstance(body, dict):
        raise ValueError('입력 형식을 확인해 주세요.')
    row = load(eval_id=str(body.get('id') or ''))
    hours = body.get('expiry_hours', 72)
    if isinstance(hours, bool) or not isinstance(hours, (int, float)) or int(hours) != hours or not 1 <= int(hours) <= 168:
        raise ValueError('유효 시간은 1~168시간으로 선택해 주세요.')
    save_fields(
        row['id'], status='pending', consent_at=None, verified=0, verify_fails=0, cookie_hash=None,
        scenario_index=0, transcript='[]', answers='{}', auto_score=None, confirmed_score=None, confirmed_at=None,
        needs_human=0, items='[]', gemini_score=None, gemini_note='', submitted_at=None,
        expires=time.time() + int(hours) * 3600,
    )
    return detail(row['id'])


def handle(handler, method):
    import support_applications as support
    import wiki_chat
    parts = urllib.parse.urlsplit(handler.path)
    path = parts.path
    public = path.startswith(PUBLIC)
    admin = path == ADMIN or path.startswith(ADMIN + '/')
    if not public and not admin:
        return False
    head = method == 'HEAD'
    try:
        if public:
            token, _, action = path[len(PUBLIC):].partition('/')
            if not re.fullmatch(r'[A-Za-z0-9_-]{20,120}', token) or action not in ('', 'consent', 'verify', 'message', 'live-token'):
                raise LookupError('평가 링크를 확인해 주세요.')
            if action == '' and method in ('GET', 'HEAD'):
                support.send_json(handler, 200, state_for(handler, token), head)
                return True
            if method != 'POST':
                raise wiki_chat.ChatError(405, '지원하지 않는 요청입니다.')
            wiki_chat.check_origin(handler)
            body = wiki_chat.read_json(handler, 8000)
            if action == 'consent':
                if not isinstance(body, dict) or body.get('accepted') is not True:
                    raise ValueError('평가 안내를 확인한 뒤 동의해 주세요.')
                support.send_json(handler, 200, consent(token), head)
            elif action == 'verify':
                secure = bool(os.getenv('RAILWAY_ENVIRONMENT_ID') or handler.headers.get('X-Forwarded-Proto') == 'https')
                payload, cookie_header = verify(token, body, secure)
                support.send_json(handler, 200, payload, head, cookie=cookie_header)
            elif action == 'message':
                row = load(token=token)
                if not cookie_ok(handler, row):
                    raise wiki_chat.ChatError(401, '본인 확인 후 이어서 답해 주세요.')
                if not isinstance(body, dict):
                    raise ValueError('답변을 입력해 주세요.')
                append_message(token, body.get('text', ''))
                support.send_json(handler, 200, state_for(handler, token), head)
            elif action == 'live-token':
                support.send_json(handler, 200, live_credentials(handler, token), head)
            return True
        if not support.authenticated(handler):
            raise wiki_chat.ChatError(401, '담당자 접근 키로 로그인해주세요.')
        route = path[len(ADMIN):]
        if method == 'POST':
            wiki_chat.check_origin(handler)
            body = wiki_chat.read_json(handler, 8000)
            if route == '/create':
                result = create_session(body)
            elif route == '/confirm':
                result = confirm(body)
            elif route == '/retake':
                result = retake(body)
            else:
                raise LookupError('요청한 기능을 찾을 수 없습니다.')
        elif method in ('GET', 'HEAD'):
            query = urllib.parse.parse_qs(parts.query)
            if route == '':
                result = listing(query.get('branch', [''])[0])
            elif route == '/detail':
                result = detail(query.get('id', [''])[0])
            else:
                raise LookupError('요청한 기능을 찾을 수 없습니다.')
        else:
            raise wiki_chat.ChatError(405, '지원하지 않는 요청입니다.')
        support.send_json(handler, 200, result, head)
    except wiki_chat.ChatError as exc:
        support.send_json(handler, exc.status, {'error': str(exc)}, head)
    except PermissionError as exc:
        support.send_json(handler, 403, {'error': str(exc)}, head)
    except LookupError as exc:
        support.send_json(handler, 404, {'error': str(exc)}, head)
    except ValueError as exc:
        support.send_json(handler, 400, {'error': str(exc)}, head)
    except (TypeError, KeyError, json.JSONDecodeError):
        support.send_json(handler, 400, {'error': '입력 내용을 확인해 주세요.'}, head)
    except (sqlite3.Error, OSError):
        support.send_json(handler, 503, {'error': '평가 기록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'}, head)
    return True
