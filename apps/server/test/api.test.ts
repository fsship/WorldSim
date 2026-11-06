import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createProvider, MockLLMProvider } from '@worldsim/llm';
import { GameViewSchema, type GameView, type PublicConfig } from '@worldsim/shared';
import { buildApp } from '../src/app';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function filename() {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-test-'));
  dirs.push(dir);
  return join(dir, 'test.sqlite');
}
function appAt(path = ':memory:', factory: typeof createProvider = createProvider) {
  const app = buildApp({ databasePath: path, providerFactory: factory, env: {} });
  apps.push(app);
  return app;
}
async function create(app: FastifyInstance): Promise<GameView> {
  const res = await app.inject({ method: 'POST', url: '/api/games', payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return GameViewSchema.parse(res.json());
}
function action(app: FastifyInstance, id: string, requestId: string, version = 0, input = '观察周围') {
  return app.inject({ method: 'POST', url: `/api/games/${id}/turns`, payload: { requestId, version, input } });
}

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe('SQLite 游戏事务与 HTTP 边界', () => {
  it('同一请求只提交一次，旧版本与复用编号的不同动作返回冲突', async () => {
    const app = appAt();
    const { state } = await create(app);
    const first = await action(app, state.id, 'request-1');
    expect(first.statusCode, first.body).toBe(200);
    const view = GameViewSchema.parse(first.json());
    expect(view.state.version).toBe(1);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.endTime).toBe(view.state.time);
    const retry = await action(app, state.id, 'request-1');
    expect(retry.json()).toEqual(view);
    expect((await action(app, state.id, 'request-2')).statusCode).toBe(409);
    expect((await action(app, state.id, 'request-1', 1, '等待三分钟')).statusCode).toBe(409);
    expect((await app.inject(`/api/games/${state.id}`)).json()).toEqual(view);
  });

  it('处理中的重复请求共享结果，冲突操作不能越过进行中的回合', async () => {
    const started = deferred();
    const finish = deferred();
    let calls = 0;
    const provider = createProvider();
    const app = appAt(':memory:', () => new MockLLMProvider({
      parse: async context => {
        calls += 1;
        started.release();
        await finish.wait;
        return provider.parse(context);
      },
    }));
    const { state } = await create(app);
    const first = action(app, state.id, 'A').then(r => r);
    await started.wait;
    const duplicate = action(app, state.id, 'A').then(r => r);
    const conflict = await action(app, state.id, 'B');
    finish.release();
    expect(conflict.statusCode).toBe(409);
    const [r1, r2] = await Promise.all([first, duplicate]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    expect(calls).toBe(1);
  });

  it('同一文件被第二个服务更新时，慢请求的旧状态无法覆盖已提交的回合', async () => {
    const path = filename();
    const started = deferred();
    const finish = deferred();
    const provider = createProvider();
    const slowServer = appAt(path, () => new MockLLMProvider({
      parse: async context => {
        started.release();
        await finish.wait;
        return provider.parse(context);
      },
    }));
    const quickServer = appAt(path);
    const { state } = await create(slowServer);
    const slow = action(slowServer, state.id, 'slow').then(r => r);
    await started.wait;
    const quick = await action(quickServer, state.id, 'quick');
    finish.release();
    expect(quick.statusCode, quick.body).toBe(200);
    expect((await slow).statusCode).toBe(409);
    expect((await slowServer.inject(`/api/games/${state.id}`)).json()).toEqual(quick.json());
  });

  it('非法解析结果不会损坏存档，使用相同编号可以成功重试', async () => {
    const provider = createProvider();
    let invalid = true;
    const app = appAt(':memory:', () => new MockLLMProvider({
      parse: async context => {
        if (invalid) return { kind: 'grant-invulnerability', sql: 'DROP TABLE games' };
        return provider.parse(context);
      },
    }));
    const initial = await create(app);
    const failure = await action(app, initial.state.id, 'retry-me');
    expect(failure.statusCode).toBe(502);
    expect((await app.inject(`/api/games/${initial.state.id}`)).json()).toEqual(initial);
    invalid = false;
    expect((await action(app, initial.state.id, 'retry-me')).statusCode).toBe(200);
  });

  it('日志插入故障时回滚同一事务中的世界状态写入', async () => {
    const path = filename();
    const app = appAt(path);
    const initial = await create(app);
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TRIGGER test_abort BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
      const failed = await action(app, initial.state.id, 'atomic');
      expect(failed.statusCode).toBe(500);
      expect((await app.inject(`/api/games/${initial.state.id}`)).json()).toEqual(initial);
      db.exec('DROP TRIGGER test_abort');
      const retried = await action(app, initial.state.id, 'atomic');
      expect(retried.statusCode, retried.body).toBe(200);
      const snapshot = db.prepare('SELECT version, world FROM games WHERE id = ?').get(initial.state.id);
      const journal = db.prepare('SELECT version, turn FROM turns WHERE game_id = ?').get(initial.state.id);
      expect(journal?.version).toBe(snapshot?.version);
      const world = JSON.parse(String(snapshot?.world));
      const turn = JSON.parse(String(journal?.turn));
      expect(turn.endTime).toBe(world.time);
      for (const event of turn.events) expect(world.history).toContainEqual(event);
    } finally {
      db.close();
    }
  });

  it('重新打开数据库后恢复世界与历史，快照分支只包含创建时的回合', async () => {
    const path = filename();
    const first = appAt(path);
    const initial = await create(first);
    const id = initial.state.id;
    const one = GameViewSchema.parse((await action(first, id, 'one')).json());
    const snapshot = await first.inject({ method: 'POST', url: `/api/games/${id}/snapshots`, payload: { version: 1 } });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const two = GameViewSchema.parse((await action(first, id, 'two', 1)).json());
    expect(two.turns).toHaveLength(2);
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    const reopened = appAt(path);
    expect((await reopened.inject(`/api/games/${id}`)).json()).toEqual(two);
    expect((await reopened.inject(`/api/games/${id}/snapshots`)).json()).toContainEqual(snapshot.json());
    const forkResponse = await reopened.inject({
      method: 'POST', url: `/api/games/${id}/snapshots/${snapshot.json().id}/load`, payload: {},
    });
    expect(forkResponse.statusCode, forkResponse.body).toBe(200);
    const fork = GameViewSchema.parse(forkResponse.json());
    expect(fork.state.id).not.toBe(id);
    expect(fork.state.version).toBe(1);
    expect(fork.turns).toEqual(one.turns);
    expect((await action(reopened, fork.state.id, 'branch-action', 1)).statusCode).toBe(200);
    expect((await reopened.inject(`/api/games/${id}`)).json()).toEqual(two);
  });

  it('密钥仅驻留服务端设置，换服务地址不能复用，游戏和日志不含密钥', async () => {
    const path = filename();
    const app = appAt(path);
    const opts: PublicConfig = (await app.inject('/api/settings')).json();
    const { hasApiKey: _flag, ...config } = opts;
    const key = 'unit-test-secret-only';
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings', payload });
    const saved = await put({ ...config, apiKey: key });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(key);
    expect(saved.json().hasApiKey).toBe(true);
    const initial = await create(app);
    const turn = await action(app, initial.state.id, 'one');
    expect(turn.body).not.toContain(key);
    const db = new DatabaseSync(path);
    try {
      expect(JSON.stringify(db.prepare('SELECT * FROM turns').all())).not.toContain(key);
      expect(JSON.stringify(db.prepare('SELECT * FROM games').all())).not.toContain(key);
    } finally { db.close(); }
    expect((await put({ ...config, model: 'another-model' })).json().hasApiKey).toBe(true);
    expect((await put({ ...config, baseUrl: 'https://other.example/v1' })).json().hasApiKey).toBe(false);
    const bad = await put({ ...config, baseUrl: 'https://user:password@bad.example/v1' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('password');
  });

  it('拒绝将数据库写到静态文件目录，包括经符号链接访问的目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldsim-public-test-'));
    dirs.push(dir);
    const staticRoot = join(dir, 'public');
    const link = join(dir, 'saves');
    mkdirSync(staticRoot);
    symlinkSync(staticRoot, link);
    const path = join(link, 'private.sqlite');
    expect(() => buildApp({ databasePath: path, staticRoot, env: {} })).toThrow('浏览器无法读取');
    expect(existsSync(path)).toBe(false);
  });

  it('拒绝不可信 Host、跨源写入和简单表单请求', async () => {
    const app = appAt();
    for (const headers of [{ host: 'evil.example' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const result = await app.inject({ method: 'POST', url: '/api/games', headers, payload: {} });
      expect(result.statusCode).toBe(403);
    }
    const simple = await app.inject({
      method: 'POST', url: '/api/games', headers: { 'content-type': 'text/plain' }, payload: '{}',
    });
    expect(simple.statusCode).toBe(415);
    expect((await app.inject('/api/games')).json()).toEqual([]);
  });
});
