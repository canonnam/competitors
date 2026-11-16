"""Serve and publish the internal monthly Carefor comparison report."""
import argparse
import base64
from datetime import date, datetime, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

BRANCHES = {'anyang', 'incheon'}
STATUSES = {'complete', 'partial', 'blocked'}
CATEGORIES = {'admission', 'work', 'misc', 'program'}
TYPES = {'difference', 'review'}
MAX_IMPORT = 2_000_000


def report_path():
    return Path(os.getenv('ERP_LONGTERM_VERIFICATION_PATH', '/data/erp-longterm-verification.json'))


def read_report():
    return json.loads(report_path().read_bytes())


def validate(payload):
    if not isinstance(payload, dict) or set(payload) != {'updatedOn', 'months', 'findings', 'updates'}:
        raise ValueError('invalid report fields')
    if date.fromisoformat(payload['updatedOn']).isoformat() != payload['updatedOn']:
        raise ValueError('invalid report date')
    months = payload['months']
    if not isinstance(months, dict) or not months:
        raise ValueError('invalid months')
    for month, branches in months.items():
        if not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])', month):
            raise ValueError('invalid benefit month')
        if not isinstance(branches, dict) or not branches or not branches.keys() <= BRANCHES:
            raise ValueError('invalid branches')
        for result in branches.values():
            if (not isinstance(result, dict) or not result.keys() <= {'status', 'note'}
                    or result.get('status') not in STATUSES
                    or not isinstance(result.get('note', ''), str)):
                raise ValueError('invalid branch status')
    if not isinstance(payload['findings'], list) or not isinstance(payload['updates'], list):
        raise ValueError('invalid entries')
    for item in payload['findings']:
        required = {'month', 'branch', 'category', 'type', 'detail'}
        if not isinstance(item, dict) or not required <= item.keys() <= required | {'date', 'subject'}:
            raise ValueError('invalid finding fields')
        branch = months.get(item['month'], {}).get(item['branch'])
        if (not branch or branch['status'] == 'blocked' or item['category'] not in CATEGORIES
                or item['type'] not in TYPES
                or not all(isinstance(item.get(key, ''), str) for key in ('date', 'subject', 'detail'))
                or not item['detail'].strip()):
            raise ValueError('invalid finding')
    for item in payload['updates']:
        if (not isinstance(item, dict) or set(item) != {'date', 'title', 'detail'}
                or not all(isinstance(value, str) and value.strip() for value in item.values())):
            raise ValueError('invalid automation update')
        if date.fromisoformat(item['date']).isoformat() != item['date']:
            raise ValueError('invalid update date')
    return payload


def merge_report(previous, incoming):
    months = {month: dict(branches) for month, branches in previous.get('months', {}).items()}
    replaced = set()
    for month, branches in incoming['months'].items():
        stored = months.setdefault(month, {})
        for branch, result in branches.items():
            old = stored.get(branch, {})
            if old.get('status') == 'complete' and result['status'] != 'complete':
                continue
            if old.get('status') == 'partial' and result['status'] == 'blocked':
                continue
            stored[branch] = result
            replaced.add((month, branch))
    def key(item):
        return item['month'], item['branch']
    findings = [row for row in previous.get('findings', []) if key(row) not in replaced]
    findings.extend(row for row in incoming['findings'] if key(row) in replaced)
    findings.sort(key=lambda row: row['month'], reverse=True)
    updates = list(previous.get('updates', []))
    updates.extend(row for row in incoming['updates'] if row not in updates)
    return {'updatedOn': max(previous.get('updatedOn', ''), incoming['updatedOn']),
            'months': months, 'findings': findings, 'updates': updates}


def publish(incoming):
    # The writer runs on the existing Linux Railway service.
    from fcntl import LOCK_EX, flock

    path = report_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a') as lock:
        flock(lock, LOCK_EX)
        try:
            previous = read_report()
        except FileNotFoundError:
            previous = {}
        report = merge_report(previous, incoming)
        if report == {key: previous.get(key) for key in report}:
            return
        report['publishedAt'] = datetime.now(timezone.utc).isoformat()
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.erp-verification-', delete=False) as stream:
            staged = Path(stream.name)
            try:
                stream.write(json.dumps(report, ensure_ascii=False).encode('utf-8'))
                stream.flush()
                os.fsync(stream.fileno())
                stream.close()
                staged.replace(path)
            finally:
                staged.unlink(missing_ok=True)


def verification_summary():
    raw = report_path().read_bytes()
    report = json.loads(raw)
    totals = {branch: {kind: 0 for kind in sorted(TYPES)} for branch in sorted(BRANCHES)}
    for finding in report['findings']:
        totals[finding['branch']][finding['type']] += 1
    return {'sha256': hashlib.sha256(raw).hexdigest(), 'months': len(report['months']),
            'totals': totals, 'updates': len(report['updates'])}


def handle(handler, method):
    if urlsplit(handler.path).path != '/api/erp-longterm-verification':
        return False
    from support_applications import send_json

    try:
        report = read_report()
    except FileNotFoundError:
        send_json(handler, 404, {'error': '게시된 검증 내역이 없습니다.'}, method == 'HEAD')
    except (OSError, ValueError):
        send_json(handler, 503, {'error': '검증 내역을 읽지 못했습니다.'}, method == 'HEAD')
    else:
        send_json(handler, 200, report, method == 'HEAD')
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--import-gzip-base64')
    args = parser.parse_args()
    if args.import_gzip_base64:
        packed = base64.b64decode(args.import_gzip_base64, validate=True)
        with gzip.GzipFile(fileobj=io.BytesIO(packed)) as stream:
            raw = stream.read(MAX_IMPORT + 1)
        if len(raw) > MAX_IMPORT:
            parser.error('import is too large')
        publish(validate(json.loads(raw)))
    print(json.dumps(verification_summary()))
