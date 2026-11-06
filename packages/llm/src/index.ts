import type { LLMProvider, ProviderConfig } from '@worldsim/shared';
import { MockLLMProvider } from './mock';
import { OpenAICompatibleProvider } from './openai';

export { MockLLMProvider, OpenAICompatibleProvider };
export type { MockHandlers } from './mock';
export function createProvider(config?: ProviderConfig): LLMProvider {
  return config?.mode === 'openai' ? new OpenAICompatibleProvider(config) : new MockLLMProvider();
}
