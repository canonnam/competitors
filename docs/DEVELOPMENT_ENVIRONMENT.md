# 더비다 지식 창고 개발 환경

확인일: 2026-10-02. 이 문서는 실행과 배포에 필요한 구조를 기록한다. 계정 비밀 값과 운영 데이터는 포함하지 않는다.

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

## 시설 3D 지도 구성

- `/facility-3d.html`: 기존 서버의 공개 정적 페이지 목록과 Docker 이미지에 포함한다. 시설 인수·개설 메뉴, 홈 기능 카드, 지식 질문의 기능 안내에 등록한다.
- `assets/facility-3d-model.js`: 층·공간·치수와 JSON 도면 파일의 검증 및 공간 배치. `assets/facility-3d.js`는 화면 조작·렌더링을 담당한다.
- 층의 `level`은 배열 위치와 별개인 실제 층 번호(지하 1층 -1, 지상 1~12층 1~12)다. 0층은 허용하지 않는다. 중간 층 삭제 후에도 번호·ID를 유지하며 클라이언트와 서버 검증은 중복 번호를 막고 오름차순으로 저장한다. 번호 없는 이전 JSON만 배열 순서로 보완한다. 층 추가·삭제는 저장 전 편집이며 가장 최근 삭제한 층을 새로고침 전 복구할 수 있다. 공간 가져오기·종사자 배치는 ID/층 번호로 찾고 ERP 연결도 실제 층 번호를 쓴다.
- `assets/facility-3d-ui.js`는 공통 안내 툴팁과 저장 결과의 native dialog를 담당한다. 전체 화면 내부의 층 선택은 일반 층 선택과 같은 렌더링·현황 닫기 동작을 사용한다.
- `assets/vendor/three/`: 공식 npm 배포의 Three.js 0.186.1과 OrbitControls를 보관한다. 출처·MIT 라이선스는 해당 폴더에 포함한다. 기존 정적 파일로 제공하며 추가 빌드나 외부 CDN 요청은 필요하지 않다.
- WebGL2를 지원하는 브라우저에서 3D를 제공하고, 지원하지 않으면 선택 층의 2D 평면으로 표시한다.
- 건물은 지하 1층·지상 1~12층, 최대 13개 층이며 층별 공간은 최대 40개다. 새 건물의 층 수는 지상층 개수이며 지하층은 층 추가에서 등록한다. `floorName`·`floorCode`는 지하 1층/B1 표기를 통일하고 `floorIndex`는 B1=-1, 1F=0으로 렌더링 위치를 잡는다. `verticalBounds`로 최하층 밑에 바닥·그리드를 놓고 카메라가 지하층까지 포함하도록 맞춘다. 치수를 생략하면 24×16m, 층 높이 3.2m를 예시로 사용하고 추정 크기로 표시한다.
- 공간의 선택적 `points: [{x,z}, ...]`는 3~32개 꼭짓점을 보관한다. 사각형 기존 파일은 그대로 읽는다. 다각형은 경계·최소 면적·자기 교차를 검증하고 오목한 도형을 삼각형으로 나눠 면적·충돌을 계산한다. 표시 중심은 내부 삼각형에서 찾는다.
- 층의 선택적 `staff: [{role,count}, ...]`에는 직종과 인원만 보관한다. `care/social/nurse/therapy/admin/director/kitchen/other`의 직종당 20명, 층당 80명, 건물당 200명까지 검증한다. 기존 도면은 빈 배치로 읽는다. `assets/facility-staff-model.js`는 비복도 공간을 장애물로 두고 연결된 격자의 경로를 따라 예시 인물을 이동시킨다. `assets/facility-staff.js`는 입력·재생·속도·움직임 줄이기 설정을 담당한다. 실제 직원 이름·일정·작업량·손익은 사용하지 않는다.
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
- 공개 `/api/facility-observation/data?nursing_home_id=2|3`는 생활실 이름·층·정원·현원·잔여 정원, 생활실별 집중·주의 인원과 수집 시각만 반환한다. 생활실 현원 합은 배정된 재원 인원이며 미배정 어르신은 포함하지 않는다. 실명·입소자 ID·개별 의료정보는 수집 과정에서 집계한 뒤 폐기하고 캐시·로그·파일·DB·브라우저 저장소에 남기지 않는다. 자격증명은 서버 비밀 변수, 토큰은 서버 메모리에만 둔다. 화면에는 로그인·연결 버튼이 없다.
- 캐시는 서버 메모리에서 마지막 성공한 생활실·관찰 묶음을 보관한다. 일부 API 실패는 새 자료로 교체하지 않으며 이전 자료·오류·마지막 수집 시각을 표시한다. 첫 수집 미완료는 503으로 응답한다. 서버 재시작은 바로 수집을 시작한다. 브라우저 요청은 수집을 시작하지 않는다. 기존 `/session`과 `/targets`의 개인별 조회는 쿠키 인증·최대 8시간 세션을 유지하고 공개하지 않는다.
- `assets/facility-observation-model.js`는 같은 층에서 유일하게 일치하는 생활실만 연결한다. ERP 층의 `-1`·`B1`·`B1F`·`지하 1층`은 지하층으로 해석하며 1층과 구분한다. 등록하지 않은 지하층도 지상층에 연결하지 않는다. 미등록·중복·층 정보 없음은 위치 확인 대상으로 남긴다. `floorSummaries`는 도면 연결 여부와 무관하게 ERP의 명시적 층을 기준으로 현원·정원·관찰 인원을 집계한다. `markers`는 건물 전체·층별 펼치기에서 층 요약, 선택 층·평면에서 생활실 표식을 반환한다. `assets/facility-observation.js`는 진입·BFCache 복귀·지점 변경과 열린 탭의 60초 확인에서 서버 캐시를 읽고 로딩·실패·이전 자료 상태와 3D 화면 안 오른쪽 위 정보 박스를 표시한다. 관찰 선택은 카메라·보기·스크롤을 유지한다. 변경 없는 캐시 확인에서는 도면 편집과 직원 이동을 다시 만들지 않는다. 공개 집계 API와 개인별 조회 API의 인증은 이 표시 변경에서 수정하지 않는다.
- MVP 검증: `python -m unittest test_facility_projects.py test_facility_collection.py test_facility_observation.py`, `node --test test_facility_mvp.cjs test_facility_3d.cjs test_facility_observation.cjs`. `python test_facility_collection.py --serve`는 localhost:8097에서 합성 ERP 응답과 임시 공유 도면 DB를 사용하는 UI 검증 서버를 연다. localhost와 127.0.0.1의 서로 다른 브라우저 저장소에서 같은 공유 도면과 직원 인원을 확인할 수 있다. 운영 계정이나 실제 명단을 사용하지 않는다.
- 검증: `node --test test_facility_detection.cjs test_facility_3d.cjs test_navigation.cjs test_dashboard.cjs`, `python -m unittest test_facility_assets.py test_ui_consistency.py test_static_pages.py test_card_knowledge.CardKnowledgeTests.test_every_new_card_routes_without_operating_false_positive`.

## 배포와 확인

`petdev`에 검증한 커밋을 반영하면 기존 Railway 연결을 통해 배포한다. 배포 후 `https://app.aivida.tech/statistics.html`과 `/assets/statistics-data.js`에서 변경된 자료를 확인하고 변경 기록에 결과를 추가한다. Railway의 서비스/환경 연결을 바꾸거나 새 프로젝트를 만들지 않는다.

2026-09-28 로컬 `railway status`는 오래된 연결을 가리켜 서비스 조회 오류가 난다. 배포 확인에는 Git 원격 브랜치와 운영 URL을 사용한다. CLI 연결 정보를 문서에 있는 이름만 보고 재설정하지 않는다.
