import { Elysia } from 'elysia'
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker'
import { gateway } from './index.ts'

export default new Elysia({ adapter: CloudflareAdapter }).use(gateway).compile()
