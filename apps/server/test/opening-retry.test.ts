import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockLLMProvider, type MockHandlers } from '@worldsim/llm';
import { createPalace } from '@worldsim/scenarios';
import { buildApp } from '../src/app';
import { GameStore } from '../src/store';

const servers: ReturnType<typeof buildApp>[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive:true, force:true});
});

function server(path:string, hooks:MockHandlers = {}) {
  const app = buildApp({ databasePath:path, env:{}, providerFactory:() => new MockLLMProvider(hooks) });
  servers.push(app);
  return app;
}

// Seed exactly the old persisted form. There is no npcAction metadata on this opening.
function failedLegacySave() {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-opening-'));
  tempDirs.push(dir);
  const path = join(dir, 'test.sqlite');
  const store = new GameStore(path);
  try {
    const world = createPalace(randomUUID());
    const line = world.history.find(e => e.kind === 'npc' && e.source === 'opening')!;
    line.dialogueSource = 'fallback';
    line.text = '陛下，我暂时没有能够核实的答复。';
    const initial = store.create(world);
    expect(initial.state.openingRetryable).toBe(true);
    return {path, id:world.id, initial};
  } finally { store.close(); }
}
function deferred() {
  let release!:() => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
}
const okReview = {grounded:true, playerAgency:true, citationsAccurate:true};
const retry = (app:ReturnType<typeof buildApp>, id:string) =>
  app.inject({method:'POST', url:'/api/games/' + id + '/opening/retry', payload:{version:0}});
const enterTurn = (app:ReturnType<typeof buildApp>, id:string) =>
  app.inject({method:'POST', url:'/api/games/' + id + '/turns', payload:{input:'观察周围', version:0, requestId:randomUUID()}});

describe('原地重试失败开场', () => {
  it('旧存档原地恢复且重复请求幂等，保存过的快照仍对应旧开场', async () => {
    const {path, id, initial} = failedLegacySave();
    let generated = 0;
    const text = '陛下，早安。';
    const app = server(path, {
      dialogue:() => { generated++; return {text, factIds:[]}; },
      reviewDialogue:() => okReview,
    });
    const saved = await app.inject({method:'POST', url:'/api/games/' + id + '/snapshots', payload:{version:0}});
    expect(saved.statusCode).toBe(200);
    const recovered = await retry(app, id);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().state).toMatchObject({id, time:initial.state.time, version:0});
    expect(recovered.json().state.opening).toContain(text);
    expect(recovered.json().state.openingUsedFallback).not.toBe(true);
    expect(recovered.json().turns).toEqual([]);
    expect((await retry(app, id)).json()).toEqual(recovered.json());
    expect(generated).toBe(1);
    const fork = await app.inject({method:'POST', url:'/api/games/' + id + '/snapshots/' + saved.json().id + '/load', payload:{}});
    expect(fork.json().state.opening).toBe(initial.state.opening);
    expect(fork.json().state.id).not.toBe(id);
    expect((await app.inject('/api/games/' + id)).json()).toEqual(recovered.json());
  });

  it('进行中的同一开场重试共用结果，拒绝同时提交回合', async () => {
    const {path, id} = failedLegacySave();
    const started = deferred(), finish = deferred();
    let calls = 0;
    const app = server(path, {dialogue:async () => {
      calls++; started.release(); await finish.promise;
      return {text:'陛下好。',factIds:[]};
    }, reviewDialogue:() => okReview});
    const a = retry(app, id).then(r => r);
    await started.promise;
    const b = retry(app, id).then(r => r);
    const conflict = await enterTurn(app, id);
    finish.release();
    expect(conflict.statusCode).toBe(409);
    const [first, second] = await Promise.all([a, b]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(calls).toBe(1);
  });

  it('另一服务恢复开场后，旧开场之上的进行中回合提交失败', async () => {
    const {path, id} = failedLegacySave();
    const started = deferred(), finish = deferred();
    const slow = server(path, {parse:async () => {
      started.release(); await finish.promise; return {kind:'look'};
    }});
    const fast = server(path);
    const turn = enterTurn(slow, id).then(r => r);
    await started.promise;
    expect((await retry(slow, id)).statusCode).toBe(409);
    const recovered = await retry(fast, id);
    finish.release();
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect((await turn).statusCode).toBe(409);
    expect((await fast.inject('/api/games/' + id)).json()).toEqual(recovered.json());
  });

  it('另一服务已完成首回合，迟到的开场重试不能覆盖它', async () => {
    const {path, id} = failedLegacySave();
    const started = deferred(), finish = deferred();
    const slow = server(path, {dialogue:async () => {
      started.release(); await finish.promise; return {text:'陛下早。',factIds:[]};
    }, reviewDialogue:() => okReview});
    const fast = server(path);
    const opening = retry(slow, id).then(r => r);
    await started.promise;
    const first = await enterTurn(fast, id);
    finish.release();
    expect(first.statusCode, first.body).toBe(200);
    expect((await opening).statusCode).toBe(409);
    expect((await retry(fast, id)).statusCode).toBe(409);
    expect((await fast.inject('/api/games/' + id)).json()).toEqual(first.json());
  });

  it('开场动作已经执行时不能因其随后台词失败而重演动作', async () => {
    const app = server(':memory:', {
      decideNpcAction:() => ({kind:'gesture', gesture:'bow', thenSpeak:true}),
      dialogue:() => { throw Error('fixture failure'); },
    });
    const created = await app.inject({method:'POST', url:'/api/games', payload:{}});
    expect(created.statusCode, created.body).toBe(200);
    const view = created.json();
    expect(view.state.openingUsedFallback).toBe(true);
    expect(view.state.openingRetryable).not.toBe(true);
    expect((await retry(app, view.state.id)).statusCode).toBe(409);
    expect((await app.inject('/api/games/' + view.state.id)).json()).toEqual(view);
  });
});
