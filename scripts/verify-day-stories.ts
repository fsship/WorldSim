import { quake } from './earthquake-story';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCustomScenario } from '../packages/scenarios/src';
import { prepareOpening, projectWorld, runTurn } from '../packages/engine/src';
import { createProvider } from '../packages/llm/src';
import { WorldStateSchema, type ScenarioInput, type WorldState } from '../packages/shared/src';
import { readLiveConfig } from './live-fixture';

const provider = createProvider(readLiveConfig(), attempt => {
  if (attempt.errorReason === 'format' && attempt.responseBody) {
    const completion = JSON.parse(attempt.responseBody).choices?.[0]?.message?.content;
    console.warn(attempt.task,'未通过格式校验', completion);
  }
});
const output = process.argv[2] ?? join(tmpdir(),'worldsim-day-'+Date.now());
mkdirSync(output,{recursive:true});
console.log(output);
const darkroom:ScenarioInput = {
  title:'暗房的定时器',worldInfo:'一间自助胶片工作室，今晚只有我预约使用。',startTime:1140,
  opening:'晚上七点，我刚将一卷胶片放入冲洗罐，定时器还有十五分钟响。',
  locations:[{id:'dark',name:'暗房',description:'操作台上有冲洗罐、计时器和晾片夹。'}],
  events:[{afterMinutes:15,locationId:'dark',text:'操作台上的定时器响起，这卷胶片的冲洗时间到了。'}],
};
async function session(id:string,story:ScenarioInput) {
  const path = join(output,id+'.json');
  const saved = existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : undefined;
  let world = saved ? WorldStateSchema.parse(saved.world) : await prepareOpening(createCustomScenario(id,id,story),provider);
  const journal: {input:string}[] = saved?.journal ?? [];
  const played = (input:string) => journal.some(row => row.input === input);

  async function play(input:string) {
    const before = world;
    let result;
    for (let attempt=1;;attempt++) {
      try {result = await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(before))),input,provider);break;}
      catch (error) {console.log(id,'解析或服务失败',input,attempt,String(error)); if (attempt === 2) throw error;}
    }
    world=result.world;
    const state=projectWorld(world);
    const row={input,time:world.time,place:state.location.name,status:result.turn.resolution.status,
      plan:result.turn.plan,narrative:result.turn.narrative,scene:world.sceneState,
      events:result.turn.events.filter(e=>e.changes.some(c=>c.op==='event')).map(e=>({time:e.time,text:e.text,witnesses:e.noticeWitnessIds}))};
    journal.push(row);
    writeFileSync(join(output,id+'.json'),JSON.stringify({story,journal,world},null,2));
    console.log(id,world.time,state.location.name,row.status,input,row.narrative.slice(0,180));
    return row;
  }
  async function until(clock:string, target:number, stopOnEvent=false) {
    if(stopOnEvent && world.queue.some(e => e.at <= target && e.status === 'executed')) return;
    for(let i=0;world.time<target && i<45;i++){
      const old=world.time;
      const row=await play('等到'+clock);
      if(world.time===old) throw Error('时钟停滞 '+clock);
      if(stopOnEvent && row.events.length) return;
    }
    if(world.time<target) throw Error('未推进到目标时刻 '+clock);
  }
  const once = async (input:string) => { if (!played(input)) await play(input); };
  return {play,once,until,played,state:():WorldState=>world};
}
async function workday() {
  const s=await session('quake',quake);
  if(!s.state().version) await s.play('我背上装着笔记本电脑的背包，驾驶自己的车去公司，到公司停车位停好车');
  if(s.state().time<720 && projectWorld(s.state()).location.id!=='office') await s.play('我开车前往公司');
  for(const input of ['从背包里取出笔记本电脑','把笔记本电脑放到桌上','打开笔记本电脑开始工作'])
    if(!s.played(input) && s.state().time<720) await s.play(input);
  await s.until('今天12:00',720);
  await s.once('我在工位吃午饭，然后继续工作');
  await s.until('今天15:00',900,true);
  await s.once('我暂停工作，观察周围刚发生了什么');
  await s.once('我查看桌上的笔记本电脑');
  await s.once('把桌上这台笔记本电脑收回背包');
  await s.until('今天18:00',1080);
  await s.once('我带上背包，驾驶早上停在公司的那辆车回家，到家后停好车');
  await s.once('查看背包里早上那台笔记本电脑');
  await s.until('今天22:00',1320);
  await s.once('我留下来休息');
}
async function photo() {
  const s=await session('photo',darkroom);
  await s.once('我在操作台旁整理好晾片夹');
  await s.until('今天20:00',1200,true);
  await s.once('我取出刚冲洗好的胶片，用晾片夹挂起来');
  await s.once('我查看刚才挂起来的那卷胶片');
}
function verify(id:'quake'|'photo') {
  const log = JSON.parse(readFileSync(join(output,id+'.json'),'utf8')) as {
    world:WorldState; journal:{input:string;time:number;place:string;status:string;narrative:string;scene:WorldState['sceneState']}[]};
  const opening = log.world.history.flatMap(event => event.changes).find(c => c.op === 'openingAssets');
  assert.ok(opening?.op === 'openingAssets');
  const object = (name:RegExp) => {
    const i = opening.assets.findIndex(a => name.test(a.name));
    assert.ok(i>=0,'开场缺少'+name);
    return log.world.id+'/opening-object/'+i;
  };
  const at = (input:string,objectId:string) => {
    const row = log.journal.find(r=>r.input.includes(input));
    assert.ok(row && row.status==='resolved',input);
    const entries = row.scene.filter(e=>e.objectId===objectId);
    assert.equal(entries.length,1,input+' 的物品身份');
    return entries[0];
  };
  if (id==='photo') {
    const film=object(/胶片|底片/);
    assert.match(at('用晾片夹挂起来',film).value,/挂|晾/);
    assert.ok(log.world.history.some(e=>e.observedItemId===film && /挂|晾/.test(e.text)));
    return;
  }
  const car=object(/汽车|轿车|私家车|小车/), pc=object(/笔记本|电脑/);
  const drives=log.world.history.flatMap(e=>e.changes).filter(c=>c.op==='move' && c.using===car);
  assert.deepEqual(drives.map(c=>c.op==='move' && c.to),['office']);
  assert.equal(at('到公司停车位',pc).scope,'held');
  assert.equal(at('放到桌上',pc).scope,'scene');
  assert.match(at('打开笔记本电脑',pc).value,/开|工作|运行|使用|启动/);
  assert.ok(log.world.history.some(e=>e.time===840 && e.noticeWitnessIds?.includes('player') && e.text.includes('强震')));
  assert.equal(at('收回背包',pc).scope,'held');
  const returnAttempt = log.journal.find(row => row.input.includes('到家后停好车'));
  assert.equal(returnAttempt?.place,'公司');
  assert.notEqual(returnAttempt?.status,'resolved');
  assert.equal(at('查看背包里早上',pc).locationId,'office');
  assert.ok(log.world.time>=1320);
}
const runs=await Promise.allSettled([workday(),photo()]);
for (const [i,r] of runs.entries()) if(r.status==='fulfilled') verify(i===0?'quake':'photo');
for(const r of runs) if(r.status==='rejected'){console.error(r.reason);process.exitCode=1;}
