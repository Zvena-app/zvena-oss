# zvena web from an app already built on the host (`npm ci && npm run build`
# in web/): the same image as web.Dockerfile without building inside
# Docker — for a build machine short on disk. Build context: web/.
#   docker build -f deploy/web.prebuilt.Dockerfile -t zvena-web:<ver> web
FROM node:24.11-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0 \
    ZVENA_DB_PATH=/data/zvena.db ZVENA_FILES_DIR=/data/files
COPY .next/standalone ./
COPY .next/static ./.next/static
COPY public ./public
COPY templates ./templates
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3100
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
