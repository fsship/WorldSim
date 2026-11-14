import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOpening, projectWorld, runTurn } from '../packages/engine/src';
import { createProvider, ProviderFailure } from '../packages/llm/src';
import { createCustomScenario } from '../packages/scenarios/src';
import { DialogueReviewSchema, WorldStateSchema, type ScenarioInput, type WorldState } from '../packages/shared/src';
import { readLiveConfig } from './live-fixture';

interface TestCase {
  story: ScenarioInput;
  messenger: string;
  recipient: string;
  listener?: string;
  destination: string;
  request: string;
  followUp: string;
  answerContent: RegExp[];
  responseContent: RegExp;
}

const cases: Record<string,TestCase> = {
  stage: {
    story:{
      title:'《渡船》最后一站',startTime:1176,
      worldInfo:'巡演最后一场的开演时间是二十点。今晚的主演丁荷已经失声，余唯是排过全剧的替补。前厅领班许笙在前厅守着检票桌；持票观众纪宁在桌前等候演员安排。',
      opening:'19:36，我和余唯在后台，离开演还有二十四分钟。化妆间里，丁荷正在休息。刚刚讨论完换角的可能性，前厅还不知道我的决定。',
      locations:[
        {id:'back',name:'后台',description:'后台和前厅之间有一扇隔音门，关上门听不见另一边说什么。'},
        {id:'foyer',name:'前厅',description:'观众在检票桌前等候，旁边的门通向后台。'},
      ],
      player:{name:'江序',role:'舞台监督',locationId:'back'},
      npcs:[
        {name:'余唯',role:'替补演员',locationId:'back',duty:'巡演期间协助舞台监督，前厅需要时传递当晚的演出安排。'},
        {name:'许笙',role:'前厅领班',locationId:'foyer',duty:'在前厅值守检票桌，听取现场通知并回应观众。'},
        {name:'纪宁',role:'持票观众',locationId:'foyer',duty:'在前厅等候开场，想知道今天的演员是否与票面相同。'},
      ],
    },
    messenger:'余唯',recipient:'许笙',listener:'纪宁',destination:'前厅',
    request:'我对余唯说：“请你现在去前厅，当着领班许笙和观众的面，公开宣布我的决定：今晚由余唯替丁荷演出，二十点照常开演。我留在后台，你愿意去吗？”',
    followUp:'我问许笙：“你刚才亲耳听到了哪项安排？是谁来告诉你的？”',
    answerContent:[/余唯|替补演员/,/丁荷|替演|替.{0,9}演|代.{0,9}演|换角|顶替|接替/],
    responseContent:/丁荷|替补|替演|演员|照常开演|换角|演出|票面|(?:回应|解释给|通知|告知|告诉|答复|向).{0,5}观众/,
  },
  radio: {
    story:{
      title:'《夜线》播出前',startTime:1106,
      worldInfo:'《夜线》还有半小时开播。记者沈杳在录音间值班。编辑夏真独自在编辑部负责待播稿。两间房之间隔音，现场口信需要当面传达。',
      opening:'18:26，我刚摘下监听耳机，沈杳正站在身边。热线录音的来电者身份仍待核实，编辑部等着我的决定。',
      locations:[
        {id:'booth',name:'录音间',description:'监听台对面是一扇通往编辑部的隔音门。'},
        {id:'desk',name:'编辑部',description:'编辑在这里安排播出顺序。侧门通往录音间。'},
      ],
      player:{name:'任川',role:'值班主播',locationId:'booth'},
      npcs:[
        {name:'沈杳',role:'现场记者',locationId:'booth',duty:'随时协助主播核实信息，来往编辑部与录音间传递播出决定。'},
        {name:'夏真',role:'值班编辑',locationId:'desk',duty:'在编辑部值守编务台，根据播出决定安排值班工作。'},
      ],
    },
    messenger:'沈杳',recipient:'夏真',destination:'编辑部',
    request:'我对沈杳说：“请你现在去编辑部，单独告诉值班编辑夏真我的决定：今晚停播热线录音，改播天气简讯。我留在录音间，你愿意去吗？”',
    followUp:'我低声问夏真：“刚才你亲耳听到了哪项播出决定？是谁来通知你的？”',
    answerContent:[/热线|录音/,/停播|不播|暂停|撤|暂缓|取消|改播|天气/],
    responseContent:/录音|天气|停播|撤下|稿单|播出顺序/,
  },
};

const output=mkdtempSync(join(tmpdir(),'worldsim-live-commitments-'));
const chosen=process.argv.slice(2);
const names=chosen.length ? chosen : Object.keys(cases);
assert.ok(names.every(n=>Object.hasOwn(cases,n)));
const config=readLiveConfig();
console.log(output);
const reload=(world:WorldState)=>WorldStateSchema.parse(JSON.parse(JSON.stringify(world)));

