# 더비다 지식 창고 개발 환경

## 대시보드 시설 3D 뷰어 (2026-10-09)

- 대시보드는 기존 `/facility-3d.html?viewer=dashboard`를 같은 출처 iframe으로 연다. `assets/facility-viewer.js`가 조회 전용 표시·높이·활성 상태와 전체 화면 대체 보기를 연결하며 기존 렌더러와 서버 저장 도면을 재사용한다. 추가 DB·비밀 변수·배포 서비스는 없다.
- 조회 전용 모드에서는 편집/저장/삭제/파일 처리 이벤트와 도면 가져오기를 연결하지 않고 공유 도면 요청은 GET만 허용한다. 브라우저 편집 보관본을 읽거나 덮어쓰지 않는다. 지점 현황과 예시 이동은 기존 인증 API를 사용하며 비활성 영역에서는 반복 조회와 이동을 멈춘다. 인증 만료 시 전체 대시보드를 공통 인증으로 돌린다.
- 서버는 인증된 GET/HEAD의 정확한 뷰어 URL에만 `X-Frame-Options: SAMEORIGIN`을 제공한다. 외부 사이트 임베드는 차단하고 일반 지도·다른 페이지·인증 전 로그인은 기존 DENY를 유지한다. 기존 공통 비밀번호·API 인증·영구 도면 저장을 유지한다.
- 검증: `python -m unittest test_ui_consistency test_static_pages test_facility_assets test_facility_access test_facility_projects test_facility_collection test_facility_observation`; `node --test test_dashboard.cjs test_navigation.cjs test_facility_3d.cjs test_facility_mvp.cjs test_facility_observation.cjs test_facility_viewer.cjs test_facility_residents.cjs`.

## 홈페이지 방문·상담 분석 (2026-10-09)

- `/clarity-report.html`과 인증이 필요한 `GET/HEAD /api/clarity-report`는 기존 Python 앱과 공통 사이트 비밀번호를 사용한다. 홍보·상담·영업 메뉴와 홈 기능 카드에서 연다.
- `clarity_report.py`는 서버 전용 `THEVIDA_BRANDSITE_CLARITY`를 읽는다. 첫 실행 및 매일 09:40 KST에 Clarity Export API의 최근 24시간 통계와 Microsoft 공식 MCP 대시보드의 봇 제외 세션·맞춤 이벤트 세션 수를 수집한다. 토큰은 로그·응답·Git에 포함하지 않는다.
- `CLARITY_REPORT_DB_PATH` 기본값은 Railway 기존 `/data/clarity-report.db`, 로컬 `.local/clarity-report.db`다. `CLARITY_REPORT_SYNC_ENABLED=false`는 자동 수집만 끈다. 화면 새로고침은 저장 결과만 읽는다. 수집 재시도는 최소 30분 간격, 최근 24시간 최대 3회로 Export 호출 예산을 제한한다.
- 관측별 시작·종료 시각을 저장하며 최근 30개 일별 스냅샷을 표시한다. 시각이 다른 24시간 관측을 주간·월간 합계로 더하지 않는다. 이벤트는 횟수가 아닌 해당 이벤트가 발생한 세션 수다. 오류·미조회는 0으로 바꾸지 않는다. 실제 접수는 같은 UTC 구간의 기존 홈페이지 접수 DB에서 production 집계만 읽는다. 이름·전화·내용·접수 ID는 보고서에 포함하지 않는다.
- 공식 근거: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api 와 https://github.com/microsoft/clarity-mcp-server . MCP 집계는 지정한 UTC 범위와 단일 정수 열을 검증하고 실제 프로젝트 토큰으로 확인한다.
- 검증: `python -m unittest test_clarity_report test_ui_consistency test_static_pages test_facility_access test_website_intake`; `node --test test_clarity_report.cjs test_navigation.cjs test_dashboard.cjs`; 실제 토큰 조회는 집계만 확인한다.

확인일: 2026-10-08. 이 문서는 실행과 배포에 필요한 구조를 기록한다. 계정 비밀 값과 운영 데이터는 포함하지 않는다.

## 시설 맞춤 대시보드 랜딩 접수

