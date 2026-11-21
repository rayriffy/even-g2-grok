import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: true, port: 5173,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/reference/**', '**/g2-notes/**'] },
  },
  build: { target: 'es2022' },
})
