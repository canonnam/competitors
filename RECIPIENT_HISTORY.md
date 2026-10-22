# 수급자구분 변경이력 자동화

## 범위·일정

- 매월 1일 오전 11시 Asia/Seoul에 **당월 급여제공월**을 조회한다. 2026-11-01 실행은 2026-11, 1월 실행은 그해 1월이다. 전월 급여·보험료 자동화와 혼동하지 않는다.
- 안양점 기관번호 14117000625, 인천점 12817700685. 두 지점을 독립 검증하며 실제 조회 시각을 남긴다.
- 출처: https://www.longtermcare.or.kr/ → 장기요양정보시스템 → 기타 → 엑셀다운로드 → 수급자구분변경이력(npca008m01).
- 결과: https://app.aivida.tech/recipient-history.html. 운영·인사·회계 카드 및 대시보드 배상책임보험 바로 위 요약.
- 매월 1일 조회 시점의 스냅샷이다. 월중 발생하는 모든 변경을 감시하지 않는다. 화면 새로고침은 저장 자료만 조회한다.

## 2026-10-22 진행 상태 — 운영 반영 완료

- 코드 구현·로컬 UI·회귀 검증을 마치고 `14b082e`를 petdev에 반영했다. heartbeat `automation-4`는 활성 상태다.
- 두 지점 2026-10 자료를 지점별 순차 게시하고 별도 재조회 해시 일치를 확인했다. 안양 34행/34명, 인천 43행/41명이다. 공단 실제 조회 시각(10월 22일 오전)을 유지하며 배포 시각을 조회 시각으로 바꾸지 않았다. 소스·문서·대시보드에는 개별 이력을 넣지 않는다.
- 첫 배포는 Railway 장애로 중단됐으나 사용자의 재시도 요청 후 Pro 빌드 재개를 확인해 기존 서비스·환경에 한 번 제출했다. 배포 `4dda6e32-947f-48bc-a590-defa26d6e95d`가 SUCCESS다. petdev `e3cbb99` 작업 소스를 CLI로 배포했으며 새 모듈·HTML·JS·홈·기존 인증 모듈 7개 파일의 원격 SHA-256이 로컬과 일치한다.
- 인증 전 두 API가 401/no-store, 상세가 로그인 화면인 것을 확인했다. 로그인된 실제 운영 화면에서 운영 카테고리 8개·새 카드·당월 자료·인천 원본 43행·대시보드의 배상책임보험 바로 위 배치를 확인했다. 기존 데이터·비밀 변수·권한은 변경하지 않았다. 월별 예약은 같은 일정으로 유지하고 오래된 배포 미완료 안내를 제거했다.
- 이번 검증은 기능 배포·저장 무결성과 기존 로그인 보호 확인이다. Railway 보안 사고 전체에 대한 감사나 자격 증명 회전을 완료했다는 의미는 아니다. 비밀 변수 회전·권한 변경·호스팅 변경은 별도 승인이 필요하다. 추후 접근 실패는 성공으로 처리하지 않는다.

## 수집·검증·게시 순서

1. AGENTS.md, 이 문서, 현재 Computer Use skill을 읽는다. `git status`로 사용자의 다른 변경을 보존한다. 브라우저용 CUA의 연결된 Chrome을 사용한다. 기존 지점별 청구 점검과 같은 로그인 사이트지만 이 작업에서는 조회만 한다.
2. 사용자가 승인한 기존 로그인 세션을 사용한다. 인증서·비밀번호·JWT·쿠키·SESSIONCHECK 포함 URL을 파일·프롬프트·로그에 남기지 않는다. Windows 인증 대화상자 등 사용자 인증 단계는 사용자에게 완료를 요청한다. 로그인 실패를 우회하거나 반복하지 않는다.
3. 상단 **기관번호**, 선택 탭, **급여제공월=당월**, 수급자구분 **전체**를 확인하고 조회한다. 제한 필터가 없는 화면은 전체 탭인지 확인한다. 경고 안내 닫기는 가능하나 청구·신고·확정·자격 판정은 하지 않는다.
4. 열은 수급자명 / 인정관리번호 / 자격 / 적용일자 / 종료일자다. 원본 조회결과 N건과 전체 수집 행 수 N을 대조한다. 가상 스크롤·페이징이 있으면 전부 확인한다. 조회 전 '-'나 불완전 수집을 0건으로 저장하지 않는다. 성공 0건도 실제 조회 완료와 0건 표시를 확인한다.
5. 엑셀이 정상 내려받아지면 전체 파일과 화면을 대조한다. 현재 다운로드 경고에서 내부 업무처리를 선택해도 다운로드 이벤트가 확인되지 않을 수 있다. 이때는 **화면 DOM 전체 행 수가 원본 건수와 일치할 때만** DOM 수집을 사용하고 출처 portal-dom을 기록한다. 파일을 받았다고 허위 기록하지 않는다. 숨은 Nexacro 데이터·네트워크·세션을 추출하지 않는다.
6. `scripts/recipient_history_capture.cjs`의 prepare/saveCapture를 사용한다. raw 객체: `institutionNumber`, `benefitMonth`, `filter:'전체'`, `queryCount:N`, `headers`, `rows:[[이름,인정관리번호,자격,적용일,종료일],...]`. **raw는 메모리에만** 둔다. helper는 지점+번호의 SHA-256 personKey를 만들고 원래 번호를 제거한다. 생성 파일은 `.local/recipient-history/{branch}-{YYYY-MM}.json`에만 둔다. 서버에는 최소 자료만 게시한다. 원본 파일·전체 화면의 식별자를 Git·공개 자산·변경 기록에 넣지 않는다.
7. 예: `python -X utf8 scripts/publish_recipient_history.py .local/recipient-history/anyang-2026-11.json` (반드시 실제 당월). 건수·열·날짜·기관·수집 행 해시 검증을 통과해야 한다. 출력은 월·지점·해시·게시 여부뿐이다.
8. 같은 명령에 `--publish`를 붙여 기존 Railway 로그인으로 **지점별 순차 게시**한다. 원격 저장 후 별도 `--verify` 재조회 해시가 같아야 완료다. 로그인된 상세와 `/api/recipient-history/summary`에서 월·지점·시각·건수를 재확인한다. 인증 전 API 401과 정적 Python/.local 비공개를 확인한다.
9. 실패 지점은 `python -X utf8 scripts/publish_recipient_history.py --failure YYYY-MM --branch anyang --publish`처럼 실패만 기록한다. 다른 지점과 같은 월의 이전 성공 자료를 지우지 않는다. 이전 월을 새 월 자료로 복제하지 않는다. 게시 결과가 불명확하면 원격 해시를 재조회한다.
10. 새 월 완료·의미 있는 변경·실패·사용자 조치 필요만 알린다. 변화 없는 반복 확인은 조용히 종료한다. PC·Chrome·인증서 접근이 불가능하면 완료로 표시하지 않고 필요한 조치를 알린다.

