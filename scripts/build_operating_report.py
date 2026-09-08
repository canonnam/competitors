#!/usr/bin/env python3
"""Read source workbooks locally; publish only anonymous monthly aggregates.

Usage: python scripts/build_operating_report.py --source-root /path/to/folders
Requires openpyxl for this offline import only (not the running service).
"""
import argparse
from collections import defaultdict
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import warnings

ROOT = Path(__file__).resolve().parents[1]
EXPENSE_GROUPS = {
    '생계비': '식비', '수급자생계비': '생계급여 지급',
    '수용기관경비': '돌봄용품', '의료비': '의료·약품', '프로그램 사업비': '프로그램',
    '수용비 및 수수료': '물품·수수료', '공공요금 및 각종 세금공과금': '공과금·세금',
    '시설장비유지비': '시설 유지', '기관운영비': '기관 운영', '기타운영비': '기타 운영',
    '여비': '출장·교통', '직책보조비': '인건비', '잡지출': '기타 지출', '반환금': '반환금',
}


def classify(account, memo, income, expense):
    """Return cash-flow bucket. Signed refunds remain signed throughout."""
    compact = re.sub(r'\s+', '', memo)
    if '이월금' in account:
        return 'carry', '이월금'
    if account in {'기타차입금', '금융기관차입금', '원금상환금'}:
        return 'financing', '차입·원금 상환'
    # Interest can also be booked as negative miscellaneous income.
    if '이자' in account and '수입' not in account or ('이자' in memo and account in {'잡지출', '기타잡수입'}):
        return 'operating', '이자'
    if account == '기타전출금':
        return ('financing', '차입·원금 상환') if '원금' in memo else ('transfer', '기타 자금 이동')
    if account in {'시설비', '자산취득비'}:
        return 'investment', '시설·자산 투자'
    if account in {'기타잡수입', '잡지출'}:
        if '대여' in memo:
            return 'financing', '차입·원금 상환'
        if any(word in compact for word in ['오류', '오루입금', '입금오류']):
            return 'correction', '오입금·반환'
        if '보조금이관' in compact:
            return 'transfer', '기타 자금 이동'
    if any(word in account for word in ['급여(', '사회보험부담금', '퇴직금']):
        return 'operating', '인건비'
    if '장기요양급여수입' in account or '가산금수입' in account:
        return 'operating', '요양급여·가산금'
    if account == '본인부담금수입':
        return 'operating', '본인부담금'
    if account == '식재료비수입':
        return 'operating', '식비 수입'
    if '보조금' in account:
        return 'operating', '보조금'
    if account in {'상급침실이용료', '기타비급여수입', '이미용비'}:
        return 'operating', '기타 이용료'
    if account in {'기타잡수입', '기타예금이자수입'}:
        return 'operating', '기타 수입'
    if account in EXPENSE_GROUPS:
        return 'operating', EXPENSE_GROUPS[account]
    raise ValueError(f'Unmapped account: {account}')


def amount(value):
    if value is None:
        return 0
    number = float(value)
    if not number.is_integer():
        raise ValueError(f'Non-integer KRW: {value}')
    return int(number)


