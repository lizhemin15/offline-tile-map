FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="offline-tile-map" \
      org.opencontainers.image.description="Fully offline XYZ tile map viewer" \
      org.opencontainers.image.licenses="MIT"

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html config.js /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
COPY demo /usr/share/nginx/html/demo

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
