"""Publish a verified PC browser check through the existing Railway login."""
import argparse
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import claim_check

PROJECT = "5b74e687-8712-41c4-8c34-9cb62a686282"
SERVICE = "7eb67a26-90fe-4809-b552-b4da4976b4df"
ENVIRONMENT = "6a839bc7-ff57-4811-abdd-cb74b16d97d2"
URL = "https://app.aivida.tech/api/claim-check"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path, help="Credential-free JSON from a completed browser query")
    parser.add_argument("--publish", action="store_true", help="Write the verified result to the website")
    args = parser.parse_args()
    payload = claim_check.validate(json.loads(args.result.read_text(encoding="utf-8-sig")))
    if not args.publish:
        print("두 지점·기관 기호·급여제공월·결과 형식 검증 완료. --publish로 반영합니다.")
        return
    railway = shutil.which("railway")
    if not railway:
        raise RuntimeError("Railway CLI에 기존 계정으로 로그인해주세요.")
    encoded = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode()
    if len(encoded) > 16000:
        raise ValueError("필수 청구 3개 항목의 상태만 포함해주세요.")
    command = [railway, "ssh", "--project", PROJECT, "--service", SERVICE, "--environment", ENVIRONMENT,
               "--", "python", "/app/claim_check.py", "--import-base64", encoded]
    subprocess.run(command, check=True, timeout=90)
    with urllib.request.urlopen(URL, timeout=20) as response:
        saved = json.load(response)
    expected_times = {b["id"]: b["checkedAt"] for b in payload["branches"]}
    actual_times = {b["id"]: b["checkedAt"] for b in saved["branches"]}
    if saved["benefitMonth"] != payload["benefitMonth"] or expected_times != actual_times:
        raise RuntimeError("저장 후 사이트 응답을 확인하지 못했습니다. 같은 결과를 재확인해주세요.")
    print("사이트 반영 확인: " + ", ".join(f'{b["name"]} {b["label"]} ({b["verifiedItems"]}/3 항목)' for b in saved["branches"]))


if __name__ == "__main__":
    main()
