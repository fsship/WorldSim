import { expect, it } from 'vitest';
import { MockLLMProvider } from '@worldsim/llm';
import { createCustomScenario } from '@worldsim/scenarios';
import { WorldStateSchema, type ScenarioInput, type WorldEvent, type WorldState } from '@worldsim/shared';
import { npcContext } from './npc-dialogue';
import { npcResponse } from './npc-response';
import { progressRelays } from './relay-progress';
import { advance } from './scheduler';
import { applyChanges, record } from './state';

const gallery:ScenarioInput = {
  title:'旧城展',opening:'开馆了。',player:{name:'小路',role:'策展人',locationId:'hall'},
  locations:[{id:'hall',name:'展厅',description:'有一排播放按钮。'},{id:'archive',name:'资料室',description:'登记簿放在桌上。'}],
  npcs:[{name:'阿岚',role:'管理员',locationId:'hall'},{name:'小榆',role:'资料员',locationId:'archive'},
    {name:'小任',role:'读者',locationId:'archive'}],
  events:[{afterMinutes:1,locationId:'hall',text:'广播询问今天的安排。',public:true,situation:{
    id:'exhibit',summary:'播放安排待定。',blockedRoutes:[],actions:[
      {id:'excerpt',summary:'节选',outcome:'你放出已获准的节选。',minutes:1,next:{summary:'现在只放节选。',blockedRoutes:[]}},
      {id:'hold',summary:'停播',outcome:'整条暂缓。',minutes:1,next:{summary:'整条停播。',blockedRoutes:[]}},
    ],
  }}],
};
const reload=(world:WorldState)=>WorldStateSchema.parse(JSON.parse(JSON.stringify(world)));
function context(world:WorldState,npcId:string,listeners:string[]) {
  const npc=world.characters.find(c=>c.id===npcId)!;
  return npcContext(world,npc,'','可以回答。',[],false,undefined,listeners);
}

it('目击者记得实际完成的选择及时间地点；异地只知旧广播，后来到场能看到现状但没有经历那次选择',()=>{
  const world=createCustomScenario('gallery','witnesses',gallery);
  advance(world,2,false,[]);
  const event=record(world,{source:'action',kind:'world',text:'你放出已获准的节选。',perception:'addressed',
    locationId:'hall',recipients:['player'],changes:[{op:'respondSituation',situationId:'exhibit',actionId:'excerpt'}]});
  expect(new Set(event.noticeWitnessIds)).toEqual(new Set(['player','npc-1']));
  applyChanges(world,[{op:'move',actor:'npc-1',to:'archive'}]);
  const loaded=reload(world);
  const witness=context(loaded,'npc-1',['player']);
  expect(witness.witnessedEvents).toEqual([{time:482,location:'展厅',source:'decision',text:event.text}]);
  expect(witness.surroundings).toContain('现在只放节选');
  expect(JSON.stringify(witness)).not.toContain('整条停播');
  const unknown=context(loaded,'npc-2',['player']);
  expect(unknown.surroundings).toContain('播放安排待定');
  expect(unknown.witnessedEvents).toBeUndefined();
  expect(JSON.stringify(context(loaded,'npc-1',['npc-2','player']))).not.toContain('节选');
  applyChanges(loaded,[{op:'move',actor:'npc-2',to:'hall'}]);
  const arrived=context(loaded,'npc-2',['player']);
  expect(arrived.surroundings).toContain('现在只放节选');
  expect(arrived.witnessedEvents).toBeUndefined();
  delete event.noticeWitnessIds;
  expect(context(reload(world),'npc-1',['player']).witnessedEvents).toBeUndefined();
});

it('自己做过的可见工作能跨地点转述，没目击的人不能用旁人的动作作证',()=>{
  const world=createCustomScenario('gallery','actions',gallery);
  const text='阿岚在展厅核对播放按钮。';
  record(world,{source:'npc-action',kind:'world',text,perception:'local',locationId:'hall',recipients:['player'],changes:[],
    npcAction:{actorId:'npc-1',source:'provider',kind:'act',witnessIds:['npc-1','player']}});
  record(world,{source:'npc-action',kind:'world',text:'未获准的动作。',perception:'local',locationId:'hall',recipients:['player'],changes:[],
    npcAction:{actorId:'npc-1',source:'fallback',kind:'stay',witnessIds:['npc-1','player']}});
  applyChanges(world,[{op:'move',actor:'npc-1',to:'archive'}]);
  const stored=reload(world);
  expect(context(stored,'npc-1',['npc-2']).witnessedEvents).toEqual([{source:'npc-action',time:480,location:'展厅',text}]);
  expect(context(stored,'npc-2',['npc-1']).witnessedEvents).toBeUndefined();
});

