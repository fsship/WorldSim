import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createPalace } from '../packages/scenarios/src';
import { GameViewSchema, groupCountAt, type GameView, type LLMProvider, type WorldState } from '../packages/shared/src';
import { liveFixture } from './live-fixture';

const seed = createPalace('world-pulse-audit');
const bell = seed.queue.find(e => e.id === 'bell')!;
const king = seed.characters.find(c => c.kind === 'player')!;
const distanceMode = process.argv.slice(2).includes('--distance');
const contactMode = process.argv.slice(2).includes('--contact');
assert.ok(!(contactMode && distanceMode),'请选择一项试玩模式。');
interface Decision { at:number; who:string; room:string; offscreen:boolean; chose:string }
let calls = 0;
const decisions:Decision[] = [];
interface RegionDecision { time:number; duties:number; options:number; selected?:string }
const regionalChecks:RegionDecision[] = [];
const approvedReplies:{name:string; text:string; playerHistory:string[]}[] = [];
function trace(real:LLMProvider): LLMProvider {
  assert.ok(real.interpret);
  const interpret = real.interpret.bind(real);
  function task<T,R>(context:T, send:(value:T)=>Promise<R>) {
    calls++;
    return send(context);
  }
  return {
    parse:async () => { throw Error('真实试玩不能走离线解析。'); },
    interpret:c => task(c,interpret),
    resolve:async c => {
      if (!c.regionalDuty) return task(c,ctx=>real.resolve(ctx));
      const {time,duties,options} = c.regionalDuty;
      const traced:RegionDecision = {time,duties:duties.length,options:options.length};
      regionalChecks.push(traced);
      const result = await task(c,ctx=>real.resolve(ctx));
      if (options.some(o=>o.id===result.optionId)) traced.selected = result.optionId;
      return result;
    },
    narrate:c => task(c,ctx => real.narrate(ctx)),
    decideNpcAction:async c => {
      const offscreen = !c.present.some(person => person.name === king.name);
      const decision = await task(c,ctx => real.decideNpcAction(ctx));
      assert.ok(c.currentTime !== undefined);
      decisions.push({at:c.currentTime, who:c.npc.name, room:c.location, offscreen, chose:decision.kind});
      return decision;
    },
    reviewNpcAction:c => task(c,ctx => real.reviewNpcAction(ctx)),
    dialogue:c => task(c,ctx => real.dialogue(ctx)),
    reviewDialogue:async c => {
      const result = await task(c,ctx => real.reviewDialogue(ctx));
      if (contactMode && result.grounded && result.playerAgency && result.citationsAccurate) {
        approvedReplies.push({name:c.context.speaker.name,text:c.draft.text,
          playerHistory:c.context.history.filter(line=>line.role==='player').map(line=>line.text)});
      }
      return result;
    },
  };
}

