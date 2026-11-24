# Grok Bot gateway

An Elysia plugin for the Even G2 app. It uses the host’s Elysia instance and forwards chat and speech requests using the credentials supplied with each request.

```ts
import { Elysia } from 'elysia'
import { gateway } from '@rayriffy/g2-grokbot-gateway'

export const router = new Elysia({ prefix: '/grokbot-gateway' }).use(gateway)
```

Mount `router` on the host app. Its health probe is `GET /grokbot-gateway/ping`. The package declares Elysia `^1.4.28` as a peer dependency. Use Bun for the host so the transcript route can set its request idle timeout.

From this repository, run `pnpm pack:gateway` to build the package and save an npm tarball in `artifacts/`. A Bun app can install the tarball with `bun add /path/to/rayriffy-g2-grokbot-gateway-0.1.0.tgz`.
