FROM node:24-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/glasses/package.json ./apps/glasses/package.json
COPY packages/gateway/package.json ./packages/gateway/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
RUN pnpm --filter @rayriffy/g2-grokbot-gateway... install --frozen-lockfile

FROM oven/bun:1.4-slim AS build
WORKDIR /app
COPY --from=dependencies /app/ ./
COPY packages/gateway/src/ ./packages/gateway/src/
COPY packages/protocol/index.ts ./packages/protocol/index.ts
RUN bun build packages/gateway/src/serve.ts --compile --minify --outfile /app/grokbot-gateway

FROM gcr.io/distroless/base-debian13:nonroot
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/grokbot-gateway /grokbot-gateway
EXPOSE 3000
ENTRYPOINT ["/grokbot-gateway"]
