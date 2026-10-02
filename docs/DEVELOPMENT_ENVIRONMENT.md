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

## 시설 3D 도면

- `/facility-3d.html`: 기존 서버의 공개 정적 페이지 목록과 Docker 이미지에 포함한다. 시설 인수·개설 메뉴, 홈 기능 카드, 지식 질문의 기능 안내에 등록한다.
- `assets/facility-3d-model.js`: 층·공간·치수와 JSON 도면 파일의 검증 및 공간 배치. `assets/facility-3d.js`는 화면 조작·렌더링을 담당한다.
- `assets/vendor/three/`: 공식 npm 배포의 Three.js 0.186.1과 OrbitControls를 보관한다. 출처·MIT 라이선스는 해당 폴더에 포함한다. 기존 정적 파일로 제공하며 추가 빌드나 외부 CDN 요청은 필요하지 않다.
- WebGL2를 지원하는 브라우저에서 3D를 제공하고, 지원하지 않으면 선택 층의 2D 평면으로 표시한다.
- 건물은 1~12층, 층별 공간은 최대 40개다. 치수를 생략하면 24×16m, 층 높이 3.2m를 예시로 사용하고 추정 크기로 표시한다.
- 공간의 선택적 `points: [{x,z}, ...]`는 3~32개 꼭짓점을 보관한다. 사각형 기존 파일은 그대로 읽는다. 다각형은 경계·최소 면적·자기 교차를 검증하고 오목한 도형을 삼각형으로 나눠 면적·충돌을 계산한다. 표시 중심은 내부 삼각형에서 찾는다.
- 층의 선택적 `staff: [{role,count}, ...]`에는 직종과 인원만 보관한다. `care/social/nurse/therapy/admin/director/kitchen/other`의 직종당 20명, 층당 80명, 건물당 200명까지 검증한다. 기존 도면은 빈 배치로 읽는다. `assets/facility-staff-model.js`는 비복도 공간을 장애물로 두고 연결된 격자의 경로를 따라 예시 인물을 이동시킨다. `assets/facility-staff.js`는 입력·재생·속도·움직임 줄이기 설정을 담당한다. 실제 직원 이름·일정·작업량·손익은 사용하지 않는다.
- 건물 이름과 ERP 지점은 ‘이름·지점 변경’에서 수정한다. `nursingHomeId`는 안양 2·인천 3·미연결 null 중 하나이며 도면 JSON에 보관한다. 기존 파일의 안양·인천 지점명은 명시적 연결 값이 없을 때만 해당 지점으로 해석한다.
- 도면 이미지는 JPG·PNG·WEBP 10MB까지 받으며 긴 변 1,500px 이하로 줄여 JSON에 포함한다. PDF는 20MB·200페이지까지 받아 선택한 한 페이지를 해당 층에 등록한다. JSON 가져오기는 25MB까지 허용하고 이미지 데이터와 공간 경계를 검증한다.
- `assets/facility-3d-detect.js`는 긴 벽 선을 추출하고 문 틈을 메운 뒤 닫힌 사각형 영역을 공간 후보로 만든다. 인식되지 않는 경계·비정형 공간은 직접 구성한다. 후보는 최대 40개이며 사용자 확인 후 추가한다. 기존 공간 교체는 별도로 선택해야 한다.
- `assets/facility-3d-import.js`는 PDF.js 6.3.289로 페이지를 그리고 글자 위치를 읽는다. 이미지와 스캔 PDF는 Tesseract.js 6.0.1, core 6.1.2와 공식 한국어·영어 tessdata_fast 자료로 OCR을 수행한다. 글자의 중심이 공간 안에 있는 경우 이름을 연결하고 용도를 추정한다. 고유한 OCR 오탈자 보정 제안은 원문을 함께 표시한다. 모든 작업은 브라우저에서 수행하며 원본 도면을 외부 API로 전송하지 않는다.
- PDF/OCR 파일은 `assets/vendor/pdfjs`, `assets/vendor/tesseract`에 공식 배포 출처·라이선스와 함께 보관한다. `scripts/prepare_facility_vision.py`로 준비하며 Docker 빌드에서 내려받지 않는다. 이 폴더의 필요한 바이너리와 `example-floorplan.pdf`만 서버 공개 파일 목록에 추가한다.
- `자동 구성 예시`는 실제 지점 자료를 포함하지 않는 합성 이미지와 두 페이지 PDF를 일반 파일 처리 경로로 분석한다. 재생성은 `scripts/generate_facility_example.py`를 사용한다.
- 건물 삭제는 현재 브라우저 저장소의 선택 건물을 제거한다. 삭제 직전 화면 상태와 원래 저장본을 분리해 기억하고, 새로고침 전까지 가장 최근 삭제를 되돌릴 수 있다. 저장하지 않은 편집은 복구 시에도 미저장 상태로 유지한다.
- 저장은 현재 사이트·브라우저의 `localStorage` 키 `vida-facility-3d-v1`에 최대 8개 건물까지 보관한다. 용량 부족·차단 시 안내하고 파일 내보내기를 제공한다. 서버나 ERP에 도면·입소자 정보는 전송하지 않는다.
- `facility_collection.py`는 `FACILITY_ERP_USERNAME`·`FACILITY_ERP_PASSWORD`를 Railway Variables에서 읽는다. `app.py` 시작 직후와 3,600초마다 서버 스레드에서 안양 2·인천 3의 `/api/nursing-homes/living-rooms/?nursing_home=...`와 오늘(KST)의 집중·주의 스냅샷을 수집한다. 인증 갱신 실패 시 자동 재로그인한다. `facility_observation.py`의 기존 백엔드 주소·지점·인증·페이지 검증을 공유하고 다른 주소·지점으로 바뀐 페이지 연결과 리다이렉트를 차단한다.
- 공개 `/api/facility-observation/data?nursing_home_id=2|3`는 생활실 이름·층·정원·현원·잔여 정원, 생활실별 집중·주의 인원과 수집 시각만 반환한다. 생활실 현원 합은 배정된 재원 인원이며 미배정 어르신은 포함하지 않는다. 실명·입소자 ID·개별 의료정보는 수집 과정에서 집계한 뒤 폐기하고 캐시·로그·파일·DB·브라우저 저장소에 남기지 않는다. 자격증명은 서버 비밀 변수, 토큰은 서버 메모리에만 둔다. 화면에는 로그인·연결 버튼이 없다.
- 캐시는 서버 메모리에서 마지막 성공한 생활실·관찰 묶음을 보관한다. 일부 API 실패는 새 자료로 교체하지 않으며 이전 자료·오류·마지막 수집 시각을 표시한다. 첫 수집 미완료는 503으로 응답한다. 서버 재시작은 바로 수집을 시작한다. 브라우저 요청은 수집을 시작하지 않는다. 기존 `/session`과 `/targets`의 개인별 조회는 쿠키 인증·최대 8시간 세션을 유지하고 공개하지 않는다.
- `assets/facility-observation-model.js`는 같은 층에서 유일하게 일치하는 생활실만 연결한다. 미등록·중복·층 정보 없음은 위치 확인 대상으로 남긴다. `assets/facility-observation.js`는 진입·BFCache 복귀·지점 변경과 열린 탭의 60초 확인에서 서버 캐시를 읽고 로딩·실패·이전 자료 상태와 오른쪽 정보를 표시한다. 변경 없는 캐시 확인에서는 도면 편집과 직원 이동을 다시 만들지 않는다.
- MVP 검증: `python -m unittest test_facility_collection.py test_facility_observation.py`, `node --test test_facility_mvp.cjs test_facility_3d.cjs test_facility_observation.cjs`. `python test_facility_collection.py --serve`는 localhost:8097에서 합성 ERP 응답만 사용하는 UI 검증 서버를 연다. 운영 계정이나 실제 명단을 사용하지 않는다.
- 검증: `node --test test_facility_detection.cjs test_facility_3d.cjs test_navigation.cjs test_dashboard.cjs`, `python -m unittest test_facility_assets.py test_ui_consistency.py test_static_pages.py test_card_knowledge.CardKnowledgeTests.test_every_new_card_routes_without_operating_false_positive`.

## 배포와 확인

`petdev`에 검증한 커밋을 반영하면 기존 Railway 연결을 통해 배포한다. 배포 후 `https://app.aivida.tech/statistics.html`과 `/assets/statistics-data.js`에서 변경된 자료를 확인하고 변경 기록에 결과를 추가한다. Railway의 서비스/환경 연결을 바꾸거나 새 프로젝트를 만들지 않는다.

2026-09-28 로컬 `railway status`는 오래된 연결을 가리켜 서비스 조회 오류가 난다. 배포 확인에는 Git 원격 브랜치와 운영 URL을 사용한다. CLI 연결 정보를 문서에 있는 이름만 보고 재설정하지 않는다.
