"""Publish a private verified snapshot using the operator's existing Railway login."""
import argparse
import base64
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import payroll_insurance as model
from publish_claim_check import PROJECT, SERVICE, ENVIRONMENT


def remote(arguments):
    railway = shutil.which('railway')
    if not railway: raise RuntimeError('기존 Railway 로그인 환경이 필요합니다.')
    command = [railway, 'ssh', '--project', PROJECT, '--service', SERVICE, '--environment', ENVIRONMENT,
               '--', 'python', '/app/payroll_insurance.py', *arguments]
    # Never echo command arguments: the compressed payload contains payroll data.
    completed = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=90)
    if completed.returncode:
        raise RuntimeError('원격 반영 실패. 기존 결과는 유지됩니다. Railway 연결·배포 상태를 확인해주세요.')
    for line in reversed(completed.stdout.splitlines()):
        try: return json.loads(line)
        except ValueError: continue
    raise RuntimeError('원격 반영 결과를 확인하지 못했습니다.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('result', type=Path, nargs='?')
    parser.add_argument('--failure', help='Record a failed YYYY-MM collection without replacing any successful report')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    if args.failure:
        model.month(args.failure)
        print(json.dumps(remote(['--failure', args.failure]) if args.publish else {'month': args.failure, 'validated': True}, ensure_ascii=False))
        return
    if not args.result: parser.error('result 또는 --failure가 필요합니다.')
    payload = model.validate(json.loads(args.result.read_text('utf-8-sig')))
    expected = model.digest(payload)
    if args.publish:
        encoded = base64.b64encode(gzip.compress(model.encoded(payload), mtime=0)).decode()
        if len(encoded) > 23000: raise ValueError('결과 크기가 전송 한도를 초과했습니다.')
        result = remote(['--import-gzip-base64', encoded])
        verified = remote(['--verify', payload['month']])
        if result.get('sha256') != expected or verified.get('sha256') != expected:
            raise RuntimeError('저장 후 검증 해시가 다릅니다. 재수집 없이 저장 상태를 확인해주세요.')
    print(json.dumps({'month': payload['month'], 'sha256': expected, 'published': args.publish}, ensure_ascii=False))


if __name__ == '__main__': main()
