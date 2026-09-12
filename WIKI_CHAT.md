# 위키 채팅 운영

홈 오른쪽 아래의 채팅 아이콘에서 위키를 근거로 질의응답합니다. 이 기능은 Railway에서 실행되므로 개인 PC를 꺼도 이용할 수 있습니다. 현재 Codex 대화 자체를 연결하는 것이 아니라, 동일한 위키 문서를 검색하여 별도의 LLM API로 답변합니다.

## 배포 구성

- GitHub: `canonnam/competitors`, `petdev` 브랜치
- Railway: `vida` 프로젝트 → `dev` 환경 → `competitors`
- 서비스: https://competitors-dev.up.railway.app/
- 관리자 화면: https://competitors-dev.up.railway.app/knowledge.html
- 문서 DB: `/data/wiki-chat.db` (기존 Railway 영구 볼륨)
- 개인 위키, 원본 자료, API 키, 관리자 키, 이용자 대화는 Git에 올리지 않습니다.

필수 Railway Variables:

| 변수 | 용도 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API 키. ChatGPT 구독과 API 사용료는 별도입니다. |
| `CHAT_ADMIN_TOKEN` | 문서 관리 화면 및 동기화 인증에 사용하는 충분히 긴 임의의 비밀키 |
| `WIKI_DB_PATH` | `/data/wiki-chat.db` |
| `OPENAI_MODEL` | 기본값 `gpt-4.1-mini`. Responses API 및 Structured Outputs를 지원하는 모델 |
| `CHAT_DAILY_LIMIT` | 서비스 전체 일일 요청 한도. 기본 300회, 한국시간 자정 기준 |

키는 Railway Variables에서만 관리합니다. 관리자 키를 교체하면 이전 키는 다음 배포 후 무효가 됩니다. 관리자 화면은 키를 브라우저 저장소에 보관하지 않습니다.

## 지식 추가 방법 1: 현재 PC의 위키를 계속 사용

1. 기존 `raw/`에 새 PDF·HWP 등 자료를 추가합니다.
2. Codex에 기존처럼 `AGENTS.md 규칙에 따라 새 자료를 ingest 해주세요`라고 요청합니다.
3. 갱신된 `wiki/`를 검토한 뒤 아래 동기화를 실행하거나, Codex에 웹서비스 위키 동기화를 요청합니다.

서버는 PC 폴더를 실시간 감시하지 않습니다. `raw/`에 파일을 놓는 것만으로 웹 답변이 바뀌지 않습니다. 동기화된 사본이 서버에 유지되며, 이후 PC를 꺼도 작동합니다.

```powershell
python -m pip install -r requirements.txt
python scripts/sync_wiki.py --wiki 'C:\path\to\personal-llm-wiki-starter\wiki' --dry-run

# 이미 로그인된 Railway CLI에서 관리자 키를 출력하지 않고 전달합니다.
$wikiServiceVars = railway variables --service competitors --environment dev --json | ConvertFrom-Json
$env:CHAT_ADMIN_TOKEN = $wikiServiceVars.CHAT_ADMIN_TOKEN
try {
    python scripts/sync_wiki.py --wiki 'C:\path\to\personal-llm-wiki-starter\wiki' --url https://competitors-dev.up.railway.app
} finally {
    Remove-Item Env:CHAT_ADMIN_TOKEN -ErrorAction SilentlyContinue
}
```

이 명령은 올바른 Railway 프로젝트에 연결된 저장소 디렉터리에서 실행합니다. `sources`, `entities`, `concepts`, `syntheses`를 반영하며 `raw/`, `AGENTS.md`, `index.md`, `log.md`, `questions`는 제외합니다. `visibility: private`, `publish: false`, `internal-manual` 태그가 있는 문서도 제외합니다. 위키에서 삭제하거나 비공개로 바꾼 문서는 다음 전체 동기화 때 서버의 `wiki/` 범위에서도 제거됩니다. 관리자 화면에서 별도로 올린 `uploads/` 문서는 유지됩니다. 문서 전체를 먼저 검증하고 하나의 DB 트랜잭션으로 반영합니다.

## 지식 추가 방법 2: 관리자 화면에서 등록

1. 채팅창의 설정 아이콘 또는 `/knowledge.html`을 엽니다.
2. Railway `CHAT_ADMIN_TOKEN` 값으로 연결합니다.
3. 검토한 UTF-8 `.md` 또는 `.txt` 파일을 선택하여 등록합니다.

동일한 파일명은 `uploads/` 범위에서 갱신됩니다. 다른 이름은 새 문서가 됩니다. 등록 직후 다음 질문부터 검색에 반영되며 사이트 재배포는 필요 없습니다. 위키 동기화 문서와 관리자 업로드는 별개이므로 동일 문서를 두 경로로 중복 관리하지 않는 편이 좋습니다.