- 웹 dev 주소: `https://thevidaweb-dev.up.railway.app/facility-dashboard`. `POST /api/dashboard-inquiry`가 기존 서버 간 `POST /api/website-intake` 연결을 사용한다. 추가 환경 변수나 DB 스키마 변경은 없다.
- `data.service=facility-dashboard`일 때 `facilityType`(요양원/주야간보호/방문요양/기타 장기요양기관), `position`(대표/시설장/실무 담당자/기타)을 필수로 검사하고 `message`는 최대 2,000자로 저장한다. `trial`은 구축 신청, `pricing`은 구축 상담으로 표시한다. 기존 홈페이지 자료에 새 필드가 없으면 기존 처리와 표시를 유지한다.
- dev 신청은 `environment=dev`로 기존 상담함의 dev 필터에서 확인한다. 이 기능은 `petdev` → `competitors/dev`에만 배포한다. 상담함 조회는 기존 전체 사이트 인증이 필요하며, 외부 접수의 Bearer 인증 예외는 POST에만 유지한다.

## 저장소와 실행 구조

| 항목 | 현재 구성 |
|---|---|
| 저장소 | `https://github.com/canonnam/competitors.git` |
| 운영 주소 | `https://app.aivida.tech/` |
| 배포 브랜치 | `petdev` (기존 Railway `competitors` 서비스의 `dev` 환경) |
| 서버 | Python `app.py`, `ThreadingHTTPServer`, `0.0.0.0:${PORT:-8080}` |
| 프런트엔드 | 서버가 제공하는 정적 HTML, CSS, JavaScript. 별도 프런트엔드 빌드 도구 없음 |
| 이미지 빌드 | `Dockerfile`: Node 22 Alpine에서 지식 카탈로그 생성 후 Python 3.13 Alpine에서 앱 실행 |
| 영구 데이터 | Railway `/data` 볼륨의 SQLite와 보고서. Git과 이미지에 포함하지 않음 |
| 로컬 확인 버전 | Windows PowerShell, Python 3.13.3, Node 22.14.0, Git 2.47.0, Railway CLI 4.11.0 |

로컬 작업 경로는 `C:\Users\SYBAE\Desktop\배수용\자동화\운영분석\competitors-knowledge-navigation`이다. 다른 작업 복사본을 사용할 때는 해당 저장소 루트에서 명령을 실행한다.

## 파일과 재현 절차

- `assets/statistics-data.js`: 통계 페이지와 서버 지식 응답에 쓰는 단일 데이터 원본.
- `data/statistics_sources.json`, `assets/statistics/*.png`: 공식 PDF의 출처, 페이지, 발췌 이미지.
- `data/statistics_article_sources.json`: 기사 인용 수치의 출처와 직접 검증 범위.
- `scripts/build_service_catalogs.cjs`: 통계 데이터를 `data/statistics_knowledge.json`으로 내보낸다. Docker 빌드에서도 실행된다.
- `STATISTICS_LIBRARY.md`: 통계 선정 기준과 해석상 주의점.
- `.env.example`: 변수 **이름과 용도만** 기록한다. 실제 값은 Railway Variables 또는 로컬 비추적 `.env`에서 관리한다.

로컬 검증:

```powershell
node scripts/build_service_catalogs.cjs
node test_statistics.cjs
node scripts/build_service_catalogs.cjs --check
python -m unittest test_ui_consistency.py
python -m unittest test_static_pages.py test_card_knowledge.py
```

앱은 `python app.py`로 실행하며 기본 포트는 8080이다. 로컬 실행에서 외부 API 기능을 사용하려면 해당 기능의 환경변수가 필요하다. 통계자료 정적 화면과 위 테스트에는 운영 비밀 값이 필요하지 않다.

## 월별 입·퇴소 현황

