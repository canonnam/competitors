"""Shared facility geometry and staff counts, persisted on the Railway volume."""
from contextlib import closing
from datetime import datetime, timezone
import base64
import json
import math
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit

from facility_observation import ApiError, same_origin, send

PREFIX = '/api/facility-projects/'
MAX_BODY = 25_000_128
ROLES = {'care', 'social', 'nurse', 'therapy', 'admin', 'director', 'kitchen', 'other'}
TYPES = {'living', 'office', 'common', 'service', 'core', 'corridor', 'unknown'}
DB_PATH = None


def init_db(path=None):
    global DB_PATH
    DB_PATH = Path(path or os.getenv('FACILITY_PROJECTS_DB_PATH', '/data/facility-projects.db'))
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(DB_PATH)) as con, con:
        con.execute('CREATE TABLE IF NOT EXISTS facility_projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)')


def num(value, minimum, maximum, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum or (integer and value != int(value)):
        raise ApiError(400, '도면 치수와 종사자 인원을 확인해주세요.')
    return int(value) if integer else value


def text(value, fallback=''):
    if value is None:
        return fallback
    if not isinstance(value, str):
        raise ApiError(400, '도면 이름 형식을 확인해주세요.')
    return value.strip()[:80] or fallback


def identifier(value):
    value = text(value)
    if not value or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value):
        raise ApiError(400, '건물·층·공간 식별자를 확인해주세요.')
    return value


def cross(a, b, c):
    return (b['x']-a['x'])*(c['z']-a['z'])-(b['z']-a['z'])*(c['x']-a['x'])


def on_segment(p, a, b):
    return abs(cross(a, b, p)) < 1e-7 and min(a['x'], b['x'])-1e-7 <= p['x'] <= max(a['x'], b['x'])+1e-7 and min(a['z'], b['z'])-1e-7 <= p['z'] <= max(a['z'], b['z'])+1e-7


def segments_meet(a, b, c, d):
    return (cross(a, b, c)*cross(a, b, d) < 0 and cross(c, d, a)*cross(c, d, b) < 0) or any((on_segment(a, c, d), on_segment(b, c, d), on_segment(c, a, b), on_segment(d, a, b)))


