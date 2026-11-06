import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderConfigSchema, type ProviderConfig, type PublicConfig } from '@worldsim/shared';

function normalizedEndpoint(value: string): string {
  return new URL(ProviderConfigSchema.shape.baseUrl.parse(value)).href.replace(/\/+$/, '');
}

export function envConfig(env: NodeJS.ProcessEnv): ProviderConfig {
  const baseUrl = normalizedEndpoint(env.LLM_BASE_URL || 'https://api.openai.com/v1');
  return ProviderConfigSchema.parse({
    mode: env.LLM_MODE || 'mock', baseUrl, model: env.LLM_MODEL || 'gpt-4o-mini',
    temperature: Number(env.LLM_TEMPERATURE ?? 0.3),
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 30000),
    maxTokens: Number(env.LLM_MAX_TOKENS ?? 800), retries: Number(env.LLM_RETRIES ?? 1),
    apiKey: env.LLM_API_KEY || undefined,
  });
}

export function updateConfig(previous: ProviderConfig, next: ProviderConfig): ProviderConfig {
  const baseUrl = normalizedEndpoint(next.baseUrl);
  const sameEndpoint = normalizedEndpoint(previous.baseUrl) === baseUrl;
  // A blank field explicitly clears a key. An omitted field preserves it for
  // the exact same endpoint, never transferring an old key to another host/path.
  const apiKey = next.apiKey === undefined ? (sameEndpoint ? previous.apiKey : undefined) : next.apiKey.trim();
  return ProviderConfigSchema.parse({ ...next, baseUrl, apiKey: apiKey || undefined });
}

export function publicConfig(config: ProviderConfig): PublicConfig {
  const { apiKey, ...visible } = config;
  return { ...visible, hasApiKey: Boolean(apiKey) };
}

const workspace = fileURLToPath(new URL('../../../', import.meta.url));

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(canonicalPath(dirname(absolute)), basename(absolute));
}

export function assertPrivateDatabase(filename: string, staticRoot?: string) {
  if (filename === ':memory:') return;
  const destination = canonicalPath(filename);
  const frontendRoots = ['apps/web', 'packages/shared', 'node_modules'].map(dir => resolve(workspace, dir));
  if (staticRoot) frontendRoots.push(staticRoot);
  // These directories are reachable through Vite or the production file server.
  // Check the real destination as a configured path may be a symlink.
  for (const directory of frontendRoots) {
    const served = canonicalPath(directory);
    if (destination === served || destination.startsWith(served + sep)) {
      throw new Error('存档数据库必须位于浏览器无法读取的目录。');
    }
  }
}
