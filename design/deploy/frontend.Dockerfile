# zvena Design frontend: the official Penpot nginx image with the zvena bundle.
# Build context: a directory with app/ (the bundle from bin/build-frontend.sh),
# config.js and zvena-entrypoint.sh (bin/build-frontend-image.sh prepares it).
FROM penpotapp/frontend:2.18.3
USER root
RUN rm -rf /var/www/app
# Resolve the backend and the exporter per request (a recreated container
# may get a new address) and give up on a dead one after 3 s, not 300 s.
RUN sed -i 's|valid=10s;|valid=2s;|' /tmp/resolvers.conf.template \
 && grep -q 'valid=2s;' /tmp/resolvers.conf.template \
 && sed -i 's|^    proxy_connect_timeout 300s;$|    proxy_connect_timeout 3s;|' /tmp/nginx.conf.template \
 && grep -q '^    proxy_connect_timeout 3s;$' /tmp/nginx.conf.template
RUN sed -i \
      -e 's|proxy_pass $PENPOT_BACKEND_URI/assets;|proxy_pass $PENPOT_BACKEND_URI$request_uri;|' \
      -e 's|proxy_pass $PENPOT_BACKEND_URI/api;|proxy_pass $PENPOT_BACKEND_URI$request_uri;|' \
      -e 's|proxy_pass $PENPOT_BACKEND_URI/ws/notifications;|proxy_pass $PENPOT_BACKEND_URI$request_uri;|' \
      -e 's|proxy_pass $PENPOT_EXPORTER_URI;|proxy_pass $PENPOT_EXPORTER_URI$request_uri;|' \
      /tmp/nginx.conf.template \
 && test "$(grep -c 'proxy_pass $PENPOT_[A-Z]*_URI$request_uri;' /tmp/nginx.conf.template)" = 5
# Static files are cached for a week only when they exist (never a cached 404).
RUN sed -i 's|^    map $http_upgrade $connection_upgrade {$|    map $status $zv_static_cache { ~^(200\|206\|304)$ "public, max-age=604800"; default "no-store"; }\n    map $http_upgrade $connection_upgrade {|' /tmp/nginx.conf.template \
 && sed -i 's|add_header Cache-Control "public, max-age=604800" always; # 7 days|add_header Cache-Control $zv_static_cache always; # 7 days when found|' /tmp/nginx.conf.template \
 && grep -q 'map $status $zv_static_cache' /tmp/nginx.conf.template \
 && grep -q 'add_header Cache-Control $zv_static_cache always;' /tmp/nginx.conf.template
# The access log (docker logs) keeps the path, not the query string or the
# Referer: a share link's share-id travels in the query of the viewer's
# requests, and neither may outlive the request (deploy/caddy/Caddyfile masks
# the same things in front of Design).
RUN sed -i \
      -e 's|"\$request" |"$request_method $uri $server_protocol" |' \
      -e 's| "\$http_referer" | "-" |' \
      /tmp/nginx.conf.template \
 && grep -qF '"$request_method $uri $server_protocol"' /tmp/nginx.conf.template \
 && ! grep -qF -e 'http_referer' -e '"$request"' /tmp/nginx.conf.template
# The management API is internal (the zvena web app calls the backend directly):
# never reachable through the public frontend.
RUN sed -i 's|^    server {$|    server {\n        location /management/ { return 404; }|' /tmp/nginx.conf.template \
 && grep -q 'location /management/ { return 404; }' /tmp/nginx.conf.template
# Google Fonts through Design with a persistent cache (fonts-cache volume at
# /opt/data/gfonts); the GitHub templates proxy is dropped.
COPY --chown=1001:0 nginx-gfonts-cache.conf /etc/nginx/overrides/http.d/zvena-gfonts-cache.conf
COPY --chown=1001:0 nginx-gfonts-locations.conf /etc/nginx/overrides/location.d/external-locations.conf
COPY --chown=1001:0 nginx-app-locations.conf /etc/nginx/overrides/location.d/zvena-app-locations.conf
RUN mkdir -p /opt/data/gfonts && chown 1001:0 /opt/data/gfonts
COPY --chown=1001:0 app /var/www/app
COPY --chown=1001:0 config.js /var/www/app/js/config.js
COPY --chown=1001:0 zvena-entrypoint.sh /zvena-entrypoint.sh
USER penpot:penpot
ENTRYPOINT ["/bin/bash", "/zvena-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
