"""Validate original bank XLS locally, then publish over the existing Railway login."""
import argparse
import base64
from datetime import datetime
import gzip
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bank_transactions as model
from publish_claim_check import PROJECT, SERVICE, ENVIRONMENT
import shutil
import subprocess


def remote(arguments):
    executable = shutil.which('railway')
    if not executable:
        raise RuntimeError('기존 Railway 로그인 환경이 필요합니다.')
    # Financial records travel only to the user's existing protected service.
    result = subprocess.run([executable, 'ssh', '--project', PROJECT, '--service', SERVICE, '--environment', ENVIRONMENT,
                             '--', 'python', '/app/bank_transactions.py', *arguments],
                            capture_output=True, text=True, encoding='utf-8', timeout=90)
    if result.returncode:
        raise RuntimeError('원격 게시 또는 검증 실패. 이전 성공 자료는 유지됩니다.')
    for line in reversed(result.stdout.splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            continue
    raise RuntimeError('저장 확인 응답이 없습니다.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path, nargs='?')
    parser.add_argument('--month', required=True)
    parser.add_argument('--branch', choices=model.BRANCHES, required=True)
    parser.add_argument('--collected-at')
    parser.add_argument('--full-export', action='store_true')
    parser.add_argument('--failure', action='store_true')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    model.month(args.month)
    if args.failure:
        if args.publish:
            print(json.dumps(remote(['--failure', args.month, '--branch', args.branch]), ensure_ascii=False))
        return
    if not args.file or not args.full_export:
        parser.error('전체엑셀다운로드로 받은 파일과 --full-export가 필요합니다.')
    raw = args.file.read_bytes()
    collected = args.collected_at or datetime.fromtimestamp(args.file.stat().st_mtime, model.KST).isoformat()
    result = model.save(raw, args.branch, args.month, collected, True)
    if args.publish:
        value = {'month': args.month, 'branch': args.branch, 'collectedAt': collected, 'fullExport': True,
                 'file': base64.b64encode(raw).decode()}
        packed = base64.b64encode(gzip.compress(model.encoded(value), mtime=0)).decode()
        if len(packed) > 23000:
            raise ValueError('원격 전송 크기 초과. 파일을 자르지 말고 별도 전송 경로를 확인해주세요.')
        stored = remote(['--import-gzip-base64', packed, '--branch', args.branch])
        checked = remote(['--verify', args.month, '--branch', args.branch])
        if stored != result or checked != result:
            raise RuntimeError('원본 해시·건수·검증 상태가 게시 후 재조회와 다릅니다.')
    print(json.dumps({**result, 'published': args.publish}, ensure_ascii=False))


if __name__ == '__main__':
    main()
