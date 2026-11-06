import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app';
import { GameViewSchema, SnapshotSummarySchema } from '../packages/shared/src/contracts';
import type { LlmCallList, LlmCallDetail } from '../packages/shared/src/llm-calls';

// Full loopback integration without vendor credentials. Use the production
// provider and HTTP endpoints, with a local stand-in for Chat Completions.
const seen = new Set<string>();
let requests = 0;
let rejectNext = false;
const fixtureLine = '今早的议程里有一场晨会，会场在议事厅。';
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer loopback-fixture');
    let raw = '';
    for await (const part of req) raw += part;
    requests++;
    if (rejectNext) {
      res.writeHead(503).end('upstream unavailable');
      return;
    }
    const request = JSON.parse(raw);
    const input = JSON.parse(request.messages[1].content);
    let reply;
    if ('proposal' in input) {
      seen.add('review-npc-action');
      assert.equal(input.proposal.description, '将双手交叠在身前');
      reply = {grounded:true, selfOnly:true};
    } else if ('trigger' in input && 'npc' in input) {
      seen.add('npc-action');
      assert.equal(input.facts.some((f: {id: string}) => f.id === 'plot'), false);
      if (input.trigger === 'ambient' && input.currentTime === 485 &&
          !input.present.some((c:{name:string}) => c.name === '国王')) {
        assert.equal(input.input,'');
        seen.add('offscreen-decision');
      }
      reply = input.trigger === 'ambient' ? {kind:'act', description:'将双手交叠在身前'} :
        input.trigger === 'opening' ? {kind:'gesture', gesture:'bow', thenSpeak:true} : {kind:'speak'};
    } else if ('draft' in input) {
      seen.add('review');
      assert.equal(input.draft.text, fixtureLine);
      reply = { grounded: true, playerAgency: true, citationsAccurate: true };
    } else if ('speaker' in input) {
      seen.add('dialogue');
      assert.equal(input.facts.some((f: {id: string}) => f.id === 'plot'), false);
      reply = { text: fixtureLine, factIds: ['assembly'] };
    } else if ('options' in input) {
      seen.add('resolve');
      reply = { optionId: input.options[0].id };
    } else if ('observations' in input) {
      seen.add('narrate');
      assert.deepEqual(Object.keys(input), ['observations']);
      reply = { lines: input.observations.map((_: unknown, index: number) => ({ index, style: 'plain' })) };
    } else {
      assert.ok(Array.isArray(input.referents), '运行中的真实适配器应请求结构化回合计划');
      seen.add('interpret');
      if (input.text.includes('罗兰')) reply = {kind:'speak', targetId:'captain', private:false, words:'今天值守可还顺利？'};
      else if (input.text.includes('宫门')) reply = {kind:'move', destination:'gate'};
      else if (input.text.includes('印玺')) reply = {kind:'item', itemId:'seal', interaction:'handle_inspect'};
      else reply = {kind:'attempt', activity:'perform'};
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }],
      usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
    }));
  } catch {
    res.writeHead(400).end();
  }
});