- `resident_movement.py`, `assets/dashboard-residents.js`: 대시보드의 월별 운영손익 위에 안양점(2)·인천점(3)의 월별 입소/퇴소 인원 표와 연도 선택을 제공한다. 기존 Python/정적 앱과 Railway `petdev` 배포를 재사용한다.
- 서버 시작 직후와 1시간마다 기존 `FACILITY_ERP_USERNAME/PASSWORD`(미설정 시 `LIABILITY_ERP_USERNAME/PASSWORD`)로 `/api/token/` 인증 후 `/api/elderly/?nursing_home=...&status=all`, `/api/discharge-records/?nursing_home=...`의 전체 페이지를 조회한다. 기존 ERP 요청·토큰 갱신·재로그인 규칙을 재사용한다. 지점·경로·호스트·status가 바뀐 페이지나 반복/잘못된 응답은 거부한다.
- 집계가 있는 연도와 현재 연도의 1월 1일 현원은 `/api/elderly/list/?nursing_home=...&date=YYYY-01-01`의 전체 페이지로 조회한다. 날짜가 바뀐 페이지는 거부한다. `yearStarts`에는 연도·기준일·현원 합계·조회 실패만 저장한다. 기준 현원 실패는 정상 월별 집계를 버리지 않으며 비율만 미조회로 표시한다. 선택 연도 누적 입소/퇴소 인원 ÷ 해당 연도 1월 1일 현원 × 100을 소수 한 자리로 표시한다. 전체 비율은 두 지점의 분자·분모 합으로 계산하고 기준 현원 0명·미조회나 불완전한 합계이면 ‘—’다. 월별 합산이므로 같은 사람의 다른 달 퇴소는 각 달에 포함되고 누적 비율은 100%를 넘을 수 있다.
- 입소는 삭제되지 않은 재원·퇴소자의 `admission_date`, 퇴소는 삭제되지 않은 퇴소 기록의 `discharge_date`를 서울 시간으로 변환해 월별 집계한다. 퇴소는 어르신 ID를 지점·월별 중복 제거한 사람 수다. 최근 입소일 덮어쓰기로 재입소자의 과거 입소는 복원할 수 없으며 안내 아이콘과 표 하단에 기준을 명시한다. 입소일 미등록 인원은 별도 표시하고 미래 날짜는 제외한다. 월말 현원은 계산하지 않는다.
- 개인별 이름·ID·날짜는 집계 중에만 사용하고 저장하지 않는다. 서버 메모리에는 월별 인원·연도별 기준 현원·조회시각·오류만 남긴다. 새 DB/비밀 변수는 추가하지 않는다. `/api/resident-movement`의 GET/HEAD는 기존 전체 사이트 비밀번호 인증 후 집계만 반환하며 no-store로 제공한다. 브라우저는 분마다 캐시를 읽고 ERP 수집을 직접 시작하지 않는다.
- 실패한 지점은 이전 집계를 유지하면서 이전 결과와 오류를 표시하고, 최초 미조회는 null/‘—’로 표시한다. 성공한 빈 목록만 0명으로 해석한다. 재시작 직후 첫 수집 전에는 미조회 상태이며 수집 완료 후 자동 표시한다. 기본값은 올해이며 올해는 현재 월까지, 과거 연도는 12개월을 표시한다. 모바일은 표 내부 스크롤·키보드 이동을 지원한다.
- 검증: `python -m unittest test_resident_movement.py test_ui_consistency.py test_static_pages.py test_facility_access.py test_facility_collection.py`; `node --test test_dashboard_residents.cjs test_dashboard.cjs test_dashboard_operating.cjs`; `node scripts/verify_dashboard_ui.cjs`. 실제 ERP 조회는 집계 결과만 확인하며 계정/토큰·개인별 응답은 로그/문서에 남기지 않는다.

## 배상책임보험 관리

- `/liability-insurance.html`, `liability_insurance.py`, `assets/liability-*`: 운영·인사·회계의 보험 관리와 대시보드 운영 현황. Python 서버의 기존 정적 구조와 Railway 배포를 재사용한다.
- `LIABILITY_INSURANCE_DB_PATH`의 기본값은 `/data/liability-insurance.db`다. 지점별 보험 정보·버전과 PDF/이미지 증서(최대 10MB), 마지막 전체 현원·조회 시각·오류만 SQLite에 보관한다. 서버 재시작에도 유지하며 실제 인원·증서는 소스에 넣지 않는다. 증서는 첨부 다운로드로 제공하고 캐시하지 않는다.
- 서버 전용 ERP 계정은 선택적 `LIABILITY_ERP_USERNAME/PASSWORD` 또는 기존 `FACILITY_ERP_USERNAME/PASSWORD`를 읽는다. 로그인·토큰 갱신·재로그인은 기존 ERP 모듈을 공유한다. 지점 ID는 안양 2·인천 3이다.
- 처음 자료가 없을 때 수집하고, 이후 한국시간 매일 09:00에 점검한다. 실패는 1시간 뒤 재시도한다. 브라우저는 캐시를 분 단위로 읽으며 ‘지금 현원 확인’만 수동 수집한다(1분 제한). 재시작으로 놓친 점검은 자동 재개한다.
- `/api/elderly/statistics/?nursing_home=...`의 `total_elderly`를 우선 사용한다. ERP 서버 오류는 `/api/dashboard/stats/{id}/`의 같은 필드로 대체한다. 2026-10-02 실제 조회에서 입소자 통계는 HTTP 500, 대시보드 통계는 정상임을 확인했다. 생활실 현원 합계는 사용하지 않는다. 미조회 값은 null로 두고 실패는 이전 현원과 함께 별도 표시한다.
- 양호 판정에는 오늘 확인한 전체 현원, 현원 이상의 가입 인원, 등록한 보험 이름, 시작된 가입기간과 30일을 초과한 만료 잔여일이 필요하다. 만료 30일 전·당일은 갱신 준비, 만료 후·가입 전·인원 부족은 조치 필요다. 초과 가입에는 감소 안내를 표시하지 않는다. API의 인원 차이는 기존 부호를 유지한다. 모든 만료 계산은 한국시간 날짜 기준이다.
- `assets/liability-ui.js`가 상세·대시보드의 지점별 요약을 공유한다. 대시보드는 summary 옵션으로 지점명·상태·두 인원만 표시한다. 상세 화면은 다운로드/수정 아이콘과 접근 가능한 툴팁을 제공하며 등록·수정은 네이티브 dialog 폼을 사용하고 버전별 초안과 증서 선택을 유지한다. 자동 점검 안내·다음 점검은 툴팁에서 확인한다. 수집 시각은 API에 보존하며 카드 본문에서만 숨긴다.
- PDF.js·Tesseract의 기존 자체 제공 파일로 PDF(자동 추출 20페이지)·스캔·JPG·PNG·WEBP를 브라우저에서 읽는다. 보험 이름·가입 인원·가입기간의 명시적 문구를 추출하며 여러 값이 충돌하면 직접 확인을 요구한다. 자동 저장하지 않는다. 입력 및 선택한 새 증서는 ‘확인 후 저장’으로 원자적으로 저장하며 기존 증서는 새 증서 저장 때만 교체한다. 버전 충돌은 409로 막는다.
- 검증: `python -m unittest test_liability_insurance.py test_ui_consistency.py test_static_pages.py test_card_knowledge.py test_claim_check.py test_facility_collection.py`; `node --test test_liability_certificate.cjs test_liability_ui.cjs test_navigation.cjs test_dashboard.cjs`.

