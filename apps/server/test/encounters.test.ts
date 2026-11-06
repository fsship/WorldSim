import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MockLLMProvider } from '@worldsim/llm';
import type { GameView, EncounterContext } from '@worldsim/shared';
import { buildApp } from '../src/app';

const apps:FastifyInstance[] = [];
const directories:string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive:true, force:true});
});

async function post(app:FastifyInstance, url:string, payload:Record<string, unknown>) {
  const response = await app.inject({method:'POST', url, payload});
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

it('只写背景与处境即可开局。重试回合、编辑模板、重启服务及恢复快照沿用已遇见的身份', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worldsim-encounter-test-'));
  directories.push(directory);
  const seen:EncounterContext[] = [];
  function open() {
    const app = buildApp({
      databasePath:join(directory, 'test.sqlite'), env:{},
      providerFactory:() => new MockLLMProvider({encounter:context => {
        seen.push(context);
        return {kind:'npc', name:'白榆', role:'守夜人', duty:'接待登岛的旅客', goal:'想找回自己的旧日记'};
      }}),
    });
    apps.push(app);
    return app;
  }
  const original = open();
  const premise = {worldInfo:'雾岛每晚只能凭灯号靠岸。', opening:'我刚靠岸，就有人在检票口朝我招手。'};
  const template = await post(original, '/api/scenarios', premise);
  expect((await original.inject('/api/scenarios/' + template.id)).json().npcs).toEqual([]);
  const game:GameView = await post(original, '/api/games', {scenarioId:template.id});
  expect(game.state.present).toEqual([{id:expect.any(String), name:'白榆', role:'守夜人'}]);
  expect(JSON.stringify(game.state)).not.toContain('想找回自己的旧日记');
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({worldInfo:premise.worldInfo, situation:premise.opening, trigger:'opening'});
  const base = '/api/games/' + game.state.id;
  const cmd = {version:0, requestId:'greeting', input:'我对白榆说：“你好。”'};
  const greeting:GameView = await post(original, base + '/turns', cmd);
  expect(greeting.turns[0].hearing?.listeners).toEqual(['白榆']);
  expect(await post(original, base + '/turns', cmd)).toEqual(greeting);
  const snapshot = await post(original, base + '/snapshots', {version:1});
  expect((await original.inject({
    method:'PUT', url:'/api/scenarios/' + template.id, payload:{...premise, worldInfo:'岛上搭起了新的航标。'},
  })).statusCode).toBe(200);
  await original.close();
  const reopened = open();
  expect((await reopened.inject(base)).json()).toEqual(greeting);
  const fork:GameView = await post(reopened, base + '/snapshots/' + snapshot.id + '/load', {});
  expect(fork.state.worldInfo).toBe(premise.worldInfo);
  expect(fork.state.present).toEqual(game.state.present);
  expect(fork.turns).toEqual(greeting.turns);
  expect(seen).toHaveLength(1);
});

it('开场人物生成失败可以重试，后续仅重试人物行动时保持已生成的身份', async () => {
  let encounters = 0, decisions = 0;
  const app = buildApp({
    databasePath:':memory:', env:{},
    providerFactory:() => new MockLLMProvider({
      encounter:() => {
        if (++encounters === 1) throw new Error('本次服务暂不可用');
        return {kind:'npc', name:'秋原', role:'乘务员', duty:'在车门口检票'};
      },
      decideNpcAction:() => {
        if (++decisions === 1) throw new Error('本次行动未返回');
        return {kind:'speak'};
      },
    }),
  });
  apps.push(app);
  const template = await post(app, '/api/scenarios', {worldInfo:'站台有人值班。', opening:'我走到检票员面前。'});
  const game:GameView = await post(app, '/api/games', {scenarioId:template.id});
  expect(game.state).toMatchObject({present:[], openingRetryable:true});
  const path = '/api/games/' + game.state.id + '/opening/retry';
  const introduced:GameView = await post(app, path, {version:0});
  expect(introduced.state.openingRetryable).toBe(true);
  expect(introduced.state.present).toEqual([{id:expect.any(String), name:'秋原', role:'乘务员'}]);
  const recovered:GameView = await post(app, path, {version:0});
  expect(recovered.state.openingUsedFallback).not.toBe(true);
  expect(recovered.state.present).toEqual(introduced.state.present);
  expect(recovered.state.time).toBe(game.state.time);
  expect(await post(app, path, {version:0})).toEqual(recovered);
  expect(encounters).toBe(2);
  expect(decisions).toBe(2);
});
