import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '@worldsim/llm';
import { createPalace } from '@worldsim/scenarios';
import { readMovement } from '@worldsim/shared';
import { runTurn } from './index';

const kingRoom = (world: ReturnType<typeof createPalace>) => world.characters.find(c => c.kind === 'player')!.locationId;

describe('玩家移动的原文与目的地', () => {
  it('相同路线可以步行；模型漏掉明确的驾车方式也不能绕过车辆封路或暴露异地消息',async()=>{
    const world = createPalace('vehicle-barrier');
    const summary = '抢修员发现门轴松动，正在宫门内侧检查。';
    world.situations.push({
      id:'gate-repair',eventId:'gate-report',locationId:'gate',summary,
      blockedRoutes:[{from:'gate',to:'hall',mode:'vehicle'}],actions:[],
      startedAt:world.time,updatedAt:world.time,decisions:[],witnesses:[],lastReports:[],
    });
    const provider = Object.assign(new MockLLMProvider(), {interpret:async()=>({kind:'move' as const,destination:'gate'})});
    const blocked = await runTurn(world,'我开车去宫门',provider);
    expect(kingRoom(blocked.world)).toBe('hall');
    expect(blocked.turn.narrative).toContain('无法驾乘通行');
    expect(blocked.turn.narrative).not.toContain(summary);
    const walked = await runTurn(blocked.world,'我步行去宫门',provider);
    expect(kingRoom(walked.world)).toBe('gate');
  });

  it.each([
    '我向宫门走去', '我朝着宫门快步走过去。', '往城门去！', '我快步走向王宫大门', '我动身前往宫门。',
    '我想去一趟宫门', '我到宫门去吧。', '请移步至宫门。', '我朝宫门的方向前进', '我赶赴宫门口', '我往宫门那里跑去',
    '我沿着长廊缓步走向宫门', '我顺着回廊踱到宫门', '我起身，沿石板路朝宫门跑去', '我快步沿着小径往宫门前进',
    '我从大殿朝宫门走去', '我从议事厅沿着长廊走到宫门',
    '我向着宫门走了过去', '我跌跌撞撞地跑到宫门', '我三步并作两步奔向宫门', '我轻盈地迈向宫门',
    '我朝着宫门跌跌撞撞地走过去',
  ])('%s 从议事厅到宫门', async input => {
    const w = createPalace('at-0839');
    w.time = 519;
    for (const e of w.queue) if (e.at < w.time) e.status = 'executed';
    const {world, turn} = await runTurn(w, input, new MockLLMProvider());
    expect(turn.intent.kind).toBe('move');
    expect(turn.resolution.optionId).toBe('travel');
    expect(kingRoom(world)).toBe('gate');
    expect(turn.endTime).toBe(524);
    expect(turn.changes.filter(change => change.op === 'move')).toEqual([{op:'move', actor:'king', to:'gate'}]);
  });

  it.each(['我去宫门看看', '我先去宫门，看看情况', '我走到宫门前，要求卫兵通报国王', '我快步向宫门走去看看动静'])('%s 只兑现第一程并还权', async input => {
    const w = createPalace('one-leg');
    const {world, turn} = await runTurn(w, input, new MockLLMProvider({decideNpcAction:() => ({kind:'stay'})}));
    expect(kingRoom(world)).toBe('gate');
    expect(turn.endTime - turn.startTime).toBe(5);
    expect(turn.observations).toContainEqual({kind:'system', text:'本回合已完成移动。接下来的行动请在新地点继续。',time:485});
    expect(turn.changes.filter(c => c.op !== 'clock')).toEqual([
      {op:'depart',actor:'king',to:'gate',arrivesAt:485}, {op:'move',actor:'king',to:'gate'},
    ]);
    expect(turn.events.filter(e => e.source === 'speech')).toEqual([]);
  });

  it.each([
    ['我前往议事厅', '已经在议事厅'], ['我前往', '请说明你要去哪里'],
    ['我去书房或者花园', '多个目的地'], ['去宫门然后返回议事厅', '一次移动'],
    ['去宫门旁的岗亭', '通往这个地点的出口'], ['我去西楼', '通往这个地点的出口'], ['我从档案室走到宫门', '出发地不一致'],
    ['去宫门，算了还是不去', '一次移动'], ['我去宫门，看看再去花园', '一次移动'],
    ['我去宫门旁的岗亭看看', '通往这个地点的出口'],
  ])('%s 说明原因与可走的出口', async (input, note) => {
    const w = createPalace('movement-reasons');
    const {world, turn} = await runTurn(w, input, new MockLLMProvider({parse:() => ({kind:'move', target:'宫门'})}));
    expect(turn.narrative).toContain(note);
    expect(turn.narrative).toContain('档案室、宫门、王宫花园');
    expect(turn.changes).toEqual([]);
    expect(world.time).toBe(w.time);
  });

  it('原文地点全名优先，重名或不相邻不会改动玩家位置', async () => {
    const w = createPalace('movement-boundaries');
    for (const room of w.locations.filter(l => ['gate','garden'].includes(l.id))) room.aliases.push('小门');
    const ambiguous = await runTurn(w, '我朝小门走去', new MockLLMProvider());
    expect(ambiguous.turn.narrative).toContain('多个地点');
    expect(ambiguous.turn.changes).toEqual([]);
    const moved = await runTurn(w, '我走进书房', new MockLLMProvider());
    const remote = await runTurn(moved.world, '我朝城门走去', new MockLLMProvider());
    expect(remote.turn.narrative).toContain('从档案室不能直接到宫门');
    expect(remote.turn.narrative).toContain('议事厅、王宫花园');
    expect(remote.turn.changes).toEqual([]);
    expect(kingRoom(remote.world)).toBe('archive');
  });

  it.each([
    '我看向宫门', '我朝着宫门望去', '我指向宫门', '我往宫门方向张望', '我向宫门口的侍卫挥手',
    '我不朝宫门走去', '如果我向宫门走去会怎样', '艾琳向宫门走去',
    '我朝宫门走去吗？', '我想象自己向宫门走去', '我听说他去了宫门',
    '我看着艾琳沿着长廊走向宫门', '我不沿着长廊走向宫门', '我沿着长廊看着艾琳走向宫门', '我沿着长廊走向宫门？',
    '我目睹一名访客跑向宫门', '我梦见自己走到宫门', '我催他飞速地跑到宫门', '我假装地跑到宫门',
  ])('%s 不会被模型的移动提议变成旅行', async input => {
    const w = createPalace('movement-guards');
    expect(readMovement(input)).toBeUndefined();
    const {world, turn} = await runTurn(w, input, new MockLLMProvider({parse:() => ({kind:'move', target:'宫门'})}));
    expect(kingRoom(world)).toBe('hall');
    expect(turn.changes).toEqual([]);
  });

  it.each(['我让罗兰朝宫门走去', '我回答艾琳，正在等回复', '我向艾琳解释我可能往宫门走去'])('%s 可以是社交指令，但不会让国王移动', async input => {
    expect(readMovement(input)).toBeUndefined();
    const {world, turn} = await runTurn(createPalace('other-travel'), input, new MockLLMProvider({parse:() => ({kind:'move', target:'宫门'})}));
    expect(kingRoom(world)).toBe('hall');
    expect(turn.changes.some(c => c.op === 'move' && c.actor === 'king')).toBe(false);
  });

  it('引语里的移动只算说话；句末问号不授权移动', async () => {
    const w = createPalace('movement-quote');
    for (const input of ['我问艾琳：“我向宫门走去？”', '“去宫门”', '前往宫门？']) {
      const {world, turn} = await runTurn(w, input, new MockLLMProvider({parse:() => ({kind:'move'})}));
      expect(kingRoom(world)).toBe('hall');
      expect(turn.changes.some(c => c.op === 'move')).toBe(false);
    }
  });

  it('语序清楚时纠正模型的错误类别或目的地，时钟仍由引擎决定', async () => {
    const provider = new MockLLMProvider({parse:() => ({kind:'speak', target:'艾琳'}),
      resolve:() => { throw Error('明确移动不需要再确认'); }});
    const {world, turn} = await runTurn(createPalace('explicit'), '我向城门走去', provider);
    expect(kingRoom(world)).toBe('gate');
    expect(turn.hearing).toBeUndefined();
    expect(turn.endTime - turn.startTime).toBe(5);
  });

});
