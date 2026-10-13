# AI Visibility Checker in a container: CLI, dashboard, scheduler and MCP server.
#   docker build -t avc .
#   docker run --rm -v avc-data:/data avc audit https://yoursite.com
#   docker run --rm -p 4317:4317 -v avc-data:/data avc ui --host 0.0.0.0
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
RUN npm run compile && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    AVC_DATA_DIR=/data \
    AVC_CHROME_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium
# Chromium for JavaScript rendering, fonts so rendered pages measure correctly, CA certs for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY README.md LICENSE ./
RUN ln -s /app/dist/cli.js /usr/local/bin/avc && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4317
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli.js"]
CMD ["--help"]
