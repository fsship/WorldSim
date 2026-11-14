import { expect, it } from 'vitest';
import { MockLLMProvider } from '@worldsim/llm';
import { createCustomScenario } from '@worldsim/scenarios';
import { WorldStateSchema, type TurnPlan } from '@worldsim/shared';
import { projectWorld, runTurn } from './index';

const world = () => createCustomScenario('studio','test',{worldInfo:'城市里的一间画室。',opening:'你来到画室。'});
const interpret = (plan:TurnPlan) => Object.assign(new MockLLMProvider(),{interpret:async () => plan});
const lamp = {scope:'scene' as const,name:'台灯',value:'已打开'};
const pen = {scope:'held' as const,name:'铅笔',value:'在手中'};
it('部分完成的步骤在读档后仍然生效，失败步骤和后续步骤不写入',async () => {
  const start = world();
  const result = await runTurn(start,'开灯，拿笔，写字',interpret({kind:'sequence',steps:[
    {source:'开灯',text:'台灯亮了。',sets:[lamp]},
    {source:'拿笔',text:'你拿起铅笔。',requires:[{...lamp,value:'已关闭'}],sets:[pen]},
    {source:'写字',text:'你写下了名字。'},
  ]}));
  expect(result.turn.resolution.status).toBe('uncertain');
  expect(result.world.time).toBe(start.time+1);
  expect(result.turn.narrative).not.toContain('写下');
  expect(result.turn.narrative).toContain('「写字」尚未执行');
  const loaded = WorldStateSchema.parse(JSON.parse(JSON.stringify(result.world)));
  expect(loaded.sceneState).toEqual([{...lamp,locationId:'start'}]);
  const used = await runTurn(loaded,'借着灯光拿起铅笔',interpret({kind:'sequence',steps:[
    {source:'拿起铅笔',text:'你拿起铅笔。',requires:[lamp],sets:[pen]},
  ]}));
  expect(projectWorld(used.world).player.items.map(i=>i.name)).toContain('铅笔');
  const next = await runTurn(used.world,'前往公园',interpret({kind:'explore',destination:'公园'}));
  expect(projectWorld(next.world).player.items.map(i=>i.name)).toContain('铅笔');
  expect(projectWorld(next.world).location.description).not.toContain('台灯');
  const put = await runTurn(next.world,'放下铅笔',interpret({kind:'sequence',steps:[
    {source:'放下铅笔',text:'你放下铅笔。',clears:[pen],sets:[{scope:'scene',name:'铅笔',value:'地面上'}]},
  ]}));
  expect(projectWorld(put.world).player.items).toHaveLength(0);
  expect(projectWorld(put.world).location.description).toContain('铅笔');
});

it('受阻的末步没有列出后文时仍从原文告知尚未执行的动作',async()=>{
  const place = {scope:'self' as const,name:'位置',value:'工具间'};
  const start = world();
  const result = await runTurn(start,'走进工具间，拉开抽屉，拿出扳手',interpret({kind:'sequence',steps:[
    {source:'走进工具间',text:'你走进工具间。',sets:[place]},
    {source:'拉开抽屉',text:'抽屉还锁着。',blocked:true},
  ]}));
  expect(result.turn.resolution.status).toBe('uncertain');
  expect(result.turn.narrative).toContain('抽屉还锁着。后续的「拿出扳手」尚未执行。');
  expect(result.world.sceneState).toEqual([{...place,locationId:'start'}]);
});

it('行程首段失败时点明尚未执行的目的地内操作',async()=>{
  const start = world();
  const result = await runTurn(start,'前往展厅，在展台上签到',Object.assign(new MockLLMProvider(),{
    interpret:async (ctx:import('@worldsim/shared').ParseContext):Promise<TurnPlan> => ctx.segment === 'travel' ?
      {kind:'unavailable',subject:'place'} : {kind:'itinerary',steps:[
        {kind:'travel',source:'前往展厅'},{kind:'local',source:'在展台上签到'}]},
  }));
  expect(result.turn.resolution.status).toBe('refused');
  expect(result.turn.observations.at(-1)?.text).toBe('后续的「在展台上签到」尚未执行。');
  expect(result.world.time).toBe(start.time);
  expect(result.world.sceneState).toEqual(start.sceneState);
});

