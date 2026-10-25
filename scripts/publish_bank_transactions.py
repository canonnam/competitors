"""Validate original bank XLS locally, then publish over the existing Railway login."""
import argparse
import base64
from datetime import datetime
import gzip
import json
from pathlib import Path
import sys

local_dependencies = Path(__file__).resolve().parents[1] / '.local' / 'deps'
if local_dependencies.is_dir():
    sys.path.insert(0, str(local_dependencies))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bank_transactions as model
from publish_claim_check import PROJECT, SERVICE, ENVIRONMENT
import shutil
import subprocess


def remote(arguments):
    executable = shutil.which('railway')
    if not executable:
        raise RuntimeError('기존 Railway 로그인 환경이 필요합니다.')
    # Windows npm's CMD shim caps commands at 8191 characters. The official
    # installed executable accepts the original file's larger packed payload.
    if Path(executable).suffix.lower() in ('.cmd', '.bat'):
        binary = Path(executable).parent / 'node_modules' / '@railway' / 'cli' / 'bin' / 'railway.exe'
        if not binary.is_file():
            raise RuntimeError('기존 Railway CLI의 실행 파일을 확인해주세요.')
        executable = str(binary)
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
    parser.add_argument('--chunked', action='store_true', help='Use bounded chunks even for small exports')
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
        if len(packed) > 23000 or args.chunked:
            upload_id = model.digest(packed.encode('ascii'))
            chunks = [packed[offset:offset + 6000] for offset in range(0, len(packed), 6000)]
            if len(chunks) > 4000:
                raise ValueError('원본 파일의 전송 크기를 확인해주세요.')
            for part, chunk in enumerate(chunks):
                staged = remote(['--stage-chunk', chunk, '--upload-id', upload_id, '--part', str(part), '--branch', args.branch])
                if staged != {'uploadId': upload_id, 'part': part}:
                    raise RuntimeError('전송 조각 확인에 실패했습니다. 기존 성공 자료는 유지됩니다.')
            stored = remote(['--finish-upload', '--upload-id', upload_id, '--parts', str(len(chunks)), '--branch', args.branch])
        else:
            stored = remote(['--import-gzip-base64', packed, '--branch', args.branch])
        checked = remote(['--verify', args.month, '--branch', args.branch])
        if stored != result or checked != result:
            raise RuntimeError('원본 해시·건수·검증 상태가 게시 후 재조회와 다릅니다.')
    print(json.dumps({**result, 'published': args.publish}, ensure_ascii=False))


if __name__ == '__main__':
    main()