## DOM 위치 (2026-10-22 확인, 세션마다 재확인)

CUA `tab.playwright.evaluate`는 화면 DOM 읽기 전용으로 사용한다. 현재 관측한 작업창 접두사:

`mainframe.VFrameSet.HFrameSet.VFrameSetSub.framesetWork.winnp00000000071.form._div_bizFrameMain.form`

- 월 input: 접두사 + `.div_info.form.cal_paymtOffrDd.form.cal_begin.calendaredit:input`
- 구분 필터가 표시되면 `.div_info.form.cmb_clsfcCd.comboedit:input`. 없으면 제한 필터 없이 전체 이력을 조회하는 탭임을 확인한다.
- 조회 건수 text: 접두사 + `.sta_totalCnt:text`
- 그리드: 접두사 + `.tab_excel.tabpage2.form.gridCommE00`
- 열 제목: 그리드 안 `[id*=".head."][id$=":text"]`의 textContent.
- 행: 그리드 안 id가 `/\.body\.gridrow_\d+$/`와 일치하는 요소를 순서대로 읽는다. 각 행의 `[id$=":text"]` 5개가 열 값이다. DOM 행 수가 원본 건수보다 적으면 저장하지 않는다.
- 기관번호는 상단에 실제 표시된 더비다요양원 `[기관번호]`에서 확인한다. 전체 URL이나 인증 관련 DOM은 수집하지 않는다.

## 변경 분류와 한계

- 전체 원본 행 수는 자격 변경 건수가 아니다. 사람 연결은 지점별 personKey로만 한다. 이름만으로 합치지 않는다.
- 이전 종료일과 이후 적용일이 같거나 하루 차이이고 겹침·동일일 상충이 없을 때만 이전·이후 자격을 대조한다. 자격이 다르면 변경, 같으면 기간 갱신이다. 조회일 이후 적용은 변경 예정으로 따로 센다.
- 이전 자격 없는 적용, 후속 자격 없는 종료, 겹침·기간 단절은 확인 필요다. 신규 입소·퇴소·감경 사유·자격 상실을 추정하지 않는다. 해당 월 원본에 없는 이전 자격을 다른 월 값으로 임의 보정하지 않는다.
- 유형별 사람 수는 중복될 수 있으므로 유형 합계를 전체 인원으로 해석하지 않는다. 원본 종료 9999-12-31은 종료일 미정으로 표시한다. 원래 자격 표현과 날짜를 보존한다.

## 저장·API·보안·배포

- `recipient_history.py`: Railway `/data/recipient-history/YYYY-MM.json`, 수정 전 history 백업, 지점별 failure 파일. 로컬 기본 `.local/recipient-history/store`, 선택 환경 변수 RECIPIENT_HISTORY_DIR. 새 비밀번호·계정은 만들지 않는다.
- `/api/recipient-history?month=YYYY-MM`: 로그인된 상세. `/api/recipient-history/summary`: 이름·personKey·개별 자격이 없는 요약. 기본 월은 항상 서울 당월. GET/HEAD만 허용하고 no-store를 유지한다.
- 기존 facility_access 공통 로그인 보호 아래에서 제공한다. 지식 채팅은 사용법만 안내하며 수급자별 자료를 읽지 않는다. 브라우저 localStorage에도 개인 자료를 저장하지 않는다.
- 기존 petdev → Railway competitors/dev 배포 경로를 유지한다. 작업 checkout은 competitors-recipient-status이며 다른 dirty checkout을 덮어쓰지 않는다.
- 테스트: `python -X utf8 -m unittest test_recipient_history.py test_ui_consistency.py test_static_pages.py`, `node --test test_recipient_history.cjs test_dashboard.cjs test_navigation.cjs`.
- 브라우저: 운영 카테고리 카드·상세 월/지점/보기 전환·안내 툴팁·대시보드 순서·320px 좁은 화면·로그인 보호를 확인한다.
