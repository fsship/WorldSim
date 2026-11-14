import {expect, it} from 'vitest';
import {MockLLMProvider} from '@worldsim/llm';
import {createCustomScenario} from '@worldsim/scenarios';
import {WorldStateSchema, type ScenarioInput} from '@worldsim/shared';
import {projectWorld, runTurn} from './index';

const closed = [{from:'studio',to:'yard',mode:'all' as const}];
const repair = '换上备用锁芯';
const story:ScenarioInput = {
  title:'库房的门',opening:'你在库房里清点货物。',
  locations:[{id:'studio',name:'库房',description:'一扇门通往后院。'},{id:'yard',name:'后院',description:'院内堆着木箱。'}],
  player:{name:'小陈',role:'保管员',locationId:'studio'},npcs:[],
  events:[{afterMinutes:2,locationId:'studio',text:'门锁的弹簧断了。',
    situation:{id:'lock',summary:'库房通往后院的门卡住了。',blockedRoutes:closed,actions:[
      {id:'replace',summary:repair,locationId:'studio',outcome:'你换好锁芯，门可以打开了。',minutes:15,
        next:{summary:'库房已经换过锁芯。',blockedRoutes:[]}},
    ]}}],
};

it('通行由已发生的事件与玩家决定改变，旁支仍保留故障',async()=>{
  const mock = new MockLLMProvider();
  const fresh = createCustomScenario('repair','game',story);
  expect(projectWorld(fresh).situations).toBeUndefined();
  const triggered = await runTurn(fresh,'等待五分钟',mock);
  expect(triggered.world.time-fresh.time).toBe(2);
  expect(projectWorld(triggered.world).situations?.[0].actions).toContain(repair);
  const save=JSON.stringify(triggered.world);
  const fork=()=>WorldStateSchema.parse(JSON.parse(save));
  const stuck=await runTurn(fork(),'去后院',mock);
  expect(stuck.turn.resolution.status).toBe('refused');
  expect(projectWorld(stuck.world).location.id).toBe('studio');
  const success=await runTurn(fork(),repair,mock);
  expect(success.world.time-triggered.world.time).toBe(15);
  expect(projectWorld(success.world).situations?.[0].decisions).toHaveLength(1);
  expect(projectWorld(success.world).situations?.[0].actions).toEqual([]);
  const passed=await runTurn(success.world,'去后院',mock);
  expect(projectWorld(passed.world).location.id).toBe('yard');
  expect(projectWorld(stuck.world).situations?.[0].decisions).toEqual([]);
});

it('应对措施执行中遇到更早的重要通告，暂停并保留现场状况',async()=>{
  const mock=new MockLLMProvider();
  const fresh=createCustomScenario('repair','game',{...story,events:[
    ...story.events!,{afterMinutes:8,locationId:'studio',text:'送货员来到库房。'},
  ]});
  const triggered=await runTurn(fresh,'等待五分钟',mock);
  const stopped=await runTurn(triggered.world,repair,mock);
  expect(stopped.turn.endTime-fresh.time).toBe(8);
  expect(stopped.turn.resolution.status).toBe('uncertain');
  expect(stopped.turn.narrative).toContain('送货员');
  expect(projectWorld(stopped.world).situations?.[0].decisions).toEqual([]);
  const resumed=await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(stopped.world))),repair,mock);
  expect(resumed.turn.resolution.status).toBe('resolved');
  expect(resumed.world.time-triggered.world.time).toBe(15);
  expect(projectWorld(resumed.world).situations?.[0].decisions).toHaveLength(1);
});

it('同一分钟局势发生变化时，不提交上一阶段同名行动的结果',async()=>{
  const mock=new MockLLMProvider();
  const old=story.events![0];
  const replacement={...old.situation!,summary:'整扇门需要重新安装。'};
  const fresh=createCustomScenario('repair','game',{...story,events:[old,
    {...old,afterMinutes:17,text:'门框脱落了。',situation:replacement},
  ]});
  const triggered=await runTurn(fresh,'等待五分钟',mock);
  const stopped=await runTurn(triggered.world,repair,mock);
  expect(stopped.turn.resolution.status).toBe('uncertain');
  expect(stopped.turn.narrative).toContain('门框脱落');
  expect(stopped.turn.narrative).not.toContain('你换好锁芯');
  expect(projectWorld(stopped.world).situations?.[0].decisions).toEqual([]);
});

it('NPC 查看过的现场在情况变化前不反复播报，新通知后可以再查看',async()=>{
  const fresh=createCustomScenario('warehouse','idle',{
    ...story,npcs:[{name:'阿陆',role:'维修员',locationId:'studio'}],
    events:[{afterMinutes:50,locationId:'studio',text:'一批新货抵达库房。'}],
  });
  const mock=new MockLLMProvider({decideNpcAction:ctx=>({kind:ctx.canInspect?'inspect':'stay'})});
  const first=await runTurn(fresh,'等待四十分钟',mock);
  expect(first.world.time-fresh.time).toBe(40);
  expect(first.turn.observations.filter(o=>o.text.includes('仔细查看'))).toHaveLength(1);
  const notice=await runTurn(first.world,'等待二十分钟',mock);
  expect(notice.turn.narrative).toContain('一批新货');
  const again=await runTurn(notice.world,'等待五分钟',mock);
  const inspections=[...notice.turn.events,...again.turn.events].filter(e=>e.npcAction?.kind==='inspect');
  expect(inspections).toHaveLength(1);
});
