import { describe, expect, it } from 'vitest';
import { createCustomScenario } from '@worldsim/scenarios';
import { WorldStateSchema, type CommitmentAudience, type Observation, type ScenarioInput } from '@worldsim/shared';
import { witnessedSpeech, meetCrowdMember } from './crowd-contact';
import { advance, createTurnClock } from './scheduler';
import { applyChanges, perceive, record } from './state';

const message = '交班暂定十点，请再核实。';
const story:ScenarioInput = {
  title:'换班',opening:'今天有一则交班口信。',
  locations:[{id:'a',name:'值班室',description:'有人值班。'},{id:'b',name:'回廊',description:'通往两侧。'},
    {id:'c',name:'会客室',description:'有人等候。'}],
  player:{name:'周林',role:'职员',locationId:'a'},npcs:[{name:'楚河',role:'联络员',locationId:'a'},
    {name:'伍青',role:'主管',locationId:'c'},{name:'阿叶',role:'访客',locationId:'c'}],
};
function seed(audience:CommitmentAudience, scenario=story) {
  const w=createCustomScenario('relay','clock',scenario);
  const req=record(w,{kind:'world',source:'speech',speakerId:'player',locationId:'a',perception:'addressed',
    text:message,utterance:{speakerId:'player',listenerIds:['npc-1']},recipients:['npc-1'],changes:[]});
  const reply=record(w,{kind:'npc',source:'npc-action',speakerId:'npc-1',locationId:'a',perception:'addressed',
    text:'我去转告。',utterance:{speakerId:'npc-1',listenerIds:['player']},recipients:['player'],changes:[]});
  applyChanges(w,[{op:'acceptCommitment',commitment:{id:'task',actorId:'npc-1',requestEventId:req.id,replyEventId:reply.id,
    destinationId:'c',audience,message,status:'pending',createdAt:w.time,nextAt:w.time+1}}]);
  return w;
}

describe('世界时钟推进已接受的传话',()=>{
  it('每次只走一条开放的路；途中读档、再次等待均不重复，异地玩家看不到送达',async()=>{
    const initial=seed({kind:'person',id:'npc-2'});
    const observations:Observation[]=[];
    advance(initial,2,false,observations);
    expect(initial.characters[1].locationId).toBe('b');
    expect(initial.commitments[0].status).toBe('pending');
    const w=WorldStateSchema.parse(JSON.parse(JSON.stringify(initial)));
    const heard:string[]=[];
    const clock=createTurnClock(w,observations,undefined,undefined,undefined,async e=>{heard.push(e.id);return [];});
    await clock.advance(10,true);
    await clock.advance(10,false);
    expect(w.characters[1].locationId).toBe('c');
    const events=w.history.filter(e=>e.source==='commitment-delivery');
    expect(heard).toEqual([events[0].id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({locationId:'c',utterance:{private:true,listenerIds:['npc-2']},npcAction:{source:'commitment'}});
    expect(w.commitments[0].status).toBe('delivered');
    expect(observations.every(o=>!o.text.includes(message))).toBe(true);
    expect(perceive(events[0],w,w.characters[3])).toBeUndefined();
  });
  it('途中发生封路后停在真实位置，不产生送达或虚构听众',()=>{
    const w=seed({kind:'room'},{...story,events:[{afterMinutes:3,locationId:'b',text:'回廊通往会客室的门封闭了。',public:false,
      situation:{id:'closure',summary:'回廊的门暂时关闭。',actions:[],blockedRoutes:[{from:'b',to:'c',mode:'all'}]}}]});
    advance(w,15,false,[]);
    expect(w.characters[1].locationId).toBe('b');
    expect(w.commitments[0]).toMatchObject({status:'failed',failureReason:'到目的地的路线不通。'});
    expect(w.history.some(e=>e.source==='commitment-delivery')).toBe(false);
  });
  it('当众但须让具名者听见：人在时打断在场玩家的等待，缺席时不会对其他人照念',()=>{
    for (const present of [true,false]) {
      const w=seed({kind:'room',id:'npc-2'});
      applyChanges(w,[{op:'move',actor:'player',to:'b'},{op:'move',actor:'player',to:'c'}]);
      if (!present) applyChanges(w,[{op:'move',actor:'npc-2',to:'b'}]);
      const observations:Observation[]=[];
      expect(advance(w,20,true,observations)).toBe(present);
      expect(observations.filter(o=>o.kind==='dialogue' && o.text.includes(message))).toHaveLength(present ? 1 : 0);
      expect(w.commitments[0].status).toBe(present ? 'delivered' : 'failed');
      if (present) expect(w.time).toBeLessThan(500);
    }
  });
  it('限定群体的口信只交给在场成员；当时在场而后来结识的成员也能作证',()=>{
    const w=seed({kind:'room'});
    w.populationGroups=['staff','visitors'].map(id=>({id,name:id,size:4,homeId:'c',work:{locationId:'a',task:'换班',from:600,by:610,leave:680,homeBy:690}}));
    w.commitments[0].audience={kind:'group',id:'staff'};
    applyChanges(w,[{op:'move',actor:'player',to:'b'},{op:'move',actor:'player',to:'c'}]);
    advance(w,15,false,[]);
    const event=w.history.find(e=>e.source==='commitment-delivery')!;
    expect(event.utterance).toMatchObject({private:true,groupOnly:'staff',listenerIds:[],groups:[{groupId:'staff',count:4}]});
    expect(perceive(event,w)).toBeUndefined();
    meetCrowdMember(w,'staff','c');meetCrowdMember(w,'visitors','c');
    expect(witnessedSpeech(w,event.utterance!,'crowd:staff')).toBe(true);
    expect(witnessedSpeech(w,event.utterance!,'crowd:visitors')).toBe(false);
  });
});
