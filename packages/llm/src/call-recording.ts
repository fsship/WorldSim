import { z } from 'zod';
import type { LlmCallAttempt } from '@worldsim/shared';

export type LlmCallRecorder = (entry: LlmCallAttempt) => void;

// Keep the original formatting and retain the available prefix of incomplete bodies.
export async function readResponseBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0, truncated = false;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const remaining = limit - bytes;
        const part = chunk.value.subarray(0, remaining);
        text += decoder.decode(part, {stream:true});
        bytes += part.byteLength;
        if (part.byteLength < chunk.value.byteLength) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } catch {
      truncated = true;
    } finally {
      reader.releaseLock();
    }
  }
  return {text:text + decoder.decode(), bytes, truncated};
}

const tokenCount = z.number().int().safe().nonnegative().nullable().catch(null);
const tokenUsage = z.object({usage:z.object({
  prompt_tokens:tokenCount.optional(), completion_tokens:tokenCount.optional(), total_tokens:tokenCount.optional(),
})});

export function captureUsage(entry: LlmCallAttempt, response: unknown) {
  const result = tokenUsage.safeParse(response);
  if (result.success) {
    entry.promptTokens = result.data.usage.prompt_tokens ?? null;
    entry.completionTokens = result.data.usage.completion_tokens ?? null;
    entry.totalTokens = result.data.usage.total_tokens ?? null;
  }
}

// Only the HTTP payload is recorded. A service may also echo credentials in its error body.
function redact(text: string, apiKey?: string) {
  if (apiKey) {
    const encoded = JSON.stringify(apiKey).slice(1, -1);
    const nested = JSON.stringify(encoded).slice(1, -1);
    for (const form of new Set([nested, encoded, apiKey])) text = text.replaceAll(form, '[REDACTED]');
  }
  return text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
}

export function emitCall(recorder: LlmCallRecorder, entry: LlmCallAttempt, apiKey?: string) {
  try {
    recorder({
      ...entry, model:redact(entry.model, apiKey), requestBody:redact(entry.requestBody, apiKey),
      responseBody:entry.responseBody === null ? null : redact(entry.responseBody, apiKey),
    });
  } catch {
    // A failure to store diagnostics must never resend a paid request.
    console.warn('无法写入本次模型调用记录。');
  }
}
