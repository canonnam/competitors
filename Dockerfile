FROM node:22-alpine AS knowledge
WORKDIR /build
COPY assets/competitors-data.js ./assets/competitors-data.js
COPY scripts/build_competitor_knowledge.cjs ./scripts/build_competitor_knowledge.cjs
RUN mkdir -p data && node scripts/build_competitor_knowledge.cjs

FROM python:3.13-alpine

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY claim_check.py claim-check.html app.py naver_ads.py competitor_news.py wiki_chat.py agency_news.py business_support.py support_feedback.py search_visibility.py reputation_watch.py index.html competitors.html competitor-news.html agency-news.html ai-hub-data.html naver-ads.html search-visibility.html reputation-watch.html operating-costs.html nearby-facilities.html statistics.html knowledge.html /app/
COPY assets /app/assets
COPY payroll.html /app/
COPY robots.txt favicon.ico /app/
COPY data /app/data
COPY service_knowledge.py /app/
COPY aeo_missions.py /app/
COPY web_search_results.py /app/
COPY --from=knowledge /build/data/competitor_knowledge.json /app/data/competitor_knowledge.json
COPY nginx /app/nginx

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "app.py"]
