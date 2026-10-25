"""Publish a verified PC browser check through the existing Railway login."""
import argparse
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import claim_check

PROJECT = "5b74e687-8712-41c4-8c34-9cb62a686282"
SERVICE = "7eb67a26-90fe-4809-b552-b4da4976b4df"
ENVIRONMENT = "6a839bc7-ff57-4811-abdd-cb74b16d97d2"
URL = "https://app.aivida.tech/api/claim-check"


def read_published(railway, benefit_month=None):
    url = URL + ("?benefitMonth=" + urllib.parse.quote(benefit_month) if benefit_month else "")
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
        try:
            locked = json.load(error).get("code") == "site_locked"
        except (ValueError, AttributeError):
            locked = False
        if not locked:
            raise
    # The site password protects HTTP reads. Use the existing authenticated
    # Railway connection to read the same report used by the production API.
    command = [railway, "ssh", "--project", PROJECT, "--service", SERVICE,
               "--environment", ENVIRONMENT, "--", "python", "/app/claim_check.py"]
    if benefit_month:
        command.extend(["--benefit-month", benefit_month])
    result = subprocess.run(
        command,
        check=True, timeout=90, capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


def verify_published(payload, saved, labor_only=False):
    actual = {b["id"]: b for b in saved["branches"]}
    if saved["benefitMonth"] != payload["benefitMonth"] or set(actual) != {b["id"] for b in payload["branches"]}:
        raise RuntimeError("저장 후 사이트의 대상 월과 지점을 확인하지 못했습니다.")
    for branch in payload["branches"]:
        if not labor_only:
            key = "checkedAt" if branch["querySucceeded"] else "lastQueryFailureAt"
            if actual[branch["id"]].get(key) != branch["checkedAt"]:
                raise RuntimeError("저장 후 사이트 응답을 확인하지 못했습니다. 같은 결과를 재확인해주세요.")
        if "laborCost" in branch:
            labor = branch["laborCost"]
            published = actual[branch["id"]].get("laborCost", {})
            key = "checkedAt" if labor["querySucceeded"] else "lastQueryFailureAt"
            if published.get(key) != labor["checkedAt"] or published.get("benefitMonth") != labor["benefitMonth"] or published.get("year") != labor["year"]:
                raise RuntimeError("인건비 조회월·연도·확인 시각이 사이트와 일치하지 않습니다.")
            if labor["querySucceeded"] and published.get("annualRatio") != labor["annualRatio"]:
                raise RuntimeError("16번 연간비율이 사이트에 반영되지 않았습니다.")
            if "amounts" in labor:
                amounts = labor["amounts"]
                saved_amounts = published.get("amounts", {})
                key = "checkedAt" if amounts["querySucceeded"] else "lastQueryFailureAt"
                if saved_amounts.get(key) != amounts["checkedAt"]:
                    raise RuntimeError("②·③ 금액의 실제 조회 또는 실패 시각이 사이트와 일치하지 않습니다.")
                if amounts["querySucceeded"] and (saved_amounts.get("status") != "verified" or any(
                        saved_amounts.get(field) != amounts[field] for field in claim_check.LABOR_AMOUNT_FIELDS)):
                    raise RuntimeError("②·③ 비용·가산 네 금액이 사이트에 반영되지 않았습니다.")


def verify_history_published(payload, saved, previous=None):
    actual = {b["id"]: b for b in saved["branches"]}
    for branch in payload["branches"]:
        records = {record["benefitMonth"]: record for record in actual[branch["id"]].get("laborHistory", [])}
        for labor in branch["laborCosts"]:
            published = records.get(labor["benefitMonth"], {})
            key = "checkedAt" if labor["querySucceeded"] else "lastQueryFailureAt"
            if published.get(key) != labor["checkedAt"] or published.get("year") != labor["year"]:
                raise RuntimeError("월별 인건비 이력의 조회월·연도·확인 시각이 일치하지 않습니다.")
            if labor["querySucceeded"] and published.get("annualRatio") != labor["annualRatio"]:
                raise RuntimeError("월별 연간비율이 반영되지 않았습니다.")
            if "amounts" in labor:
                amounts = labor["amounts"]
                result = published.get("amounts", {})
                key = "checkedAt" if amounts["querySucceeded"] else "lastQueryFailureAt"
                if result.get(key) != amounts["checkedAt"] or (amounts["querySucceeded"] and any(
                        result.get(field) != amounts[field] for field in claim_check.LABOR_AMOUNT_FIELDS)):
                    raise RuntimeError("월별 네 금액 또는 실제 확인/실패 시각이 반영되지 않았습니다.")
    if previous:
        if saved["benefitMonth"] != previous["benefitMonth"]:
            raise RuntimeError("인건비 이력 게시 중 청구 대상월이 변경되었습니다.")
        for branch in previous["branches"]:
            if any(actual[branch["id"]].get(key) != branch.get(key) for key in (
                    "claims", "checkedAt", "lastQueryFailureAt", "status")):
                raise RuntimeError("인건비 이력 게시 중 기존 청구 결과가 변경되었습니다.")


def verify_claim_archive_published(payload, reports, previous=None, current=None):
    for entry in payload["months"]:
        report = reports[entry["benefitMonth"]]
        if report["benefitMonth"] != entry["benefitMonth"]:
            raise RuntimeError("월별 청구 대상월이 일치하지 않습니다.")
        actual = {b["id"]: b for b in report["branches"]}
        for branch in entry["branches"]:
            saved = actual[branch["id"]]
            key = "checkedAt" if branch["querySucceeded"] else "lastQueryFailureAt"
            if saved.get(key) != branch["checkedAt"] or (branch["querySucceeded"] and saved["claims"] != branch["claims"]):
                raise RuntimeError("월별 청구 내역 또는 실제 조회/실패 시각이 일치하지 않습니다.")
    if previous and current:
        if previous["benefitMonth"] != current["benefitMonth"]:
            raise RuntimeError("과거 청구 게시 중 정기 점검 대상월이 변경되었습니다.")
        actual = {b["id"]: b for b in current["branches"]}
        updated = {b["id"] for e in payload["months"] if e["benefitMonth"] == current["benefitMonth"] for b in e["branches"]}
        for branch in previous["branches"]:
            for key in ("laborCost", "laborHistory"):
                if actual[branch["id"]].get(key) != branch.get(key):
                    raise RuntimeError("청구 이력 게시 중 기존 인건비 자료가 변경되었습니다.")
            if branch["id"] not in updated and any(actual[branch["id"]].get(key) != branch.get(key) for key in ("claims", "checkedAt", "lastQueryFailureAt")):
                raise RuntimeError("조회하지 않은 지점의 기존 청구 결과가 변경되었습니다.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path, help="Credential-free JSON from a completed browser query")
    parser.add_argument("--publish", action="store_true", help="Write the verified result to the website")
    parser.add_argument("--labor-only", action="store_true", help="Publish labor ratios without resubmitting claim results")
    parser.add_argument("--labor-history", action="store_true", help="Backfill past labor months without changing claims")
    parser.add_argument("--claim-history", action="store_true", help="Backfill claim months without changing the monthly target")
    args = parser.parse_args()
    if sum((args.labor_only, args.labor_history, args.claim_history)) > 1:
        parser.error("게시 형식은 하나만 선택해주세요.")
    validator = claim_check.validate_claim_archive_payload if args.claim_history else claim_check.validate_history_payload if args.labor_history else claim_check.validate_labor_payload if args.labor_only else claim_check.validate
    payload = validator(json.loads(args.result.read_text(encoding="utf-8-sig")))
    if not args.publish:
        print("기관 기호·급여제공월·결과 형식 검증 완료. --publish로 반영합니다.")
        return
    railway = shutil.which("railway")
    if not railway:
        raise RuntimeError("Railway CLI에 기존 계정으로 로그인해주세요.")
    encoded = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode()
    if len(encoded) > 16000:
        raise ValueError("필수 청구 3개 항목의 상태만 포함해주세요.")
    previous = read_published(railway) if args.labor_history or args.claim_history else None
    operation = "--import-claim-history-base64" if args.claim_history else "--import-labor-history-base64" if args.labor_history else "--import-labor-base64" if args.labor_only else "--import-base64"
    command = [railway, "ssh", "--project", PROJECT, "--service", SERVICE, "--environment", ENVIRONMENT,
               "--", "python", "/app/claim_check.py", operation, encoded]
    subprocess.run(command, check=True, timeout=90)
    saved = read_published(railway)
    if args.claim_history:
        reports = {entry["benefitMonth"]: read_published(railway, entry["benefitMonth"]) for entry in payload["months"]}
        verify_claim_archive_published(payload, reports, previous, saved)
    elif args.labor_history:
        verify_history_published(payload, saved, previous)
    else:
        verify_published(payload, saved, args.labor_only)
    print("사이트 반영 확인: " + ", ".join(f'{b["name"]} {b["label"]} ({b["verifiedItems"]}/3 항목)' for b in saved["branches"]))


if __name__ == "__main__":
    main()
