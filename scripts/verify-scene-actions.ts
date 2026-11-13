import assert from 'node:assert/strict';
import { prepareOpening, projectWorld, runTurn } from '../packages/engine/src';
import { createProvider } from '../packages/llm/src';
import { createCustomScenario } from '../packages/scenarios/src';
import { WorldStateSchema, type WorldState } from '../packages/shared/src';
import { readLiveConfig } from './live-fixture';

const provider = createProvider(readLiveConfig());
async function play(id:string, inputs:string[]) {
  let world = await prepareOpening(createCustomScenario('commuter',id,{
    worldInfo:'2026年的世界', opening:'主角是一家普通公司职员，准备出门上班。',
  }),provider);
  const results = [];
  for (const input of inputs) {
    const result = await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(world))),input,provider);
    world = result.world;
    console.log(JSON.stringify({id,input, time:world.time, location:projectWorld(world).location.name,
      plan:result.turn.plan, status:result.turn.resolution.status, narrative:result.turn.narrative, state:world.sceneState}));
    assert.equal(result.turn.resolution.status,'resolved',input);
    results.push(result);
  }
  return results;
}

function usesPrevious(previous:WorldState, current:Awaited<ReturnType<typeof runTurn>>) {
  const plan = current.turn.plan;
  assert.equal(plan?.kind,'sequence');
  assert.ok(plan.steps.some(step => step.requires?.some(req => previous.sceneState.some(entry =>
    entry.name === req.name && entry.scope === req.scope && entry.value === req.value))),current.turn.input);
}

async function commute() {
  const [station,bus,company,work,follow] = await play('commute',[
    '我前往公交站台，准备去公司上班','我等待公交车到来','我上车去公司上班',
    '我走到工位上坐下，打开电脑开始工作','我继续用刚打开的电脑处理手头的工作',
  ]);
  assert.equal(projectWorld(station.world).location.name,'公交站台');
  assert.ok(bus.turn.events.some(event => event.changes.some(change => change.op === 'event' && change.status === 'executed')));
  assert.equal(company.turn.plan?.kind,'explore');
  assert.ok(bus.turn.events.some(event => event.id === (company.turn.plan?.kind === 'explore' && company.turn.plan.via?.noticeId)));
  assert.equal(projectWorld(company.world).location.name,'公司');
  assert.equal(projectWorld(work.world).location.name,'公司');
  assert.ok(work.turn.events.filter(event => event.changes.some(change => change.op === 'sceneStep')).length >= 3);
  assert.match(JSON.stringify(work.world.sceneState),/电脑/);
  assert.match(JSON.stringify(work.world.sceneState),/工作/);
  usesPrevious(work.world,follow);
}
async function cafe() {
  const [arrived,seated,order,received,sip] = await play('cafe',[
    '我去咖啡店','我找个空位坐下','我坐在这里点一杯咖啡','我接过刚才点的咖啡','我端起手里的那杯喝一口',
  ]);
  assert.equal(projectWorld(arrived.world).location.name,'咖啡店');
  usesPrevious(seated.world,order);
  usesPrevious(order.world,received);
  assert.ok(projectWorld(received.world).player.items.some(item => item.name.includes('咖啡')));
  usesPrevious(received.world,sip);
}
const outcomes = await Promise.allSettled([commute(),cafe()]);
for (const outcome of outcomes) if (outcome.status === 'rejected') {
  console.error(outcome.reason); process.exitCode = 1;
}
