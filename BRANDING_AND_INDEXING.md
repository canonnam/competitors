# 더비다 지식 창고: 브랜드 이미지와 검색 제외

운영 주소: https://competitors-dev.up.railway.app

## 이미지

- `assets/brand/favicon.svg`: 기존 사이트의 파란색과 펼친 책을 조합한 벡터 아이콘.
- `favicon.ico`: 16·32·48px 브라우저 호환 아이콘.
- `assets/brand/apple-touch-icon.png`: 180px iOS 홈 화면 아이콘.
- `assets/brand/icon-512.png`: 512px 원본 크기 아이콘.
- `assets/brand/og-image.png`: 1200×630px 공유 이미지. 내장 ImageGen으로 생성한 이미지를 규격에 맞게 인코딩했다.

모든 HTML 문서의 원본 `<head>`에 아이콘, Open Graph, Twitter 카드 정보를 넣었다. 자바스크립트를 실행하지 않는 공유 미리보기 봇도 읽을 수 있다. 사이트 주소가 바뀌면 전체 HTML의 `og:url`, `og:image`, `og:image:secure_url`, `twitter:image` 주소도 변경한다. 공유 이미지는 구체적인 운영 수치나 내부 보고서 내용을 포함하지 않는다.

## 검색 제외

모든 HTML에 `robots` 메타 태그를, Python 서버의 모든 응답에 `X-Robots-Tag` 헤더를 적용했다. 값은 `noindex, nofollow, noarchive, nosnippet, noimageindex`다. HTML 이외의 API·이미지·오류·HEAD·304 응답에도 적용한다. 기존 Nginx 템플릿에도 같은 정책을 유지한다.

`robots.txt`는 크롤러가 **검색 제외 지시를 읽을 수 있게** 접근을 허용한다. `Disallow: /`를 함께 넣으면 크롤러가 `noindex`를 읽지 못해 외부 링크로 알려진 URL이 검색 결과에 남을 수 있다. 사이트맵과 검색용 구조화 데이터는 제공하지 않는다.

검색 제외는 접근 인증이 아니다. 지시를 따르지 않는 봇이나 직접 접속을 막지는 않으며, 기존 색인의 삭제에는 검색엔진의 재방문이 필요하다. 완전한 비공개가 필요하면 별도로 사용자 인증을 설계해야 한다. 검색봇의 접근을 일괄 차단하면 링크 공유 미리보기에도 영향을 줄 수 있다.

근거: [Google의 noindex 문서](https://developers.google.com/search/docs/crawling-indexing/block-indexing).

## 확인

`python -m unittest discover -v`는 모든 페이지의 원본 메타정보, 아이콘과 OG 규격, 응답 유형별 검색 제외 헤더 및 소스 파일 접근 차단을 검사한다. 새 HTML 페이지에도 같은 메타정보를 넣어야 이 검사가 통과한다.
