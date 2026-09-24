FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:client && npm run build:server
RUN AWS_SDK_VERSION="$(node -p "require('./node_modules/@aws-sdk/client-s3/package.json').version")" \
  && AZURE_SDK_VERSION="$(node -p "require('./node_modules/@azure/storage-blob/package.json').version")" \
  && npm prune --omit=dev \
  && npm install --prefix /tmp/provider-deps --no-save --no-package-lock --omit=dev --no-audit --no-fund \
    "@aws-sdk/client-s3@${AWS_SDK_VERSION}" \
    "@azure/storage-blob@${AZURE_SDK_VERSION}" \
  && cp -a /tmp/provider-deps/node_modules/. /app/node_modules/ \
  && rm -rf /tmp/provider-deps

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV THIMBLE_HOST=0.0.0.0
ENV THIMBLE_PORT=8787

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8787

CMD ["node", "dist/server/server.js"]
