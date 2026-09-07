# 경쟁사 분석 개선요청 자동화

## 동작 흐름

1. `competitors.html`의 **개선요청**은 `POST /api/feedback`으로 의견을 접수한다.
2. 앱은 Railway Volume의 SQLite DB(`FEEDBACK_DB_PATH`, 기본 `/data/feedback.db`)에 원문을 저장한다.
3. `SLACK_FEEDBACK_WEBHOOK_URL`이 설정되면 같은 의견을 Slack 채널로 즉시 전송한다.
4. `HERMES_FEEDBACK_WEBHOOK_URL`과 `HERMES_FEEDBACK_WEBHOOK_SECRET`이 설정되면 HMAC 서명된 JSON 이벤트를 Hermes webhook에 전송한다.
5. Hermes는 아래 정책에 따라 의견을 분류·처리한다.

## 배포 정책

### 자동 처리 — 낮은 중요도 (0~2점)
- 오탈자·문구·레이아웃·끊어진 링크 수정
- 이미 검증된 출처의 표기 보정
- 기존 기준을 바꾸지 않는 카드/상세 화면의 작은 보완

처리: 근거 확인 → 테스트 → `dev`에 커밋·푸시 → Slack에 변경·커밋·배포 상태 보고.

### 승인 필요 — 높은 중요도 (3점 이상 또는 불확실)
- 순위·비교 방법론·시장 주장 변경
- 서비스 추가/삭제, 가격·고객수·대표자 등 핵심 사실 변경
- 개인정보·비용·외부 API·보안·권한·데이터 보존 변경
- Railway 인프라·도메인·환경변수·배포 방식 변경
- 요구가 모호하거나 검증 가능한 근거가 없는 경우

처리: Slack에 **기획 초안**(문제, 범위, 근거, 예상 영향, 구현/테스트, 롤백)을 올린 뒤 명시적 승인 전에는 커밋·배포하지 않는다.

## Railway 환경변수

Railway 서비스 → **Variables** → **Raw Editor**에 아래 키를 추가한다. 실제 secret은 채팅이나 Git에 저장하지 않는다.

```dotenv
FEEDBACK_DB_PATH=/data/feedback.db
SLACK_FEEDBACK_WEBHOOK_URL=https://hooks.slack.com/services/…
HERMES_FEEDBACK_WEBHOOK_URL=https://<public-hermes-domain>/webhooks/competitors-feedback
HERMES_FEEDBACK_WEBHOOK_SECRET=<competitors-feedback subscription secret>
```

- `SLACK_FEEDBACK_WEBHOOK_URL`: Slack 앱에서 이 경쟁사 채널을 대상으로 만든 Incoming Webhook URL이다.
- `HERMES_FEEDBACK_WEBHOOK_URL`: `localhost`, `127.0.0.1`, `*.railway.internal`은 사용할 수 없다. Railway 컨테이너에서 접근 가능한 외부 HTTPS Hermes 주소여야 한다.
- `HERMES_FEEDBACK_WEBHOOK_SECRET`: webhook 생성 시 반환된 route secret이다. 재발급 시 Railway 값도 함께 바꾼다.
- Railway에서 `/data`에 Volume을 마운트해야 피드백이 재배포 후에도 보존된다.

## Hermes webhook 등록

먼저 Hermes webhook을 외부에서 접근 가능한 HTTPS 주소로 노출하고, `hermes gateway setup`으로 webhook 플랫폼을 활성화한다. 이후 다음 취지의 구독을 생성한다.

```bash
hermes webhook subscribe competitors-feedback \
  --prompt "경쟁사 분석 개선요청 #{feedback_id}: {message}\n분류: {category}\n\n중요도 정책을 적용하세요. 낮은 중요도(0~2)는 근거 확인, 테스트, /opt/data/competitors dev 브랜치 커밋·푸시 후 Slack에 결과를 알리세요. 높은 중요도(3+), 보안·비용·사실성·인프라 변경, 또는 불확실한 요청은 수정/배포하지 말고 Slack에 한국어 기획 초안을 작성하고 명시적 승인을 기다리세요." \
  --deliver slack
```

구독 명령이 반환하는 webhook URL과 secret을 Railway 환경변수에 넣는다. `--deliver slack`의 세부 대상은 Hermes에서 이 경쟁사 채널로 지정한다.
