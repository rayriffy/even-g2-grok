import { gateway } from './index.ts'

gateway.listen({
  port: Number(Bun.env.PORT ?? 3000),
  hostname: '0.0.0.0',
  idleTimeout: 10,
})