const staticRoot = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
assert.ok(existsSync(join(staticRoot, 'index.html')), '请先执行 pnpm build');
const dir = mkdtempSync(join(tmpdir(), 'worldsim-smoke-'));
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const app = buildApp({ databasePath: join(dir, 'game.sqlite'), staticRoot, env: {
  LLM_MODE: 'openai', LLM_BASE_URL: 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port + '/v1',
  LLM_API_KEY: 'loopback-fixture', LLM_MODEL: 'local-fixture', LLM_RETRIES: '0',
} });
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = async (path: string, body: object) => {
    const response = await fetch(base + path, { method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(!text.includes('loopback-fixture'));
    return JSON.parse(text);
  };
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<script[^>]+src="\/assets\//);
  assert.equal((await fetch(base + '/palace.webp')).status, 200);
  const initial = GameViewSchema.parse(await post('/api/games', {}));
  assert.ok(initial.state.opening.includes(fixtureLine));
  const path = '/api/games/' + initial.state.id;
  const first = { requestId: 'smoke-1', version: 0, input: '我询问罗兰，今天值守可还顺利？' };
  const one = GameViewSchema.parse(await post(path + '/turns', first));
  assert.equal(one.state.version, 1);
  assert.deepEqual(one.turns[0].hearing, {volume:'room', listeners:['艾琳', '罗兰']});
  assert.ok(one.turns[0].observations.some(o => o.kind === 'dialogue' && o.text === fixtureLine));
  assert.deepEqual(await post(path + '/turns', first), one);
  const snapshot = SnapshotSummarySchema.parse(await post(path + '/snapshots', { version: 1 }));
  const two = GameViewSchema.parse(await post(path + '/turns', { requestId: 'smoke-2', version: 1, input: '我练习一段即兴朗诵。' }));
  assert.equal(two.state.version, 2);
  assert.equal(two.turns.length, 2);
  assert.deepEqual(await (await fetch(base + path)).json(), two);
  const fork = GameViewSchema.parse(await post(path + '/snapshots/' + snapshot.id + '/load', {}));
  assert.notEqual(fork.state.id, initial.state.id);
  assert.deepEqual(fork.turns, one.turns);
  const travel = GameViewSchema.parse(await post('/api/games/' + fork.state.id + '/turns',
    {requestId:'smoke-move', version:1, input:'我向宫门走去'}));
  assert.equal(travel.state.location.id, 'gate');
  assert.equal(travel.state.time - fork.state.time, 5);
  const inspect = GameViewSchema.parse(await post(path + '/turns', {requestId:'smoke-item', version:2, input:'我拿起王室印玺仔细看'}));
  assert.ok(inspect.turns[2].narrative.includes('印面'));
  assert.ok(two.turns[1].observations.some(o => o.text.includes('将双手交叠在身前')));
  assert.deepEqual(seen, new Set(['interpret', 'resolve', 'npc-action', 'offscreen-decision', 'review-npc-action', 'dialogue', 'review', 'narrate']));
  const logUrl = base + '/api/llm-calls';
  const logs = async (params: Record<string, string> = {}): Promise<LlmCallList> => {
    const response = await fetch(logUrl + '?' + new URLSearchParams(params));
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await logs()).total, requests);
  const matching = await logs({ q: first.input, status: 'success' });
  const interpret = matching.items.find(item => item.task === 'interpret' && item.gameId === initial.state.id && item.turnVersion === 1);
  assert.ok(interpret && !('requestBody' in interpret));
  const detail: LlmCallDetail = await (await fetch(logUrl + '/' + interpret.id)).json();
  assert.equal(JSON.parse(detail.requestBody).messages[0].role, 'system');
  assert.equal(JSON.parse(detail.responseBody!).choices[0].finish_reason, 'stop');
  assert.equal(detail.totalTokens, 48);
  assert.ok(!JSON.stringify(detail).includes('loopback-fixture'));
  const recordsPage = await fetch(base + '/llm-calls', { headers: { accept: 'text/html' } });
  assert.equal(recordsPage.status, 200);
  assert.match(await recordsPage.text(), /<script[^>]+src="\/assets\//);

  rejectNext = true;
  const failed = await fetch(base + path + '/turns', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'smoke-failure', version: 3, input: '我环顾四周。' }) });
  assert.equal(failed.status, 502);
  const errors = await logs({ q: 'upstream unavailable', status: 'error' });
  assert.equal(errors.total, 1);
  assert.equal(errors.items[0].httpStatus, 503);
  assert.equal(errors.items[0].turnVersion, 4);
  assert.deepEqual(await (await fetch(base + path)).json(), inspect);
  assert.equal((await logs()).total, requests);
  console.log('通过：生产网页、NPC 行动与对白、幂等、快照分支、异地 NPC 决策、成功与失败的模型调用检索。');
} finally {
  await app.close();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
