# 월별 급여·4대보험

운영·인사·회계의 /payroll-insurance.html. 전월 자료를 매월 10일 11:00 KST에 PC에서 수집한다. 예: 10월 10일 → 9월 귀속. 2026년 8월은 9월 22일 소급 게시했다.

## 접근과 보관

- 사용자 요청에 따라 별도 담당자 접근 키 없이 화면과 GET/HEAD/CSV를 조회한다. 응답은 no-store이며 브라우저 쓰기 API는 제공하지 않는다.
- /data/payroll-insurance/YYYY-MM.json에 최소한의 성명·직책·금액만 저장한다. 동일 월 수정 전 버전은 history에 보존한다. 개인 자료는 Git, 정적 assets/data, 공개 채팅 근거에 넣지 않는다.
- ERP/인증서 비밀번호, JWT, 생년월일, 주민번호, 계좌, 연락처는 게시하지 않는다. 인증 정보는 이 업무를 승인한 원래 작업에서만 참조하며 실행 프로세스 메모리에서 사용한다.
- 실패는 YYYY-MM.failure.json에 별도로 기록한다. 기존 성공 결과와 실제 확인 시각을 바꾸거나 이전 달을 새 달로 복사하지 않는다.

## 실행

1. 실행일의 한국시간 기준 전월을 정한다. 예약 실행에는 PC·Codex·연결된 Chrome과 인증서 사용 가능 상태가 필요하다.
2. Chrome Computer Use로 국민건강보험 사업장에 지점별 로그인한다. 안양 333-85-03020(더비다요양원), 인천 389-85-02626(매화요양원). 사용자가 직접 제공하고 자동 입력을 승인한 인증서 비밀번호를 원래 작업에서 참조한다. 인증서나 암호를 복사·업로드·저장하지 않는다.
3. 보험료 고지내역 조회 → 보험료 산출내역조회. 사업자번호와 조회 연도·월을 화면에서 검증한 후 건강·국민연금·고용·산재 각각 개인별 Excel 다운로드. 실제 파일은 CP949 CSV다. 파일 저장을 확인한 뒤 로딩 오버레이가 남으면 페이지를 새로고침하고 다음 종류를 조회한다. 급여 확정·보험료 납부는 하지 않는다.
4. 원본을 작업 전용 비공개 폴더에 지점_YYYY-MM_건강/국민연금/고용/산재.csv로 구분해 보관한다. 8개 파일을 모두 확보한다. 원본을 Git에 넣지 않는다.
5. 비공개 manifest를 작성한다. 최상위 month, branches 2개. 지점 항목은 id(2/3), month, businessNumber, checkedAt(화면 확인 ISO 시간대 포함), healthEmployerEqualsEmployee(건강·요양 사용자=가입자 부담액을 실제 화면 확인), portalTotals(healthCare/pension/employment/accident: 사업장 고지금액; 미확인 null), files(건강/국민연금/고용/산재 각각 SHA256 소문자). 실제 확인한 값만 넣는다. 사업장 결정보험료/납부할 금액과 개인별 결정액의 차이는 근거와 함께 검토하고 임의 배분하지 않는다.
6. ERP 운영 주소 vida-backend-prod-production.up.railway.app 에 사용자 승인 계정으로 JWT 로그인한다. 환경변수 VIDA_REPORT_USER/VIDA_REPORT_PASS를 해당 프로세스에서만 설정한다. 개발 환경을 사용하지 않는다.

```text
python scripts/collect_payroll_insurance.py --month YYYY-MM --nhis-dir <원본 폴더> --manifest <비공개 manifest.json> --output .local/YYYY-MM.json
python scripts/publish_payroll_insurance.py .local/YYYY-MM.json
python scripts/publish_payroll_insurance.py .local/YYYY-MM.json --publish
```

수집기는 /api/payroll/ledger/?nursing_home_id=2 또는 3&year=연도&month=월과 /api/users/?nursing_home=2 또는 3&exclude_viewer=true&employment_status=all을 조회한다. 대장의 지점·연도·월을 응답과 대조한다. 지점/성명/생년월일로 연결하고 숫자 접미사는 생년월일 일치 때 연결한다. 연결되지 않거나 직책이 없는 사람은 별도 행을 남긴다. 미확정 대장은 화면에 경고로 표시한다.

반영은 기존 Railway CLI 로그인으로 SSH 수입 명령을 호출한다. 데이터는 압축 전송하며 명령 인자를 로그에 출력하지 않는다. 별도 서비스계정/키를 만들지 않는다. 전송 후 원격 재조회 SHA256까지 같아야 성공이다.

실패 시, 연결 가능하면 다음 명령으로 실패만 기록하고 필요한 조치를 이 작업에 알린다.

```text
python scripts/publish_payroll_insurance.py --failure YYYY-MM --publish
```

## 금액과 검증

- 급여 합계 = 대장 지급총액. 실지급 = 지급총액 - 공제합계 대사.
- 급여 보험공제 = 대장 국민연금+건강+요양+고용. 세금 등 제외.
- 보험료 총합(노사합산 기준) = NHIS 건강 고지×2 + 요양 고지×2 + 국민연금/고용/산재 결정액 원본. 건강·요양 부담액 동일 여부를 확인하고 적용한다. 국민연금·고용·산재 결정액을 다시 2배 하지 않는다.
- 가입 여부/자료 없음/0원은 다르다. 결측은 null, 원본 0은 0, 환급은 음수. 존재하는 원본 내역의 합계이며 사업장 최종 납부액과 같다고 단정하지 않는다.
- 직책은 해당 월 급여대장 우선. 사회복지사, 간호(조무)사, 물리(작업)치료사, 요양보호사 및 기타/미확인으로 집계한다. 해당 월 퇴사자 정산도 포함.
- 건강 CSV의 중복 헤더는 열 번호로 구분(건강 13, 요양 26). 같은 사람의 복수 정산 행은 합산한다. 모든 개인별 원본 금액과 결과 합계, 직책별 합계, 두 지점 합계를 검증한다.
- 브라우저에서 키 입력 없이 새로고침/지점선택/직원검색/다운로드를 확인한다. API는 직접 조회되지만 서버 원본 파일과 코드의 정적 다운로드는 차단되는지 검사한다.

테스트: python -m unittest test_payroll_insurance.py test_ui_consistency.py test_site_identity.py test_card_knowledge.py, node --test test_navigation.cjs.
