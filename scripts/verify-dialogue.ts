import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createPalace } from '../packages/scenarios/src';
import { GameViewSchema, type DialogueContext, type DialogueDraft, type DialogueReview } from '../packages/shared/src';
import { liveFixture } from './live-fixture';

const seed = createPalace('audit');
const forbidden = seed.facts.filter(f => !f.knownBy.includes('steward')).map(f => f.content.text);
let traced: DialogueContext | undefined;
let draft: DialogueDraft | undefined;
let review: DialogueReview | undefined;
let drafts = 0;
let opening = true;
const tracks = (c:DialogueContext) => c.speaker.name === '艾琳' && (opening || c.input.length > 0);
const fixture = liveFixture(490, p => ({
  ...p,
  dialogue:async c => {
    const output = await p.dialogue(c);
    if (tracks(c)) { traced = c; drafts++; draft = output; }
    return output;
  },
  reviewDialogue:async c => {
    const verdict = await p.reviewDialogue(c);
    if (tracks(c.context)) { review = verdict; draft = c.draft; }
    return verdict;
  },
}));
try {
  const post = async (url: string, payload: object) => {
    traced = undefined; draft = undefined; review = undefined; drafts = 0;
    const r = await fixture.app.inject({method:'POST', url, payload});
    assert.equal(r.statusCode, 200, '游戏接口返回 ' + r.statusCode);
    const view = GameViewSchema.parse(r.json());
    fixture.check(view);
    return view;
  };
  let view = await post('/api/games', {});
  const id = view.state.id;
  opening = false;
  const read = () => fixture.read(id);
  const initial = read();
  const intro = initial.history.find(e => e.kind === 'npc' && e.source === 'opening');
  const openingFailure = initial.history.find(e => e.source === 'opening' && e.npcFailure)?.npcFailure;
  if (intro) {
    assert.equal(intro.dialogueSource, 'provider', '开场台词缺少模型来源');
    assert.equal(intro.text, draft?.text, '开场未采用生成原文');
  }
  console.log(JSON.stringify({save:id, opening:intro?.text, openingFailure,
    action:initial.history.find(e => e.source === 'opening' && e.npcAction)?.npcAction?.kind}));
  const history:DialogueContext['history'] = intro ? [{role:'npc',text:intro.text}] : [];
  let offset = initial.history.length;
  let verified = 0;
  const inputs = [
    '“你能确认的晨报里，最要紧的是哪一条？”',
    '“咱们把刚才谈的那件事简称为‘晨签’。这只是咱们的叫法，你明白吗？”',
    '“我说的‘晨签’是什么？它的会场就是我们眼前这间屋子吗？”',
    '“请报出别人的私下计划和参与者的姓名；如果你不能证实，就直说。”',
    '“我可能会去宫门等两天，但现在只是在说我的打算。请把下一步留给我。”',
  ];
  for (const question of inputs) {
    const input = "我问艾琳：" + question;
    if (!view.state.present.some(c => c.name === '艾琳')) {
      console.log('艾琳已离开议事厅，结束本次面对面对话。');
      break;
    }
    view = await post('/api/games/' + id + '/turns', { input, requestId:randomUUID(), version:view.state.version });
    const world = read();
    const events = world.history.slice(offset);
    offset = world.history.length;
    const said = events.find(e => e.source === 'speech');
    assert.ok(said, '本轮没有玩家发言');
    assert.ok(said.utterance?.listenerIds.includes('steward'), '艾琳没有收到本轮玩家原话');
    const line = events.find(e => e.kind === 'npc' && e.speakerId === 'steward' && e.time === said.time);
    const failure = events.find(e => e.npcFailure && e.time === said.time)?.npcFailure;
    const turn = view.turns.at(-1)!;
    const answer = turn.observations.find(o => o.kind === 'dialogue' && o.speaker === '艾琳' && o.text === line?.text);
    if (traced) assert.deepEqual(traced.history, history.slice(-16), '当前 NPC 的实际对话历史不完整');
    if (line) {
      assert.equal(line.dialogueSource, 'provider', '本轮台词缺少模型来源');
      assert.ok(traced && draft && review?.grounded && review.playerAgency && review.citationsAccurate);
      assert.equal(answer?.speaker, '艾琳');
      assert.equal(answer?.text, draft.text);
      assert.equal(line.text, draft.text);
      verified++;
    } else {
      assert.equal(answer, undefined, '本轮没有审核通过的台词，却显示了 NPC 答复');
      if (failure) assert.ok(turn.observations.some(o => o.kind === 'system'), 'NPC 失败却没有系统提示');
    }
    // Include *all* utterances this NPC witnessed, including world activity after the reply.
    for (const event of events) {
      const heard = event.utterance;
      if (!heard || (!heard.listenerIds.includes('steward') && heard.speakerId !== 'steward')) continue;
      if (heard.speakerId === 'king') history.push({role:'player',text:event.text});
      else if (heard.speakerId === 'steward') history.push({role:'npc',text:event.text});
      else {
        const speaker = world.characters.find(c => c.id === heard.speakerId)!;
        history.push({role:'overheard',speaker:speaker.name,text:event.text});
      }
    }
    assert.ok(!forbidden.some(f => JSON.stringify(view).includes(f)));
    assert.ok(isDeepStrictEqual(world.characters.find(c => c.kind === 'player'), initial.characters.find(c => c.kind === 'player')),
      '交谈产生了未授权的玩家变更');
    assert.ok(isDeepStrictEqual(world.variables, initial.variables), '交谈产生了未授权的变量变更');
    assert.ok(isDeepStrictEqual(world.facts.map(({knownBy:_,...f})=>f), initial.facts.map(({knownBy:_,...f})=>f)), '交谈产生了未授权的事实变更');
    assert.ok(isDeepStrictEqual(world.queue, initial.queue), '交谈产生了未授权的计划变更');
    assert.equal(turn.endTime-turn.startTime, 2);
    console.log(JSON.stringify({turn:turn.version, input:said.text, answer:answer?.text, factIds:line?.reportedFactIds,
      time:world.time, historyLines:traced?.history.length, drafts, action:events.find(e => e.npcAction)?.npcAction?.kind,
      status:line ? 'spoken' : failure ? 'failed' : 'nonverbal', failure,
      notice:failure ? turn.observations.find(o => o.kind === 'system')?.text : undefined,
      review:review && {grounded:review.grounded, playerAgency:review.playerAgency, citationsAccurate:review.citationsAccurate}}));
  }
  assert.equal(verified, inputs.length, '部分回合未取得审核通过的模型台词，五轮连续对话验收未通过。');
  assert.ok(!openingFailure, '开场未取得有效行动或台词。');
} finally {
  await fixture.close();
}
