import type { LLMProvider, ProviderConfig } from '@worldsim/shared';
import { MockLLMProvider } from './mock';
import { OpenAICompatibleProvider } from './openai';
import type { LlmCallRecorder } from './call-recording';

export { MockLLMProvider, OpenAICompatibleProvider };
export { ProviderFailure } from './openai';
export type { MockHandlers } from './mock';
export type { LlmCallRecorder } from './call-recording';
export function createProvider(config?: ProviderConfig, recorder?: LlmCallRecorder): LLMProvider {
  return config?.mode === 'openai' ? new OpenAICompatibleProvider(config, undefined, recorder) : new MockLLMProvider();
}
