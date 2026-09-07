FROM python:3.13-alpine

WORKDIR /app
COPY app.py index.html competitors.html /app/
COPY assets /app/assets
COPY nginx /app/nginx

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "app.py"]
