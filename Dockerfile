FROM node:26-alpine3.23@sha256:871eb674ad6e692c91330a8959f1ce2f80ba3f445cdc54e306869d2ea265e42d AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine3.23@sha256:871eb674ad6e692c91330a8959f1ce2f80ba3f445cdc54e306869d2ea265e42d AS runtime

RUN apk add --no-cache git ca-certificates \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server.mjs theme.css theme.json ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CONTENT_VIEWER_REPO_PATH=/app/content

RUN mkdir -p /app/content && chown node:node /app/content
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
