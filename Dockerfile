# Single container: static client + websocket game server, plain HTTP.
# TLS/proxying is handled externally (Pangolin). See DESIGN.md.
FROM node:24-alpine AS build
WORKDIR /app

# Workspace manifests first, for layer caching.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json   packages/shared/
COPY packages/engine/package.json   packages/engine/
COPY packages/carddata/package.json packages/carddata/
COPY apps/server/package.json       apps/server/
COPY apps/web/package.json          apps/web/
RUN npm ci --no-audit --fund=false

COPY . .
# The vendored engine and generated card data are checked in, so the build needs
# no git submodule. Regenerating them from calculator/ is `npm run sync`, run by
# a human, deliberately NOT part of the image build, so an image can never
# silently pick up upstream rule changes.
RUN npm run build --workspaces --if-present

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# node:sqlite is built in: no native module build, no compiler in the image.

COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN npm ci --omit=dev --no-audit --fund=false && npm cache clean --force

# SQLite lives on a volume so games survive container replacement.
# The user is created and /data made writable BEFORE anything declares it a
# volume: Docker discards writes to a VOLUME path in later instructions, so a
# chown after `VOLUME` silently does nothing and a fresh volume comes up
# root-owned, which the non-root user cannot write to.
RUN addgroup -S fr && adduser -S fr -G fr && mkdir -p /data && chown -R fr:fr /data

ENV FR_DATA_DIR=/data
ENV FR_STATIC_DIR=/app/apps/web/dist
ENV PORT=3000
EXPOSE 3000

# /api/health reports room count; used by compose and any orchestrator.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER fr

CMD ["node", "apps/server/dist/src/index.js"]