const fixture = liveFixture(distanceMode ? 530 : contactMode ? 499 : 497,trace);
try {
  async function post(url:string,payload:object):Promise<GameView> {
    const res = await fixture.app.inject({url,method:'POST',payload});
    fixture.check({});
    assert.equal(res.statusCode,200,'游戏 API '+res.statusCode);
    const times = regionalChecks.map(r=>r.time);
    assert.ok(new Set(times).size===times.length && times.every(t=>t % 30===0),'世界时钟在同一时刻重复请求区域决定。');
    assert.ok(regionalChecks.every(r=>r.duties>0 && r.duties<=2 && r.options>0 && r.options<=4),'区域决策超过有界候选。');
    assert.ok(regionalChecks.every(r=>r.selected !== undefined),'一次区域决定未取得有效的真实模型结果。');
    const view = GameViewSchema.parse(res.json());
    fixture.check(view);
    return view;
  }
  let game = await post('/api/games',{});
  const url = '/api/games/'+game.state.id+'/turns';
  const world = () => fixture.read(game.state.id);
  const opportunities = new Set<number>();
  let remoteCommits = 0;
  async function play(input:string) {
    const previous = world();
    const start = decisions.length;
    const command = {input,version:game.state.version,requestId:randomUUID()};
    game = await post(url,command);
    const saved = world();
    const turn = game.turns.at(-1)!;
    const events = saved.history.slice(previous.history.length);
    const traced = decisions.slice(start);
    const committed = events.filter(e => e.npcAction?.source === 'provider');
    const origin = previous.characters.find(c => c.id === king.id)!.locationId;
    const destination = game.state.location.id;
    for (const d of traced) {
      assert.ok(d.at >= previous.time && d.at <= saved.time, 'NPC 决策发生在本回合耗时之外。');
      const focus = d.at === previous.time ? [origin] : d.at < saved.time ? [origin,destination] : [destination];
      const near = saved.locations.filter(room => focus.includes(room.id) || saved.locations.some(from =>
        focus.includes(from.id) && from.exits.includes(room.id))).map(room=>room.name);
      assert.ok(near.includes(d.room), '远处地点触发了逐人决策。');
      if (d.at > previous.time && d.at % 5 === 0) opportunities.add(d.at);
      const actor = saved.characters.find(c => c.name === d.who)!;
      const event = committed.find(e => e.time === d.at && e.npcAction?.worldPulse && e.npcAction.actorId === actor.id && e.npcAction.kind === d.chose);
      if (!d.offscreen || !event) continue;
      remoteCommits++;
      const witnesses = event.utterance?.listenerIds ?? event.npcAction?.witnessIds ?? event.recipients;
      if (!witnesses.includes(king.id)) {
        assert.ok(!turn.observations.some(o => o.text === event.text), '场外动作出现在玩家纪事里。');
        assert.ok(!turn.narrative.includes(event.text), '场外动作泄露到玩家叙事。');
      }
    }
    checkPositions(previous,saved);
    assert.equal(turn.endTime,saved.time);
    const beforeReplay = calls;
    const replay = await post(url,command);
    assert.ok(isDeepStrictEqual(replay,game) && isDeepStrictEqual(world(),saved), '重复行动改变了公开状态或权威存档。');
    assert.equal(calls,beforeReplay,'重放已提交回合时再次调用了模型。');
    console.log(JSON.stringify({input,start:previous.time,end:saved.time,room:game.state.location.name,
      decisions:traced, publicJournal:turn.observations.map(o=>o.text), committed:committed.length, replayGenerated:false}));
    return {previous, saved, events, turn, traced};
  }
  function checkPositions(before:WorldState, after:WorldState) {
    const positions = new Map(before.characters.map(c => [c.id,c.locationId]));
    for (const e of after.history.slice(before.history.length)) {
      for (const change of e.changes) {
        if (change.op === 'move') positions.set(change.actor,change.to);
        if (change.op === 'meet') {
          const member = after.populationGroups.find(g=>g.id===change.group)?.representative;
          assert.ok(member);
          positions.set(member.id,change.locationId);
        }
      }
    }
    assert.ok(after.characters.every(c => c.locationId === positions.get(c.id)), '存档位置与已提交移动不一致。');
  }

  async function testNear() {
    // A witnessed arrival or departure can legitimately hand the turn back
    // early. Resume toward the same deadline after each such decision point.
    for (let attempt=0; game.state.time < 492 && attempt < 3; attempt++) {
      const time = game.state.time;
      await play('我留在议事厅等到今天08:12。');
      assert.equal(game.state.location.id,'hall');
      assert.ok(game.state.time > time && game.state.time <= 492, '继续等候时越过截止时刻或没有推进时钟。');
    }
    assert.equal(game.state.time,492);
    await play('我从议事厅走到宫门。');
    assert.equal(game.state.location.id,'gate');
    assert.equal(game.state.time,497);
    assert.deepEqual([...opportunities].sort((a,b)=>a-b),[485,490,495], '模拟时钟没有逐段调度角色。');
    assert.ok(remoteCommits > 0, '没有取得真实模型在异地作出并持久保存的 NPC 决策。');
    const final = world();
    assert.ok(final.queue.some(e => e.id === bell.id && e.status === 'executed'), '到期的钟声未执行。');
    assert.ok(game.turns.flatMap(t=>t.observations).some(o=>o.text === bell.text), '玩家缺少实际听到的钟声。');
    console.log(JSON.stringify({pulses:[...opportunities],remoteCommits,finalTime:final.time,bellExecuted:true}));
  }
  async function testDistance() {
    const initial = world();
    const groups = ['court-officials','valley-residents'] as const;
    function counts(w:WorldState, groupId:typeof groups[number]) {
      const group = w.populationGroups.find(g=>g.id===groupId)!;
      assert.ok(group,'缺少验收所需的群体 '+groupId);
      assert.equal(group.representative,undefined,'本次出行没有与群体搭话，不应替玩家生成代表。');
      const rows = w.locations.map(l=>[l.id,groupCountAt(group,l.id,w.time)] as const);
      const total = rows.reduce((n,[,count])=>n+count,0);
      assert.equal(total,groupId==='court-officials' ? 18 : 240,'往返后某个群体变多或减少。');
      assert.ok(rows.every(([,count])=>Number.isSafeInteger(count) && count>=0));
      return Object.fromEntries(rows);
    }
    function population(w:WorldState) {
      assert.equal(new Set(w.populationGroups.map(g=>g.id)).size,w.populationGroups.length,'存档的群体 ID 重复。');
      const local = new Map(game.state.location.population?.map(group=>[group.id,group.count]));
      const totals = Object.fromEntries(groups.map(group => [group,counts(w,group)]));
      for (const id of groups) {
        const count = totals[id][game.state.location.id];
        assert.equal(local.get(id) ?? 0,count,'公开视图的群体人数与玩家此处能看到的人数不符。');
        if (count === 0) assert.ok(!local.has(id),'公开视图展示了不在现场的群体。');
      }
      return totals;
    }
    async function go(to:string) {
      const name = initial.locations.find(l=>l.id===to)?.name;
      assert.ok(name,'剧本缺少外出路线。');
      const before = game.state.time;
      const {saved} = await play('我前往'+name+'。');
      assert.equal(game.state.location.id,to);
      assert.equal(saved.time,before+5);
      population(saved);
    }
    const before = population(initial);
    assert.equal(before['court-officials'].archive,18);
    assert.equal(before['court-officials'].hall,0);
    assert.equal(before['valley-residents']['river-village'],240);
    const outward = ['gate','post-road','river-village','river-palace'];
    for (const to of outward) await go(to);
    assert.equal(game.state.time,500);
    const outside = world();
    assert.ok(outside.queue.some(e=>e.id==='bell' && e.status==='executed'),'离开后宫中仍应在 08:15 敲钟。');
    const arrivals = population(outside)['court-officials'].hall;
    assert.ok(arrivals > 0 && arrivals < 18,'到行宫时，已有部分官员按进度集合。');
    while (game.state.time < 510) {
      const at = game.state.time;
      const {saved,traced} = await play('我在行宫休息到今天08:30。');
      assert.equal(game.state.location.id,'river-palace');
      assert.ok(saved.time > at && saved.time <= 510);
      const courtrooms = ['hall','archive','garden','gate'].map(id=>saved.locations.find(l=>l.id===id)!.name);
      assert.ok(traced.every(d=>!courtrooms.includes(d.room)), '行宫等候期间远处王宫官员被逐人唤起。');
    }
    const mid = population(world());
    assert.ok(mid['court-officials'].hall > arrivals,'前往行宫后，宫内集合进度停止。');
    assert.ok(mid['valley-residents']['post-road'] > before['valley-residents']['post-road'],
      '在行宫等候期间，河谷集市的人数未推进。');
    const returnPath = ['river-village','post-road','gate','hall'];
    for (const to of returnPath) await go(to);
    const final = world();
    const settled = population(final);
    assert.equal(final.time,530);
    assert.equal(settled['court-officials'].hall,18);
    assert.equal(settled['court-officials'].archive,0);
    assert.equal(final.characters.length,initial.characters.length,'普通人口被复制为逐个模拟的命名 NPC。');
    const dispatch = final.queue.find(e=>e.id==='dispatch')!;
    assert.equal(dispatch.status,'executed');
    const topics = final.history.filter(e=>e.source==='bell' || e.source==='dispatch').map(e=>[e.source,e.time]);
    assert.deepEqual(topics,[['bell',495],['dispatch',512]],'宫中到期事件应按原时序执行一次。');
    assert.ok(!game.turns.flatMap(t=>t.observations).some(o=>o.text===dispatch.text),'宫中局部通报泄露到远处。');
    assert.ok(decisions.some(d=>d.at>480 && d.at<=490),'在近处行动时没有取得真实的 NPC 决策。');
    for (const request of regionalChecks) {
      const committed = final.history.filter(e=>e.time===request.time && e.npcAction?.regional && e.npcAction.source==='provider');
      assert.equal(committed.length,request.duties,'远处职责的模型选择没有落实到对应人物的客观状态。');
    }
    console.log(JSON.stringify({distanceAudit:true,checkpoints:[{at:initial.time,counts:before},{at:outside.time,
      arrivingInHall:arrivals},{at:510,counts:mid},{at:final.time,counts:settled}],courtEvents:topics,
      individuallyModelled:final.characters.length,regionalDecisions:regionalChecks,duplicates:false}));
  }
  async function testContact() {
    const initial = world();
    for (const location of ['gate','post-road','river-village']) {
      const room = initial.locations.find(l=>l.id===location)!;
      await play('我前往'+room.name+'。');
      assert.equal(game.state.location.id,location);
    }
    // Ask in public; the resident can answer in their own words or decide to leave.
    const room = game.state.location.id, groupId = 'valley-residents';
    const words = ['你们今天有什么活要忙？','刚才说的这份活，在哪里做？'];
    const inputs = ['我问眼前的一位河谷居民：“'+words[0]+'”',
      '我继续问刚才那位河谷居民：“'+words[1]+'”'];
    let contactId:string|undefined;
    for (const [index,input] of inputs.entries()) {
      if (contactId) assert.ok(game.state.present.some(c=>c.id===contactId),'刚才的居民已经离开，本次无法验收面对面追问。');
      const {previous,saved,events,turn} = await play(input);
      const group = saved.populationGroups.find(g=>g.id===groupId)!;
      const id = group.representative?.id;
      assert.ok(id,'本次发言没有让一位实际在场的居民回应。');
      if (contactId) assert.equal(id,contactId,'追问换了角色。');
      contactId = id;
      const member = saved.characters.find(c=>c.id===id)!;
      assert.equal(saved.characters.length,initial.characters.length+1);
      assert.equal(events.flatMap(e=>e.changes).filter(c=>c.op==='meet').length,index===0 ? 1 : 0);
      const anonymous = saved.locations.reduce((n,l)=>n+groupCountAt(group,l.id,saved.time),0);
      assert.equal(anonymous+1,240,'具名居民被重复计入普通人口。');
      const speech = events.find(e=>e.source==='speech' && e.utterance?.speakerId===king.id);
      assert.ok(speech?.utterance);
      assert.equal(speech.text,words[index]);
      const named = new Set(previous.characters.filter(c=>c.kind==='npc' && !c.journey && c.locationId===room &&
        c.condition!=='dead').map(c=>c.id));
      named.add(id);
      assert.deepEqual([...speech.utterance.listenerIds].sort(),[...named].sort(),'玩家发言的具名听众与开口时的现场不符。');
      const crowd = [{name:group.name,count:groupCountAt(group,room,speech.time)}];
      assert.deepEqual(turn.hearing?.groups,crowd,'玩家发言的匿名听众包含异地人，或重复计入了具名居民。');
      const selected = events.find(e=>e.npcAction?.trigger==='addressed')?.npcAction;
      assert.ok(selected?.source==='provider' && selected.actorId===id,'回复者不是本次找的居民。');
      const spoken = events.find(e=>e.dialogueSource==='provider' && e.speakerId===id && e.time===speech.time);
      assert.ok(spoken?.utterance,'本次居民尚未给出通过审核的答复，无法据此验收连续对话。');
      named.delete(id); named.add(king.id);
      assert.deepEqual([...spoken.utterance.listenerIds].sort(),[...named].sort(),'居民答复的具名听众与现场不符。');
      assert.deepEqual(spoken.utterance.groups?.map(({name,count})=>({name,count})),crowd,'居民答复的匿名听众与现场不符。');
      const accepted = approvedReplies.find(r=>r.name===member.name && r.text===spoken.text && (!index || r.playerHistory.includes(words[0])));
      assert.ok(accepted && turn.observations.some(o=>o.kind==='dialogue' && o.text===spoken.text),
        '显示的回复缺少真实审核记录，或追问遗漏了之前听到的问题。');
      if (index) assert.ok(spoken.text.includes('驿道'),'追问尚未确认集市的实际地点。');
      console.log(JSON.stringify({question:speech.text,answer:spoken.text,contact:member.name,at:speech.time,
        anonymousPopulation:anonymous,namedListeners:speech.utterance.listenerIds.length,groupListening:crowd}));
    }
  }
  assert.equal(game.state.time,480);
  if (contactMode) await testContact();
  else if (distanceMode) await testDistance();
  else await testNear();
} finally {
  await fixture.close();
}
