# 종사자 평가

운영·인사·회계 카드에서 요양보호사 상황판단 평가 링크를 만들고, 종사자는 휴대폰에서 Gemini Live 음성으로 여섯 상황을 듣고 말로 답합니다. 마이크나 음성 연결이 안 되면 같은 화면에서 글로 답합니다. 자동 점수는 초안이고 담당자가 확정합니다.

- 관리: `/staff-eval.html` (기존 담당자 접근 키)
- 종사자: `/staff-eval-session.html#토큰`
- 저장: `STAFF_EVAL_DB_PATH` (기본 `/data/staff-eval.db`, 기존 Railway 볼륨)
- 모델: 서버의 `GEMINI_API_KEY`만 사용. 음성은 `STAFF_EVAL_LIVE_MODEL`(기본 `gemini-3.8-live`)용 짧은 토큰을 서버가 발급하고, 브라우저에는 그 토큰만 전달합니다. 키가 없거나 음성 연결이 실패하면 글로 답하고, 키워드·순서 루브릭으로 채점합니다.

음성 연결은 REST `auth_tokens`의 `bidiGenerateContentSetup`으로 제한한 일회용 토큰을 사용합니다. `liveConnectConstraints`는 SDK용 형식이므로 직접 HTTP 요청에 넣지 않습니다. WebSocket의 `setup`도 같은 설정을 사용하며 `responseModalities`와 `speechConfig`는 `generationConfig` 안에 둡니다. API 기준: https://ai.google.dev/api/generate-content#method:-auth_tokens.create 및 https://ai.google.dev/api/live

‘답변 말하기’와 ‘답변 끝내기’는 `activityStart`/`activityEnd`를 보냅니다. 자동 발화 감지는 끄고, 상황 읽기는 `clientContent.turnComplete`로 시작하므로 말 사이의 쉼을 답변 종료로 처리하지 않습니다.

연결 실패·시간 초과 시 글 답변과 ‘음성 다시 시도’를 제공합니다. 연결 중 화면을 전환하면 마이크·소켓·타이머를 정리하고, 인식한 답변의 저장 실패 시 글 입력란에 답변을 보존합니다. 서버 진단 로그에는 오류 유형과 HTTP 상태만 남기며 키·토큰·답변은 기록하지 않습니다.

배포는 이 저장소 `petdev` 브랜치의 기존 Railway `competitors` 서비스(Dockerfile)입니다. 새 비밀 값은 필요 없습니다. `GEMINI_API_KEY`는 이미 호스팅 환경에 있어야 하며 저장소에 넣지 않습니다.
