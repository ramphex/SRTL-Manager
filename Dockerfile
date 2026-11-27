FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY scripts/build.mjs ./scripts/build.mjs
COPY src ./src
RUN npm run build

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime

ENV NODE_ENV=production \
    SRTL_DATA_DIR=/tmp/srtl-data \
    SRTL_HOST=0.0.0.0 \
    SRTL_PORT=3010 \
    SRTL_WEB_ROOT=/app/dist/client \
    SRTL_BACKUP_DIR=/backups \
    SRTL_PG_BIN_DIR=/usr/lib/postgresql/17/bin

LABEL org.opencontainers.image.source="https://github.com/ramphex/SRTL-Manager"

# pg_dump must be at least as new as the database, and Debian's own client is
# older, so it comes from the PostgreSQL project's repository. The public
# signing key is kept in the repo (docker/apt.postgresql.org.asc) so the build
# does not depend on postgresql.org being reachable; its hash is pinned here and
# checked after the copy. Fingerprint:
# B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8. To refresh it, download
# https://www.postgresql.org/media/keys/ACCC4CF8.asc, compare the fingerprint
# with the one published at https://www.postgresql.org/download/linux/debian/,
# replace the file and update the sha256 below.
#
# The base image is refreshed less often than Debian publishes security fixes,
# so the runtime layer upgrades the packages it ships (for example libpam,
# CVE-2025-6020) before installing anything else. The container scan fails on
# fixed HIGH or CRITICAL issues, so this keeps it passing between refreshes.
COPY docker/apt.postgresql.org.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
RUN set -eu \
    && apt-get update \
    && apt-get upgrade --no-install-recommends -y \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg tini \
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
