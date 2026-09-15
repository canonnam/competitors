# 홈페이지 상담·무료체험 접수

홈 카드 **상담·무료체험 신청** → `/website-requests.html`에서 방문상담, 무료체험, 비용 문의를 관리합니다. 기존 지원사업 신청 준비의 담당자 접근 키와 세션을 사용합니다. 공개 홈에는 연락처나 접수 내용이 나오지 않습니다.

- `POST /api/website-intake`: 서버 간 접수 전용. `WEBSITE_INTAKE_SECRET` Bearer 인증. 조회·상태 변경 권한 없음.
- `GET /api/support/website-requests`: 담당자 세션 필수. 유형·상태·개발/운영 사이트 필터, 30건 단위 페이지.
- `POST /api/support/website-requests/status`: 담당자 세션과 동일 출처 검증. 새 접수/상담 중/상담 완료/보관함, 담당자 메모.
- `WEBSITE_INTAKE_DB_PATH` 기본 `/data/website-intake.db`. Railway의 기존 영구 볼륨 사용. 배포 시 유지.
- 접수 ID는 UUID이며 동일 ID 재시도는 기존 접수를 반환합니다. 동일 ID의 내용 변경은 거부합니다. 익명화된 발신자 식별값당 10분에 5건으로 제한합니다.
- 요청 본문 최대 16KB, 수집 동의·입력 형식 검증. 신청 내용은 로그·공개 정적 파일·AI 지식 검색에 포함하지 않습니다.
- 테스트: `python -m unittest test_website_intake -v`. 임시 DB와 로컬 서버만 사용합니다.

운영에서 정한 개인정보 보유 기간이 끝나면 별도 승인된 파기 절차를 적용해야 합니다. 보관함은 복구 가능한 상태 변경이며 영구 파기가 아닙니다.
