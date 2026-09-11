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

# SQLite lives on a bind mount (./DATA on the host, see docker-compose.yml) so
# games survive a container replacement and are backed up with a plain tar.
# A bind mount keeps the HOST directory's ownership, unlike a named volume: the
# container has to run as whatever uid owns that directory on the host, not as
# a uid this image invents. The `node:*-alpine` base already ships a non-root
# `node` user at uid 1000, which is also the first regular user on most single-
# user Linux hosts, so reusing it (rather than creating our own `fr` user) is
# what makes the bind mount writable without also having to chown the host
# directory or run the container as root. Hosts where that uid is wrong say so
# in .env (FR_UID/FR_GID), which docker-compose.yml passes as `user:`;
# scripts/deploy.sh fills it in from `id -u` on the first run.
RUN mkdir -p /data && chown -R node:node /data

ENV FR_DATA_DIR=/data
ENV FR_STATIC_DIR=/app/apps/web/dist
ENV PORT=3000
EXPOSE 3000

# /api/health reports room count; used by compose and any orchestrator.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "apps/server/dist/src/index.js"]
