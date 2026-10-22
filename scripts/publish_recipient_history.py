"""Validate and publish minimized recipient history over the existing Railway login."""
import argparse
import base64
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recipient_history as model
from publish_claim_check import PROJECT, SERVICE, ENVIRONMENT


def remote(arguments):
    railway = shutil.which('railway')
    if not railway:
        raise RuntimeError('기존 Railway 로그인 환경이 필요합니다.')
    # Never print this command: the payload contains private recipient records.
    result = subprocess.run([railway, 'ssh', '--project', PROJECT, '--service', SERVICE, '--environment', ENVIRONMENT,
                             '--', 'python', '/app/recipient_history.py', *arguments],
                            capture_output=True, text=True, encoding='utf-8', timeout=90)
    if result.returncode:
        raise RuntimeError('원격 저장 실패. 기존 성공 자료는 유지됩니다.')
    for line in reversed(result.stdout.splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            continue
    raise RuntimeError('저장 확인 응답을 받지 못했습니다.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('result', type=Path, nargs='?')
    parser.add_argument('--failure')
    parser.add_argument('--branch', choices=model.BRANCHES)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    if args.failure:
        model.month(args.failure)
        if not args.branch:
            parser.error('--failure에는 --branch가 필요합니다.')
        print(json.dumps(remote(['--failure', args.failure, '--branch', args.branch]) if args.publish else
                         {'benefitMonth': args.failure, 'branch': args.branch, 'validated': True}, ensure_ascii=False))
        return
    if not args.result:
        parser.error('수집 결과 파일이 필요합니다.')
    payload = model.validate(json.loads(args.result.read_text('utf-8-sig')))
    expected = {b['id']: model.digest(b) for b in payload['branches']}
    if args.publish:
        packed = base64.b64encode(gzip.compress(model.encoded(payload), mtime=0)).decode()
        if len(packed) > 23000:
            raise ValueError('전송 크기 초과: 지점별로 나누어 검증·게시해주세요.')
        result = remote(['--import-gzip-base64', packed])
        verified = remote(['--verify', payload['benefitMonth']])
        if result.get('branches') != expected or any(verified.get('branches', {}).get(k) != v for k, v in expected.items()):
            raise RuntimeError('게시 후 재조회 해시 불일치. 완료로 표시하지 마세요.')
    print(json.dumps({'benefitMonth': payload['benefitMonth'], 'branches': expected, 'published': args.publish}, ensure_ascii=False))


if __name__ == '__main__':
    main()
