FROM python:3.13-alpine

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py naver_ads.py competitor_news.py wiki_chat.py agency_news.py index.html competitors.html competitor-news.html agency-news.html ai-hub-data.html naver-ads.html operating-costs.html nearby-facilities.html statistics.html knowledge.html /app/
COPY assets /app/assets
COPY robots.txt favicon.ico /app/
COPY data /app/data
COPY nginx /app/nginx

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "app.py"]
