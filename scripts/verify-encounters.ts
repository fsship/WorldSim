import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app';
import { createProvider } from '../packages/llm/src';
import { GameViewSchema, type LlmCallList } from '../packages/shared/src';
import { readLiveConfig } from './live-fixture';

// Exercise the user's configured model using a fictional world and a separate database.
const config = readLiveConfig();
const directory = mkdtempSync(join(tmpdir(), 'worldsim-encounters-'));
const app = buildApp({
  databasePath:join(directory, 'game.sqlite'), env:{},
  providerFactory:(_, recorder) => createProvider(config, recorder),
});
async function post(url:string, payload:Record<string, unknown>) {
  const response = await app.inject({method:'POST', url, payload});
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
try {
  const draft = {
    worldInfo:'海港渡轮凭纸票登船。值班室在候船厅的柜台后方，当班引导员听见柜台的服务铃就会出来接待旅客。',
    opening:'我独自在候船厅等船，整个厅里空无一人，柜台上摆着一只服务铃。',
  };
  const template = await post('/api/scenarios', draft);
  const saved = (await app.inject('/api/scenarios/' + template.id)).json();
  assert.deepEqual(saved.npcs, []);
  const game = GameViewSchema.parse(await post('/api/games', {scenarioId:template.id}));
  assert.equal(game.state.worldInfo, draft.worldInfo);
  assert.ok(!game.state.openingUsedFallback, game.state.openingNotice);
  assert.equal(game.state.present.length, 0, '独处开场应保留空场');
  const path = '/api/games/' + game.state.id;
  const contact = {version:0, requestId:'live-seek', input:'我按响柜台上的服务铃。'};
  const met = GameViewSchema.parse(await post(path + '/turns', contact));
  assert.equal(met.state.present.length, 1, '主动寻找当班人员时应产生一名现场角色');
  const person = met.state.present[0];
  assert.ok(person.name && person.role);
  assert.deepEqual(GameViewSchema.parse(await post(path + '/turns', contact)), met);
  const command = {version:1, requestId:'live-ask', input:'我对' + person.name + '说：“买票要去哪里？”'};
  const asked = GameViewSchema.parse(await post(path + '/turns', command));
  assert.deepEqual(asked.state.present, [person]);
  assert.ok(asked.turns[1].hearing?.listeners.includes(person.name), '发言应由已相遇的角色听见');
  assert.deepEqual(GameViewSchema.parse(await post(path + '/turns', command)), asked);
  const snapshot = await post(path + '/snapshots', {version:2});
  const fork = GameViewSchema.parse(await post(path + '/snapshots/' + snapshot.id + '/load', {}));
  assert.deepEqual(fork.state.present, [person]);
  assert.deepEqual(fork.turns, asked.turns);
  const calls:LlmCallList = (await app.inject('/api/llm-calls?limit=100')).json();
  const successful = calls.items.filter(call => call.task === 'encounter' && call.status === 'success');
  assert.deepEqual(successful.map(c => c.turnVersion).sort(), [0, 1], '仅开场和寻人才需要相遇判定');
  console.log('真实模型通过：首次相遇生成' + person.role + '「' + person.name + '」，交谈和快照保留同一角色。');

  const dispatch = await post('/api/scenarios', {
    ...draft, events:[
      {afterMinutes:2, locationId:saved.player.locationId, text:'一名邮差推开候船厅的门，走到我面前询问包裹的收件人。'},
      {afterMinutes:2, locationId:saved.player.locationId, text:'墙上的钟在这时也敲了一声。'},
    ],
  });
  const quiet = GameViewSchema.parse(await post('/api/games', {scenarioId:dispatch.id}));
  assert.ok(!quiet.state.openingUsedFallback, quiet.state.openingNotice);
  assert.equal(quiet.state.present.length, 0);
  const wait = GameViewSchema.parse(await post('/api/games/' + quiet.state.id + '/turns', {
    version:0, requestId:'live-arrival', input:'我在原地等待五分钟。',
  }));
  assert.equal(wait.state.time, quiet.state.time + 2);
  assert.equal(wait.state.present.length, 1, '同分钟的钟声应保留邮差出场的机会');
  console.log('真实模型通过：等待时亲历邮差进门与钟响，现场出现了' + wait.state.present[0].role + '「' + wait.state.present[0].name + '」。');
} finally {
  await app.close();
  rmSync(directory, {recursive:true, force:true});
}
