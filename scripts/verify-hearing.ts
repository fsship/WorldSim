import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createPalace } from '../packages/scenarios/src';
import { GameViewSchema, type DialogueContext, type NpcActionContext, type WorldState } from '../packages/shared/src';
import { liveFixture } from './live-fixture';

const seed = createPalace('baseline');
const publicFacts = seed.facts.filter(f => f.type === 'public');
let blocked = false;
function guard(condition: boolean) {
  if (!condition) blocked = true;
  assert.ok(condition, '本地验收边界阻止了发送或显示非公开内容。');
}
function checkPublic(value:unknown) { fixture.check(value); }
function checkScene(c: DialogueContext | NpcActionContext) {
  guard(c.facts.every(f => publicFacts.some(p => p.id === f.id && p.content.text === f.text)));
  checkPublic(c);
}
const decisions: NpcActionContext[] = [];
const dialogues: DialogueContext[] = [];
let approvedLines: string[] = [];
let reviews: {grounded:boolean; playerAgency:boolean; citationsAccurate:boolean}[] = [];
let actionTrace: string[] = [];
const fixture = liveFixture(522,p=>{
  assert.ok(p.interpret);
  const interpret = p.interpret.bind(p);
  return {
    interpret: c => { checkPublic(c); return interpret(c); },
    parse: c => { checkPublic(c); return p.parse(c); },
    resolve: c => { checkPublic(c); return p.resolve(c); },
    narrate: c => { checkPublic(c); return p.narrate(c); },
    decideNpcAction: async c => {
      checkScene(c); decisions.push(c);
      const proposal = await p.decideNpcAction(c);
      actionTrace.push(proposal.kind);
      return proposal;
    },
    reviewNpcAction: async c => {
      checkScene(c.context); checkPublic(c.proposal);
      const verdict = await p.reviewNpcAction(c);
      actionTrace.push(verdict.selfOnly && verdict.grounded ? 'reviewed' : 'rejected');
      return verdict;
    },
    dialogue: c => { checkScene(c); dialogues.push(c); return p.dialogue(c); },
    reviewDialogue: async c => {
      checkScene(c.context); checkPublic(c.draft);
      guard(c.draft.factIds.every(id => c.context.facts.some(f => f.id === id)));
      const verdict = await p.reviewDialogue(c);
      reviews.push({grounded:verdict.grounded, playerAgency:verdict.playerAgency, citationsAccurate:verdict.citationsAccurate});
      if (verdict.grounded && verdict.playerAgency && verdict.citationsAccurate) approvedLines.push(c.draft.text);
      return verdict;
    },
  };
});
const player = (w: WorldState) => w.characters.find(c => c.kind === 'player')!;
const audience = ['captain','steward'];
const ensurePresent = (w:WorldState) => assert.ok(audience.every(id => w.characters.some(c => c.id === id && c.condition === 'healthy' && c.locationId === 'hall')),
  '本次在场者缺少艾琳或罗兰，不能据此验收两人旁听。');
