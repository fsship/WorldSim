import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '@worldsim/llm';
import { createPalace } from '@worldsim/scenarios';
import { isDirectedLook, readWaitAction } from '@worldsim/shared';
import { runTurn } from './index';

function quietHall() {
  const w = createPalace('waiting-language');
  w.queue = [];
  return w;
}

describe('原地等候、休息和观察', () => {
  it.each([
    ['我在这里等五分钟', 5], ['我站在原地等一会儿', 5], ['我等十分钟再说', 10],
    ['我暂且休息五分钟', 5], ['继续等待', 5], ['我留在议事厅等候一刻钟', 15],
    ['等待半个小时', 30], ['我等一个半小时', 90], ['我等一小时三十分', 90],
    ['我等到八点一刻', 15], ['休息至 08:08', 8], ['我等到中午十一点', 180],
    ['我等到晚上十二点', 720], ['我等5分钟，再等待两天', 5],
    ['我等五分钟，不去宫门', 5], ['我等到明天八点一刻', 720],
  ])('%s 的目标时长为 %d 分钟，长等候在可续接的世界时刻暂停', async (input, elapsed) => {
    const before = quietHall();
    const {turn, world} = await runTurn(before, String(input), new MockLLMProvider());
    expect(turn.resolution.optionId).toBe('wait');
    expect(world.time - before.time).toBe(Math.min(Number(elapsed),30));
    if (Number(elapsed) > 30) expect(turn.narrative).toContain('是否继续');
    expect(world.characters.find(c => c.kind === 'player')?.locationId).toBe('hall');
    expect(turn.hearing).toBeUndefined();
  });

  it('等待官员到来被重要事件打断；明确写下时限时只等那么久', async () => {
    const world = createPalace('wait-for-officials');
    const result = await runTurn(world, '接着等待官员们到来', new MockLLMProvider());
    expect(result.turn.intent.kind).toBe('wait_event');
    expect(result.turn.endTime).toBe(495);
    const short = await runTurn(world, '等待各部官员到场，最多等待八分钟', new MockLLMProvider());
    expect(short.turn.endTime).toBe(488);
    const reply = await runTurn(world, '我等候信使的回话，最多等八分钟', new MockLLMProvider());
    expect(reply.turn.intent.kind).toBe('wait_event');
    expect(reply.turn.endTime).toBe(488);
  });

  it.each(['我不等五分钟', '如果我等五分钟', '我告诉罗兰我等五分钟', '艾琳等五分钟', '我等五分钟吗？',
    '我等了五分钟', '我在档案室等五分钟', '我等到25:30', '我等半刻钟', '我等-5分钟'])(
    '%s 不能被错误的等待提案推进时钟', async input => {
      const world = quietHall();
      const {turn} = await runTurn(world, input, new MockLLMProvider({parse:() => ({kind:'wait_event', minutes:720})}));
      expect(turn.endTime).toBe(turn.startTime);
      expect(turn.changes).toEqual([]);
    });

  it.each(['我看向宫门', '我朝宫门看去', '我转头向花园望了一眼', '我朝宫门方向张望', '我把视线投向宫门'])(
    '%s 在原房间观察，眼中的地名不会变成目的地', async input => {
      const w = quietHall();
      expect(isDirectedLook(input)).toBe(true);
      const {world, turn} = await runTurn(w, input, new MockLLMProvider());
      expect(turn.resolution.optionId).toBe('observe');
      expect(world.time).toBe(w.time);
      expect(world.characters.find(c => c.kind === 'player')?.locationId).toBe('hall');
    });
  it('不会把实际移动、假设或转述识别为原地观察', () => {
    for (const text of ['我向宫门走去', '我前往宫门看看', '罗兰朝宫门望去', '如果我看向宫门', '我没看向宫门']) {
      expect(isDirectedLook(text)).toBe(false);
    }
    expect(readWaitAction('“我要等两天。”我问道')).toBeUndefined();
  });
});
