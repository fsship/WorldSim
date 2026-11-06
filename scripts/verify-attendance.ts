import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPalace } from '../packages/scenarios/src';
import { GameViewSchema, type LLMProvider } from '../packages/shared/src';
import { liveFixture } from './live-fixture';

const verifyRetry = process.argv.slice(2).includes('--retry');
const seed = createPalace('attendance-baseline');
let interruptQuestionReview = false;
let injectedFailures = 0;
let dialogueCalls = 0;
let reviewCalls = 0;
let plans: string[] = [];
let actions: string[] = [];
let approved: string[] = [];
let reviews: {speaker:string; grounded:boolean; playerAgency:boolean; citationsAccurate:boolean; facts:number; notices:number}[] = [];
function safeProvider(p:LLMProvider): LLMProvider {
  assert.ok(p.interpret);
  const interpret = p.interpret.bind(p);
  return {
    parse:async () => { throw Error('真实模型试玩不能回到离线解析。'); },
    interpret:async c => {
      const plan = await interpret(c);
      plans.push(plan.kind);
      return plan;
    },
    resolve:c => p.resolve(c),
    narrate:c => p.narrate(c),
    decideNpcAction:async c => {
      const decision = await p.decideNpcAction(c);
      actions.push(c.npc.name + '/' + decision.kind);
      return decision;
    },
    reviewNpcAction:c => p.reviewNpcAction(c),
    dialogue:c => {
      dialogueCalls++;
      return p.dialogue(c);
    },
    reviewDialogue:async c => {
      reviewCalls++;
      if (interruptQuestionReview && c.context.speaker.name === '艾琳' && c.context.input === '官员们怎么还没来？') {
        injectedFailures++;
        throw Error('测试注入：本次提问的审核服务暂时中断');
      }
      const verdict = await p.reviewDialogue(c);
      const {grounded, playerAgency, citationsAccurate} = verdict;
      reviews.push({speaker:c.context.speaker.name, grounded, playerAgency, citationsAccurate,
        facts:c.context.facts.length, notices:c.context.recentNotices?.length ?? 0});
      if (grounded && playerAgency && citationsAccurate) approved.push(c.draft.text);
      return verdict;
    },
  };
}