## 전체 사이트 접근 인증

- `facility_access.py`가 `app.App`의 GET·HEAD·POST·DELETE에서 업무 처리보다 먼저 인증한다. 기존 `FACILITY_MAP_PASSWORD_HASH` 비밀 변수의 PBKDF2-SHA256(600,000회·무작위 salt) 값을 그대로 검증하며 비밀번호 원문·hash 값은 소스·문서에 저장하지 않는다. 설정 누락·형식 오류는 잠금 상태다.
- 서명된 24시간 `vida_knowledge_access` 쿠키는 HttpOnly·SameSite=Strict·운영 HTTPS Secure·Path=/이며 인증 화면·API·업무 파일은 no-store와 Vary: Cookie를 적용한다. 이전 map-only 쿠키는 새 인증으로 인정하지 않아 배포 후 최초 진입 비밀번호를 다시 요구한다. 비밀번호 hash 변경도 기존 인증을 무효화한다. 같은 IP에서 연속 10회 비밀번호 오류가 나면 10번째 요청부터 1시간 동안 새 로그인을 차단한다. 올바른 비밀번호도 차단 중에는 거부하며 추가 시도로 만료 시각을 연장하지 않는다. 성공하면 이전 실패 횟수를 지우고, 차단 만료 후에는 새 횟수로 시작한다. 이미 인증된 브라우저의 업무 사용과 다른 IP의 새 로그인은 유지한다.
- 실패 횟수와 차단 만료는 `SITE_ACCESS_DB_PATH` SQLite에 저장한다. 기본 경로는 Railway `/data/site-access.db`, 로컬 `.local/site-access.db`이며 기존 영구 볼륨을 재사용한다. 비밀번호나 IP 원문은 저장하지 않고 기존 서버 비밀 hash를 키로 한 HMAC-SHA256 IP 식별자만 보관한다. 브라우저/서버 재시작으로 차단을 해제할 수 없다. DB 조회 실패는 503으로 로그인을 막는다.
- Railway에서는 공식 클라이언트 주소 헤더인 `X-Real-IP`의 마지막 값을 사용한다. 실제 운영 요청에서 사용자 `X-Forwarded-For`가 그대로 전달되어 횟수 초기화에 악용될 수 있음을 확인했으므로 이 헤더는 인증 식별에 사용하지 않는다. 중복 헤더도 마지막 값을 읽고 IP 형식을 검사하며 IPv4-mapped IPv6는 IPv4로 통일한다. 로컬에서는 전달 헤더를 신뢰하지 않는다. [Railway 요청 헤더](https://docs.railway.com/networking/public-networking/specs-and-limits)를 따른다. 4개 검증 슬롯으로 비밀번호 hash 작업을 제한하며 동시에 진행된 결과는 SQLite 트랜잭션으로 집계한다.
- 오류 응답은 남은 횟수, 차단 응답은 HTTP 429와 `Retry-After`/`retryAfter` 남은 초를 제공한다. 1시간 차단 전후와 동시 성공/실패의 경합에서도 이미 시작한 차단을 성공 요청이 지우지 못한다. 공통·이전 지도 인증 주소가 같은 기록을 사용한다.
- `/api/site-access/session`의 POST는 인증, GET·HEAD는 인증 상태, DELETE는 현재 브라우저 잠금이다. 기존 `/api/facility-map-access/session`은 같은 공통 인증의 호환 별칭으로만 유지한다. 3D 지도의 더보기 ‘지식 창고 잠그기’도 전체 쿠키를 지운다.
- 홈페이지·모든 HTML·외부 지원사업 공유·종사자 응시 페이지와 인코딩·상대 경로는 인증 전 독립 로그인 화면을 응답한다. 성공하면 현재 URL을 새로고침하여 경로·쿼리·해시를 유지한다. 내부 탐색·업무 데이터 스크립트는 로그인 화면에 포함하지 않는다. 지도에는 별도 인증 화면이 없다.
- 모든 조회·작성 API와 데이터·문서·업무 자산 직접 주소는 인증 전 401이다. 인증 후 쓰기는 동일 출처도 확인한다. 로그인용 favicon·robots·foundation CSS·로그인 CSS/JS만 방문자에게 제공한다. Python 소스·DB·환경 파일은 인증 후에도 기존 정적 허용 목록에서 제외한다.
- 기존 외부 홈페이지 접수 `POST /api/website-intake`만 별도 서버 Bearer 비밀 인증을 유지한다. 방문자 조회·업무 진입의 예외가 아니며 GET·HEAD는 공통 잠금으로 차단한다. 외부 링크의 범위·만료와 응시자 본인 확인은 공통 인증 이후 기존 구현을 그대로 적용한다.
- 검증: `python -m unittest test_facility_access.py test_facility_assets.py test_facility_projects.py test_facility_collection.py test_ui_consistency.py test_static_pages.py`; `node --check assets/facility-map-login.js`; `node --check assets/facility-3d.js`; `node --test test_site_access_login.cjs`.

## 시설 3D 지도 구성

- `/facility-3d.html`: 기존 서버의 정적 페이지 목록과 Docker 이미지에 포함하되 비밀번호 인증 후 제공한다. 시설 인수·개설 메뉴, 홈 기능 카드, 지식 질문의 기능 안내에 등록한다.
- `assets/facility-3d-model.js`: 층·공간·치수와 JSON 도면 파일의 검증 및 공간 배치. `assets/facility-3d.js`는 화면 조작·렌더링을 담당한다.
- 공간 `type`은 기존 `living/office/common/service/core/corridor/unknown`과 `program/kitchen/lounge/changing/garden/therapy/nursing`을 허용한다. 새 값은 프로그램실·주방·휴게실·탈의실·정원·물리치료실·간호사실이며 클라이언트와 `facility_projects.py`의 허용 목록을 함께 유지한다. JSON 버전은 1로 유지하고 기존 저장 공간을 자동 분류하지 않는다. 도면 후보의 이름으로 새 용도를 제안하며 정원 인원 안내는 제외한다. 정원은 벽·실내 가구를 만들지 않는다.
- 층의 `level`은 배열 위치와 별개인 실제 층 번호(지하 1층 -1, 지상 1~12층 1~12)다. 0층은 허용하지 않는다. 중간 층 삭제 후에도 번호·ID를 유지하며 클라이언트와 서버 검증은 중복 번호를 막고 오름차순으로 저장한다. 번호 없는 이전 JSON만 배열 순서로 보완한다. 층 추가·삭제는 저장 전 편집이며 가장 최근 삭제한 층을 새로고침 전 복구할 수 있다. 공간 가져오기·종사자 배치는 ID/층 번호로 찾고 ERP 연결도 실제 층 번호를 쓴다.
- `assets/facility-3d-ui.js`는 공통 안내 툴팁과 저장 결과의 native dialog를 담당한다. 전체 화면 내부의 층 선택은 일반 층 선택과 같은 렌더링·현황 닫기 동작을 사용한다.
- `assets/vendor/three/`: 공식 npm 배포의 Three.js 0.186.1과 OrbitControls를 보관한다. 출처·MIT 라이선스는 해당 폴더에 포함한다. 기존 정적 파일로 제공하며 추가 빌드나 외부 CDN 요청은 필요하지 않다.
- WebGL2를 지원하는 브라우저에서 3D를 제공하고, 지원하지 않으면 선택 층의 2D 평면으로 표시한다.
- 건물은 지하 1층·지상 1~12층, 최대 13개 층이며 층별 공간은 최대 40개다. 새 건물의 층 수는 지상층 개수이며 지하층은 층 추가에서 등록한다. `floorName`·`floorCode`는 지하 1층/B1 표기를 통일하고 `floorIndex`는 B1=-1, 1F=0으로 렌더링 위치를 잡는다. `verticalBounds`로 최하층 밑에 바닥·그리드를 놓고 카메라가 지하층까지 포함하도록 맞춘다. 치수를 생략하면 24×16m, 층 높이 3.2m를 예시로 사용하고 추정 크기로 표시한다.
- 공간의 선택적 `points: [{x,z}, ...]`는 3~32개 꼭짓점을 보관한다. 사각형 기존 파일은 그대로 읽는다. 다각형은 경계·최소 면적·자기 교차를 검증하고 오목한 도형을 삼각형으로 나눠 면적·충돌을 계산한다. 표시 중심은 내부 삼각형에서 찾는다.
- 층의 선택적 `staff: [{role,count}, ...]`에는 직종과 인원만 보관한다. `care/social/nurse/therapy/admin/director/kitchen/other`의 직종당 20명, 층당 80명, 건물당 200명까지 검증한다. 기존 도면은 빈 배치로 읽는다. `assets/facility-staff-model.js`는 비복도 공간을 장애물로 두고 연결된 격자의 경로를 따라 예시 인물을 이동시킨다. `assets/facility-staff.js`는 입력·재생·속도·움직임 줄이기 설정을 담당한다. 실제 직원 이름·일정·작업량·손익은 사용하지 않는다.
- `assets/facility-resident-model.js`는 인증 명단의 생활실 매핑 결과에서 현원·확인된 등급만 받아 익명 예시 활동을 만든다. 침대와 자동 출입구를 같은 좌표로 렌더링·경로 계산에 사용하며 생활실·화장실의 벽과 침대는 통과하지 않는다. 복도 등록 시 복도 안의 경로만 사용하고 화장실은 공간 이름으로 찾는다. 연결되지 않은 목적지는 생략한다. `assets/facility-residents.js`는 회색 머리 인물의 걷기·의자 휴식·화장실·누움 자세와 2D 대체 표식을 그린다. 활동 상태는 브라우저 메모리에만 있으며 개인정보·ERP ID·위치를 저장하거나 내보내지 않는다. 공간 선택·보기 전환 시 같은 도면·현원·등급의 활동은 유지하고 변경 시 재구성한다. 직원과 일시정지·속도를 공유하며 그리기·비활성 탭·움직임 줄이기에서 이동을 멈춘다.
- 건물 이름과 ERP 지점은 ‘이름·지점 변경’에서 수정한다. `nursingHomeId`는 안양 2·인천 3·미연결 null 중 하나이며 도면 JSON에 보관한다. 기존 파일의 안양·인천 지점명은 명시적 연결 값이 없을 때만 해당 지점으로 해석한다.
- 도면 이미지는 JPG·PNG·WEBP 10MB까지 받으며 긴 변 1,500px 이하로 줄여 JSON에 포함한다. PDF는 20MB·200페이지까지 받아 선택한 한 페이지를 해당 층에 등록한다. JSON 가져오기는 25MB까지 허용하고 이미지 데이터와 공간 경계를 검증한다.
- `assets/facility-3d-detect.js`는 긴 벽 선을 추출하고 문 틈을 메운 뒤 닫힌 사각형 영역을 공간 후보로 만든다. 인식되지 않는 경계·비정형 공간은 직접 구성한다. 후보는 최대 40개이며 사용자 확인 후 추가한다. 기존 공간 교체는 별도로 선택해야 한다.
- `assets/facility-3d-import.js`는 PDF.js 6.3.289로 페이지를 그리고 글자 위치를 읽는다. 이미지와 스캔 PDF는 Tesseract.js 6.0.1, core 6.1.2와 공식 한국어·영어 tessdata_fast 자료로 OCR을 수행한다. 글자의 중심이 공간 안에 있는 경우 이름을 연결하고 용도를 추정한다. 고유한 OCR 오탈자 보정 제안은 원문을 함께 표시한다. 모든 작업은 브라우저에서 수행하며 원본 도면을 외부 API로 전송하지 않는다.
- PDF/OCR 파일은 `assets/vendor/pdfjs`, `assets/vendor/tesseract`에 공식 배포 출처·라이선스와 함께 보관한다. `scripts/prepare_facility_vision.py`로 준비하며 Docker 빌드에서 내려받지 않는다. 이 폴더의 필요한 바이너리와 `example-floorplan.pdf`만 서버 공개 파일 목록에 추가한다.
- `자동 구성 예시`는 실제 지점 자료를 포함하지 않는 합성 이미지와 두 페이지 PDF를 일반 파일 처리 경로로 분석한다. 재생성은 `scripts/generate_facility_example.py`를 사용한다.
- `facility_projects.py`는 `/api/facility-projects/`에서 건물·도면 이미지·다각형·층별 직종/인원을 공유 저장한다. `FACILITY_PROJECTS_DB_PATH`는 Railway `/data/facility-projects.db`를 가리키며 서버 재시작·배포 후에도 영구 볼륨에 남는다. 로컬 실행에서는 임시 또는 작업 디렉터리의 DB 경로를 설정한다. 저장 건물은 최대 8개, 요청은 25MB이며 서버에서 치수·다각형 교차·이미지 데이터·직종/인원과 허용 필드를 검증한다. ERP 비밀번호·토큰·입소자 명단·개별 건강정보는 저장하지 않는다.
- 브라우저는 진입 시 서버 저장본을 우선 사용하고, 편집하지 않을 때 30초마다 및 탭 복귀 시 최신 공유본을 확인한다. 저장·삭제·복원에는 읽은 `revision`을 보내며 SQLite 트랜잭션에서 충돌을 409로 반환해 다른 사람의 변경을 덮어쓰지 않는다. 변경 중에는 자동 교체하지 않으며 충돌 시 파일 내보내기 후 최신 저장본을 다시 열도록 안내한다. 쓰기 요청은 같은 출처의 JSON만 허용한다.
- `localStorage`의 `vida-facility-3d-v1`은 기존 도면의 최초 이전과 보조 보관에 사용한다. 서버에 건물이 없으면 기존 도면을 표시하고 사용자의 저장으로 공유본을 만든다. 이후 다른 기기는 해당 서버 본을 사용한다. 브라우저 보관 실패는 서버 저장 성공에 영향을 주지 않는다. 이미지/PDF 분석은 브라우저에서 진행하고 저장 시 축소된 층 이미지와 공간 초안을 서버로 보낸다.
- 건물 삭제는 서버에서 숨김 처리하고 버전을 올린다. 삭제 직전 화면과 삭제 버전을 기억해 새로고침 전까지 가장 최근 삭제를 되돌릴 수 있다. 원래 서버 저장본을 복원하고 저장하지 않은 편집은 화면에서 미저장 상태로 유지한다. 파일 내보내기/열기도 더보기에서 제공한다.
- `facility_collection.py`는 `FACILITY_ERP_USERNAME`·`FACILITY_ERP_PASSWORD`를 Railway Variables에서 읽는다. `app.py` 시작 직후와 3,600초마다 서버 스레드에서 안양 2·인천 3의 `/api/nursing-homes/living-rooms/?nursing_home=...`와 오늘(KST)의 집중·주의 스냅샷을 수집한다. 인증 갱신 실패 시 자동 재로그인한다. `facility_observation.py`의 기존 백엔드 주소·지점·인증·페이지 검증을 공유하고 다른 주소·지점으로 바뀐 페이지 연결과 리다이렉트를 차단한다.
- 인증 후 `/api/facility-observation/data?nursing_home_id=2|3`는 생활실 이름·층·정원·현원·잔여 정원, 생활실별 집중·주의 인원과 수집 시각만 반환한다. 생활실 현원 합은 배정된 재원 인원이며 미배정 어르신은 포함하지 않는다. 집계 응답은 실명·입소자 ID를 포함하지 않는다. 인증 전용 `/residents`는 생활실별 `{id,name}` 명단과 오늘 집중·주의 스냅샷의 입소자 ID·이름·층·생활실·등급만 추가한다. 이 자료는 시간별 수집의 서버 메모리에만 보관하고 로그·파일·DB·브라우저 저장소·내보내기에는 넣지 않는다. 진단·생년월일·다른 의료 필드는 수집하지 않는다. 자격증명은 서버 비밀 변수, 토큰은 서버 메모리에만 둔다. 화면에는 로그인·연결 버튼이 없다.
- 캐시는 서버 메모리에서 마지막 성공한 생활실·관찰 묶음을 보관한다. 일부 API 실패는 새 자료로 교체하지 않으며 이전 자료·오류·마지막 수집 시각을 표시한다. 첫 수집 미완료는 503으로 응답한다. 서버 재시작은 바로 수집을 시작한다. 브라우저 요청은 수집을 시작하지 않는다. 기존 `/session`과 `/targets`의 개인별 조회는 쿠키 인증·최대 8시간 세션을 유지하고 공개하지 않는다.
- `assets/facility-observation-model.js`는 같은 층에서 유일하게 일치하는 생활실만 연결한다. ERP 층의 `-1`·`B1`·`B1F`·`지하 1층`은 지하층으로 해석하며 1층과 구분한다. 등록하지 않은 지하층도 지상층에 연결하지 않는다. 미등록·중복·층 정보 없음은 위치 확인 대상으로 남긴다. `floorSummaries`는 도면 연결 여부와 무관하게 ERP의 명시적 층을 기준으로 현원·정원·관찰 인원을 집계한다. `markers`는 건물 전체·층별 펼치기에서 층 요약, 선택 층·평면에서 생활실 표식을 반환한다. `assets/facility-observation.js`는 진입·BFCache 복귀·지점 변경과 열린 탭의 60초 확인에서 인증된 명단 캐시를 읽고 로딩·실패·이전 자료 상태와 3D 화면 안 오른쪽 위 정보 박스를 표시한다. 관찰 선택은 카메라·보기·스크롤을 유지한다. 변경 없는 캐시 확인에서는 도면 편집과 직원 이동을 다시 만들지 않는다. 명단의 ID를 우선 연결하고 ID가 없을 때만 같은 생활실의 유일한 이름을 쓴다. 중복·ID 불일치·상충 등급은 확인 필요로 남긴다. 기존 ERP 세션 `/targets`의 인증은 유지한다.
- MVP 검증: `python -m unittest test_facility_access.py test_facility_projects.py test_facility_collection.py test_facility_observation.py`, `node --test test_facility_mvp.cjs test_facility_3d.cjs test_facility_observation.cjs`. `python test_facility_collection.py --serve`는 localhost:8097에서 합성 ERP 응답과 임시 공유 도면 DB를 사용하는 UI 검증 서버를 연다. 지도 비밀번호는 테스트 전용 `facility-map-demo`이며 운영 설정을 사용하지 않는다. localhost와 127.0.0.1의 서로 다른 브라우저 저장소에서 같은 공유 도면과 직원 인원을 확인할 수 있다. 운영 계정이나 실제 명단을 사용하지 않는다.
- 검증: `node --test test_facility_detection.cjs test_facility_3d.cjs test_navigation.cjs test_dashboard.cjs`, `python -m unittest test_facility_assets.py test_ui_consistency.py test_static_pages.py test_card_knowledge.CardKnowledgeTests.test_every_new_card_routes_without_operating_false_positive`.

## 배포와 확인

`petdev`에 검증한 커밋을 반영하면 기존 Railway 연결을 통해 배포한다. 배포 후 `https://app.aivida.tech/statistics.html`과 `/assets/statistics-data.js`에서 변경된 자료를 확인하고 변경 기록에 결과를 추가한다. Railway의 서비스/환경 연결을 바꾸거나 새 프로젝트를 만들지 않는다.

2026-09-28 로컬 `railway status`는 오래된 연결을 가리켜 서비스 조회 오류가 난다. 배포 확인에는 Git 원격 브랜치와 운영 URL을 사용한다. CLI 연결 정보를 문서에 있는 이름만 보고 재설정하지 않는다.

## 종사자 평가 삭제·복구와 안내 툴팁 (2026-10-05)

- 기존 `STAFF_EVAL_DB_PATH` DB에 nullable `deleted_at` 열만 자동 추가한다. 새 저장소·비밀 변수는 필요 없다. 초기화의 쓰기 트랜잭션으로 동시 마이그레이션을 직렬화한다.
- 관리 POST `/api/support/staff-eval/delete`, `/restore`에 `{id}`를 전달한다. 기존 동일 출처 검사와 직접 관리 접근 방식을 유지한다. GET 목록의 `view=active|deleted` 기본값은 `active`다. 삭제는 응시 쿠키 해제와 링크 차단을 포함하며, 복구는 기존 답변·점수·상태·만료를 유지한다.
- `assets/ui-help.js`는 명시된 설명 노드를 제목 옆 툴팁으로 옮기고 인쇄 시 원래 위치로 복원한다. 지원사업의 동적 탭도 관찰하며 기존 별도 툴팁 구현은 변경하지 않는다. HTML의 새 CSS/JS 조회 버전으로 브라우저 캐시를 갱신한다.
- 검증: `python -m unittest test_ui_consistency.py test_static_pages.py test_claim_check.py test_staff_eval.py test_support_projects.py test_payroll.PayrollRouteTests.test_payroll_assets_and_no_personal_data_submission`; `node --test test_ui_help.cjs test_staff_eval_voice.cjs test_navigation.cjs test_payroll.cjs test_operating_math.cjs test_naver_ads_math.cjs test_nearby_facilities.cjs test_statistics.cjs test_search_visibility.cjs test_reputation_watch.cjs test_claim_check.cjs`.
