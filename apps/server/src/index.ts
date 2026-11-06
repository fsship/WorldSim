import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildApp } from './app';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 取值必须为 1–65535。');
const staticRoot = process.env.NODE_ENV === 'production' ? resolve(root, 'apps/web/dist') : undefined;
if (staticRoot && !existsSync(resolve(staticRoot, 'index.html'))) {
  throw new Error('请先运行 pnpm build 生成 Web 资源。');
}
const app = buildApp({
  databasePath: resolve(root, process.env.DATABASE_PATH || 'data/worldsim.sqlite'), logger: true, staticRoot,
});
await app.listen({ port, host: '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
