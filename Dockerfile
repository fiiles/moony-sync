# Moony sync server. Build with: docker build -t moony-sync:local .
#
# Both stages use the same base image, so the native modules (better-sqlite3, @node-rs/argon2)
# are installed inside the build stage for the libc the runtime stage runs on. Nothing is ever
# copied in from the host's node_modules.

FROM node:24-bookworm-slim AS build
# Build tools for better-sqlite3, in case no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY admin-ui ./admin-ui
RUN npm run build \
 && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/admin-ui/dist ./admin-ui/dist
# `docker exec <container> moony-sync reset-admin`
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/moony-sync \
 && chmod 755 /usr/local/bin/moony-sync \
 && mkdir -p /data \
 && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/server').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/main.js"]
