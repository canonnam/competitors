# 더비다 지식 창고 개발 환경

확인일: 2026-09-28. 이 문서는 실행과 배포에 필요한 구조를 기록한다. 계정 비밀 값과 운영 데이터는 포함하지 않는다.

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

## 배포와 확인

`petdev`에 검증한 커밋을 반영하면 기존 Railway 연결을 통해 배포한다. 배포 후 `https://app.aivida.tech/statistics.html`과 `/assets/statistics-data.js`에서 변경된 자료를 확인하고 변경 기록에 결과를 추가한다. Railway의 서비스/환경 연결을 바꾸거나 새 프로젝트를 만들지 않는다.

2026-09-28 로컬 `railway status`는 오래된 연결을 가리켜 서비스 조회 오류가 난다. 배포 확인에는 Git 원격 브랜치와 운영 URL을 사용한다. CLI 연결 정보를 문서에 있는 이름만 보고 재설정하지 않는다.
