# ─── ChitChatBusiness backend image ─────────────────────────────────────────
# Multi-stage build: compile TypeScript in a full-deps stage, then ship a lean
# runtime image with only production dependencies and the compiled output.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install all dependencies (incl. dev) against the lockfile for a reproducible
# build. Copy manifests first so this layer is cached when only source changes.
COPY package.json package-lock.json ./
RUN npm ci

# Compile src/ → dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so we can copy a production-only node_modules into the
# runtime image.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# dumb-init gives us correct PID 1 signal forwarding so SIGTERM reaches Node and
# triggers the graceful shutdown path in src/index.ts.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
ENV PORT=4000

# Production dependencies and compiled output.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# migrate.ts resolves ../../migrations from dist/db/, so migrations must sit at
# /app/migrations alongside /app/dist.
COPY migrations ./migrations

# Run as the built-in unprivileged node user.
USER node

EXPOSE 4000

# Container healthcheck hits the app's own /health (Postgres + Redis probe).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# Default: run the server. Apply migrations first with:
#   docker run ... node dist/db/migrate.js up
CMD ["node", "dist/index.js"]
