# The backend (backend/) as a small container, for any host that runs
# Dockerfiles with HTTPS in front (Fly.io, Railway, Render, Cloud Run...).
#
# The backend imports the shared engine code in src/engine/, so the build
# context is the repository root. Node 24 runs the TypeScript sources
# directly (type stripping): there is no build step. The one runtime npm
# dependency is the Anthropic SDK (AI_PROVIDER=anthropic), installed from
# the lockfile: production dependencies only, no install scripts. No
# secret is baked in - .dockerignore keeps every .env file out, and the
# host supplies the AI provider's key (GEMINI_API_KEY, OPENAI_API_KEY or
# ANTHROPIC_API_KEY), SUPABASE_URL, SUPABASE_ANON_KEY and FRONTEND_ORIGIN
# at runtime (see DEPLOYMENT.md).
FROM node:24-slim

ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app

# package.json for "type": "module"; the lockfile pins what npm ci installs.
COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY backend/package.json ./backend/package.json
COPY backend/src ./backend/src
COPY src/engine ./src/engine

USER node
EXPOSE 8787
CMD ["node", "backend/src/server.ts"]
