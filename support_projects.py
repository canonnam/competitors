"""Versioned grant preparation, budget scenarios, attachments and scoped expiring shares."""
from contextlib import closing
from datetime import datetime, timezone, timedelta
from decimal import Decimal, ROUND_HALF_UP
import base64
import hashlib
import json
import math
from pathlib import Path
import secrets
import time
import urllib.parse

import support_applications as support
import wiki_chat

ADMIN = '/api/support/projects'
PUBLIC = '/api/project-share/'
KST = timezone(timedelta(hours=9))
SECTIONS = {'overview', 'requirements', 'consortium', 'budget', 'journal', 'files'}
RATES = {'sme': (.25, .10), 'mid': (.30, .13), 'large': (.50, .15), 'nonprofit': (0, 0)}
MAX_FILE = 12 * 1024 * 1024


def init_db():
    with closing(support.connect()) as db, db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS grant_projects(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS grant_history(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS grant_files(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES grant_projects(id), name TEXT NOT NULL, kind TEXT NOT NULL, sha TEXT NOT NULL, content BLOB NOT NULL, created TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS grant_file_dedup ON grant_files(project_id,name,sha);
        CREATE TABLE IF NOT EXISTS grant_shares(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES grant_projects(id), token TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, sections TEXT NOT NULL, file_ids TEXT NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
        ''')
        seed = Path(__file__).parent/'data'/'ax-2026-project.json'
        if seed.exists():
            data = json.loads(seed.read_text(encoding='utf-8'))
            db.execute('INSERT OR IGNORE INTO grant_projects VALUES(?,1,?,?)', (data['id'], support.dumps(data), support.now()))


def text(value, maximum=2000):
    if not isinstance(value, str) or len(value) > maximum: raise ValueError('입력 내용이 너무 길거나 형식이 올바르지 않습니다.')
    return value.strip()


def number(value, maximum=1000000):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= maximum:
        raise ValueError('예산과 비율은 범위 내의 0 이상 숫자로 입력해주세요.')
    return value


def money(value): return float(Decimal(str(value)).quantize(Decimal('.000001'), rounding=ROUND_HALF_UP))


def budget_result(scenario, years):
    """Units: KRW 100 million. Rates are explicitly selected notice assumptions."""
    if not isinstance(scenario, dict): raise ValueError('예산안을 확인해주세요.')
    rows = scenario.get('rows', [])
    if not isinstance(rows, list) or len(rows) > 60: raise ValueError('예산 기관은 60개까지 등록할 수 있습니다.')
    results = []
    for i, year in enumerate(years):
        national, local = number(year['national']), number(year['local'])
        out, allocated, total, regional, unresolved = [], 0, 0, 0, False
        for row in rows:
            name = text(row.get('name', ''), 150)
            rates = row.get('shares', [])
            if len(rates) != len(years): raise ValueError('연차별 배분율을 확인해주세요.')
            rate = number(rates[i], 100)
            kind = row.get('type', 'unknown')
            region = row.get('region', 'unknown')
            if kind not in {*RATES, 'unknown'} or region not in ('local', 'other', 'unknown'): raise ValueError('기관 유형과 소재지를 확인해주세요.')
            grant = money((national + local) * rate / 100)
            allocated += rate
            burden = cash = inkind = full = None
            if kind in RATES:
                own, cashrate = RATES[kind]
                burden = money(grant * own / (1-own))
                cash = money(burden * cashrate)
                inkind = money(burden-cash)
                full = money(grant+burden)
                total += full
                if region == 'local': regional += full
            if rate and (kind == 'unknown' or region == 'unknown'): unresolved = True
            out.append({'name': name, 'type': kind, 'region': region, 'share': rate, 'national': money(national*rate/100), 'local': money(local*rate/100), 'grant': grant, 'burden': burden, 'cash': cash, 'inkind': inkind, 'total': full})
        region_share = money(regional/total*100) if total and not unresolved and abs(allocated-100)<.00001 else None
        results.append({'rows': out, 'allocated': money(allocated), 'unallocated': money((national+local)*max(0,100-allocated)/100), 'overallocated': allocated>100.00001, 'total': None if unresolved else money(total), 'region_share': region_share, 'region_pass': None if region_share is None else region_share>=50})
    return results


def get_project(pid):
    with closing(support.connect()) as db:
        row = db.execute('SELECT * FROM grant_projects WHERE id=?', (pid,)).fetchone()
    if not row: raise LookupError('지원사업을 찾을 수 없습니다.')
    return {'id': row['id'], 'revision': row['revision'], 'data': json.loads(row['data']), 'updated': row['updated']}


def validate(data):
    if not isinstance(data, dict): raise ValueError('지원사업 내용을 확인해주세요.')
    text(data.get('title', ''), 300)
    if not data.get('title', '').strip(): raise ValueError('지원사업명을 입력해주세요.')
    if len(support.dumps(data)) > 600000: raise ValueError('지원사업 내용이 너무 큽니다.')
    years = data.get('years', [])
    if not isinstance(years, list) or len(years)>10: raise ValueError('지원 연차를 확인해주세요.')
    for y in years:
        text(y['label'], 150); number(y['national']); number(y['local'])
    scenarios=data.get('scenarios', [])
    if len(scenarios)>30: raise ValueError('예산안은 30개까지 저장할 수 있습니다.')
    for scenario in scenarios:
        text(scenario.get('name', ''), 150); budget_result(scenario, years)
    for key in ('tasks','partners','journal'):
        if not isinstance(data.get(key, []), list) or len(data.get(key, [])) > 1000: raise ValueError('항목 수를 확인해주세요.')
    return data


def save(body):
    data=validate(body.get('data')); pid=body.get('id'); stamp=support.now()
    with closing(support.connect()) as db, db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT * FROM grant_projects WHERE id=?', (pid,)).fetchone()
        if not row: raise LookupError('지원사업을 찾을 수 없습니다.')
        if row['revision'] != body.get('revision'): raise wiki_chat.ChatError(409,'다른 화면에서 수정되었습니다. 입력 내용을 복사한 뒤 새로고침해주세요.')
        data['id']=pid
        db.execute('INSERT INTO grant_history(project_id,revision,data,created) VALUES(?,?,?,?)',(pid,row['revision'],row['data'],stamp))
        db.execute('UPDATE grant_projects SET revision=revision+1,data=?,updated=? WHERE id=?',(support.dumps(data),stamp,pid))
    return get_project(pid)


def create(body):
    title=text(body.get('title',''),300)
    if not title: raise ValueError('지원사업명을 입력해주세요.')
    pid=support.identity()
    data={'id':pid,'title':title,'code':text(body.get('code',''),100),'summary':'','status':'검토 중','deadline':'','years':[], 'requirements':[], 'kpis':[], 'tasks':[], 'partners':[], 'journal':[], 'scenarios':[], 'sources':[], 'reference':None,'gates':[],'tracks':[]}
    with closing(support.connect()) as db, db: db.execute('INSERT INTO grant_projects VALUES(?,1,?,?)',(pid,support.dumps(data),support.now()))
    return get_project(pid)


def files(pid):
    with closing(support.connect()) as db:
        return [dict(r) for r in db.execute('SELECT id,name,kind,created,length(content) AS size FROM grant_files WHERE project_id=? ORDER BY created DESC',(pid,))]


def upload(body):
    pid=body.get('id'); get_project(pid)
    name=support.docs.clean_name(text(body.get('name',''),250))
    if Path(name).suffix.lower() not in {'.hwp','.hwpx','.xlsx','.xls','.csv','.pdf','.docx','.pptx','.txt','.md','.png','.jpg','.jpeg','.zip'}: raise ValueError('지원하지 않는 파일 형식입니다.')
    raw=base64.b64decode(body.get('base64',''),validate=True)
    if not raw or len(raw)>MAX_FILE: raise ValueError('파일당 12MB 이하의 자료를 선택해주세요.')
    kind=text(body.get('kind','참고 자료'),50); sha=hashlib.sha256(raw).hexdigest()
    with closing(support.connect()) as db, db:
        db.execute('BEGIN IMMEDIATE')
        existing=db.execute('SELECT id FROM grant_files WHERE project_id=? AND name=? AND sha=?',(pid,name,sha)).fetchone()
        if existing: return {'id':existing['id'],'duplicate':True}
        if db.execute('SELECT COALESCE(SUM(length(content)),0) FROM grant_files').fetchone()[0]+len(raw)>1024**3: raise ValueError('자료 보관 용량(1GB)을 초과합니다.')
        fid=support.identity();db.execute('INSERT INTO grant_files VALUES(?,?,?,?,?,?,?)',(fid,pid,name,kind,sha,raw,support.now()))
    return {'id':fid}


def default_expiry(): return f'{datetime.now(KST).year}-12-31'


def share_create(body):
    pid=body.get('id'); get_project(pid)
    sections=body.get('sections',['overview','requirements','consortium'])
    if not isinstance(sections,list) or not sections or not set(sections)<=SECTIONS: raise ValueError('공유할 내용을 선택해주세요.')
    date=text(body.get('expires',default_expiry()),10)
    expiry=datetime.strptime(date,'%Y-%m-%d').replace(hour=23,minute=59,second=59,tzinfo=KST).timestamp()
    if expiry<=time.time(): raise ValueError('열람 기한은 오늘 이후로 선택해주세요.')
    selected=body.get('file_ids',[])
    if not isinstance(selected,list) or not set(selected)<={f['id'] for f in files(pid)}: raise ValueError('공유할 파일을 다시 선택해주세요.')
    if 'files' not in sections:selected=[]
    token=secrets.token_urlsafe(32); sid=support.identity()
    with closing(support.connect()) as db, db:
        db.execute('INSERT INTO grant_shares VALUES(?,?,?,?,?,?,?,?,0,?)',(sid,pid,token,hashlib.sha256(token.encode()).hexdigest(),text(body.get('label','컨소시엄 검토용'),150),support.dumps(sections),support.dumps(selected),expiry,support.now()))
    return {'id':sid,'url':'/support-share.html#'+token,'expires':date}


def resolve_share(token):
    if not isinstance(token,str) or not 30<=len(token)<=100: raise wiki_chat.ChatError(404,'공유 링크를 확인해주세요.')
    with closing(support.connect()) as db:
        row=db.execute('SELECT * FROM grant_shares WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
    if not row: raise wiki_chat.ChatError(404,'공유 링크를 확인해주세요.')
    if row['revoked'] or row['expires']<=time.time(): raise wiki_chat.ChatError(410,'열람 기한이 만료되었거나 공유가 해제되었습니다.')
    return row


def shared_payload(row):
    project=get_project(row['project_id']); data=project['data']; scopes=set(json.loads(row['sections']))
    visible={k:data.get(k) for k in ('id','title','code','status','deadline')}
    fields={'overview':('summary','period','years','gates','tracks','sources','reference'), 'requirements':('requirements','kpis'), 'consortium':('partners',), 'budget':('years','scenarios'), 'journal':('journal',)}
    for scope,keys in fields.items():
        if scope in scopes:
            for key in keys:visible[key]=data.get(key)
    # Preparation assignments and private contacts are never implicitly included.
    if 'partners' in visible: visible['partners']=[{k:p.get(k,'') for k in ('name','role','type','region','status','deliverable')} for p in (visible['partners'] or [])]
    selected=json.loads(row['file_ids'])
    return {'data':visible,'updated':project['updated'],'sections':sorted(scopes),'files':[f for f in files(row['project_id']) if f['id'] in selected] if 'files' in scopes else [],'label':row['label'],'expires':datetime.fromtimestamp(row['expires'],KST).isoformat()}


def handle(handler, method):
    parts=urllib.parse.urlsplit(handler.path); path=parts.path
    public=path.startswith(PUBLIC)
    if not public and not (path==ADMIN or path.startswith(ADMIN+'/')):return False
    query=urllib.parse.parse_qs(parts.query); param=lambda k:query.get(k,[''])[0]; head=method=='HEAD'
    try:
        if public:
            if method not in ('GET','HEAD'):raise wiki_chat.ChatError(405,'공유 화면에서는 열람만 가능합니다.')
            token=path[len(PUBLIC):].split('/')[0]; row=resolve_share(token)
            if path==PUBLIC+token+'/file':
                if 'files' not in json.loads(row['sections']) or param('id') not in json.loads(row['file_ids']):raise wiki_chat.ChatError(404,'공유하지 않은 파일입니다.')
                with closing(support.connect()) as db: f=db.execute('SELECT * FROM grant_files WHERE id=? AND project_id=?',(param('id'),row['project_id'])).fetchone()
                if not f:raise LookupError('파일을 찾을 수 없습니다.')
                support.send_file(handler,f['name'],f['content'],head);return True
            if path!=PUBLIC+token:raise LookupError('공유 화면을 찾을 수 없습니다.')
            result=shared_payload(row)
        else:
            route=path[len(ADMIN):]
            if method=='POST':
                wiki_chat.check_origin(handler)
                body=wiki_chat.read_json(handler,18_000_000 if route=='/upload' else 900000)
                if not isinstance(body,dict):raise ValueError('입력 형식을 확인해주세요.')
                if route=='/save':result=save(body)
                elif route=='/create':result=create(body)
                elif route=='/upload':result=upload(body)
                elif route=='/share':result=share_create(body)
                elif route=='/revoke':
                    with closing(support.connect()) as db, db:db.execute('UPDATE grant_shares SET revoked=1 WHERE id=? AND project_id=?',(body.get('share_id'),body.get('id')))
                    result={'revoked':True}
                else:raise LookupError('요청한 기능을 찾을 수 없습니다.')
            elif method in ('GET','HEAD'):
                if route=='':
                    with closing(support.connect()) as db:rows=db.execute('SELECT id,data,updated FROM grant_projects ORDER BY updated DESC').fetchall()
                    result={'projects':[{'id':r['id'],**{k:json.loads(r['data']).get(k) for k in ('title','code','status','deadline','summary')},'updated':r['updated']} for r in rows], 'default_expiry':default_expiry()}
                elif route=='/detail':
                    result=get_project(param('id'));result['files']=files(param('id'))
                    with closing(support.connect()) as db:
                        result['shares']=[{'id':r['id'],'label':r['label'],'url':'/support-share.html#'+r['token'],'expires':datetime.fromtimestamp(r['expires'],KST).isoformat(),'revoked':bool(r['revoked']),'sections':json.loads(r['sections'])} for r in db.execute('SELECT * FROM grant_shares WHERE project_id=? ORDER BY created DESC',(param('id'),))]
                elif route=='/file':
                    with closing(support.connect()) as db:f=db.execute('SELECT * FROM grant_files WHERE id=?',(param('id'),)).fetchone()
                    if not f:raise LookupError('파일을 찾을 수 없습니다.')
                    support.send_file(handler,f['name'],f['content'],head);return True
                elif route=='/history':
                    with closing(support.connect()) as db:rows=db.execute('SELECT revision,created FROM grant_history WHERE project_id=? ORDER BY revision DESC LIMIT 30',(param('id'),)).fetchall()
                    result={'history':[dict(r) for r in rows]}
                else:raise LookupError('요청한 기능을 찾을 수 없습니다.')
            else:raise wiki_chat.ChatError(405,'지원하지 않는 요청입니다.')
        support.send_json(handler,200,result,head)
    except wiki_chat.ChatError as exc:support.send_json(handler,exc.status,{'error':str(exc)},head)
    except (ValueError,TypeError,KeyError,LookupError) as exc:support.send_json(handler,404 if isinstance(exc,LookupError) else 400,{'error':str(exc) if isinstance(exc,(ValueError,LookupError)) else '입력 형식을 확인해주세요.'},head)
    except Exception:
        support.LOG.exception('Grant workspace failed')
        support.send_json(handler,503,{'error':'저장하지 못했습니다. 입력 내용을 유지한 채 다시 시도해주세요.'},head)
    return True