파일당 200KB, 한 번에 100개/합계 4MB, 전체 500개까지 지원합니다. PDF·HWP·스캔은 직접 업로드할 수 없습니다. 기존 ingest 과정에서 본문을 추출하고, 표·수치·시행일을 검토하여 Markdown으로 정리한 뒤 등록합니다. 이 화면은 문서 저장과 검색 색인을 갱신하며, LLM을 이용한 자동 요약이나 법령 검증을 수행하지 않습니다.

```markdown
---
type: source
updated: 2026-09-08
status: active
---
# 문서 제목

## 적용 범위와 시행일
시설 유형, 적용 대상, 원문 시행일을 기재합니다.

## 확인한 내용
원문의 기준·산식·예외를 출처와 페이지 번호와 함께 정리합니다.

## Source Notes
공식 출처 URL과 확인일을 기재합니다.
```

## 답변과 운영 범위

### 서비스 데이터 질의 (2026-09-09)

- 경쟁사 분석: 화면과 같은 18개 회사의 기능, 고객 지표, 50인 가격 및 조건, 운영사 매출 공시 내용을 읽습니다. 운영사 매출과 서비스 단독 매출을 구별합니다.
- 경쟁사 뉴스: 기존 뉴스 DB를 질문 시 읽으며, 게시일·회사 필터와 수집 성공 시각을 제공합니다. 질문이 뉴스 수집을 실행하지 않으며, 본문 없는 기사는 제목 수준으로만 답변합니다. 단순 뉴스 목록은 검토된 요약을 그대로 표시하여 계획을 실적으로 바꾸지 않고, 영향 분석 등 복합 질문은 근거와 함께 LLM에 전달합니다.
- 더비다 운영분석: `data/operating_report.json`의 공개 월별 집계만 읽습니다. 지점·월·기간별 합계, 두 지점 공통 월 비교, 전월 대비 증감과 계정군별 손익 영향을 서버에서 계산합니다. 이름, 개별 급여, 거래 메모, 원본 파일은 조회·전송하지 않습니다.
- 기존 서비스는 로그인 없는 공개 접근 모델입니다. 이 연결도 이미 공개한 화면의 자료로 한정하며, 비공개 DB나 다른 시설 원장을 열지 않습니다. 이후 비공개 자료를 연결하려면 별도 로그인 및 서버 권한 검사를 먼저 구현해야 합니다.
- 문서와 서비스 발췌에 하나의 인용 번호를 부여하며, 출처 버튼에서 기준일·발췌·원래 화면 또는 기사 링크를 확인합니다. 데이터 내 명령은 지침으로 실행하지 않으며, 임의 SQL·URL·파일 읽기 기능은 없습니다.
- `이번 달`, `지난달`, `최근 N개월`은 한국시간의 현재 달 기준입니다. 기간 미지정 운영 질의는 보유 최신 월을 사용하고 명시합니다. 자료 없는 월은 0이나 다른 달로 대체하지 않습니다. 연도 미지정 `7월`은 현재 연도로 해석합니다.
- 홈의 12개 카드를 모두 연결합니다. 아래 표의 원자료를 매 질문마다 읽으며, 별도 복사본을 위키 DB에 적재하지 않습니다.

### 전체 카드 연결·갱신 (2026-09-12)

| 카드 | 질문 시 읽는 원자료 | 반영 방식 |
|---|---|---|
| 급여 계산·근로계약서 | `payroll.html`, `assets/contracts/templates.json` | 공개 사용법·공통 양식 갱신 후 다음 질문. 직원 입력값과 계산 결과는 읽지 않음 |
| 지점별 청구 점검 | `claim_check.report()` / `CLAIM_CHECK_PATH` | 점검 파일 저장 후 다음 질문. 급여제공월·조회시각·접수/지급 구분 |
| 경쟁사 분석 | 화면의 `competitors-data.js`와 HTML | 배포 시 동일 원본 자동 내보내기, 실행 시 해시 검증 |
| 경쟁사 및 요양원 뉴스 | 기존 뉴스 DB | 수집 완료 후 다음 질문 |
| 건보공단·복지부 뉴스·지원사업 | `agency_news.report()` | 수집·관심 상태 갱신 후 다음 질문. 추천은 자격 확정이 아님 |
| AI 허브 활용데이터 | `ai-hub-data.html` | 같은 공개 본문을 질문할 때 읽음 |
| 네이버 광고분석 | `naver_ads.report()` | 수집 완료 후 다음 질문. 캠페인 합계로 계산, 소재 중복 합산 방지 |
| 검색노출 현황 | `search_visibility.report()` 및 저장된 AI 웹 관측 | 수집·관측·미션 저장 후 다음 질문. 광고/자연 검색/AI 웹, 지점, 미측정·지난 관측 구분 |
| 평판 점검 | `reputation_watch.report()` | 수집·분류 갱신 후 다음 질문. 검토 후보를 확정 사건으로 바꾸지 않음 |
| 운영비 분석 | `data/operating_report.json` | 기존 집계 갱신·배포 후 다음 질문 |
| 주변 영업처 지도 | `data/nearby_facilities.json` | 기존 자료 갱신·배포 후 다음 질문 |
| 통계자료 | `statistics-data.js`의 문헌·책갈피 | 배포 시 동일 원본 자동 내보내기, 실행 시 해시 검증 |