const fixture = liveFixture(507,safeProvider);
try {
  async function post(url:string, payload:object) {
    plans = []; actions = []; approved = []; reviews = [];
    const reply = await fixture.app.inject({method:'POST', url, payload});
    fixture.check({});
    assert.equal(reply.statusCode, 200, '游戏接口返回 ' + reply.statusCode + (reply.statusCode === 200 ? '' :
      ' ' + reply.json().error + ' ' + JSON.stringify(reviews)));
    const view = GameViewSchema.parse(reply.json());
    fixture.check(view);
    return view;
  }
  let view = await post('/api/games', {});
  const now = () => view.state.time;
  assert.equal(now(), 480);
  const initialKing = structuredClone(view.state.player);
  const bell = seed.queue.find(e => e.id === 'bell')!;
  async function play(input:string, expectedTime:number, expectedPlan:string, allowEarly = false) {
    const before = view.state.time;
    view = await post('/api/games/' + view.state.id + '/turns',
      {input, version:view.state.version, requestId:randomUUID()});
    const turn = view.turns.at(-1)!;
    console.log(JSON.stringify({input, time:view.state.time, actions, reviews,
      observations:turn.observations.map(o => o.text), hearing:turn.hearing}));
    assert.deepEqual(plans, [expectedPlan], '该回合没有取得指定的真实语义计划');
    assert.equal(turn.startTime, before);
    if (allowEarly) assert.ok(turn.endTime > before && turn.endTime <= expectedTime);
    else assert.equal(turn.endTime,expectedTime);
    assert.equal(view.state.time,turn.endTime);
    assert.equal(view.state.location.id, 'hall');
    assert.deepEqual(view.state.player, initialKing);
    return turn;
  }
  const reading = await play('我看了看晨会议程，想知道都有些啥', 483, 'read');
  const agenda = seed.readables.find(d => d.id === 'morning-agenda')!;
  assert.equal(agenda.entries.length, 3);
  for (const entry of agenda.entries) {
    assert.ok(reading.observations.some(o => o.kind === 'world' && o.text.includes(entry.title) && o.text.includes(entry.text)),
      '纪事应逐项展示当天议程的标题与实际正文');
  }
  while (now() < 495) {
    const input = now() === 483 ? '等待官员到场' : '留在此处等到今天08:15。';
    const waiting = await play(input,495,'wait',true);
    if (now() === 495)
      assert.ok(waiting.observations.some(o => o.text === bell.text),'应当听到 08:15 的钟声');
  }
  // This is the time-controlled hearing fixture. Unqualified “继续等待” now
  // resumes the previous goal and deadline and is covered by the world-clock tests.
  await play('继续等五分钟。', 500, 'wait');
  await play('继续等五分钟。', 505, 'wait');
  const present = view.state.present.map(c => c.name).sort();
  assert.ok(present.includes('艾琳'), '艾琳离开了议事厅，本次现场无法验收她的回答');
  interruptQuestionReview = verifyRetry;
  const reply = await play('“官员们怎么还没来？”我说道', 507, 'speak');
  interruptQuestionReview = false;
  assert.equal(reply.hearing?.volume, 'room');
  assert.deepEqual([...(reply.hearing?.listeners ?? [])].sort(), present, '公开问话应被开口时同处议事厅的人听到');
  console.log(JSON.stringify({presentAtQuestion:present,
    matchedScreenshotAudience:present.length === 2 && present.includes('罗兰')}));
  if (verifyRetry) {
    assert.ok(injectedFailures >= 1, '审核故障必须实际出现在提问期间');
    assert.equal(reply.replyRetry?.speaker, '艾琳');
    assert.equal(reply.observations[reply.replyRetry!.observation].kind, 'system');
    const url = '/api/games/' + view.state.id + '/dialogue/retry';
    const command = {version:view.state.version};
    const countsBefore = {dialogueCalls, reviewCalls};
    const repaired = await post(url, command);
    assert.deepEqual(plans, [], '补答不能重新解析玩家行动');
    assert.deepEqual(actions, [], '补答不能重新执行 NPC 行动');
    assert.ok(dialogueCalls > countsBefore.dialogueCalls && reviewCalls > countsBefore.reviewCalls);
    assert.deepEqual(repaired.state, view.state, '补答不能改变时钟、位置或当前公开世界');
    assert.equal(repaired.turns.length, view.turns.length);
    assert.deepEqual(repaired.turns.slice(0,-1), view.turns.slice(0,-1));
    const fixed = repaired.turns.at(-1)!;
    assert.equal(fixed.replyRetry, undefined);
    assert.equal(fixed.version, reply.version);
    assert.equal(fixed.startTime, reply.startTime);
    assert.equal(fixed.endTime, reply.endTime);
    assert.equal(fixed.input, reply.input);
    assert.deepEqual(fixed.hearing, reply.hearing);
    assert.equal(fixed.observations.length, reply.observations.length);
    const index = reply.replyRetry!.observation;
    assert.deepEqual(fixed.observations.filter((_, i) => i !== index), reply.observations.filter((_, i) => i !== index));
    const line = fixed.observations[index];
    assert.ok(line.kind === 'dialogue' && line.speaker === '艾琳' && approved.includes(line.text),
      '原失败位置应当显示本次真实模型生成并审核通过的艾琳台词');
    const countsAfter = {dialogueCalls, reviewCalls};
    assert.deepEqual(await post(url, command), repaired, '重复补答应返回相同存档');
    assert.deepEqual({dialogueCalls, reviewCalls}, countsAfter, '重复补答不应再次生成或审核');
    assert.deepEqual(plans, []);
    assert.deepEqual(actions, []);
    console.log(JSON.stringify({recovered:line.text, time:fixed.endTime, version:fixed.version,
      listeners:fixed.hearing?.listeners, duplicateGenerated:false}));
  } else {
    const line = reply.observations.find(o => o.kind === 'dialogue' && o.speaker === '艾琳');
    assert.ok(line && approved.includes(line.text), '没有取得艾琳通过审核的真实回答，详见上述动作与审核标记');
  }
} finally {
  await fixture.close();
}
