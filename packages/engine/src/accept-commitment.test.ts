import {describe,expect,it} from 'vitest';
import {MockLLMProvider} from '@worldsim/llm';
import {createCustomScenario} from '@worldsim/scenarios';
import {WorldStateSchema,type RelayAcceptance} from '@worldsim/shared';
import {acceptSpokenCommitment} from './accept-commitment';
import {npcResponse} from './npc-response';
import {record} from './state';
import {retryDialogue,runTurn} from './index';

const message='听说交接可能推迟，请核实';
const input='请去门房，私下告诉赵姐：“'+message+'”。';
const text='我现在去门房，亲自把原话带给赵姐。';
const relay:RelayAcceptance={acceptance:text,destination:'门房',audience:{kind:'person',name:'赵姐'},message};
const verdict={grounded:true,playerAgency:true,citationsAccurate:true};
function story(){
  return createCustomScenario('courier','test',{
    title:'换班',opening:'你正在收发室值班。',locations:[
      {id:'mail',name:'收发室',description:'一间收发室。'},{id:'entry',name:'门房',description:'当班人员在门房。'},
    ],player:{name:'小杜',role:'职员',locationId:'mail'},npcs:[
      {name:'小安',role:'同事',locationId:'mail'},{name:'赵姐',role:'领班',locationId:'entry'},
    ],
  });
}
function provider(said:string, proposal?:RelayAcceptance){
  return new MockLLMProvider({dialogue:()=>({text:said,factIds:[]}),reviewDialogue:()=>{
    if (!proposal) return verdict;
    const {acceptance,...fields}=proposal;
    // The mock reviewer attests to a whole reply; a proposed excerpt is
    // represented by the obsolete wire shape, which the protocol rejects.
    const relay=acceptance === said ? {...fields,acceptsEntireReply:true} : proposal;
    return {...verdict,relay};
  }});
}
async function answer(said:string, proposal?:RelayAcceptance, requested=input,w=story()){
  const request=record(w,{source:'speech',kind:'world',text:requested,speaker:'小杜',speakerId:'player',
    utterance:{speakerId:'player',listenerIds:['npc-1']},perception:'addressed',recipients:['npc-1'],locationId:'mail',changes:[]});
  await npcResponse(w,w.characters[1],requested,'双方正在此地交谈。',[],provider(said,proposal),'addressed',undefined,request.id);
  return w;
}
describe('从实际交流建立送信承诺',()=>{
  it('在听见具体请求并亲自接受后生成一项可读档的计划，保留原意与受众',async()=>{
    const w=await answer(text,relay);
    const p=WorldStateSchema.parse(JSON.parse(JSON.stringify(w))).commitments[0];
    expect(p).toMatchObject({actorId:'npc-1',destinationId:'entry',audience:{kind:'person',id:'npc-2'},message,
      createdAt:480,nextAt:481,status:'pending'});
    const line=w.history.find(e=>e.id===p.replyEventId)!;
    expect(line.text).toBe(text);
    expect(w.history.find(e=>e.id===p.requestEventId)?.text).toBe(input);
    acceptSpokenCommitment(w,p.requestEventId,line,relay);
    expect(w.commitments).toHaveLength(1);
    expect(w.facts).toEqual([]);
  });
  it.each([
    ['我不能代你跑这一趟。',undefined],
    ['我听清了。',undefined],
    ['我听清了。',relay], // A fabricated acceptance excerpt cannot be applied.
    [text,{...relay,message:'交接已经推迟'}],
    [text,{...relay,destination:'调度室'}],
    [text,{...relay,audience:{kind:'person',name:'站长'}}],
  ] as const)('请求本身、听懂或未经支持的提取均不建约',async(said,proposal)=>{
    expect((await answer(said,proposal)).commitments).toEqual([]);
  });
  it.each([
    ['我不去门房传话。','去门房传话','今天不营业','person'],
    [text,text,'营业','person'],
    [text,text,'今天不营业','room'],
    [text,text,'以公告为准','person'],
  ] as const)('拒绝切除否定、遗漏后半句、扩大私信范围或只传最后一节',async(said,acceptance,clipped,kind)=>{
    const request='请去门房，私下告诉赵姐：今天不营业，以公告为准。';
    const audience=kind==='person'?{kind,name:'赵姐'} as const:{kind} as const;
    expect((await answer(said,{...relay,acceptance,audience,message:clipped},request)).commitments).toEqual([]);
  });
  it('审核提取无法把一条完整的私人口信变成面向其他人的广播',async()=>{
    const request='请去门房，私下告诉赵姐：今天不营业。';
    const w=await answer(text,{...relay,message:'今天不营业',audience:{kind:'room'}},request);
    expect(w.commitments).toEqual([]);
    expect(w.history.at(-1)?.npcFailure).toBe('validation');
    expect(w.history.some(e=>e.text===text)).toBe(false);
  });
  it('认可完整的带标点口信，忽略交给信使的后续问话',async()=>{
    const words='今天不营业，以公告为准';
    const w=await answer(text,{...relay,message:words},'请去门房私下告诉赵姐：'+words+'。你愿意去吗？');
    expect(w.commitments[0].message).toBe(words);
  });
  it('只有当前当场写入的台词可建约，构造的副本不能代替实际发言',async()=>{
    const w=await answer(text);
    const line=w.history.at(-1)!;
    const request=w.history.find(e=>e.source==='speech')!;
    acceptSpokenCommitment(w,request.id,{...line},relay);
    expect(w.commitments).toEqual([]);
  });
  it('明确要求向全场宣告并让具名对象听到时保留两项限制；指定群体用群体标识',async()=>{
    const opening=story();
    opening.populationGroups=[{id:'shift',name:'换班人员',size:3,homeId:'entry',work:{locationId:'mail',task:'交班',from:500,by:510,leave:600,homeBy:610}}];
    const publicWords='我亲自去门房向所有人传达。';
    const publicPlan={...relay,acceptance:publicWords,audience:{kind:'room' as const,name:'赵姐'}};
    const publicWorld=await answer(publicWords,publicPlan,'请去门房向全场转达并确保赵姐听到：“'+message+'”。',opening);
    expect(publicWorld.commitments[0].audience).toEqual({kind:'room',id:'npc-2'});
    const titled=await answer(publicWords,{...publicPlan,audience:{kind:'room',name:'领班赵姐'}},
      '请去门房，当着领班赵姐的面向全场转达：“'+message+'”。');
    expect(titled.commitments[0].audience).toEqual({kind:'room',id:'npc-2'});
    for (const audience of [{kind:'room' as const},{kind:'room' as const,name:'门房'}]) {
      const named=await answer(publicWords,{...publicPlan,audience},'请去门房，当着领班赵姐和大家的面，公开宣布：“'+message+'”。');
      expect(named.commitments[0].audience).toEqual({kind:'room',id:'npc-2'});
    }
    const groupWords='我亲自去门房转告换班人员。';
    const groupWorld=await answer(groupWords,{...relay,acceptance:groupWords,audience:{kind:'group',name:'换班人员'}},
      '请到门房向换班人员传话：“'+message+'”。',{...opening,commitments:[]});
    expect(groupWorld.commitments[0].audience).toEqual({kind:'group',id:'shift'});
  });
  it('审核失败只留下未完成答复；恢复出实际台词后建约一次',async()=>{
    const initial=story();
    const failed=await runTurn(initial,'我对小安说：“请去门房，私下告诉赵姐，'+message+'。”',
      new MockLLMProvider({dialogue:()=>({text,factIds:[]}),reviewDialogue:()=>{throw Error('offline');}}));
    expect(failed.world.commitments).toEqual([]);
    const recovered=await retryDialogue(failed.world,failed.turn,provider(text,relay));
    if (!('world' in recovered)) throw Error(recovered.notice);
    expect(recovered.world.commitments).toHaveLength(1);
    const second=await retryDialogue(recovered.world,failed.turn,provider(text,relay));
    expect(second).toHaveProperty('notice');
  });
});