def validate(raw):
    # Construct an allowlisted document; ERP credentials and resident records are never persisted.
    if not isinstance(raw, dict) or raw.get('version') != 1 or not isinstance(raw.get('floors'), list) or not 1 <= len(raw['floors']) <= 12:
        raise ApiError(400, '시설 3D 도면 파일 형식을 확인해주세요.')
    p = dict(version=1, id=identifier(raw.get('id')), name=text(raw.get('name'), '새 건물'), width=num(raw.get('width'), 4, 120), depth=num(raw.get('depth'), 4, 120), height=num(raw.get('height'), 2, 6), scale='entered' if raw.get('scale') == 'entered' else 'estimated', example=raw.get('example') is True, nursingHomeId=raw.get('nursingHomeId'), floors=[])
    if isinstance(p['nursingHomeId'], bool) or p['nursingHomeId'] not in (None, 2, 3):
        raise ApiError(400, 'ERP 지점을 확인해주세요.')
    floor_ids, room_ids, total_staff = set(), set(), 0
    for i, raw_floor in enumerate(raw['floors']):
        if not isinstance(raw_floor, dict) or not isinstance(raw_floor.get('rooms'), list) or len(raw_floor['rooms']) > 40:
            raise ApiError(400, '층과 공간 개수를 확인해주세요.')
        f = dict(id=identifier(raw_floor.get('id')), level=i+1, name=text(raw_floor.get('name'), f'{i+1}층'), rooms=[], image=None, staff=[])
        if f['id'] in floor_ids:
            raise ApiError(400, '중복된 층 정보가 있습니다.')
        floor_ids.add(f['id'])
        for raw_room in raw_floor['rooms']:
            if not isinstance(raw_room, dict):
                raise ApiError(400, '공간 정보를 확인해주세요.')
            r = dict(id=identifier(raw_room.get('id')), name=text(raw_room.get('name'), '새 공간'), type=raw_room.get('type') if raw_room.get('type') in TYPES else 'common', beds=num(raw_room.get('beds', 0), 0, 8, True))
            if r['id'] in room_ids:
                raise ApiError(400, '중복된 공간 정보가 있습니다.')
            room_ids.add(r['id'])
            points = raw_room.get('points')
            if points is not None:
                if not isinstance(points, list) or not 3 <= len(points) <= 32 or any(not isinstance(q, dict) for q in points):
                    raise ApiError(400, '다각형은 3~32개 점으로 그려주세요.')
                pts = [dict(x=num(q.get('x'), -p['width']/2, p['width']/2), z=num(q.get('z'), -p['depth']/2, p['depth']/2)) for q in points]
                for j, a in enumerate(pts):
                    b = pts[(j+1) % len(pts)]
                    if math.hypot(a['x']-b['x'], a['z']-b['z']) < .1:
                        raise ApiError(400, '다각형 점 간격을 확인해주세요.')
                    for k in range(j+1, len(pts)):
                        if k == j+1 or (j == 0 and k == len(pts)-1):
                            continue
                        if segments_meet(a, b, pts[k], pts[(k+1) % len(pts)]):
                            raise ApiError(400, '다각형 선이 교차합니다.')
                if abs(sum(a['x']*pts[(j+1) % len(pts)]['z']-pts[(j+1) % len(pts)]['x']*a['z'] for j, a in enumerate(pts))/2) < .25:
                    raise ApiError(400, '다각형 공간이 너무 작습니다.')
                xs, zs = [q['x'] for q in pts], [q['z'] for q in pts]
                r.update(points=pts, x=(min(xs)+max(xs))/2, z=(min(zs)+max(zs))/2, w=max(xs)-min(xs), d=max(zs)-min(zs))
            else:
                r.update(x=num(raw_room.get('x'), -p['width']/2, p['width']/2), z=num(raw_room.get('z'), -p['depth']/2, p['depth']/2), w=num(raw_room.get('w'), .5, p['width']), d=num(raw_room.get('d'), .5, p['depth']))
                if abs(r['x'])+r['w']/2 > p['width']/2+.001 or abs(r['z'])+r['d']/2 > p['depth']/2+.001:
                    raise ApiError(400, '건물 밖에 있는 공간이 있습니다.')
            f['rooms'].append(r)
        image = raw_floor.get('image')
        if image is not None:
            if not isinstance(image, dict) or not isinstance(image.get('src'), str) or len(image['src']) > 1_800_000 or not re.fullmatch(r'data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+', image['src']):
                raise ApiError(400, '도면 이미지 형식을 확인해주세요.')
            try:
                base64.b64decode(image['src'].split(',', 1)[1], validate=True)
            except ValueError:
                raise ApiError(400, '도면 이미지 형식을 확인해주세요.') from None
            f['image'] = dict(src=image['src'], name=text(image.get('name'), '층 도면'), aspect=num(image.get('aspect'), .05, 20))
            if 'labels' in image:
                if not isinstance(image['labels'], list) or len(image['labels']) > 500 or any(not isinstance(q, dict) for q in image['labels']):
                    raise ApiError(400, '도면 글자 정보를 확인해주세요.')
                f['image']['labels'] = [dict(text=text(q.get('text')), x=num(q.get('x'), 0, 1), y=num(q.get('y'), 0, 1), confidence=num(q.get('confidence'), 0, 100)) for q in image['labels']]
        staff = raw_floor.get('staff', [])
        if not isinstance(staff, list) or len(staff) > len(ROLES):
            raise ApiError(400, '종사자 배치 형식을 확인해주세요.')
        seen = set()
        for row in staff:
            if not isinstance(row, dict) or row.get('role') not in ROLES or row['role'] in seen:
                raise ApiError(400, '종사자 직종을 확인해주세요.')
            seen.add(row['role'])
            f['staff'].append(dict(role=row['role'], count=num(row.get('count'), 0, 20, True)))
        count = sum(row['count'] for row in f['staff'])
        total_staff += count
        if count > 80 or total_staff > 200:
            raise ApiError(400, '층당 80명·건물당 200명까지 배치할 수 있습니다.')
        p['floors'].append(f)
    return p


