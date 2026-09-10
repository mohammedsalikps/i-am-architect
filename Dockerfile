# The backend (backend/) as a small container, for any host that runs
# Dockerfiles with HTTPS in front (Fly.io, Railway, Render, Cloud Run...).
#
# The backend imports the shared engine code in src/engine/, so the build
# context is the repository root. Node 24 runs the TypeScript sources
# directly (type stripping): there is no build step and no runtime npm
# dependency. No secret is baked in - .dockerignore keeps every .env file
# out, and the host supplies OPENAI_API_KEY, SUPABASE_URL,
# SUPABASE_ANON_KEY and FRONTEND_ORIGIN at runtime (see DEPLOYMENT.md).
FROM node:24-slim

ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app

# package.json files only for "type": "module" - nothing is installed.
COPY package.json ./package.json
COPY backend/package.json ./backend/package.json
COPY backend/src ./backend/src
COPY src/engine ./src/engine

USER node
EXPOSE 8787
CMD ["node", "backend/src/server.ts"]
