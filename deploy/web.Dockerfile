# zvena web (home, Documents, account, OIDC for Design) — a self-contained
# Next.js server. Build context: web/.
#   bash design/bin/publish-source.sh            # the /source archives (MPL 2.0) go into the image
#   docker build -f deploy/web.Dockerfile -t zvena-web:<ver> web
# Data (SQLite + uploads) lives in /data; the process runs as `node`.

FROM node:24.11-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error

FROM node:24.11-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run typecheck && npm run build

FROM node:24.11-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0 \
    ZVENA_DB_PATH=/data/zvena.db ZVENA_FILES_DIR=/data/files
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/templates ./templates
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3100
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
