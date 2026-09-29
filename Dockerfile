FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:client && npm run build:studio && npm run build:server
RUN AWS_SDK_VERSION="$(node -p "require('./node_modules/@aws-sdk/client-s3/package.json').version")" \
  && AZURE_SDK_VERSION="$(node -p "require('./node_modules/@azure/storage-blob/package.json').version")" \
  && npm prune --omit=dev \
  && npm install --prefix /tmp/provider-deps --no-save --no-package-lock --omit=dev --no-audit --no-fund \
    "@aws-sdk/client-s3@${AWS_SDK_VERSION}" \
    "@azure/storage-blob@${AZURE_SDK_VERSION}" \
  && cp -a /tmp/provider-deps/node_modules/. /app/node_modules/ \
  && rm -rf /tmp/provider-deps

FROM node:22-bookworm-slim AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=https://github.com/Jason-Doyle/thimble

LABEL org.opencontainers.image.title="ThimbleDB" \
  org.opencontainers.image.description="Encrypted browser-first JSON database authority" \
  org.opencontainers.image.url="https://thimbledb.com" \
  org.opencontainers.image.source="${SOURCE}" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production
ENV THIMBLE_HOST=0.0.0.0
ENV THIMBLE_PORT=8787

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/thimbledb/data /var/lib/thimbledb/auth /var/lib/thimbledb/secrets \
  && chown -R node:node /var/lib/thimbledb

WORKDIR /var/lib/thimbledb

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:8787/healthz'); if (!response.ok) process.exit(1)"]

CMD ["node", "/app/dist/server/server.js"]