def entry(row):
    return dict(project=json.loads(row['data']), revision=row['revision'], updatedAt=row['updated_at'])


def connect():
    if DB_PATH is None:
        init_db()
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def read_body(handler):
    try:
        length = int(handler.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_BODY:
            raise ApiError(413, '25MB 이하의 도면을 저장해주세요.')
        if handler.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError()
        data = json.loads(handler.rfile.read(length), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(data, dict):
            raise ValueError()
        revision = data.get('revision')
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ValueError()
        return data
    except (ValueError, TypeError, RecursionError):
        raise ApiError(400, '저장 요청 형식을 확인해주세요.') from None


def handle(handler, method):
    path = urlsplit(handler.path).path
    if not path.startswith(PREFIX):
        return False
    head = method == 'HEAD'
    try:
        with closing(connect()) as con, con:
            if path == PREFIX and method in ('GET', 'HEAD'):
                rows = con.execute('SELECT * FROM facility_projects WHERE deleted=0 ORDER BY updated_at DESC, id').fetchall()
                send(handler, 200, dict(projects=[entry(r) for r in rows]), head=head)
                return True
            match = re.fullmatch(re.escape(PREFIX)+r'([A-Za-z0-9_-]{1,80})/(restore/)?', path)
            if (path != PREFIX or method != 'POST') and not (match and (method == 'DELETE' and not match[2] or method == 'POST' and match[2])):
                raise ApiError(404, '도면 저장 주소를 확인해주세요.')
            same_origin(handler)
            data = read_body(handler)
            project = validate(data.get('project')) if path == PREFIX else None
            project_id = project['id'] if project else match[1]
            con.execute('BEGIN IMMEDIATE')
            old = con.execute('SELECT * FROM facility_projects WHERE id=?', (project_id,)).fetchone()
            if data['revision'] != (old['revision'] if old else 0) or (old and old['deleted'] and path == PREFIX):
                raise ApiError(409, '다른 사람이 건물을 변경했습니다. 변경 내용을 파일로 내보낸 뒤 최신 저장본을 다시 열어주세요.')
            if path != PREFIX and not old:
                raise ApiError(404, '저장된 건물이 없습니다.')
            restoring = bool(match and match[2])
            if (project and not old) or restoring:
                if con.execute('SELECT COUNT(*) FROM facility_projects WHERE deleted=0').fetchone()[0] >= 8:
                    raise ApiError(400, '공유 건물은 최대 8개까지 저장할 수 있습니다.')
            revision, updated_at = data['revision']+1, datetime.now(timezone.utc).isoformat()
            if project:
                encoded = json.dumps(project, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
                con.execute('INSERT INTO facility_projects VALUES (?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data, revision=excluded.revision, updated_at=excluded.updated_at', (project_id, encoded, revision, updated_at))
            else:
                con.execute('UPDATE facility_projects SET revision=?,updated_at=?,deleted=? WHERE id=?', (revision, updated_at, 0 if restoring else 1, project_id))
            result = entry(con.execute('SELECT * FROM facility_projects WHERE id=?', (project_id,)).fetchone()) if project or restoring else dict(id=project_id, revision=revision)
        # Commit before acknowledging a successful save.
        send(handler, 200, result)
    except ApiError as error:
        send(handler, error.status, dict(error=error.message), head=head)
    except (OSError, sqlite3.Error):
        send(handler, 503, dict(error='도면 저장소에 연결하지 못했습니다. 잠시 후 다시 저장해주세요.'), head=head)
    except (TypeError, ValueError, RecursionError):
        send(handler, 400, dict(error='도면 형식을 확인해주세요.'), head=head)
    return True
