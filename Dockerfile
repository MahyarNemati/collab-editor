# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime dependencies -------------------------------------------------
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime --------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The update log is the only mutable state; keep it on a volume and owned by
# the unprivileged user the process actually runs as.
RUN mkdir -p /data && chown -R node:node /data
ENV COLLAB_DATA_DIR=/data
ENV COLLAB_HOST=0.0.0.0
ENV COLLAB_PORT=1234
VOLUME ["/data"]

USER node
EXPOSE 1234

# NODE_ENV=production also disables the token-minting endpoint and makes
# COLLAB_AUTH_SECRET mandatory, so the container refuses to start without one
# rather than generating a secret that every restart invalidates.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COLLAB_PORT||1234)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
