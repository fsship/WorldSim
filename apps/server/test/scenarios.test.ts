import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createPalace, type ScenarioDefinition } from '@worldsim/scenarios';
import { GameViewSchema } from '@worldsim/shared';
import { buildApp } from '../src/app';
import { migration1, migration2 } from '../src/schema';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-scenarios-'));
  dirs.push(dir);
  return join(dir, 'game.sqlite');
}

function openApp(databasePath = ':memory:') {
  const app = buildApp({ databasePath, env: {} });
  apps.push(app);
  return app;
}

async function newGame(app: FastifyInstance, scenarioId?: string) {
  const response = await app.inject({ method: 'POST', url: '/api/games', payload: scenarioId ? { scenarioId } : {} });
  expect(response.statusCode, response.body).toBe(200);
  return GameViewSchema.parse(response.json());
}

const river: ScenarioDefinition = {
  title: '夜渡', opening: '雨打在渡口的顶棚上。',
  locations: [
    { id: 'dock', name: '渡口', description: '一艘小船系在岸边。' },
    { id: 'road', name: '河堤', description: '河堤上亮着一盏灯。' },
  ],
  player: { name: '阿茗', role: '渡客', locationId: 'dock', goal: '找到引航人' },
  npcs: [{ name: '江叔', role: '船夫', locationId: 'dock', duty: '照看渡船' }],
  events: [{ afterMinutes: 2, locationId: 'dock', text: '渡船的汽笛响了。' }],
};

it('内置剧本可以独立开局，省略选择时兼容旧客户端', async () => {
  const app = openApp();
  const list = (await app.inject('/api/scenarios')).json();
  expect(list).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'palace', builtin: true }),
    expect.objectContaining({ id: 'lighthouse', builtin: true }),
  ]));
  const legacy = await newGame(app);
  const other = await newGame(app, 'lighthouse');
  expect(legacy.state.title).toBe('王宫疑云');
  expect(other.state.title).toBe(list.find((s: { id: string }) => s.id === 'lighthouse').title);
  expect(other.state.player.name).not.toBe(legacy.state.player.name);
  expect(other.state.opening).not.toBe(legacy.state.opening);
  expect((await app.inject({ method: 'POST', url: '/api/games', payload: { scenarioId: 'unknown' } })).statusCode).toBe(404);
  expect((await app.inject({ method: 'PUT', url: '/api/scenarios/palace', payload: river })).statusCode).toBe(403);
  expect((await app.inject('/api/games')).json()).toHaveLength(2);
});

it('建局、行动和快照使用创建时的世界；编辑剧本只影响后来新建的游戏，重启后保留', async () => {
  const path = database();
  const first = openApp(path);
  const created = await first.inject({ method: 'POST', url: '/api/scenarios', payload: river });
  expect(created.statusCode, created.body).toBe(200);
  const { id } = created.json();
  const game = await newGame(first, id);
  expect(game.state).toMatchObject({
    title: '夜渡', scenarioId: id, player: { name: '阿茗', role: '渡客' }, location: { name: '渡口' },
    exits: [{ name: '河堤' }], present: [{ name: '江叔' }], opening: expect.stringContaining(river.opening),
  });
  const turn = await first.inject({ method: 'POST', url: '/api/games/' + game.state.id + '/turns',
    payload: { requestId: 'wait', version: 0, input: '等待五分钟' } });
  expect(turn.statusCode, turn.body).toBe(200);
  const played = GameViewSchema.parse(turn.json());
  expect(played.turns[0].narrative).toContain('渡船的汽笛响了');
  const snapshot = await first.inject({ method: 'POST', url: '/api/games/' + game.state.id + '/snapshots', payload: { version: 1 } });
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  const updated = { ...river, title: '晨渡', opening: '天亮了。', player: { ...river.player, locationId: 'road' } };
  const edit = await first.inject({ method: 'PUT', url: '/api/scenarios/' + id, payload: updated });
  expect(edit.statusCode, edit.body).toBe(200);
  await first.close();

  const reopened = openApp(path);
  expect((await reopened.inject('/api/scenarios/' + id)).json()).toMatchObject(updated);
  expect((await reopened.inject('/api/scenarios')).json()).toContainEqual({ id, builtin: false, title: '晨渡', description: '天亮了。' });
  expect((await reopened.inject('/api/games/' + game.state.id)).json()).toEqual(played);
  const restored = await reopened.inject({ method: 'POST',
    url: '/api/games/' + game.state.id + '/snapshots/' + snapshot.json().id + '/load', payload: {} });
  expect(restored.statusCode, restored.body).toBe(200);
  const fork = GameViewSchema.parse(restored.json());
  expect(fork).toEqual({ ...played, state: { ...played.state, id: fork.state.id } });
  expect((await newGame(reopened, id)).state).toMatchObject({ title: '晨渡', location: { name: '河堤' } });
  const saved = (await reopened.inject('/api/games')).json();
  expect(saved).toContainEqual(expect.objectContaining({ id: fork.state.id, title: '夜渡 · 快照分支' }));
});

it('非法引用或空名返回具体字段，错误的编辑不会替换原剧本', async () => {
  const app = openApp();
  const empty = await app.inject({ method: 'POST', url: '/api/scenarios', payload: { ...river, title: ' ' } });
  expect(empty.statusCode).toBe(400);
  expect(empty.json().error).toContain('剧本名称');
  const created = await app.inject({ method: 'POST', url: '/api/scenarios', payload: river });
  const id = created.json().id;
  const invalid = await app.inject({ method: 'PUT', url: '/api/scenarios/' + id, payload: {
    ...river, player: { ...river.player, locationId: 'missing-dock' },
  } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().error).toMatch(/地点/u);
  expect((await app.inject('/api/scenarios/' + id)).json()).toMatchObject(river);
  expect((await app.inject('/api/scenarios')).json().filter((s: { builtin: boolean }) => !s.builtin)).toHaveLength(1);
});

it('升级 v2 数据库后保留旧版王宫存档与快照，并可新增独立剧本', async () => {
  const path = database();
  const db = new DatabaseSync(path);
  const original = createPalace('legacy-game');
  const { scenarioId: _newId, ...legacy } = original;
  try {
    db.exec(migration1);
    db.exec(migration2);
    db.prepare('INSERT INTO games VALUES (?,?,?,?,?,?)')
      .run(legacy.id, legacy.scenario, legacy.version, legacy.time, '2026-01-01T00:00:00.000Z', JSON.stringify(legacy));
    db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?,?)')
      .run('old-snap', legacy.id, legacy.version, legacy.time, '2026-01-01T00:00:00.000Z', JSON.stringify(legacy));
  } finally { db.close(); }
  const app = openApp(path);
  const view = await app.inject('/api/games/legacy-game');
  expect(view.statusCode, view.body).toBe(200);
  expect(view.json().state.title).toBe('王宫疑云');
  const fork = await app.inject({ method: 'POST', url: '/api/games/legacy-game/snapshots/old-snap/load', payload: {} });
  expect(fork.statusCode, fork.body).toBe(200);
  expect(fork.json().state.player).toEqual(view.json().state.player);
  const created = await app.inject({ method: 'POST', url: '/api/scenarios', payload: river });
  expect((await newGame(app, created.json().id)).state.title).toBe('夜渡');
});