async function verify(name:string) {
  const t=cases[name];
  const calls:Record<string,number>={};
  const reviewRequests:{attempt:number;status:string;maxTokens:number;reasoningEffort:string}[]=[];
  const errors:{task:string;reason:string|null;finish?:string;keys?:string[];issues?:string[]}[]=[];
  const suppliedReceipts:{task:string;time:number;actor:string;source:string;input:string}[]=[];
  const reviewedAcceptances:{actor:string;audience:string;required?:string;accepted:boolean;wireFields:string[];draft:string;issue?:string;excerpt?:string;grounded:boolean;playerAgency:boolean;citationsAccurate:boolean}[]=[];
  const provider=createProvider(config,attempt=>{
    const k=attempt.task+'/'+attempt.status;
    calls[k]=(calls[k]??0)+1;
    if(attempt.task==='reviewDialogue'){
      const request=JSON.parse(attempt.requestBody);
      reviewRequests.push({attempt:attempt.attempt,status:attempt.status,maxTokens:request.max_completion_tokens,reasoningEffort:request.reasoning_effort??'default'});
    }
    if(attempt.status==='error'){
      const diagnostic:typeof errors[number]={task:attempt.task,reason:attempt.errorReason};
      if(attempt.task==='reviewDialogue' && (attempt.errorReason==='format'||attempt.errorReason==='review_length') && attempt.responseBody){
        try{
          const choice=JSON.parse(attempt.responseBody).choices?.[0];
          diagnostic.finish=choice?.finish_reason;
          const record=JSON.parse(choice.message.content);
          diagnostic.keys=Object.keys(record);
          const parsed=DialogueReviewSchema.safeParse(record);
          if(!parsed.success)diagnostic.issues=parsed.error.issues.map(issue=>issue.path.join('.')+' '+issue.code);
        }catch{diagnostic.issues=['unparseable'];}
      }
      errors.push(diagnostic);
    }
    if(attempt.status!=='success' || !['reviewDialogue','decideNpcAction','dialogue'].includes(attempt.task))return;
    const request=JSON.parse(attempt.requestBody);
    const data=JSON.parse(request.messages[1].content);
    const context=data.context??data;
    const actor=context.speaker?.name??context.npc?.name;
    for(const witness of context.witnessedEvents??[])if(witness.source==='commitment') {
      suppliedReceipts.push({task:attempt.task,time:context.currentTime,actor,source:witness.speaker,input:context.input});
    }
    if(attempt.task==='reviewDialogue' && actor===t.messenger && context.input && attempt.responseBody){
      const response=JSON.parse(attempt.responseBody);
      const verdict=JSON.parse(response.choices[0].message.content);
      reviewedAcceptances.push({actor,audience:verdict.relay?.audience?.kind??'',required:verdict.relay?.audience?.name,
        accepted:!!verdict.relay,wireFields:Object.keys(verdict),draft:data.draft.text,issue:verdict.issue,excerpt:verdict.excerpt?.text,
        grounded:verdict.grounded,playerAgency:verdict.playerAgency,citationsAccurate:verdict.citationsAccurate});
    }
  });
  const seed=createCustomScenario(name,'live-'+name,t.story);
  let world:WorldState;
  for(let attempt=1;;attempt++) {
    try {world=await prepareOpening(seed,provider);break;}
    catch(error){
      writeFileSync(join(output,name+'-opening.json'),JSON.stringify({model:config.model,maxTokens:config.maxTokens,calls,errors},null,2));
      if(!(error instanceof ProviderFailure)||attempt>=3)throw error;
    }
  }
  const [origin,destination]=world.locations;
  const person=(name:string)=>world.characters.find(c=>c.name===name)!.id;
  const messenger=person(t.messenger), recipient=person(t.recipient), listener=t.listener ? person(t.listener) : undefined;
  const lead=world.characters.find(c=>c.kind==='player')!.id;
  const opening=projectWorld(world);
  const start=world.history.length;
  const turns:{input:string;startTime:number;endTime:number;narrative:string;view:ReturnType<typeof projectWorld>}[]=[];
  let askedAt=Infinity;
  const checks:Record<string,boolean>={};
  function evidence() {
    const history=world.history.slice(start);
    const moves=history.filter(e=>e.changes.some(c=>c.op==='move' && c.actor===messenger && c.to===destination.id));
    const deliveries=history.filter(e=>e.source==='commitment-delivery' && e.locationId===destination.id && e.utterance?.speakerId===messenger
      && e.changes.some(c=>c.op==='advanceCommitment' && c.status==='delivered')
      && e.utterance.listenerIds.includes(recipient) && (!listener || e.utterance.listenerIds.includes(listener)) && !e.utterance.listenerIds.includes(lead)
      && t.answerContent.every(rx=>rx.test(e.text)));
    const delivery=deliveries.at(0);
    const linkedReactions=delivery ? history.slice(history.indexOf(delivery)+1).filter(e=>e.reactsToDeliveryId===delivery.id) : [];
    const heardReactions=linkedReactions.filter(e=>
      e.time<askedAt && e.locationId===destination.id && e.source==='npc-action' &&
      ((e.npcAction?.trigger==='ambient' && [recipient,listener].includes(e.npcAction.actorId))
        || (e.dialogueSource==='provider' && !!e.speakerId && [recipient,listener].includes(e.speakerId)))
      && (e.kind==='npc' || (e.kind==='world' && e.perception!=='private')) && t.responseContent.test(e.text));
    function footprint(e:(typeof history)[number]){
      return {id:e.id,time:e.time,text:e.text,speaker:e.speaker,room:e.locationId,reactsToDeliveryId:e.reactsToDeliveryId,
        listeners:e.utterance?.listenerIds.map(id=>world.characters.find(c=>c.id===id)?.name??id)};
    }
    return {moves:moves.map(e=>({time:e.time,to:destination.id})),
      commitments:world.commitments.map(({id,status,createdAt,nextAt,audience,message,requestEventId,replyEventId})=>
        ({id,status,createdAt,nextAt,audience,message,requestEventId,replyEventId})),
      deliveries:deliveries.map(footprint), reactions:heardReactions.map(footprint),
      reactionOutcomes:linkedReactions.map(e=>({time:e.time,kind:e.npcAction?.kind,failure:e.npcFailure,verdict:e.npcReview,
        ...(e.perception!=='private' && !e.npcFailure && e.kind!=='system' ? {text:e.text} : {})}))};
  }
  function save() {
    writeFileSync(join(output,name+'.json'),JSON.stringify({model:config.model,maxTokens:config.maxTokens,opening,turns,checks,verification:evidence(),suppliedReceipts,reviewedAcceptances,calls,errors,reviewRequests},null,2));
  }
  async function play(input:string){
    for(let n=0;;n++) {
      try {
        const {world:next,turn}=await runTurn(reload(world),input,provider);
        world=reload(next);
        const {startTime,endTime,narrative}=turn;
        turns.push({input,startTime,endTime,narrative,view:projectWorld(world)});
        save();
        console.log(name,endTime,input,narrative.slice(0,140));
        return turn;
      }catch(e){if(!(e instanceof ProviderFailure)||n>=2)throw e;}
    }
  }

  await play(t.request);
  const accepted=world.commitments.find(c=>c.actorId===messenger && c.destinationId===destination.id &&
    (listener ? c.audience.kind==='room' : c.audience.kind==='person' && c.audience.id===recipient));
  checks.persistedAcceptance=!!accepted && world.history.some(e=>e.id===accepted.requestEventId) && world.history.some(e=>e.id===accepted.replyEventId);
  checks.requiredRecipient=accepted?.audience.id===recipient;
  if(!accepted) {
    save();
    throw new Error('NPC 没有形成待执行承诺，见首回合回复');
  }
  // Remain in the origin while the messenger travels, delivers and the listeners decide how to react.
  for(let i=0;i<6;++i){
    const e=evidence();
    if(e.deliveries.length && e.reactions.length)break;
    await play('我在这里等待五分钟');
  }
  checks.playerStayed=turns.every(r=>r.view.location.id===origin.id);
  const remote=evidence();
  checks.autonomousTravel=remote.moves.length>0;
  checks.heardInPerson=remote.deliveries.length===1;
  checks.playerDidNotHearRemoteLine=remote.deliveries.length===1 && turns.every(r=>!r.narrative.includes(remote.deliveries[0].text));
  checks.committedDelivery=world.commitments.find(c=>c.id===accepted.id)?.status==='delivered';
  checks.spontaneousResponse=remote.reactions.length>0;
  await play('我去'+t.destination);
  // Follow normal public exits if the actor walked back while we travelled.
  if(!projectWorld(world).present.some(p=>p.id===recipient) && world.locations.length===2)await play('我回'+origin.name);
  checks.playerReachedRecipient=projectWorld(world).present.some(p=>p.id===recipient);
  askedAt=world.time;
  const inquiry=await play(t.followUp);
  const answer=inquiry.observations.filter(o=>o.kind==='dialogue' && o.speaker===t.recipient).map(o=>o.text).join(' ');
  checks.recipientCanReport=t.answerContent.every(rx=>rx.test(answer)) && answer.includes(t.messenger);
  checks.reportUsedDeliveryReceipt=suppliedReceipts.some(receipt=>receipt.task==='dialogue' && receipt.actor===t.recipient && receipt.time>=askedAt && receipt.source===t.messenger);
  save();
  assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
}
const results=await Promise.allSettled(names.map(verify));
for(const [index,r] of results.entries()) if(r.status==='rejected'){console.error(names[index],String(r.reason));process.exitCode=1;}
