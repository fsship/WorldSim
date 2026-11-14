import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOpening, projectWorld, runTurn } from '../packages/engine/src';
import { advance } from '../packages/engine/src/scheduler';
import { createProvider, ProviderFailure } from '../packages/llm/src';
import { createBuiltinScenario } from '../packages/scenarios/src';
import { WorldStateSchema, type GameTurn, type Observation, type WorldState } from '../packages/shared/src';
import { readLiveConfig } from './live-fixture';

const output = mkdtempSync(join(tmpdir(),'worldsim-quake-choices-'));
console.log(output);
const interpreted = new Set<string>();
const provider = createProvider(readLiveConfig(), call => {
  if (call.task === 'interpret' && call.status === 'success') {
    const request = JSON.parse(call.requestBody);
    const input = JSON.parse(request.messages[1].content).text;
    if (typeof input === 'string') interpreted.add(input);
  }
});
const original = createBuiltinScenario('quake-week','quake-choices');
const reload = (world:WorldState) => WorldStateSchema.parse(JSON.parse(JSON.stringify(world)));
const situation = (world:WorldState,id:string) => {
  const entry = world.situations.find(s => s.id === id);
  assert.ok(entry, '当前存档缺少局势 '+id);
  return entry;
};
const tuesday = 1440 + 8*60, friday = 4*1440 + 10*60, sunday = 6*1440 + 14*60, end = 7*1440 + 8*60;
type Action = {input:string;turn:GameTurn;location:string};
type Interval = {from:number;to:number;observations:Observation[]};

function session(label:string, seed:WorldState) {
  let world = reload(seed);
  const turns:Action[] = [], intervals:Interval[] = [];
  function save() {
    writeFileSync(join(output,label+'.json'),JSON.stringify({world,view:projectWorld(world),turns,intervals},null,2));
  }
  // Exercise the production event queue; deliberately skip model decisions during actionless intervals.
  function until(target:number) {
    if (world.time >= target) return;
    const from = world.time, observations:Observation[] = [];
    while (world.time < target) advance(world,Math.min(target-world.time,world.rules.maxWait),false,observations);
    intervals.push({from,to:target,observations});
    save();
  }
  async function act(input:string) {
    for (let attempt=1;;attempt++) {
      try {
        const {world:next,turn} = await runTurn(reload(world),input,provider);
        world = next;
        turns.push({input,turn,location:projectWorld(world).location.name});
        save();
        console.log(label,world.time,projectWorld(world).location.name,turn.resolution.status,input,turn.narrative);
        return turn;
      } catch (error) {
        if (!(error instanceof ProviderFailure) || attempt >= 3) throw error;
        console.log(label,'retry',attempt,error.reason,input);
      }
    }
  }
  return {until,act,read:() => world};
}

const prepared = await prepareOpening(original,provider);
const common = session('common',prepared);
const drive = await common.act('我开自己的小汽车前往公司');
assert.equal(projectWorld(common.read()).location.id,'office');
const car = drive.changes.find(c => c.op==='move' && c.using);
assert.ok(car?.op==='move' && car.using);
const carId = car.using;
common.until(839);
const shock = await common.act('在这里等十分钟');
assert.equal(common.read().time,840);
assert.ok(shock.narrative.includes('河桥'));
assert.ok(situation(common.read(),'bridge').blockedRoutes.some(r=>r.mode==='all'));
const denied = await common.act('我试着开自己的小汽车过河桥回家');
assert.equal(denied.resolution.status,'refused');
assert.equal(projectWorld(common.read()).location.id,'office');
common.until(845); // Let the magnitude bulletin arrive before either person takes on a commitment.
const snapshot = JSON.stringify(common.read());
writeFileSync(join(output,'fork.json'),snapshot);

