"""Current-month LTC claim checks. Certificate login runs on the owner's PC."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import argparse
import base64
import json
import os
import tempfile

KST = timezone(timedelta(hours=9))
BRANCHES = {"anyang": ("안양점", "14117000625"), "incheon": ("인천점", "12817700685")}
REQUIRED_CLAIMS = (("노인요양시설(개정법)", "일반"), ("노인요양시설(개정법)", "의료"), ("장기근속장려금", "일반"))


def now_kst():
    return datetime.now(KST)


def data_path():
    return Path(os.getenv("CLAIM_CHECK_PATH", "/data/claim-check.json"))


def period(now=None):
    now = (now or now_kst()).astimezone(KST)
    previous = now.date().replace(day=1) - timedelta(days=1)
    return previous.strftime("%Y-%m"), now.date().replace(day=10)


def timestamp(value):
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("확인 시각에는 시간대가 필요합니다.")
    return result.astimezone(KST)


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("점검 결과의 항목을 확인해주세요.")


def validate(payload, now=None, require_current=True):
    now = now or now_kst()
    exact_keys(payload, {"benefitMonth", "branches"})
    month = payload["benefitMonth"]
    if not isinstance(month, str) or datetime.strptime(month, "%Y-%m").strftime("%Y-%m") != month:
        raise ValueError("급여제공월 형식이 올바르지 않습니다.")
    if require_current and month != period(now)[0]:
        raise ValueError("이번 점검 대상 급여제공월만 저장할 수 있습니다.")
    branches = payload["branches"]
    if not isinstance(branches, list) or len(branches) != 2:
        raise ValueError("두 지점의 점검 결과가 필요합니다.")
    seen = set()
    for branch in branches:
        exact_keys(branch, {"id", "institutionNumber", "checkedAt", "querySucceeded", "claims"})
        ident = branch["id"]
        if ident not in BRANCHES or ident in seen or branch["institutionNumber"] != BRANCHES[ident][1]:
            raise ValueError("지점과 기관 기호가 일치하지 않습니다.")
        seen.add(ident)
        if timestamp(branch["checkedAt"]) > now + timedelta(minutes=5):
            raise ValueError("확인 시각이 현재보다 늦습니다.")
        if type(branch["querySucceeded"]) is not bool:
            raise ValueError("조회 성공 여부가 필요합니다.")
        if not isinstance(branch["claims"], list) or len(branch["claims"]) > 100:
            raise ValueError("청구 목록 형식이 올바르지 않습니다.")
        if not branch["querySucceeded"] and branch["claims"]:
            raise ValueError("조회 실패 시 청구 상태를 추정하지 마세요.")
        for claim in branch["claims"]:
            exact_keys(claim, {"benefitMonth", "benefitType", "recipientType", "claimType", "submittedOn", "processingStatus"})
            if claim["benefitMonth"] != month:
                raise ValueError("다른 급여제공월의 청구가 포함되었습니다.")
            for key in ("benefitType", "recipientType", "claimType", "processingStatus"):
                if not isinstance(claim[key], str) or not 1 <= len(claim[key].strip()) <= 40:
                    raise ValueError("청구 항목의 내용을 확인해주세요.")
                claim[key] = claim[key].strip()
            if claim["submittedOn"] is not None:
                datetime.strptime(claim["submittedOn"], "%Y-%m-%d")
    return payload


def save(payload, path=None, now=None):
    now = now or now_kst()
    payload = validate(payload, now)
    path = Path(path or data_path())
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        if old.get("benefitMonth") == payload["benefitMonth"]:
            prior = {b["id"]: timestamp(b["checkedAt"]) for b in old["branches"]}
            if any(timestamp(b["checkedAt"]) < prior.get(b["id"], timestamp(b["checkedAt"])) for b in payload["branches"]):
                raise ValueError("더 오래된 점검으로 최신 결과를 덮어쓸 수 없습니다.")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        json.dump(payload, output, ensure_ascii=False)
        temp_path = Path(output.name)
    try:
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def report(path=None, now=None):
    now = now or now_kst()
    month, deadline = period(now)
    path = Path(path or data_path())
    stored = {}
    if path.exists():
        payload = validate(json.loads(path.read_text(encoding="utf-8")), now, require_current=False)
        if payload["benefitMonth"] == month:
            stored = {b["id"]: b for b in payload["branches"]}
    results = []
    for ident, (name, _) in BRANCHES.items():
        entry = stored.get(ident)
        claims = [c for c in entry["claims"] if (c["benefitType"], c["recipientType"]) in REQUIRED_CLAIMS] if entry else []
        missing = [{"benefitType": kind, "recipientType": recipient} for kind, recipient in REQUIRED_CLAIMS
                   if not any((c["benefitType"], c["recipientType"]) == (kind, recipient) for c in claims)]
        accepted = bool(entry and entry["querySucceeded"] and not missing
                        and all(c["processingStatus"] == "심사" for c in claims))
        if not entry:
            message = "이번 급여제공월의 청구 상태를 확인해야 합니다."
        elif not entry["querySucceeded"]:
            message = "공단 조회를 완료하지 못했습니다. 다시 확인해야 합니다."
        elif missing:
            message = f"필수 청구 항목 {len(missing)}개가 확인되지 않았습니다."
        elif accepted:
            message = "필수 청구 3개 항목이 모두 있고, 처리상태도 모두 심사입니다."
        else:
            message = "심사 이외의 처리상태가 있어 확인이 필요합니다."
        results.append({"id": ident, "name": name, "status": "accepted" if accepted else "check",
                        "label": "접수 완료" if accepted else "점검", "message": message,
                        "checkedAt": entry["checkedAt"] if entry else None,
                        "claims": claims, "count": len(claims), "missing": missing,
                        "verifiedItems": 3 - len(missing)})
    return {"benefitMonth": month, "deadline": deadline.isoformat(),
            "daysUntilDeadline": (deadline - now.astimezone(KST).date()).days,
            "generatedAt": now.astimezone(KST).isoformat(), "branches": results,
            "allAccepted": all(b["status"] == "accepted" for b in results)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-base64", help="Validated, credential-free check result")
    args = parser.parse_args()
    if args.import_base64:
        save(json.loads(base64.b64decode(args.import_base64, validate=True)))
        print("점검 결과 저장 완료")
    else:
        print(json.dumps(report(), ensure_ascii=False))
