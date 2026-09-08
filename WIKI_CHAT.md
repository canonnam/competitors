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