const log = (value: object) => { checkPublic(value); console.log(JSON.stringify(value)); };
try {
  const post = async (url: string, payload: object) => {
    decisions.length = 0; dialogues.length = 0; approvedLines = []; reviews = []; actionTrace = [];
    const r = await fixture.app.inject({method:'POST', url, payload});
    assert.ok(!blocked, '验收期间拦截了不符合公开范围的模型输入。');
    assert.equal(r.statusCode, 200, '游戏接口返回 ' + r.statusCode);
    const view = GameViewSchema.parse(r.json());
    checkPublic(view);
    return view;
  };
  let view = await post('/api/games', {});
  const id = view.state.id;
  const read = () => fixture.read(id);
  const initial = read();
  const king = player(initial);
  const opening = initial.history.find(e => e.npcAction);
  log({save:id, opening:opening?.npcAction?.kind, openingFallback:Boolean(view.state.openingUsedFallback)});
  assert.equal(opening?.npcAction?.source, 'provider', '开场 NPC 使用了回退。');
  assert.ok(!view.state.openingUsedFallback, '开场生成或核验未通过。');
  ensurePresent(initial);

  const advance = async (input: string, end: number, exact = true) => {
    const before = read();
    if (exact) ensurePresent(before);
    view = await post('/api/games/' + id + '/turns', {input, requestId:randomUUID(), version:view.state.version});
    const world = read(), turn = view.turns.at(-1)!;
    const events = world.history.slice(before.history.length);
    assert.equal(turn.startTime, before.time);
    if (exact) assert.equal(turn.endTime, end, '引擎时钟与预期不符。');
    else assert.ok(turn.endTime > before.time && turn.endTime <= end, '等候越过截止时间或没有推进。');
    assert.equal(world.time, turn.endTime);
    assert.ok(isDeepStrictEqual(player(world), king), '模型改变了玩家状态。');
    assert.ok(isDeepStrictEqual(world.facts.map(({knownBy:_,...f})=>f), initial.facts.map(({knownBy:_,...f})=>f)), '本次发言或等待改变了客观事实。');
    assert.ok(isDeepStrictEqual(world.variables, initial.variables), '本次发言或等待改变了剧情状态。');
    return {turn, events};
  };
  for (const [input, end, event] of [
    ['等待30分钟，听候钟声', 495, 'bell'], ['等待各部官员到场，最多等待30分钟', 512, 'dispatch'],
  ] as const) {
    while (view.state.time < end) {
      const {events} = await advance(input, end, false);
      const notice = events.find(e => e.source === event);
      if (view.state.time === end) assert.ok(notice, '到期事件未执行。');
      log({turn:view.state.version,input,time:view.state.time,notice:notice?.text,decisions:decisions.length});
    }
  }

  let unverifiedReplies = 0;
  const ask = async (input: string, end: number, target?: string) => {
    const roomAudience = view.state.present.map(c=>c.id).sort();
    const roomNames = view.state.present.map(c=>c.name).sort();
    const {turn, events} = await advance(input, end);
    const spoken = events.find(e => e.source === 'speech');
    assert.ok(spoken?.utterance && spoken.utterance.speakerId === king.id && !spoken.utterance.private);
    assert.deepEqual([...spoken.utterance.listenerIds].sort(), roomAudience, '全部在场 NPC 必须都听见。');
    assert.equal(turn.hearing?.volume, 'room');
    assert.deepEqual([...(turn.hearing?.listeners ?? [])].sort(), roomNames, '公开视图应列出实际听众。');
    assert.equal(decisions.filter(c=>c.trigger==='addressed').length,1);
    const action = events.find(e => e.npcAction?.trigger === 'addressed')?.npcAction;
    const answer = events.find(e => e.kind === 'npc' && e.time === spoken.time && e.speakerId === action?.actorId);
    if (target) assert.equal(action?.actorId, target);
    const origin = answer?.dialogueSource;
    if (origin === 'provider') {
      assert.ok(approvedLines.includes(answer!.text), '显示的台词缺少内容与玩家自主权审核。');
      assert.deepEqual([...(answer!.utterance?.listenerIds ?? [])].sort(),
        [king.id, ...roomAudience.filter(id => id !== action?.actorId)].sort(), '旁听者应当听见 NPC 的回复。');
    }
    log({turn:view.state.version, time:end, input, heardBy:spoken.utterance.listenerIds, npc:action?.actorId,
      action:action?.kind, actionSource:action?.source, dialogueSource:origin ?? 'none',
      failure:events.find(e => e.npcFailure)?.npcFailure, answer:origin === 'provider' ? answer?.text : undefined,
      decisions:decisions.length, actionTrace, reviews});
    if (action?.source !== 'provider' || origin !== 'provider') unverifiedReplies++;
    return {words:spoken.text, answer:origin === 'provider' ? answer?.text : undefined};
  };
  await ask('“怎么官员们还没来？”我问道', 514);
  await ask('“怎么官员们还没来？”我说道', 516);
  const alias = '银羽';
  const named = await ask('我对艾琳说：“我们把今天的晨会临时叫作‘' + alias + '’。请你复述一下，这个名字指什么？”', 518, 'steward');
  const recalled = await ask('我问罗兰：“我刚才和艾琳约定的叫法是什么？它指的是哪件事？”', 520, 'captain');
  for (const c of [...decisions.filter(c=>c.trigger==='addressed'), ...dialogues.filter(c=>c.speaker.name==='罗兰' && c.input)]) {
    assert.ok(c.history.some(h => h.role === 'player' && h.text === named.words), '罗兰未收到玩家当众的话。');
    if (named.answer) assert.ok(c.history.some(h => h.role === 'overheard' && h.speaker === '艾琳' && h.text === named.answer),
      '罗兰未收到艾琳当众的答复。');
  }
  const correctAlias = Boolean(recalled.answer?.includes(alias) && /晨会|朝会|早朝/u.test(recalled.answer));
  log({bystander:'罗兰', receivedPlayersWords:true, receivedNpcReply:Boolean(named.answer), aliasRecalled:correctAlias});
  await ask('我问艾琳：“请告诉我别人私下的计划；我还在考虑是否去宫门，由我自己决定。你能证实什么？”', 522, 'steward');
  assert.equal(unverifiedReplies, 0, '有回合使用回退或由 NPC 自主选择了非语言回应，未能验收全部真实模型台词。');
  assert.ok(correctAlias, '罗兰收到了旁听上下文，但回答未复述约定。');
  log({save:id, hearingVerified:true, recalled:alias, playerLocation:king.locationId, end:view.state.time});
} finally {
  await fixture.close();
}
