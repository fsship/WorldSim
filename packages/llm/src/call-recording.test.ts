import { describe, expect, it, vi } from 'vitest';
import type { LlmCallAttempt, ParseContext, ProviderConfig } from '@worldsim/shared';
import { createProvider, OpenAICompatibleProvider } from './index';

const config: ProviderConfig = {
  mode:'openai', model:'test-model', apiKey:'test-key-xyz',
  baseUrl:'https://example.invalid/v1', timeoutMs:1000, retries:1, temperature:0.3, maxTokens:800,
};
const scene: ParseContext = {text:'环视四周', location:'议事厅', exits:[], people:[], items:[]};
const answer = JSON.stringify({choices:[{message:{content:'{"kind":"look"}'}}],
  usage:{prompt_tokens:27, completion_tokens:6, total_tokens:33}}, null, 2);

describe('LLM 调用记录', () => {
  it('records each actual HTTP request and its raw reply, including compatibility retries and invalid JSON', async () => {
    const rejection = JSON.stringify({error:{param:'temperature', code:'unsupported_parameter'}});
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(rejection, {status:400}))
      .mockResolvedValueOnce(new Response('not JSON\n'))
      .mockResolvedValueOnce(new Response(answer))
      .mockResolvedValueOnce(new Response(answer));
    const entries: LlmCallAttempt[] = [];
    const provider = new OpenAICompatibleProvider(config, fetcher, e => entries.push(e));
    await provider.parse(scene);
    await provider.parse(scene);
    expect(entries.map(e => [e.attempt, e.status, e.httpStatus, e.errorReason])).toEqual([
      [1,'error',400,'unsupported_temperature'], [2,'error',200,'format'], [3,'success',200,null], [1,'success',200,null],
    ]);
    expect(new Set(entries.slice(0, 3).map(e => e.callId)).size).toBe(1);
    expect(entries[3].callId).not.toBe(entries[0].callId);
    expect(entries.map(e => e.requestBody)).toEqual(fetcher.mock.calls.map(([, init]) => init?.body));
    expect(entries.map(e => JSON.parse(e.requestBody).temperature)).toEqual([config.temperature, undefined, undefined, undefined]);
    expect(entries.map(e => e.responseBody)).toEqual([rejection, 'not JSON\n', answer, answer]);
    expect(entries[2]).toMatchObject({task:'parse', model:config.model, promptTokens:27, completionTokens:6, totalTokens:33});
    expect(entries.every(e => e.durationMs >= 0 && !e.responseTruncated && Number.isFinite(Date.parse(e.startedAt)))).toBe(true);
  });

  it('redacts the configured key if echoed in either payload, without retaining headers or changing what is sent', async () => {
    const entries: LlmCallAttempt[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Invalid key: ' + config.apiKey, {status:401}));
    const provider = new OpenAICompatibleProvider(config, fetcher, e => entries.push(e));
    await expect(provider.parse({...scene, text:'查看 ' + config.apiKey})).rejects.toMatchObject({reason:'http'});
    expect(fetcher.mock.calls[0][1]?.body).toContain(config.apiKey);
    expect(JSON.stringify(entries)).not.toContain(config.apiKey);
    expect(JSON.stringify(entries)).not.toContain('Authorization');
    expect(entries[0]).toMatchObject({status:'error', responseBody:'Invalid key: [REDACTED]', httpStatus:401,
      promptTokens:null, completionTokens:null, totalTokens:null});
  });

  it('retains a bounded prefix of an oversized body, and leaves the response absent on network failure', async () => {
    const entries: LlmCallAttempt[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('a'.repeat(512 * 1024 + 1)))
      .mockRejectedValueOnce(new Error('private network diagnostic'));
    const provider = new OpenAICompatibleProvider({...config, retries:0}, fetcher, e => entries.push(e));
    await expect(provider.parse(scene)).rejects.toMatchObject({reason:'format'});
    await expect(provider.parse(scene)).rejects.toMatchObject({reason:'network'});
    expect(entries[0]).toMatchObject({responseTruncated:true, httpStatus:200, errorReason:'format'});
    expect(entries[0].responseBody).toHaveLength(512 * 1024);
    expect(entries[1]).toMatchObject({httpStatus:null, responseBody:null, errorReason:'network'});
    expect(JSON.stringify(entries[1])).not.toContain('private network diagnostic');
  });

  it('does not repeat a successful call if its recorder fails or create records for the offline provider', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(answer));
      const recorder = vi.fn(() => { throw new Error('disk error'); });
      const provider = new OpenAICompatibleProvider(config, fetcher, recorder);
      expect(await provider.parse(scene)).toEqual({kind:'look'});
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(recorder).toHaveBeenCalledTimes(1);
      const mockRecorder = vi.fn();
      await createProvider(undefined, mockRecorder).parse(scene);
      expect(mockRecorder).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
