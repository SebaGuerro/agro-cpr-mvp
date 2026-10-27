# Build from the repo root: the API imports the shared spec workspace.
#   fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/spec/package.json packages/spec/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --no-fund --no-audit

COPY packages/spec packages/spec
COPY apps/api apps/api

WORKDIR /app/apps/api
EXPOSE 3001
# tsx runs the TypeScript sources directly (no build step for the pilot).
CMD ["node", "../../node_modules/tsx/dist/cli.mjs", "src/main.ts"]
