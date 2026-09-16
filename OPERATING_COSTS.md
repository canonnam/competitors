# 더비다 운영비 분석

`/operating-costs.html` compares Anyang and Incheon in one monthly view. The homepage links to it. `/api/operating-report` returns only anonymous monthly account aggregates; workbook files and transaction descriptions are never deployed.

## Refresh the data

Run the offline importer with Python and `openpyxl` installed:

```sh
python scripts/build_operating_report.py --source-root /path/to/source-folders --source-date 2026-09-16
python -m unittest test_operating_report test_static_pages
node test_operating_math.cjs
```

The source directory must contain `더비다요양원 안양점 현금출납부` and `더비다요양원 인천점 현금출납부`. Each workbook must represent exactly one month. Import rejects duplicate months, unknown accounts, fractional KRW, unexpected headers, mixed dates, and any mismatch in running balances or monthly controls. The exported worksheet dimensions incorrectly say A1:A1, so the importer explicitly resets them. Original files are read only. `--source-date` records the review date and defaults to today; the transaction dates determine the covered months. Review dated classification exceptions and month-specific notes when importing new exports. This snapshot was reviewed September 16, 2026.

Commit the regenerated `data/operating_report.json` with the code and push `petdev`. Railway's existing `vida` project, `dev` environment, `competitors` service builds this branch through its Dockerfile. No production Python dependencies or database migrations were added. This report is a snapshot; it does not collect future workbooks automatically.

## Definitions and review points

- Operating result: signed operating receipts less signed operating payments, including interest. This cash-based management measure is not accrual net income. No depreciation, unpaid bills or receivables are available.
- Carry-forward is opening cash, not new income. Borrowing/principal repayments, facility/asset investment, identified mistaken transfers/returns, and other transfers sit outside operating results. The bridge reconciles to original receipts less payments, excluding carry-forward.
- Negative income and expense values are preserved. Interest posted as negative miscellaneous income is normalized to interest expense without changing cash or operating result.
- Account classification is supplemented by transaction descriptions. Anyang's 2025-10 deposits of KRW 11m, 2m and 4.5m are identified by original dates and amounts in later return descriptions (2026-03-10, 2026-01-13, 2026-06-22). Incheon's 2025-09-09 KRW 3m deposit is paired with its 2025-09-11 return. These corrections are classified consistently on both sides.
- Incheon 2026-07: a KRW 5m payment recorded under interest says debt repayment. Keep the original account and expose the uncertainty; changing it to principal would increase operating result by KRW 5m without changing cash.
- August 2026 adds 111 Anyang and 79 Incheon transactions. The source monthly controls are Anyang E114:G114 (100,770,030 receipts / 84,316,828 payments / 16,453,202 net) and Incheon E82:G82 (110,709,790 / 122,390,965 / -11,681,175). Both opening balances equal the preceding July closing balances. All 31 previously published monthly records remain unchanged.
- Incheon's August 12 payment of KRW 579,150 explicitly returns a July 31 mistaken transfer. Both sides are classified as corrections (the July receipt already was), so the return is excluded from operating costs. August operating results are Anyang KRW 21,453,202 and Incheon KRW 7,032,975; combined KRW 28,486,177. Incheon cash still falls because of repayments, transfers and corrections.
- Anyang August food payments are KRW 874,750, and no interest payment is recorded. A KRW 9,058,400 food-related mistaken receipt and return cancel outside operating results. The page calls for checking payment timing rather than interpreting the reduction as permanent savings. Incheon includes three benefit payments totaling KRW 19,615,800 against KRW 8,736,810 subsidy receipts in that month.
- Month explanations quantify changes, not unobserved business causes. Missing payroll, social insurance or food payments are noted without assuming a permanent saving. Benefits received and paid retain their original dates and are not netted into an invented accrual month.
- Missing branch months remain unavailable. Combined KPIs require both branches. Latest available month is 2026-08; the two August files are named `현금출납부_8월_20260916.xlsx`. There are now 33 source workbooks. The month selector, charts, history and CSV derive coverage from the imported periods. A URL explicitly selecting July continues to show July; open without a month or select August to view the new data.

The API follows the existing service's public access model. Published fields contain monthly aggregate amounts, account names, workbook filenames, row ranges and source hashes; no names or transaction memos.
