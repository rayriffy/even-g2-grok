FROM node:24-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM oven/bun:1.4-slim AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY gateway/ ./gateway/
COPY src/client.ts ./src/client.ts
RUN bun build gateway/index.ts --compile --minify --outfile /app/grokbot-gateway

FROM gcr.io/distroless/base-debian13:nonroot
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/grokbot-gateway /grokbot-gateway
EXPOSE 3000
ENTRYPOINT ["/grokbot-gateway"]
