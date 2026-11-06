import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createPalace } from '@worldsim/scenarios';
import type { LlmCallEntry } from '@worldsim/shared';
import { migration1 } from '../src/schema';
import { GameStore } from '../src/store';

const first: LlmCallEntry = {
  callId: 'retry-group', gameId: 'opening-game', turnVersion: 0, startedAt: '2026-11-06T12:00:00Z',
  task: 'dialogue', model: 'Example-Model', attempt: 1, status: 'error', durationMs: 35,
  httpStatus: 503, errorReason: 'http', promptTokens: null, completionTokens: null, totalTokens: null,
  requestBody: '{"input":"询问进展 50%_完成 / 第一项"}', responseBody: '服务繁忙', responseTruncated: false,
};
const page = { limit: 10, offset: 0 };

it('升级 v1 数据库并在重启后保留开场请求及尚未提交回合的失败记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-llm-calls-'));
  const path = join(dir, 'game.sqlite');
  try {
    const world = createPalace('existing-game');
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(migration1);
      legacy.prepare('INSERT INTO games VALUES (?,?,?,?,?,?)')
        .run(world.id, '旧存档', world.version, world.time, first.startedAt, JSON.stringify(world));
    } finally { legacy.close(); }

    const store = new GameStore(path);
    try {
      expect(store.listLlmCalls(page)).toEqual({ items: [], total: 0 });
      expect(store.view(world.id).turns).toEqual([]);
      store.recordLlmCall(first);
    } finally { store.close(); }

    const reopened = new GameStore(path);
    try {
      expect(reopened.llmCall(1)).toEqual({ ...first, id: 1 });
      expect(reopened.world(world.id)).toEqual(world);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('按时间逆序分页，按状态和包括正文在内的字面文本查找，每次尝试单独保留', () => {
  const store = new GameStore(':memory:');
  try {
    store.recordLlmCall(first);
    store.recordLlmCall({ ...first, attempt: 2, status: 'success', errorReason: null, httpStatus: 200,
      promptTokens: 6, completionTokens: 4, totalTokens: 10, responseBody: '复核通过', responseTruncated: true });
    store.recordLlmCall({ ...first, callId: 'independent', requestBody: 'unrelated', responseBody: null });
    expect(store.listLlmCalls({ ...page, limit: 1, offset: 1 })).toMatchObject({ total: 3, items: [{ id: 2 }] });
    const summary = store.listLlmCalls({ ...page, q: '询问进展', status: 'success' });
    expect(summary).toMatchObject({ total: 1, items: [{ id: 2, totalTokens: 10 }] });
    for (const field of ['requestBody', 'responseBody', 'responseTruncated'])
      expect(summary.items[0]).not.toHaveProperty(field);
    for (const q of ['%_', '/', 'retry-group']) {
      expect(store.listLlmCalls({ ...page, q }).items.map(call => call.id)).toEqual([2, 1]);
    }
    expect(store.listLlmCalls({ ...page, q: 'example-model' }).total).toBe(3);
    expect(store.listLlmCalls({ ...page, q: '生成角色台词' }).total).toBe(3);
    expect(store.listLlmCalls({ ...page, q: '复核通过', status: 'error' }).total).toBe(0);
    expect(store.listLlmCalls({ ...page, q: '复核通过' }).items[0].id).toBe(2);
    expect(store.llmCall(2)).toMatchObject({ responseBody: '复核通过', responseTruncated: true });
    expect(() => store.llmCall(99)).toThrow(expect.objectContaining({ status: 404 }));
  } finally { store.close(); }
});
