FROM nginx:1.27-alpine

COPY index.html /usr/share/nginx/html/index.html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
