"""Current-month LTC claim checks. Certificate login runs on the owner's PC."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
import argparse
import base64
import copy
import json
import os
import re
import tempfile

KST = timezone(timedelta(hours=9))
BRANCHES = {"anyang": ("안양점", "14117000625"), "incheon": ("인천점", "12817700685")}
REQUIRED_CLAIMS = (("노인요양시설(개정법)", "일반"), ("노인요양시설(개정법)", "의료"), ("장기근속장려금", "일반"))
# The owner's operating benchmark; do not carry it into another year without confirmation.
LABOR_BENCHMARKS = {2026: "62.5"}
LABOR_AMOUNT_FIELDS = ("reflectedCost", "reflectedAddition", "unreflectedCost", "unreflectedAddition")


def now_kst():
    return datetime.now(KST)


def data_path():
    return Path(os.getenv("CLAIM_CHECK_PATH", "/data/claim-check.json"))


def period(now=None):
    now = (now or now_kst()).astimezone(KST)
    previous = now.date().replace(day=1) - timedelta(days=1)
    return previous.strftime("%Y-%m"), now.date().replace(day=10)


def labor_period(benefit_month):
    previous = datetime.strptime(benefit_month, "%Y-%m").date() - timedelta(days=1)
    return previous.strftime("%Y-%m"), previous.year


def following_month(month):
    value = datetime.strptime(month, "%Y-%m")
    if value.strftime("%Y-%m") != month:
        raise ValueError("조회월 형식을 확인해주세요.")
    return (value.replace(day=28) + timedelta(days=4)).strftime("%Y-%m")


def validate_labor_history(history, now):
    if not isinstance(history, dict) or set(history) - set(BRANCHES):
        raise ValueError("인건비 이력의 지점을 확인해주세요.")
    for months in history.values():
        if not isinstance(months, dict) or len(months) > 120:
            raise ValueError("인건비 조회월 이력 형식을 확인해주세요.")
        for month, labor in months.items():
            next_month = following_month(month)
            if month > period(now)[0] or labor.get("benefitMonth") != month:
                raise ValueError("인건비 이력에 미래 조회월이나 다른 월이 포함되었습니다.")
            validate_labor(labor, next_month, now)
    return history


def timestamp(value):
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("확인 시각에는 시간대가 필요합니다.")
    return result.astimezone(KST)


def exact_keys(value, keys, optional=()):
    if not isinstance(value, dict) or not set(keys) <= set(value) or set(value) - set(keys) - set(optional):
        raise ValueError("점검 결과의 항목을 확인해주세요.")


def validate_labor_amounts(amounts, now):
    exact_keys(amounts, {"checkedAt", "querySucceeded", *LABOR_AMOUNT_FIELDS}, {"lastQueryFailureAt"})
    if type(amounts["querySucceeded"]) is not bool or timestamp(amounts["checkedAt"]) > now + timedelta(minutes=5):
        raise ValueError("인건비 반영·미반영 금액의 조회 여부와 시각을 확인해주세요.")
    for key in LABOR_AMOUNT_FIELDS:
        value = amounts[key]
        if amounts["querySucceeded"]:
            if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value):
                raise ValueError("②·③ 비용·가산 네 금액을 쉼표·원 기호 없는 정수 문자열로 기록해주세요.")
        elif value is not None:
            raise ValueError("조회하지 못한 금액은 0원으로 추정하지 마세요.")
    if "lastQueryFailureAt" in amounts:
        if not amounts["querySucceeded"] or not timestamp(amounts["checkedAt"]) <= timestamp(amounts["lastQueryFailureAt"]) <= now + timedelta(minutes=5):
            raise ValueError("인건비 금액 재조회 실패 시각을 확인해주세요.")
    return amounts


def validate_labor(labor, benefit_month, now):
    exact_keys(labor, {"benefitMonth", "year", "checkedAt", "querySucceeded", "annualRatio"}, {"lastQueryFailureAt", "amounts"})
    month, year = labor_period(benefit_month)
    if labor["benefitMonth"] != month or type(labor["year"]) is not int or labor["year"] != year:
        raise ValueError("인건비는 청구 급여제공월의 직전 월과 해당 연도로 조회해야 합니다.")
    if type(labor["querySucceeded"]) is not bool or timestamp(labor["checkedAt"]) > now + timedelta(minutes=5):
        raise ValueError("인건비 조회 여부와 시각을 확인해주세요.")
    ratio = labor["annualRatio"]
    if labor["querySucceeded"]:
        if not isinstance(ratio, str) or len(ratio) > 32 or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", ratio):
            raise ValueError("16번 연간비율을 % 기호 없는 숫자 문자열로 기록해주세요.")
    elif ratio is not None:
        raise ValueError("조회하지 못한 인건비 비율을 추정하지 마세요.")
    if "lastQueryFailureAt" in labor:
        if not labor["querySucceeded"] or not timestamp(labor["checkedAt"]) <= timestamp(labor["lastQueryFailureAt"]) <= now + timedelta(minutes=5):
            raise ValueError("인건비 재조회 실패 시각을 확인해주세요.")
    if "amounts" in labor:
        validate_labor_amounts(labor["amounts"], now)
    return labor


def merge_verified_query(incoming, previous):
    if incoming is None:
        return copy.deepcopy(previous)
    result = copy.deepcopy(incoming)
    if previous is None:
        return result
    checked = timestamp(result["checkedAt"])
    prior_checked = timestamp(previous["checkedAt"])
    failed = previous.get("lastQueryFailureAt") if previous["querySucceeded"] else previous["checkedAt"]
    if result["querySucceeded"]:
        if previous["querySucceeded"] and checked < prior_checked:
            raise ValueError("더 오래된 인건비 조회로 최신 비율을 덮어쓸 수 없습니다.")
        if failed and timestamp(failed) >= checked:
            result["lastQueryFailureAt"] = max((failed, result.get("lastQueryFailureAt", failed)), key=timestamp)
    else:
        if checked < max(prior_checked, timestamp(failed) if failed else prior_checked):
            raise ValueError("더 오래된 인건비 조회로 최신 결과를 덮어쓸 수 없습니다.")
        if previous["querySucceeded"]:
            result = {**previous, "lastQueryFailureAt": result["checkedAt"]}
    return result


def merge_labor(incoming, previous):
    result = merge_verified_query(incoming, previous)
    if result is not None:
        amounts = merge_verified_query(incoming.get("amounts") if incoming else None,
                                       previous.get("amounts") if previous else None)
        if amounts is not None:
            result["amounts"] = amounts
    return result


def validate(payload, now=None, require_current=True):
    now = now or now_kst()
    exact_keys(payload, {"benefitMonth", "branches"}, {"laborHistory"})
    if "laborHistory" in payload:
        validate_labor_history(payload["laborHistory"], now)
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
        exact_keys(branch, {"id", "institutionNumber", "checkedAt", "querySucceeded", "claims"}, {"lastQueryFailureAt", "laborCost"})
        ident = branch["id"]
        if ident not in BRANCHES or ident in seen or branch["institutionNumber"] != BRANCHES[ident][1]:
            raise ValueError("지점과 기관 기호가 일치하지 않습니다.")
        seen.add(ident)
        if "laborCost" in branch:
            validate_labor(branch["laborCost"], month, now)
        if timestamp(branch["checkedAt"]) > now + timedelta(minutes=5):
            raise ValueError("확인 시각이 현재보다 늦습니다.")
        if type(branch["querySucceeded"]) is not bool:
            raise ValueError("조회 성공 여부가 필요합니다.")
        if "lastQueryFailureAt" in branch:
            failed_at = timestamp(branch["lastQueryFailureAt"])
            if not branch["querySucceeded"] or not timestamp(branch["checkedAt"]) <= failed_at <= now + timedelta(minutes=5):
                raise ValueError("재조회 실패 시각을 확인해주세요.")
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


def save(payload, path=None, now=None, require_current=True):
    now = now or now_kst()
    payload = validate(copy.deepcopy(payload), now, require_current=require_current)
    incoming_labor = {b["id"] for b in payload["branches"] if "laborCost" in b}
    path = Path(path or data_path())
    if path.exists():
        old = validate(json.loads(path.read_text(encoding="utf-8")), now, require_current=False)
        history = copy.deepcopy(old.get("laborHistory", {}))
        for ident, months in payload.get("laborHistory", {}).items():
            for month, labor in months.items():
                previous = history.setdefault(ident, {}).get(month)
                history[ident][month] = merge_labor(labor, previous)
        if history:
            payload["laborHistory"] = history
        if old.get("benefitMonth") == payload["benefitMonth"]:
            prior = {b["id"]: b for b in old["branches"]}
            for index, branch in enumerate(payload["branches"]):
                previous = prior[branch["id"]]
                labor = merge_labor(branch.get("laborCost"), previous.get("laborCost"))
                checked_at = timestamp(branch["checkedAt"])
                previous_at = timestamp(previous["checkedAt"])
                failed_at = previous.get("lastQueryFailureAt") if previous["querySucceeded"] else previous["checkedAt"]
                if branch["querySucceeded"]:
                    if previous["querySucceeded"] and checked_at < previous_at:
                        raise ValueError("더 오래된 점검으로 최신 결과를 덮어쓸 수 없습니다.")
                    # A failed attempt is not a newer claim result. An earlier verified
                    # result can fill that gap without pretending it was checked again.
                    if failed_at and timestamp(failed_at) >= checked_at:
                        incoming_failure = branch.get("lastQueryFailureAt", failed_at)
                        branch["lastQueryFailureAt"] = max((failed_at, incoming_failure), key=timestamp)
                else:
                    latest_at = max(previous_at, timestamp(failed_at)) if failed_at else previous_at
                    if checked_at < latest_at:
                        raise ValueError("더 오래된 점검으로 최신 결과를 덮어쓸 수 없습니다.")
                    if previous["querySucceeded"]:
                        payload["branches"][index] = {**previous, "lastQueryFailureAt": branch["checkedAt"]}
                if labor is not None:
                    payload["branches"][index]["laborCost"] = labor
    for branch in payload["branches"]:
        if branch["id"] in incoming_labor:
            labor = branch["laborCost"]
            months = payload.setdefault("laborHistory", {}).setdefault(branch["id"], {})
            months[labor["benefitMonth"]] = merge_labor(labor, months.get(labor["benefitMonth"]))
    validate(payload, now, require_current=require_current)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        json.dump(payload, output, ensure_ascii=False)
        temp_path = Path(output.name)
    try:
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def validate_labor_payload(payload, now=None):
    now = now or now_kst()
    exact_keys(payload, {"benefitMonth", "branches"})
    if payload["benefitMonth"] != period(now)[0]:
        raise ValueError("이번 점검 대상 급여제공월만 저장할 수 있습니다.")
    if not isinstance(payload["branches"], list) or len(payload["branches"]) != 2:
        raise ValueError("두 지점의 인건비 결과가 필요합니다.")
    seen = set()
    for branch in payload["branches"]:
        exact_keys(branch, {"id", "institutionNumber", "laborCost"})
        ident = branch["id"]
        if ident not in BRANCHES or ident in seen or branch["institutionNumber"] != BRANCHES[ident][1]:
            raise ValueError("지점과 기관 기호가 일치하지 않습니다.")
        seen.add(ident)
        validate_labor(branch["laborCost"], payload["benefitMonth"], now)
    return payload


def save_labor_costs(payload, path=None, now=None):
    now = now or now_kst()
    payload = validate_labor_payload(payload, now)
    path = Path(path or data_path())
    current = validate(json.loads(path.read_text(encoding="utf-8")), now)
    incoming = {b["id"]: b["laborCost"] for b in payload["branches"]}
    for branch in current["branches"]:
        branch["laborCost"] = merge_labor(incoming[branch["id"]], branch.get("laborCost"))
    save(current, path, now)


def validate_history_payload(payload, now=None):
    now = now or now_kst()
    exact_keys(payload, {"branches"})
    if not isinstance(payload["branches"], list) or not 1 <= len(payload["branches"]) <= 2:
        raise ValueError("수집한 지점의 인건비 이력이 필요합니다.")
    seen = set()
    for branch in payload["branches"]:
        exact_keys(branch, {"id", "institutionNumber", "laborCosts"})
        ident = branch["id"]
        if ident not in BRANCHES or ident in seen or branch["institutionNumber"] != BRANCHES[ident][1]:
            raise ValueError("인건비 이력의 지점과 기관 기호가 일치하지 않습니다.")
        seen.add(ident)
        if not isinstance(branch["laborCosts"], list) or not 1 <= len(branch["laborCosts"]) <= 24:
            raise ValueError("조회한 월별 인건비 이력이 필요합니다.")
        months = {labor["benefitMonth"]: labor for labor in branch["laborCosts"]}
        if len(months) != len(branch["laborCosts"]):
            raise ValueError("같은 지점·조회월의 중복 이력이 있습니다.")
        validate_labor_history({ident: months}, now)
    return payload


def save_labor_history(payload, path=None, now=None):
    now = now or now_kst()
    payload = validate_history_payload(payload, now)
    path = Path(path or data_path())
    current = validate(json.loads(path.read_text(encoding="utf-8")), now, require_current=False)
    history = current.setdefault("laborHistory", {})
    for branch in payload["branches"]:
        months = history.setdefault(branch["id"], {})
        for labor in branch["laborCosts"]:
            month = labor["benefitMonth"]
            months[month] = merge_labor(labor, months.get(month))
            # A historical lookup may also fill the currently displayed labor month.
            for active in current["branches"]:
                if active["id"] == branch["id"] and month == labor_period(current["benefitMonth"])[0]:
                    active["laborCost"] = merge_labor(labor, active.get("laborCost"))
    save(current, path, now, require_current=False)


def labor_report(labor, labor_month, labor_year):
    labor_verified = bool(labor and labor["querySucceeded"])
    amounts = labor.get("amounts") if labor else None
    amounts_verified = bool(amounts and amounts["querySucceeded"])
    amounts_result = {"status": "verified" if amounts_verified else "query_failed" if amounts else "unqueried",
                      "checkedAt": amounts["checkedAt"] if amounts_verified else None,
                      "lastQueryFailureAt": (amounts.get("lastQueryFailureAt") if amounts_verified else amounts["checkedAt"]) if amounts else None,
                      **{key: amounts[key] if amounts_verified else None for key in LABOR_AMOUNT_FIELDS}}
    benchmark = LABOR_BENCHMARKS.get(labor_year)
    assessment = ("stable" if Decimal(labor["annualRatio"]) > Decimal(benchmark) else "check") if labor_verified and benchmark else "unverified" if not labor_verified else "no_benchmark"
    return {"benefitMonth": labor_month, "year": labor_year, "sourceItem": 16,
            "status": "verified" if labor_verified else "query_failed" if labor else "unqueried",
            "annualRatio": labor["annualRatio"] if labor_verified else None,
            "checkedAt": labor["checkedAt"] if labor_verified else None,
            "lastQueryFailureAt": (labor.get("lastQueryFailureAt") if labor_verified else labor["checkedAt"]) if labor else None,
            "benchmarkRatio": benchmark, "assessment": assessment, "amounts": amounts_result}


def report(path=None, now=None):
    now = now or now_kst()
    month, deadline = period(now)
    path = Path(path or data_path())
    stored = {}
    history = {}
    if path.exists():
        payload = validate(json.loads(path.read_text(encoding="utf-8")), now, require_current=False)
        history = payload.get("laborHistory", {})
        if payload["benefitMonth"] == month:
            stored = {b["id"]: b for b in payload["branches"]}
    results = []
    labor_month, labor_year = labor_period(month)
    for ident, (name, _) in BRANCHES.items():
        entry = stored.get(ident)
        labor = entry.get("laborCost") if entry else None
        labor_result = labor_report(labor, labor_month, labor_year)
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
                        "checkedAt": entry["checkedAt"] if entry and entry["querySucceeded"] else None,
                        "lastQueryFailureAt": (entry.get("lastQueryFailureAt") if entry["querySucceeded"] else entry["checkedAt"]) if entry else None,
                        "claims": claims, "count": len(claims), "missing": missing,
                        "verifiedItems": 3 - len(missing), "laborCost": labor_result,
                        "laborHistory": [labor_report(item, item["benefitMonth"], item["year"])
                                         for _, item in sorted(history.get(ident, {}).items(), reverse=True)]})
    all_accepted = all(b["status"] == "accepted" for b in results)
    all_labor = all(b["laborCost"]["status"] == "verified" for b in results)
    all_amounts = all(b["laborCost"]["amounts"]["status"] == "verified" for b in results)
    return {"benefitMonth": month, "deadline": deadline.isoformat(),
            "daysUntilDeadline": (deadline - now.astimezone(KST).date()).days,
            "generatedAt": now.astimezone(KST).isoformat(), "branches": results,
            "allAccepted": all_accepted, "allLaborCostsVerified": all_labor,
            "allLaborAmountsVerified": all_amounts,
            "allChecksComplete": all_accepted and all_labor and all_amounts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-base64", help="Validated, credential-free check result")
    parser.add_argument("--import-labor-base64", help="Update labor ratios without changing claim results")
    parser.add_argument("--import-labor-history-base64", help="Backfill verified labor months without changing claims")
    args = parser.parse_args()
    if args.import_labor_history_base64:
        save_labor_history(json.loads(base64.b64decode(args.import_labor_history_base64, validate=True)))
        print("월별 인건비 이력 저장 완료")
    elif args.import_labor_base64:
        save_labor_costs(json.loads(base64.b64decode(args.import_labor_base64, validate=True)))
        print("인건비 비율 저장 완료")
    elif args.import_base64:
        save(json.loads(base64.b64decode(args.import_base64, validate=True)))
        print("점검 결과 저장 완료")
    else:
        print(json.dumps(report(), ensure_ascii=False))
