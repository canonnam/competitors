# 종사자 평가

운영·인사·회계 카드에서 요양보호사 상황판단 평가 링크를 만들고, 종사자는 휴대폰 링크로 여섯 상황을 글로 답합니다. 자동 점수는 초안이고 담당자가 확정합니다.

- 관리: `/staff-eval.html` (기존 담당자 접근 키)
- 종사자: `/staff-eval-session.html#토큰`
- 저장: `STAFF_EVAL_DB_PATH` (기본 `/data/staff-eval.db`, 기존 Railway 볼륨)
- 모델: 서버의 `GEMINI_API_KEY`만 사용. 키가 없으면 정해진 질문으로 진행하고 키워드·순서 루브릭으로 채점합니다.

배포는 이 저장소 `petdev` 브랜치의 기존 Railway `competitors` 서비스(Dockerfile)입니다. 새 비밀 값은 필요 없습니다. `GEMINI_API_KEY`는 이미 호스팅 환경에 있어야 하며 저장소에 넣지 않습니다.
