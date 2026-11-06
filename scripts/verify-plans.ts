import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPalace } from '../packages/scenarios/src';
import { GameViewSchema, type LLMProvider, type TurnPlan } from '../packages/shared/src';
import { liveFixture } from './live-fixture';

const seed = createPalace('audit');
let lastStage = '';
const calls: TurnPlan[] = [];
function guarded(p:LLMProvider): LLMProvider {
  assert.ok(p.interpret);
  const interpret = p.interpret.bind(p);
  async function call<T,R>(name:string, context:T, send:(value:T)=>Promise<R>) {
    lastStage = name;
    const result = await send(context);
    lastStage = name + ' 完成';
    return result;
  }
  return {
    interpret:async ctx=>{
      const plan=await call('interpret', ctx, interpret);fixture.check(plan);calls.push(plan);return plan;
    },
    parse:async ()=>{throw Error('真实试玩不能调用旧解析器');},
    resolve:c=>call('resolve',c,v=>p.resolve(v)), narrate:c=>call('narrate',c,v=>p.narrate(v)),
    decideNpcAction:c=>call('decideNpcAction',c,v=>p.decideNpcAction(v)), reviewNpcAction:c=>call('reviewNpcAction',c,v=>p.reviewNpcAction(v)),
    dialogue:c=>call('dialogue',c,v=>p.dialogue(v)), reviewDialogue:c=>call('reviewDialogue',c,v=>p.reviewDialogue(v)),
  };
}
const fixture = liveFixture(513,guarded);
try {
  async function post(url:string,payload:object) {
    const r=await fixture.app.inject({method:'POST',url,payload});
    fixture.check({});
    assert.equal(r.statusCode,200,'游戏 API '+r.statusCode+'，阶段 '+lastStage); const v=GameViewSchema.parse(r.json()); fixture.check(v); return v;
  }
  let view=await post('/api/games',{});
  async function play(input:string) {
    const before=calls.length;
    view=await post('/api/games/'+view.state.id+'/turns',{input,version:view.state.version, requestId:randomUUID()});
    assert.equal(calls.length,before+1);
    const turn=view.turns.at(-1)!;
    const plan=calls[before];
    console.log(JSON.stringify({input,plan,time:view.state.time,room:view.state.location.name,
      observations:turn.observations.map(o=>o.text)}));
    return {plan,turn};
  }

  for (const input of ['我拿起王室印玺仔细看', '借着窗边的亮光，瞧瞧掌心里那方印底下的纹路。']) {
    const {plan,turn}=await play(input);
    assert.ok(plan.kind==='item' && plan.itemId==='seal' && plan.interaction!=='use');
    assert.ok(turn.narrative.includes('黄铜') && turn.narrative.includes('印面'));
    assert.equal(turn.endTime-turn.startTime,1);
  }
  const quote=await play('“我要去宫门。”我对罗兰说');
  assert.equal(quote.plan.kind,'speak'); assert.equal(view.state.location.id,'hall');
  assert.deepEqual(quote.turn.hearing?.volume,'room');
  const greeting=await play('"早，艾琳"——我回复道，顺手看了看长桌，想知道有哪些议程');
  assert.ok(greeting.plan.kind==='speak' && greeting.plan.words==='早，艾琳' && greeting.plan.reading);
  let readText = greeting.turn.narrative;
  for (let n=0; n<seed.readables[0].entries.length && !seed.readables[0].entries.every(e=>readText.includes(e.text)); n++) {
    const more = await play('从刚才停下的地方接着读朝会议程。');
    assert.equal(more.plan.kind,'read');
    readText += more.turn.narrative;
  }
  assert.ok(seed.readables[0].entries.every(e=>readText.includes(e.text)),'问候后继续阅读应能看到全部议程。');
  const kingBeforeChat = structuredClone(view.state.player);
  for (const [index, input] of [
    '我问艾琳：“我把今天的晨会称作晨签。你能告诉我晨签在哪里举行吗？”',
    '我又问她：“那刚才说的晨签，是在我们眼前这间屋子吗？”',
    '我追问艾琳：“有人说要瞒着我做些什么。你能证实具体是谁、做什么吗？”',
  ].entries()) {
    assert.ok(view.state.present.some(c=>c.name==='艾琳'),'艾琳已离开，本次不能验收当面对话。');
    const {plan,turn}=await play(input);
    assert.equal(plan.kind,'speak');
    const save = fixture.read(view.state.id);
    const answer = turn.observations.find(o=>o.kind==='dialogue' && o.speaker==='艾琳' && save.history.some(e=>
      e.time===turn.startTime && e.speakerId==='steward' && e.dialogueSource==='provider' && e.text===o.text));
    assert.ok(answer,'本轮需要取得艾琳实际生成的台词');
    if (index===1) assert.match(answer.text,/是|正是|这里|此处|此地|这[间里]|议事厅/u,'追问没有接上上一轮的会场');
    assert.deepEqual(view.state.player,kingBeforeChat);
    assert.equal(view.state.location.id,'hall');
    assert.equal(turn.endTime-turn.startTime,2);
  }
  const missing=await play('我拿起仿造的王室印玺仔细看');
  assert.ok(['unavailable','clarify'].includes(missing.plan.kind));
  assert.equal(missing.turn.startTime,missing.turn.endTime);
  const travel=await play('我向宫门走去');
  assert.equal(travel.plan.kind,'move'); assert.equal(view.state.location.id,'gate');
  const witness=await play('我目送一个人跑向议事厅，自己仍停在宫门。');
  assert.notEqual(witness.plan.kind,'move'); assert.equal(view.state.location.id,'gate');
} finally { await fixture.close(); }