`card_knowledge.py`는 고정된 파일/DB만 읽습니다. DB는 `mode=ro`로 열어 수집기 데이터 변경이나 누락 DB 생성을 막습니다. 질문은 외부 수집을 실행하지 않으며, 수집 오류·기준일·발췌 범위를 근거에 포함합니다. 원자료 갱신과 과거 대화 답변의 자동 변경은 다릅니다. 이미 표시된 답변은 그대로 남고 새 질문에서 최신 저장값을 읽습니다. 정적 자료 자체의 수집 주기는 변경하지 않습니다.

새 홈 카드가 추가되면 `test_registry_covers_every_homepage_card_and_source_links`에서 등록 누락을 검출합니다. 여러 카드를 묻는 질문은 카드별 근거를 먼저 확보해 한 카드의 발췌가 다른 카드를 밀어내지 않도록 합니다. 지점명만 보고 운영비로 오분류하지 않으며, 짧은 후속 질문에는 직전 주제·지점만 이어받고 이전 답변 수치는 재사용하지 않습니다.

경쟁사 정적 데이터는 `node scripts/build_competitor_knowledge.cjs`로 같은 화면 데이터에서 내보내며, Docker 빌드에서도 자동 생성합니다. 실행 시 원본 해시가 다르면 오래된 값을 답하지 않습니다. Node는 빌드 단계에만 필요합니다. 운영 집계는 기존 가져오기·배포 흐름을 유지하고 뉴스는 기존 수집기가 DB를 갱신하면 다음 질문부터 반영됩니다. 서비스 데이터를 위키 DB에 중복 저장하거나 기존 위키를 덮어쓰지 않습니다.

검증: `python -m unittest test_service_knowledge test_wiki_chat`, `node scripts/build_competitor_knowledge.cjs --check`. 브라우저 검증: `WIKI_TEST_URL`을 지정하고 `node scripts/verify_wiki_ui.cjs` 실행.

SQLite FTS5에 한국어 음절 단위 검색어를 추가하고, 관련 source 페이지를 연결하여 최대 8개 발췌를 모델에 제공합니다. 문서에 없는 숫자·규정은 추측하지 않도록 지시하며, 답변에 사용된 인용 번호를 서버에서 검사합니다. 출처 버튼은 제목, 갱신일, 실제 참고한 문서 발췌를 보여줍니다. 문서 갱신일을 법령 시행일로 취급하지 않습니다.

이 서비스는 실시간 웹 검색이나 최신 법령 확인을 하지 않습니다. 위키 요약에 원문 규정이 빠져 있으면 답변도 제한됩니다. 인용 검사는 번호의 유효성을 검사하는 것이며 모든 문장의 사실성을 보장하는 법률 검증기는 아닙니다. `needs-review` 자료는 검토 필요 상태를 유지합니다.

대화는 현재 브라우저 탭의 sessionStorage에만 보관하고, 서버 DB에는 질문·답변을 저장하지 않습니다. OpenAI Responses 요청에는 `store: false`를 지정하지만, API 제공자의 별도 데이터 보존 정책까지 없어지는 것은 아닙니다. API 키는 브라우저로 전달하지 않습니다. 업로드한 답변용 지식은 사이트 이용자의 질문에 인용될 수 있으므로, 직원·입소자 개인정보 및 내부 비밀을 등록하지 않습니다.

요청 길이 제한, IP별 10분당 20회, 동시 생성 3개, 서비스 전체 일일 한도를 적용합니다. 일일 한도는 API 호출 시도도 포함하고 재시작해도 유지됩니다. 키 미설정, 검색 근거 없음, 외부 API 오류, 시간 초과는 각각 안내합니다. 공개 사이트의 남용이 늘면 로그인/접근 제어를 추가해야 합니다.

## 확인과 복구

```powershell
python -m unittest discover -v
node --test test_*.cjs
```

`/api/chat/status`는 연결 준비 여부와 문서 수만 공개합니다. `/api/wiki/*`에는 관리자 키가 필요합니다. 소스 파일, DB, 원문 폴더는 정적 파일 경로로 제공하지 않습니다. Railway 재배포 때 `/data` 볼륨을 유지해야 합니다. 이전 코드를 롤백해도 지식 DB 파일은 볼륨에 남아 있으며 기존 광고/피드백 DB와 별개입니다. 중요한 지식은 원래 PC 위키를 기준본으로 보관하고, 관리자 화면에서 올린 파일도 별도로 보관합니다.

공식 참고: [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create), [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Railway Volumes](https://docs.railway.com/volumes).
