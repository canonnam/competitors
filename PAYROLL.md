# Contract calculator

`/payroll.html` is a client-only payroll and employment-contract tool. The source
workbook is not deployed. The checked-in template JSON contains only printable
layout and non-personal text, with no cached employee values or Excel formulas.
The Anyang/Incheon selector fills the single institution-name and address fields.
Employee identifiers, bank details and PDF bytes remain in browser memory. There
is no persistence, upload, analytics, chat context capture, or payroll API.

The three templates preserve the workbook's cells, merged areas and common text.
Variable contract terms and wages are filled directly. Font glyphs are embedded
in full because subsetting Nanum Gothic Bold dropped glyphs in PDFium. Long text
wraps with row growth; vertical merges and signing blocks are kept together.
Additional wage items and special terms use an appendix. Blank inputs remain blank.
The flexible-hours clause is opt-in and switches to manual wage entry; the general
calculator does not purport to implement a flexible-hours agreement.

## Calculation conventions

- Monthly average: 365 days / cycle length * occurrences / 12.
- Weekly schedules use seven entries. Cycles are checked over LCM(cycle, 7) days.
- Deduct real breaks. Partial break windows crossing 22:00 or 06:00 must be split.
- General regime: daily >8 hours and additional weekly >40 hours, without duplication.
- The provided workbook's week-five-day, eight-hour schedule uses 209 paid hours.
- Cycle-paid weekly rest uses the workbook's 4.345 weeks and editable weekly paid
  hours. This is a contractual convention, not an automatic determination of eligibility.
- Each fixed allowance's ordinary-wage inclusion is explicit; no tax calculation.
- Gross-mode hourly pay excludes separately designated non-ordinary allowances.
- Overtime includes the ordinary 100% plus the 50% premium. Night is an extra 50%.
- Keep unrounded hours/hourly rates internally. Round paid allowances to won and
  balance basic pay to the agreed total. The cycle workbook example therefore has
  a one-won basic-pay rounding adjustment, not a changed agreed monthly total.
- No actual attendance, statutory-holiday calendar, deductions, net pay, or minimum
  wage eligibility determination is included in this contract-average calculator.

## Validation

`node test_payroll.cjs` covers the five workbook baselines, rounding, missing values,
custom day/night cycles, overnight breaks, weekly overtime and template mappings.
`node test_payroll.cjs --pdf` additionally writes only synthetic PDF QA samples to
the parent workspace's `.codex-analysis/pdf-qa` directory, outside the served root.
`python -m unittest test_payroll.PayrollRouteTests test_static_pages -q` checks
deployed routes, exact public assets, metadata, source-file denial and no personal
data submission. Generated PDFs are visually checked with PDFium.
