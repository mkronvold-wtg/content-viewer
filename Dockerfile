FROM node:26-alpine3.23@sha256:c3c6e314fd42e41962360b2482fc18d150beb47976c3aa7b8b9689d7ef42a5c2 AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine3.23@sha256:c3c6e314fd42e41962360b2482fc18d150beb47976c3aa7b8b9689d7ef42a5c2 AS runtime

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