async function branch(kind:'family'|'volunteer') {
  const s = session(kind,JSON.parse(snapshot));
  const family = kind === 'family';
  const first = family ? 'relay' : 'volunteer', second = family ? 'reunite' : 'hand-over';
  const choice = family ? '我在联络桌填张给妈妈的平安条，请他们带到河西' : '我去联络桌当志愿者，帮邻居们登记各自去了哪里';
  const choose = await s.act(choice);
  assert.ok(interpreted.has(choice), '选择需经过真实模型解释');
  assert.equal(choose.resolution.status,'resolved');
  const goal = family ? '在家门口的小院与妈妈会合' : '把河东街坊的去向交给下一班登记员';
  assert.equal(projectWorld(s.read()).player.goal,goal);
  assert.deepEqual(situation(s.read(),'contact').decisions.map(d=>d.actionId),[first]);
  s.until(tuesday+5);
  assert.equal(projectWorld(reload(s.read())).player.goal,goal);
  assert.deepEqual(situation(s.read(),'contact').decisions.map(d=>d.actionId),[first]);
  assert.ok(situation(s.read(),'bridge').blockedRoutes.some(r=>r.mode==='vehicle'));
  if (family) {
    const walk = await s.act('我沿开放的步行便道步行回家');
    assert.equal(walk.resolution.status,'resolved');
    assert.equal(projectWorld(s.read()).location.id,'home');
    assert.equal(s.read().sceneState.find(e=>e.objectId===carId)?.locationId,'office');
  } else {
    const noCar = await s.act('我开自己的小汽车过桥回家');
    assert.equal(noCar.resolution.status,'refused');
    assert.equal(projectWorld(s.read()).location.id,'office');
  }
  const follow = family ? '我去小院和收到我便条的妈妈碰头' : '轮到下一班了，我把记着街坊去向的本子交给值班的人';
  const complete = await s.act(follow);
  assert.ok(interpreted.has(follow), '后续行动需经过真实模型解释');
  assert.equal(complete.resolution.status,'resolved');
  assert.equal(projectWorld(s.read()).player.goal,undefined);
  assert.deepEqual(situation(s.read(),'contact').decisions.map(d=>d.actionId),[first,second]);
  s.until(friday+5);
  assert.deepEqual(situation(s.read(),'bridge').blockedRoutes,[]);
  if (!family) {
    const repaired = await s.act('我开自己的小汽车过桥回家');
    assert.ok(repaired.changes.some(c=>c.op==='move' && c.using===carId && c.to==='home'));
  }
  const third = family ? 'meal' : 'confirm-list';
  const weekend = family ? '周一那顿饭错过了，我和妈妈在院里一起吃晚饭' : '我在小院对着贴出的地址，帮街坊核对河东登记的那份名单';
  s.until(5*1440+18*60);
  const closure = await s.act(weekend);
  assert.ok(interpreted.has(weekend),'周末行动需经过真实模型解释');
  assert.equal(closure.resolution.status,'resolved');
  assert.deepEqual(situation(s.read(),'contact').decisions.map(d=>d.actionId),[first,second,third]);
  s.until(sunday);
  assert.match(situation(s.read(),'contact').summary,family?/会合/:/接班人/);
  s.until(end);
  assert.equal(s.read().time,end);
  assert.match(situation(s.read(),'studio').summary,/封板/);
  const view = projectWorld(reload(s.read()));
  assert.equal(view.player.goal,undefined);
  const lastStudio = view.situations?.find(entry => entry.id==='studio');
  assert.ok(lastStudio);
  assert.equal(lastStudio.updatedAt, family ? 840 : 2*1440+600);
  assert.match(lastStudio.summary, family ? /窗玻璃破碎/ : /封板/);
  if (family) assert.doesNotMatch(lastStudio.summary,/封板/);
  assert.deepEqual(situation(s.read(),'contact').decisions.map(d=>d.actionId),[first,second,third]);
  return s.read();
}
const runs = await Promise.allSettled([branch('family'),branch('volunteer')]);
for (const run of runs) if (run.status === 'rejected') {console.error(run.reason);process.exitCode=1;}
