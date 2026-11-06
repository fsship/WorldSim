import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GameViewSchema } from '../packages/shared/src';
import { liveFixture } from './live-fixture';

const fixture = liveFixture(490);
async function post(path:string, payload:object) {
  const res = await fixture.app.inject({method:'POST',url:'/api'+path,payload});
  fixture.check({});
  assert.equal(res.statusCode,200,'游戏 HTTP '+res.statusCode);
  const view = GameViewSchema.parse(res.json());
  fixture.check(view);
  return view;
}

try {
  let view = await post('/games', {});
  const id = view.state.id;
  const read = () => fixture.read(id);
  const initial = read(), player = initial.characters.find(c => c.kind === 'player')!;
  const protectedText = initial.facts.filter(f => !f.knownBy.includes(player.id)).map(f => f.content.text);
  const opening = initial.history.find(e => e.npcAction?.trigger === 'opening');
  assert.ok(opening && opening.npcAction?.source === 'provider' && !view.state.openingUsedFallback, '开场未取得有效的真实行动');
  console.log(JSON.stringify({save:id, opening:opening.npcAction.kind, visible:view.state.opening}));
  let physical = 0;
  const attempt = async (input:string, actorId?:string) => {
    const before=read();
    view=await post('/games/'+id+'/turns',{input,version:view.state.version,requestId:randomUUID()});
    const world=read(), last=view.turns.at(-1)!;
    const events=world.history.slice(before.history.length);
    const actions=events.filter(e => e.npcAction?.trigger === (actorId ? 'addressed' : 'ambient') && !e.npcAction.worldPulse);
    assert.ok(!protectedText.some(text => JSON.stringify(view).includes(text)), '公开状态泄露私有事实');
    assert.equal(actions.length,1,'本次直接交互缺少单一的目标 NPC 决定');
    const action=actions[0], stamp=action.npcAction!;
    assert.equal(stamp.source,'provider','本次行动未取得模型有效决定');
    if(actorId) assert.equal(stamp.actorId,actorId);
    assert.ok(isDeepStrictEqual(world.characters.find(c=>c.id===player.id),player),'玩家状态被额外改变');
    const actor=world.characters.find(c=>c.id===stamp.actorId)!;
    const was=before.characters.find(c=>c.id===stamp.actorId)!;
    if (stamp.kind==='move') {
      assert.ok(before.locations.find(l=>l.id===was.locationId)?.exits.includes(actor.locationId));
      assert.notEqual(was.locationId,actor.locationId);
      assert.ok(action.changes.some(c=>c.op==='move' && c.actor===actor.id && c.to===actor.locationId));
    } else assert.ok(!action.changes.some(c=>c.op==='move' && c.actor===actor.id));
    if (stamp.kind==='carryOutOrder') assert.equal(world.variables.guardSecured,true);
    else assert.equal(world.variables.guardSecured,before.variables.guardSecured);
    if (['move','inspect','gesture','act','carryOutOrder'].includes(stamp.kind)) physical++;
    assert.equal(world.time-before.time,actorId ? 2 : 0,'NPC 决定额外改变了时钟');
    console.log(JSON.stringify({turn:view.state.version,input,actor:actor.name,choice:stamp.kind,
      before:was.locationId,after:actor.locationId,king:player.locationId,elapsed:world.time-before.time,
      observations:last.observations.map(o=>o.text)}));
  };

  const here=(id:string)=>view.state.present.some(c=>c.id===id);
  assert.ok(here('steward'), '艾琳不在场，本次无法验收向她提出的动作请求。');
  await attempt('我对艾琳说：“请用一个你自己选的小动作，示意我看看右侧的高窗，先不用说话。”','steward');
  assert.ok(here('captain'), '罗兰不在场，本次无法验收他对命令的决定。');
  await attempt('命令卫队长加强宫门守备','captain');
  assert.ok(here('steward'), '艾琳不在场，本次无法验收向她提出的动作请求。');
  await attempt('我告诉艾琳：“我希望你亲自前往王宫花园等候。我自己留在议事厅，你自行决定。”','steward');
  if (view.state.present.length) await attempt('环顾议事厅');
  assert.ok(physical>0, '本轮模型仅选择谈话或不动，尚未验证任何实际 NPC 动作');
  console.log(JSON.stringify({save:id,time:view.state.time,version:view.state.version,physical}));
} finally { await fixture.close(); }
