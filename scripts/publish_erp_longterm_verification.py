"""Publish a verified report to the private Railway volume."""
import argparse
import base64
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import sys

from publish_claim_check import ENVIRONMENT, PROJECT, SERVICE

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from erp_longterm_verification import validate


def remote(railway, *arguments):
    result = subprocess.run(
        [railway, 'ssh', '--project', PROJECT, '--service', SERVICE, '--environment', ENVIRONMENT,
         '--', 'python', '/app/erp_longterm_verification.py', *arguments],
        capture_output=True, text=True, encoding='utf-8', timeout=90,
    )
    if result.returncode:
        raise RuntimeError('운영 검증 내역을 게시하거나 조회하지 못했습니다.')
    for line in reversed(result.stdout.splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            continue
    raise RuntimeError('운영 게시 확인 응답이 없습니다.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    report = validate(json.loads(args.file.read_bytes()))
    if not args.publish:
        print(json.dumps({'months': len(report['months']), 'findings': len(report['findings']),
                          'updates': len(report['updates'])}))
        return

    railway = shutil.which('railway')
    if not railway:
        parser.error('기존 Railway CLI 로그인이 필요합니다.')
    if Path(railway).suffix.lower() in ('.cmd', '.bat'):
        railway = str(Path(railway).parent / 'node_modules' / '@railway' / 'cli' / 'bin' / 'railway.exe')
    data = json.dumps(report, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    packed = base64.b64encode(gzip.compress(data, mtime=0)).decode('ascii')
    if len(packed) > 23000:
        parser.error('지점 또는 월 단위로 나누어 게시해주세요.')
    saved = remote(railway, '--import-gzip-base64', packed)
    if remote(railway) != saved:
        raise RuntimeError('게시 결과와 운영 자료의 해시·건수가 일치하지 않습니다.')
    print(json.dumps(saved))


if __name__ == '__main__':
    main()
