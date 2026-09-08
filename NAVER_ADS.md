# 더비다요양원 네이버 광고분석

`petdev`의 기존 Python/Railway 서비스에 통합되어 있습니다. 메인 카드에서 `/naver-ads.html`로 이동하며 `/api/naver-ads`가 인천점 지표를 제공합니다. 안양점 API는 호출하지 않습니다. 기존 텔레그램 잔액·월간 알림 작업과 독립적입니다.

## Railway 배포

기존 서비스의 배포 브랜치를 `petdev`로 지정하고 Dockerfile 빌드를 사용합니다. 새 서버나 GitHub Actions 작업은 필요하지 않습니다.

서비스 Variables에 기존 인천점 키 3개를 설정합니다. 값은 Git에 넣지 않습니다.

```dotenv
NAVER_INCHEON_CUSTOMER_ID=<인천점 customer id>
NAVER_INCHEON_ACCESS_LICENSE=<인천점 액세스 라이선스>
NAVER_INCHEON_SECRET_KEY=<인천점 비밀키>
NAVER_ADS_DB_PATH=/data/naver-ads.db
NAVER_ADS_SYNC_ENABLED=true
```

- `/data`에 기존 Railway Volume을 유지합니다. 피드백 DB와 다른 파일을 사용합니다.
- 서비스는 **항상 실행**, replica는 **1개**로 운영합니다. Railway Serverless/App Sleeping은 끕니다. 이 작업은 상시 웹 프로세스 안에서 실행되므로 Railway Cron으로 웹 서비스를 실행하지 않습니다.
- 매일 **10:30 Asia/Seoul**에 어제까지의 통계를 갱신합니다. PC가 꺼져 있어도 Railway 서비스가 실행 중이면 동작합니다.
- 시작할 때 누락 기간을 확인하고 보충합니다. API 지연 정정을 반영하기 위해 최근 수집 구간을 재조회하고 같은 날짜·항목은 덮어써 중복 집계하지 않습니다.
- 실패하면 마지막 성공 데이터와 기준일을 유지하고 30분 후 재시도합니다. 페이지에 오류/지연 상태가 표시됩니다.
- 초기 자료는 실제 수집된 `data/naver_ads_seed.json.gz`이며, 초기 DB 생성 때 한 번 가져옵니다. 키가 없으면 저장된 자료는 표시되지만 **자동 갱신 연결 대기**로 표시됩니다.
- `/api/naver-ads`에서 `through`, `updated_at`, `sync.enabled`, `sync.stale`, `sync.error`를 확인할 수 있습니다. `sync.enabled=true` 및 어제 날짜의 `through`를 확인해야 연결 완료입니다.

## 로컬 실행

Python 3.13의 표준 라이브러리만 사용합니다. 환경변수에 다음 경로를 설정한 후 `python app.py`를 실행합니다.

```dotenv
NAVER_ADS_ENV_FILE=/absolute/path/to/existing/.env
NAVER_ADS_DB_PATH=/absolute/path/to/local/naver-ads.db
FEEDBACK_DB_PATH=/absolute/path/to/local/feedback.db
PORT=8080
```

기존 `.env`에서 `NAVER_INCHEON_*`만 읽습니다. 프로세스 환경변수가 파일보다 우선합니다. 임의의 `.env`를 자동 검색하지 않습니다.

수동 1회 수집: `python naver_ads.py --sync`

초기 자료 재생성: `python naver_ads.py --sync --export-seed data/naver_ads_seed.json.gz`

## 분석과 데이터

- 2025-02-01부터 조회 가능한 캠페인/소재의 일별 기록을 90일 이하 구간으로 수집합니다. 현재 자료에는 2026-09-07까지의 실적이 포함됩니다.
- 노출, 클릭, 광고비(VAT 포함)를 저장합니다. CTR=클릭/노출×100, CPC=광고비/클릭으로 다시 계산하며 분모가 0이면 미산출입니다.
- 과거에 삭제되어 API에서 조회되지 않는 항목은 소급 복구하지 못합니다. 수집한 항목이 이후 사라져도 저장된 이력은 유지합니다.
- 소재 이름은 최신 문구이며 수정 전 문구의 실적이 섞일 수 있습니다. 소재 합계와 캠페인 합계는 삭제·확장소재·반올림으로 다를 수 있어 커버리지를 표시합니다.
- 광고 유형의 노출 위치/의도 차이 및 운영 조건 변화는 통제하지 않았습니다. 지출 증가나 CTR 차이를 인과효과로 해석하지 않습니다.
- 상담 전화 약 2건은 유입 경로가 미확인입니다. 상담 CPA, 입소 CPA, ROAS는 산출하지 않습니다.
- `data/naver_ads_history.json`은 8월 23일/9월 1일 분석에서 선택한 집계값과 운영 변경 기록입니다. 원본 경로, 잔액, 계정 인증정보는 제외했습니다.
- 이 프로젝트의 공개 페이지와 API는 같은 접근 범위를 갖습니다. 초기 집계 자료도 저장소에 포함됩니다. 인증정보는 서버 환경에서만 읽고 코드·DB·환경 파일의 정적 다운로드는 차단합니다.

13개 그래프, 10개 동적 인사이트, 날짜 범위 선택, 월별·일별·유형·소재 표, 소재 정렬 및 선택 기간 일별 CSV 다운로드를 제공합니다. 브라우저 외부 CDN 호출 없이 Chart.js 4.5.1과 Lucide 아이콘을 로컬 자산으로 사용합니다.

## 검증

```sh
python -m unittest discover -v
node --test test_naver_ads_math.cjs
node --check assets/naver-ads.js
```

수집 실패 보존, 중복 실행, 누락 기간 보충, 한국시간 일정 경계, 0 분모/가중 집계, 소재·캠페인 합계 분리, 비공개 파일 GET/HEAD 차단을 검증합니다.
