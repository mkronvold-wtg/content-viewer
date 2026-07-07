FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.mjs ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CONTENT_VIEWER_REPO_PATH=/app/content

RUN mkdir -p /app/content && chown -R node:node /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