it('同一回合移动后在新现场解析后续动作；若条件不成立则保留已完成的移动',async () => {
  const initial = createCustomScenario('studio','route',{worldInfo:'海边小镇。',opening:'你在画室。',
    locations:[{id:'studio',name:'画室',description:'一间画室。'},{id:'hall',name:'展厅',description:'厅内有展台。'}]});
  const take = await runTurn(initial,'拿起铅笔',interpret({kind:'sequence',steps:[
    {source:'拿起铅笔',text:'你拿起铅笔。',sets:[pen]},
  ]}));
  const contexts:Array<[string,string|undefined]> = [];
  const run = async (blocked:boolean) => runTurn(take.world,'前往展厅，把笔放在展台上',Object.assign(new MockLLMProvider(),{
    interpret:async (ctx:import('@worldsim/shared').ParseContext):Promise<TurnPlan> => {
      contexts.push([ctx.location,ctx.segment]);
      if (!ctx.segment) return {kind:'itinerary',steps:[
        {kind:'travel',source:'前往展厅'},{kind:'local',source:'把笔放在展台上'}]};
      if (ctx.segment === 'travel') return {kind:'move',destination:'hall'};
      expect(ctx.surroundings).toContain('展台');
      expect(ctx.sceneState).toContainEqual(expect.objectContaining(pen));
      return {kind:'sequence',steps:[{source:ctx.text,text:blocked?'展台封闭。':'笔放在展台上。',
        blocked,clears:[pen],sets:[{scope:'scene',name:'铅笔',value:'展台上'}]}]};
    },
  }));
  const success = await run(false);
  expect(contexts).toEqual([['画室',undefined],['画室','travel'],['展厅','local']]);
  expect(success.world.version).toBe(take.world.version+1);
  expect(success.world.sceneState[0]).toMatchObject({scope:'scene',locationId:'hall',objectId:take.world.sceneState[0].objectId});
  const refused = await run(true);
  expect(refused.turn.resolution.status).toBe('uncertain');
  expect(projectWorld(refused.world).location.id).toBe('hall');
  expect(projectWorld(refused.world).player.items[0].id).toBe(take.world.sceneState[0].objectId);
});

it('开场物品据原文登记一次，原地更新、携带和现场查看使用同一编号', async () => {
  const {prepareOpening} = await import('./index');
  const initial = createCustomScenario('garden','garden',{worldInfo:'一间温室。',opening:'剪刀装在围裙口袋。'});
  let calls = 0;
  const provider = Object.assign(new MockLLMProvider(),{openingAssets:async () => {
    calls++;
    return {assets:[{name:'剪刀',scope:'held' as const,value:'在口袋里',evidence:'剪刀装在围裙口袋'},
      {name:'铃铛',scope:'scene' as const,value:'在门口',evidence:'门口的铃铛'}]};
  }});
  const opened = await prepareOpening(await prepareOpening(initial,provider),provider);
  expect(calls).toBe(1);
  expect(opened.sceneState).toHaveLength(1);
  const old = {name:'剪刀',scope:'held' as const,value:'在口袋里'};
  const result = await runTurn(opened,'拿出剪刀',interpret({kind:'sequence',steps:[
    {source:'拿出剪刀',text:'你拿出剪刀。',clears:[old],sets:[{...old,value:'在手中'}]},
  ]}));
  const id = opened.sceneState[0].objectId!;
  expect(result.world.sceneState[0].objectId).toBe(id);
  const inspected = await runTurn(result.world,'查看剪刀',interpret({kind:'item',itemId:id,interaction:'inspect'}));
  expect(inspected.turn.events.some(e=>e.observedItemId===id)).toBe(true);
  expect(inspected.turn.narrative).toContain('在手中');
});
