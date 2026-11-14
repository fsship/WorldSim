import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBuiltinScenario } from '../packages/scenarios/src';
import { prepareOpening, projectWorld, runTurn } from '../packages/engine/src';
import { createProvider, ProviderFailure } from '../packages/llm/src';
import { WorldStateSchema, type GameTurn, type WorldState } from '../packages/shared/src';
import { quake } from './earthquake-story';
import { readLiveConfig } from './live-fixture';

const output=process.argv[2] ?? join(tmpdir(),'worldsim-quake-week-'+Date.now());
mkdirSync(output,{recursive:true});
console.log(output);
const path=join(output,'week.json');
const save=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
const calls:Record<string,number>=save?.calls??{};
const provider=createProvider(readLiveConfig(),call=>{
  const key=call.task+'/'+call.status;
  calls[key]=(calls[key]??0)+1;
});
let world:WorldState=save?WorldStateSchema.parse(save.world):await prepareOpening(createBuiltinScenario('quake-week','week'),provider);
type Row = {key:string;turn:GameTurn;place:string;scene:WorldState['sceneState']};
const rows:Row[]=save?.rows??[];
const failures:{input:string;time:number;message:string}[]=save?.failures??[];
let stopAfterTurn=false;
process.once('SIGINT',()=>{
  stopAfterTurn=true;
  console.log('当前回合结束后保存进度。');
});
function persist(){
  writeFileSync(path+'.tmp',JSON.stringify({story:quake,world,view:projectWorld(world),rows,failures,calls},null,2));
  renameSync(path+'.tmp',path);
}
async function play(key:string,input:string){
  const finished=rows.find(r=>r.key===key);
  if(finished)return finished;
  for(let n=0;;n++){
    try {
      const r=await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(world))),input,provider);
      world=r.world;
      const place=projectWorld(world).location.name;
      const row={key,turn:r.turn,place,scene:structuredClone(world.sceneState)};
      rows.push(row);
      persist();
      if(!key.startsWith('clock-'))console.log(key,world.time,place,r.turn.narrative);
      if(stopAfterTurn)process.exit(130);
      return row;
    }catch(error){
      failures.push({input,time:world.time,message:String(error)});persist();
      if(!(error instanceof ProviderFailure)||n>=2)throw error;
    }
  }
}
async function until(target:number){
  while(world.time<target){
    const before=world.time;
    const delta=Math.min(720,target-before);
    await play('clock-'+before+'-'+target,'在这里等待'+delta+'分钟');
    assert.ok(world.time>before && world.time<=target,'时钟未按等待上限前进');
  }
}
const drive=await play('mon-drive','我驾驶自己的汽车去公司');
const trip=drive.turn.changes.find(c=>c.op==='move' && c.using && c.to==='office');
assert.ok(trip?.op==='move' && trip.using);
const laptop=drive.scene.find(e=>e.scope==='held' && e.name.includes('电脑'));
assert.ok(laptop?.objectId);
const work=await play('mon-work','我打开背包里的笔记本电脑开始工作');
assert.equal(work.turn.resolution.status,'resolved');
assert.ok(work.scene.some(e=>e.objectId===laptop.objectId));
assert.match(work.turn.narrative,/工作/);
await until(839);
await play('mon-shock','我在这里等十分钟');
assert.ok(world.history.some(e=>e.time===840 && e.noticeWitnessIds?.includes('player') && e.text.includes('强震')));
await play('mon-look','我查看刚才震动后办公室和楼前的情况');
await play('mon-cross','我尝试驾驶自己的汽车沿原路过桥回家');
const denied=rows.find(row=>row.key==='mon-cross')!;
assert.equal(denied.place,'公司');
assert.notEqual(denied.turn.resolution.status,'resolved');
await until(845);
const signup=await play('mon-register','我去联络桌当志愿者，帮邻居们登记各自去了哪里');
assert.equal(signup.turn.resolution.status,'resolved');
const queries=[
  ['周二','我把街坊们的去向和联络本交给来接班的登记员'],
  ['周三','我在广场上看看工作室窗洞现在是什么样，检查有新进展吗'],
  ['周四','我观察附近有没有余震留下的新迹象'],
  ['周五','我驾驶自己的小汽车过桥回家'],
  ['周六','我站在家门口的小院看看今天街坊有什么动静'],
  ['周日','我在院里看看今天附近有什么新消息'],
];
for(const [i,[day,input]] of queries.entries()){
  await until((i+1)*1440+(i===1||i===3 ? 605 : 540));
  const row=await play(day,input);
  if(i===0){
    assert.equal(row.turn.resolution.status,'resolved');
    assert.match(row.turn.narrative,/平安/);
  }
  if(i===3)assert.ok(row.turn.changes.some(c=>c.op==='move' && c.using===trip.using && c.to==='home'));
}
const end=480+7*1440;
await until(end);
assert.equal(world.time,end);
assert.equal(rows.at(-1)?.turn.endTime,end);
const contact=world.situations.find(s=>s.id==='contact');
assert.deepEqual(contact?.decisions.map(d=>d.actionId),['volunteer','hand-over']);
const view=projectWorld(WorldStateSchema.parse(JSON.parse(JSON.stringify(world))));
assert.equal(view.location.id,'home');
assert.equal(view.player.goal,undefined);
assert.ok(view.player.items.some(e=>e.id===laptop.objectId));
assert.match(view.situations?.find(s=>s.id==='studio')?.summary ?? '',/封板/);
assert.deepEqual(world.situations.find(s=>s.id==='bridge')?.blockedRoutes,[]);
const publicTurns=rows.map(({key,place,turn})=>{
  const {input,startTime,endTime,narrative,observations}=turn;
  return {key,place,input,startTime,endTime,narrative,observations};
});
writeFileSync(join(output,'public-week.json'),JSON.stringify({view,turns:publicTurns,calls},null,2));
console.log('finished',world.time,rows.length,failures.length);
