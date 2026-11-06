FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY scripts/build.mjs ./scripts/build.mjs
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime

ENV NODE_ENV=production \
    SRTL_DATA_DIR=/tmp/srtl-data \
    SRTL_HOST=0.0.0.0 \
    SRTL_PORT=3010 \
    SRTL_WEB_ROOT=/app/dist/client \
    SRTL_BACKUP_DIR=/backups \
    SRTL_PG_BIN_DIR=/usr/lib/postgresql/17/bin

LABEL org.opencontainers.image.source="https://github.com/ramphex/SRTL-Manager"

# pg_dump must be at least as new as the database, and Debian's own client is
# older, so it comes from the PostgreSQL project's repository. The signing key's
# hash is pinned here; its fingerprint is B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8.
RUN set -eu \
    && apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg tini \
    && install -d /usr/share/postgresql-common/pgdg \
    && node -e 'fetch("https://www.postgresql.org/media/keys/ACCC4CF8.asc").then(async (r) => { if (!r.ok) throw new Error(String(r.status)); require("node:fs").writeFileSync("/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc", await r.text()); })' \
    && echo "0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" | sha256sum -c - \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install --no-install-recommends -y postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 700 /backups

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3010

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/index.js"]
