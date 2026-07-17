FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY scripts/build.mjs ./scripts/build.mjs
COPY src ./src
RUN npm run build

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS runtime

ENV NODE_ENV=production \
    SRTL_DATA_DIR=/tmp/srtl-data \
    SRTL_HOST=0.0.0.0 \
    SRTL_PORT=3010 \
    SRTL_WEB_ROOT=/app/dist/client

LABEL org.opencontainers.image.source="https://github.com/ramphex/SRTL-Manager"

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*

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
