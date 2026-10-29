# Build from the repo root: the API imports the shared spec workspace.
#   fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Every workspace's manifest, so npm ci sees the lockfile in sync; only the API's are installed.
COPY packages/spec/package.json packages/spec/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --no-fund --no-audit -w @agro-cpr/api -w @agro-cpr/spec

COPY packages/spec packages/spec
COPY apps/api apps/api

WORKDIR /app/apps/api
EXPOSE 3001
# tsx runs the TypeScript sources directly (no build step for the pilot).
CMD ["node", "../../node_modules/tsx/dist/cli.mjs", "src/main.ts"]