it.each([true,false])('听到的履约只能证明谁对谁说了什么；定向回执可向发起人单独说明（私语 %s）',quiet=>{
  const world=createCustomScenario('gallery','receipt',gallery);
  const message='听说码头会添一列新船。';
  const req=record(world,{source:'speech',kind:'world',text:'请你把这个说法带给小榆。',speakerId:'player',speaker:'小路',
    locationId:'hall',perception:'addressed',recipients:['npc-1'],utterance:{speakerId:'player',listenerIds:['npc-1'],private:true},changes:[]});
  const reply=record(world,{source:'npc-action',kind:'npc',text:'好，我会去。',speakerId:'npc-1',speaker:'阿岚',
    locationId:'hall',perception:'addressed',recipients:['player'],utterance:{speakerId:'npc-1',listenerIds:['player'],private:true},changes:[]});
  world.commitments.push({id:'delivery',actorId:'npc-1',destinationId:'archive',audience:{kind:'person',id:'npc-2'},message,
    requestEventId:req.id,replyEventId:reply.id,status:'delivered',createdAt:480,nextAt:485});
  applyChanges(world,[{op:'move',actor:'npc-1',to:'archive'},{op:'clock',to:485}]);
  const speech:NonNullable<WorldEvent['utterance']>={speakerId:'npc-1',listenerIds:quiet?['npc-2']:['npc-2','npc-3'],private:quiet};
  world.history.push({id:'delivered',source:'commitment-delivery',kind:'npc',text:message,locationId:'archive',time:world.time,
    speaker:'阿岚',speakerId:speech.speakerId,perception:'addressed',utterance:speech,recipients:speech.listenerIds,
    changes:[{op:'advanceCommitment',id:'delivery',status:'delivered'}]});
  const stored=reload(world), expected={source:'commitment',time:485,location:'资料室',text:message,speaker:'阿岚',recipient:'小榆',...(quiet?{restricted:true}:{})};
  expect(context(stored,'npc-2',['player']).witnessedEvents).toEqual([expected]);
  expect(context(stored,'npc-1',['player']).witnessedEvents).toEqual([expected]);
  const publicReply=context(stored,'npc-2',['player','npc-3']);
  expect(publicReply.witnessedEvents).toEqual(quiet ? undefined : [expected]);
  expect(publicReply.facts).not.toContainEqual(expect.objectContaining({text:message}));
  expect(context(stored,'npc-3',['player']).witnessedEvents).toEqual(quiet ? undefined : [expected]);
  if(quiet) expect(JSON.stringify(publicReply)).not.toContain(message);
});

it('路程和工作调动不能充当送达；失败后只有执行人向原委托人单独说明实际原因',async()=>{
  const world=createCustomScenario('gallery','missing-recipient',gallery);
  const req=record(world,{source:'speech',kind:'world',text:'请去资料室告诉小榆。',speakerId:'player',speaker:'小路',
    locationId:'hall',perception:'addressed',recipients:['npc-1'],utterance:{speakerId:'player',listenerIds:['npc-1'],private:true},changes:[]});
  const reply=record(world,{source:'npc-action',kind:'npc',text:'我这就去。',speakerId:'npc-1',speaker:'阿岚',
    locationId:'hall',perception:'addressed',recipients:['player'],utterance:{speakerId:'npc-1',listenerIds:['player'],private:true},changes:[]});
  world.commitments.push({id:'missing',actorId:'npc-1',destinationId:'archive',audience:{kind:'person',id:'npc-2'},message:'节选今日开放。',
    requestEventId:req.id,replyEventId:reply.id,status:'pending',createdAt:480,nextAt:481});
  applyChanges(world,[{op:'move',actor:'npc-2',to:'hall'},{op:'clock',to:481}]);
  const leg=progressRelays(world);
  expect(leg.deliveries).toHaveLength(0);
  expect(world.commitments[0].status).toBe('pending');
  expect(context(world,'npc-1',['player']).witnessedEvents?.some(m=>m.source.startsWith('commitment'))).toBe(false);
  applyChanges(world,[{op:'clock',to:486}]);
  expect(progressRelays(world).deliveries).toHaveLength(0);
  const loaded=reload(world), reason='到了约定地点，没找到要转告的人。';
  expect(loaded.commitments[0].status).toBe('failed');
  applyChanges(loaded,[{op:'move',actor:'npc-1',to:'hall'}]);
  expect(context(loaded,'npc-1',['player']).witnessedEvents).toContainEqual({
    source:'commitment-failed',time:486,location:'资料室',text:reason});
  expect(JSON.stringify(context(loaded,'npc-1',['player','npc-2']))).not.toContain(reason);
  expect(JSON.stringify(context(loaded,'npc-1',['npc-2']))).not.toContain(reason);
  expect(JSON.stringify(context(loaded,'npc-2',['player']))).not.toContain(reason);
  // An unfinished or legacy save cannot prove a failure from just one side
  // of the ledger, nor can a person infer it from who was at the workplace.
  const missingHistory=reload(loaded);
  missingHistory.history=missingHistory.history.filter(e=>e.source!=='commitment-failed');
  expect(JSON.stringify(context(missingHistory,'npc-1',['player']))).not.toContain(reason);
  loaded.commitments[0].status='pending';
  expect(JSON.stringify(context(loaded,'npc-1',['player']))).not.toContain(reason);
  loaded.commitments[0].status='failed';
  applyChanges(loaded,[{op:'move',actor:'npc-2',to:'archive'}]);
  await npcResponse(loaded,loaded.characters[1],'你亲自遇到什么情况？','双方在此地交谈。',[],new MockLLMProvider({
    decideNpcAction:()=>({kind:'speak'}),dialogue:()=>({text:reason,factIds:[]}),
    reviewDialogue:()=>({grounded:true,playerAgency:true,citationsAccurate:true}),
  }),'addressed');
  const answer=loaded.history.at(-1)!;
  expect(answer.text).toBe(reason);
  expect(answer.utterance?.private).toBeUndefined();
  expect(answer.restrictedRecall).toBe(true);
  applyChanges(loaded,[{op:'move',actor:'npc-2',to:'hall'}]);
  expect(context(reload(loaded),'npc-1',['player']).history).toContainEqual({role:'npc',text:reason});
  expect(JSON.stringify(context(reload(loaded),'npc-1',['player','npc-2']))).not.toContain(reason);
});
