# 더비다 지식 창고 개발 환경

확인일: 2026-09-30. 이 문서는 실행과 배포에 필요한 구조를 기록한다. 계정 비밀 값과 운영 데이터는 포함하지 않는다.

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
- 도면 이미지는 JPG·PNG·WEBP 10MB까지 받으며 긴 변 1,500px 이하로 줄여 JSON에 포함한다. 자동 벽 인식은 수행하지 않으며 평면 편집에서 공간의 두 모서리를 지정한다. JSON 가져오기는 25MB까지 허용하고 이미지 데이터와 공간 경계를 검증한다.
- 저장은 현재 사이트·브라우저의 `localStorage` 키 `vida-facility-3d-v1`에 최대 8개 건물까지 보관한다. 용량 부족·차단 시 안내하고 파일 내보내기를 제공한다. 서버나 ERP에 도면·입소자 정보는 전송하지 않는다.
- 검증: `node --test test_facility_3d.cjs test_navigation.cjs test_dashboard.cjs`, `python -m unittest test_ui_consistency.py test_static_pages.py test_card_knowledge.CardKnowledgeTests.test_every_new_card_routes_without_operating_false_positive`.

## 배포와 확인

`petdev`에 검증한 커밋을 반영하면 기존 Railway 연결을 통해 배포한다. 배포 후 `https://app.aivida.tech/statistics.html`과 `/assets/statistics-data.js`에서 변경된 자료를 확인하고 변경 기록에 결과를 추가한다. Railway의 서비스/환경 연결을 바꾸거나 새 프로젝트를 만들지 않는다.

2026-09-28 로컬 `railway status`는 오래된 연결을 가리켜 서비스 조회 오류가 난다. 배포 확인에는 Git 원격 브랜치와 운영 URL을 사용한다. CLI 연결 정보를 문서에 있는 이름만 보고 재설정하지 않는다.