def build(source_root):
    import openpyxl
    warnings.filterwarnings('ignore', category=UserWarning, module='openpyxl')
    report = {'schemaVersion': 1, 'sourceDate': '2026-09-08', 'currency': 'KRW', 'branches': [], 'sourceCount': 0}
    for branch_id, name in [('anyang', '안양점'), ('incheon', '인천점')]:
        folder = source_root / f'더비다요양원 {name} 현금출납부'
        paths = sorted(folder.glob('*.xlsx'))
        if not paths:
            raise ValueError(f'No workbooks for {name}')
        branch = {'id': branch_id, 'name': name, 'months': []}
        seen = set()
        for path in paths:
            workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
            if len(workbook.worksheets) != 1:
                raise ValueError(f'Expected one sheet: {path.name}')
            sheet = workbook.active
            sheet.reset_dimensions()  # Source files incorrectly declare A1:A1.
            rows = list(sheet.values)
            workbook.close()
            if tuple(rows[0][:7]) != ('번호', '날짜', '계정과목', '적요', '수입금액', '지출금액', '차인금액'):
                raise ValueError(f'Unexpected headers: {path.name}')
            monthly_controls = [(i, r) for i, r in enumerate(rows, 1) if str(r[0]).strip() == '[월계]']
            if len(monthly_controls) != 1:
                raise ValueError('Expected one monthly control')
            control_row, control = monthly_controls[0]
            transactions = []
            opening = 0
            for row_number, row in enumerate(rows[1:], 2):
                if len(row) < 7:
                    raise ValueError(f'Incomplete row: {path.name}:{row_number}')
                if str(row[0]).startswith('['):
                    continue
                if row[3] == '(전월이월)':
                    opening = amount(row[6])
                    continue
                if not isinstance(row[1], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', row[1]):
                    raise ValueError(f'Invalid transaction date: {path.name}:{row_number}')
                date.fromisoformat(row[1])
                transactions.append((row_number, row))
            periods = {row[1][:7] for _, row in transactions}
            if len(periods) != 1 or periods & seen:
                raise ValueError(f'Duplicate or mixed month: {path.name}')
            month = periods.pop()
            seen.add(month)
            sums = defaultdict(int)
            accounts = defaultdict(lambda: {'income': 0, 'expense': 0, 'count': 0})
            adjustments = defaultdict(lambda: {'income': 0, 'expense': 0, 'count': 0})
            flags = []
            balance = opening
            for row_number, row in transactions:
                _, day, account, memo, incoming, outgoing, ending = row[:7]
                incoming, outgoing = amount(incoming), amount(outgoing)
                balance += incoming - outgoing
                if balance != amount(ending):
                    raise ValueError(f'Running balance mismatch: {path.name}:{row_number}')
                bucket, group = classify(account, memo or '', incoming, outgoing)
                # These deposits are explicitly referenced by later return entries.
                if branch_id == 'anyang' and month == '2025-10' and account == '기타잡수입' and day in {'2025-10-10', '2025-10-11', '2025-10-15'} and incoming in {11000000, 2000000, 4500000}:
                    bucket, group = 'correction', '오입금·반환'
                if branch_id == 'incheon' and day == '2025-09-09' and account == '기타잡수입' and incoming == 3000000:
                    bucket, group = 'correction', '오입금·반환'
                sums['sourceIncome'] += incoming
                sums['sourceExpense'] += outgoing
                sums[bucket] += incoming - outgoing
                if bucket == 'operating':
                    # Interest entered as negative income is normalized to expense.
                    if group == '이자':
                        incoming, outgoing = 0, outgoing - incoming
                    sums['revenue'] += incoming
                    sums['cost'] += outgoing
                    key = (account, group)
                    accounts[key]['income'] += incoming
                    accounts[key]['expense'] += outgoing
                    accounts[key]['count'] += 1
                else:
                    adjustments[group]['income'] += incoming
                    adjustments[group]['expense'] += outgoing
                    adjustments[group]['count'] += 1
                if '이자' in account and '부채상환' in (memo or ''):
                    flags.append({'type': 'classification', 'amount': outgoing, 'message': '이자로 분류된 부채 상환이 포함되어 있습니다. 원금 여부 확인 전까지 원본의 이자 비용으로 반영했습니다.', 'rows': f'C{row_number}:F{row_number}'})
            if (sums['sourceIncome'], sums['sourceExpense'], sums['sourceIncome']-sums['sourceExpense']) != tuple(amount(x) for x in control[4:7]):
                raise ValueError(f'Month total mismatch: {path.name}')
            if not any('급여(' in a for a, _ in accounts):
                flags.append({'type': 'coverage', 'message': '급여 지출이 기록되지 않은 달입니다. 정상 운영 월과 직접 비교할 때 주의가 필요합니다.'})
            if month == '2026-05' and branch_id == 'incheon':
                flags.append({'type': 'timing', 'message': '식비와 사회보험 납부 기록이 없습니다. 다음 달 지급·정산 여부를 확인해야 흑자 지속성을 판단할 수 있습니다.'})
            if month == '2026-07' and branch_id == 'anyang':
                flags.append({'type': 'timing', 'message': '생계급여 지급 2회가 포함되어 있습니다. 월별 지급 시점 차이가 손익에 영향을 줍니다.'})
            cash_change = sums['sourceIncome']-sums['sourceExpense']-sums['carry']
            profit = sums['revenue']-sums['cost']
            if cash_change != profit + sum(sums[k] for k in ['financing', 'investment', 'transfer', 'correction']):
                raise ValueError('Cash bridge does not reconcile')
            branch['months'].append({
                'month': month, 'firstDate': min(r[1] for _,r in transactions), 'lastDate': max(r[1] for _,r in transactions),
                'transactionCount': len(transactions), 'revenue': sums['revenue'], 'cost': sums['cost'], 'profit': profit,
                'cashChange': cash_change, 'closingBalance': balance, 'openingBalance': opening + sums['carry'],
                'financing': sums['financing'], 'investment': sums['investment'], 'transfer': sums['transfer'], 'correction': sums['correction'],
                'carry': sums['carry'], 'sourceIncome': sums['sourceIncome'], 'sourceExpense': sums['sourceExpense'],
                'accounts': [{'account': a, 'group': g, **v} for (a,g),v in sorted(accounts.items())],
                'adjustments': [{'group': g, **v} for g,v in sorted(adjustments.items())], 'flags': flags,
                'source': {'file': path.name, 'sheet': sheet.title, 'range': f'A2:G{control_row-1}', 'controlRange': f'E{control_row}:G{control_row}', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()},
            })
            report['sourceCount'] += 1
        branch['months'].sort(key=lambda m:m['month'])
        report['branches'].append(branch)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT/'data'/'operating_report.json')
    args = parser.parse_args()
    result = build(args.source_root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f"Validated {result['sourceCount']} monthly workbooks; wrote anonymous aggregates.")
