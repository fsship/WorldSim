import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const envFile = new URL('../../.env', import.meta.url)
const port = process.env.PORT ?? (existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')).PORT : undefined) ?? '3001'
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PORT 取值必须为 1–65535。')
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: {
      strict: true,
      allow: [webRoot],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/*.{sqlite,db}', '**/*.{sqlite,db}-{wal,shm,journal}',
        '**/data/**', '**/apps/server/**', '**/packages/{engine,llm,scenarios}/**', '**/@worldsim/{engine,llm,scenarios,server}/**']
    },
    proxy: { '/api': { target: 'http://127.0.0.1:' + port, changeOrigin: false } }
  }
})
