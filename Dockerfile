# syntax=docker/dockerfile:1

# ---- base -------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- dependencies (all, including dev, for the build) -----------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- test image --------------------------------------------------------------
# Keeps the test suite and dev dependencies out of the runtime image while
# still making `docker compose run --rm test` a one-liner for a reviewer.
FROM deps AS test
ENV NODE_ENV=test
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY migrations ./migrations
CMD ["npx", "vitest", "run"]

# ---- production dependencies only -------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime

# The container is capped at 512 MB (see docker-compose.yml). We give V8 a heap
# ceiling well under that so the process dies predictably if the ingest ever
# stops being streaming, instead of being OOM-killed by the kernel.
ENV NODE_OPTIONS=--max-old-space-size=320

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node

EXPOSE 3000
CMD ["node", "dist/src/api.js"]
