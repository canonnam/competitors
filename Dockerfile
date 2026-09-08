FROM python:3.13-alpine

WORKDIR /app
COPY app.py naver_ads.py index.html competitors.html competitor-news.html ai-hub-data.html naver-ads.html /app/
COPY assets /app/assets
COPY data /app/data
COPY nginx /app/nginx

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "app.py"]
