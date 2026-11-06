import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { WorldStateSchema, type GameTurn, type NpcActionContext, type ParseContext, type TurnPlan, type WorldState } from "@worldsim/shared";
import { cancelEvent, runTurn } from "./index";

const greeting = '"早，艾琳"——我回复道，顺手看了看长桌，想知道有哪些议程';
const quietNpc = () => new MockLLMProvider({decideNpcAction: () => ({kind:"stay"})});
const agenda = (world: WorldState) => world.readables.find(d => d.id === "morning-agenda")!;
const worldLines = (turn: GameTurn) => turn.observations.filter(o => o.kind === "world").map(o => o.text).join("\n");

describe("侍卫呈上的宫门交接簿", () => {
  const input = "我看了下交接簿，看看上面写了什么";

  it("08:32 等待被呈交通报打断，原话在离线和模型解释路径都读到簿上条目", async () => {
    const offline = quietNpc();
    const bell = await runTurn(createPalace("ledger-read"), "等待晨会钟声", offline);
    const delivered = await runTurn(bell.world, "等待三十分钟", offline);
    expect(delivered.world.time).toBe(512);
    expect(worldLines(delivered.turn)).toContain("侍卫呈上宫门的交接簿");
    const ledger = delivered.world.readables.find(doc => doc.availableAfterEvent === "dispatch")!;
    const interpreted = Object.assign(quietNpc(), {
      async interpret(context: ParseContext): Promise<TurnPlan> {
        expect(context.text).toBe(input);
        const offered = context.referents?.find(ref => ref.kind === "document" && [ref.name, ...ref.aliases].includes("交接簿"));
        expect(offered?.id).toBe(ledger.id);
        expect(offered?.sectionTitles).toEqual(ledger.entries.map(entry => entry.title));
        for (const entry of ledger.entries) expect(JSON.stringify(context)).not.toContain(entry.text);
        return {kind:"read", reading:{documentId:offered!.id}};
      },
    });
    for (const provider of [offline, interpreted]) {
      const {turn} = await runTurn(delivered.world, input, provider);
      expect(turn.resolution.status).toBe("resolved");
      expect(turn.endTime).toBe(512 + ledger.entries.length);
      for (const entry of ledger.entries) expect(worldLines(turn)).toContain(entry.text);
      for (const entry of agenda(delivered.world).entries) expect(turn.narrative).not.toContain(entry.text);
    }
  });

  it("呈交前、取消后以及离开议事厅时，目录和阅读裁决都拒绝这份簿册", async () => {
    const offline = quietNpc();
    const bell = await runTurn(createPalace("ledger-unavailable"), "等待晨会钟声", offline);
    const ledger = bell.world.readables.find(doc => doc.availableAfterEvent === "dispatch")!;
    const cancelled = structuredClone(bell.world);
    cancelEvent(cancelled, "dispatch");
    const afterDeadline = await runTurn(cancelled, "等待十七分钟", offline);
    expect(afterDeadline.world.time).toBe(512);
    const delivered = await runTurn(bell.world, "等待三十分钟", offline);
    const away = await runTurn(delivered.world, "我前往宫门", offline);
    expect(away.world.characters.find(c => c.kind === "player")?.locationId).toBe("gate");
    const guessesId = Object.assign(quietNpc(), {
      async interpret(context: ParseContext): Promise<TurnPlan> {
        expect(context.referents?.filter(ref => ref.kind === "document").map(ref => ref.id)).not.toContain(ledger.id);
        return {kind:"read", reading:{documentId:ledger.id}};
      },
    });
    for (const world of [bell.world, afterDeadline.world, away.world]) {
      const {turn} = await runTurn(world, input, guessesId);
      expect(turn.resolution.status).toBe("refused");
      expect(turn.endTime).toBe(world.time);
      expect(turn.events.some(event => event.bookmark)).toBe(false);
      for (const entry of ledger.entries) expect(turn.narrative).not.toContain(entry.text);
    }
  });
});

describe("阅读身边的朝会议程", () => {
  it("一句话问候并阅读，NPC 只听到引语，世界纪事显示具体条目", async () => {
    const initial = createPalace("agenda-first-turn");
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({
      parse: () => ({kind:"speak"}),
      decideNpcAction: context => { decisions.push(context); return {kind:"stay"}; },
    });
    const {world, turn} = await runTurn(initial, greeting, provider);
    expect(turn.resolution.status).toBe("resolved");
    const spoken = turn.events.filter(event => event.source === "speech");
    expect(spoken.map(event => event.text)).toEqual(["早，艾琳"]);
    expect(new Set(spoken[0].utterance?.listenerIds)).toEqual(new Set(["steward", "captain"]));
    expect(decisions.map(d => [d.npc.name, d.trigger, d.input])).toEqual([["艾琳", "addressed", "早，艾琳"]]);
    expect(turn.hearing?.volume).toBe("room");
    const entries = agenda(initial).entries;
    expect(entries).toHaveLength(3);
    for (const [index, entry] of entries.entries()) {
      expect(worldLines(turn)).toContain(entry.title);
      expect(worldLines(turn)).toContain(entry.text);
      expect(turn.observations.find(o => o.text.includes(entry.text))?.time).toBe(480 + index);
      expect(JSON.stringify(decisions)).not.toContain(entry.text);
    }
    expect(turn.endTime).toBe(483);
    expect(world.characters.find(c => c.kind === "player")?.locationId).toBe("hall");
    expect(turn.changes.some(c => c.op === "move" || c.op === "flag")).toBe(false);
    const privateFact = initial.facts.find(f => f.type === "secret")!;
    expect(JSON.stringify(turn.observations)).not.toContain(privateFact.content.text);
    expect(JSON.stringify(decisions)).not.toContain(privateFact.content.text);
  });

  it.each([
    {at:495, notice:"bell", name:"钟声"},
    {at:512, notice:"dispatch", name:"交接簿"},
  ])("目击$name时只读完第一项，下一次从第二项开始", async ({at, notice, name}) => {
    let world = createPalace("interrupted-reading-" + notice);
    const provider = quietNpc();
    if (at > 495) world = (await runTurn(world, "等待晨会钟声", provider)).world;
    world = (await runTurn(world, "等待" + (at - 1 - world.time) + "分钟", provider)).world;
    expect(world.time).toBe(at - 1);
    const [first, second, last] = agenda(world).entries;
    const wasReading = await runTurn(world, "阅读朝会议程", provider);
    const {turn} = wasReading;
    expect(turn.endTime).toBe(at);
    expect(turn.hearing).toBeUndefined();
    expect(turn.observations.some(o => o.kind === "world" && o.text.includes(name))).toBe(true);
    const reading = turn.events.findIndex(e => e.text.includes(first.text));
    const interruption = turn.events.findIndex(e => e.source === notice);
    expect(reading).toBeGreaterThanOrEqual(0);
    expect(interruption).toBeGreaterThan(reading);
    expect(turn.events[reading].time).toBe(at - 1);
    expect(turn.events[interruption].time).toBe(at);
    expect(turn.observations.find(o => o.text.includes(name))?.time).toBe(at);
    for (const unread of [second, last]) {
      expect(turn.narrative).not.toContain(unread.text);
      expect(turn.narrative).not.toContain(unread.title);
    }
    const npc = turn.events.findIndex(e => e.npcAction);
    if (at % 5 === 0) {
      expect(npc).toBeGreaterThan(interruption);
      expect(turn.events[npc].time).toBe(at);
    } else expect(npc).toBe(-1);
    const saved = WorldStateSchema.parse(JSON.parse(JSON.stringify(wasReading.world)));
    const resumed = await runTurn(saved, "继续阅读朝会议程", provider);
    expect(resumed.turn.narrative).not.toContain(first.text);
    expect(worldLines(resumed.turn)).toContain(second.text);
    expect(worldLines(resumed.turn)).toContain(last.text);
    expect(resumed.turn.endTime).toBe(at + 2);
    expect(resumed.world.queue.find(e => e.id === notice)?.status).toBe("executed");
    expect(resumed.turn.events.some(e => e.source === notice)).toBe(false);
  });

  it("本分钟已经到点的钟声在第一项之前发生，从第一项续读", async () => {
    const initial = createPalace("reading-start-interrupt");
    initial.queue.find(e => e.id === "bell")!.at = initial.time;
    const halted = await runTurn(initial, "阅读朝会议程", quietNpc());
    expect(halted.turn.narrative).toContain("钟声");
    expect(halted.turn.endTime).toBe(initial.time);
    for (const entry of agenda(initial).entries) expect(halted.turn.narrative).not.toContain(entry.text);
    const continued = await runTurn(halted.world, "继续阅读", quietNpc());
    for (const entry of agenda(initial).entries) expect(worldLines(continued.turn)).toContain(entry.text);
  });

  it("最后一项读完时响起的钟声仍写入纪事，但没有多余的下一项", async () => {
    const initial = createPalace("reading-end-interrupt");
    initial.queue.find(e => e.id === "bell")!.at = initial.time + 3;
    const read = await runTurn(initial, "阅读朝会议程", quietNpc());
    const entries = agenda(initial).entries;
    for (const entry of entries) expect(worldLines(read.turn)).toContain(entry.text);
    expect(read.turn.narrative.indexOf("钟声")).toBeGreaterThan(read.turn.narrative.indexOf(entries[2].text));
    const atEnd = await runTurn(read.world, "继续阅读", quietNpc());
    expect(atEnd.turn.endTime).toBe(read.turn.endTime);
    for (const entry of entries) expect(atEnd.turn.narrative).not.toContain(entry.text);
  });

  it("花园的局部事件不打断议事厅的阅读，也不会被叙事器写成公开消息", async () => {
    const world = createPalace("unseen-notice");
    const hidden = "花园另一端传来了暗号。";
    world.queue.push({...world.queue[0], id:"remote-notice", text:hidden, at:481, perception:"local", locationId:"garden"});
    const {turn} = await runTurn(world, "阅读朝会议程", quietNpc());
    for (const entry of agenda(world).entries) expect(worldLines(turn)).toContain(entry.text);
    expect(turn.endTime).toBe(483);
    expect(turn.narrative).not.toContain(hidden);
    expect(turn.events.filter(e => e.source === "remote-notice")).toHaveLength(1);
  });

  it("明确只看第二项时由玩家选择哪一项，不自动读完整份文书", async () => {
    const world = createPalace("one-agenda-item");
    const [first, second, last] = agenda(world).entries;
    const {turn} = await runTurn(world, "阅读朝会议程的第二项", quietNpc());
    expect(worldLines(turn)).toContain(second.text);
    expect(turn.narrative).not.toContain(first.text);
    expect(turn.narrative).not.toContain(last.text);
    expect(turn.endTime).toBe(481);
  });

  it("解释器从现场目录选择所指的条目，正文仍逐项通过引擎读取", async () => {
    const world = createPalace("agenda-section-by-meaning");
    const document = agenda(world);
    world.readables.push({id:"other-list", name:"远处的清单", locationId:"garden", aliases:[],
      entries:[{title:"只在花园可见的标题", text:"另一处的正文。"}]});
    const input = "想看看夜岗换班那项，别的先不读";
    const provider = Object.assign(quietNpc(), {
      async interpret(context: ParseContext): Promise<TurnPlan> {
        const offered = context.referents?.find(r => r.id === document.id);
        expect(context.text).toBe(input);
        expect(offered?.sectionTitles).toEqual(document.entries.map(e => e.title));
        expect(JSON.stringify(context)).not.toContain("只在花园可见的标题");
        for (const entry of document.entries) expect(JSON.stringify(context)).not.toContain(entry.text);
        return {kind:"read", reading:{documentId:document.id, section:2}};
      },
    });
    const {turn} = await runTurn(world, input, provider);
    expect(turn.narrative).toContain(document.entries[1].text);
    for (const entry of [document.entries[0], document.entries[2]]) expect(turn.narrative).not.toContain(entry.text);
    expect(turn.endTime - turn.startTime).toBe(1);
  });

  it("换到别处，继续读旧文书与翻阅手边唯一的新文书有不同结果", async () => {
    const initial = createPalace("agenda-in-another-room");
    const gardenNote = {id:"garden-board", name:"庭园日记", aliases:[], locationId:"garden",
      entries:[{title:"剪枝", text:"园丁上午修整了柏树。"}]};
    initial.readables.push(gardenNote);
    const started = await runTurn(initial, "阅读朝会议程的第一项", quietNpc());
    const moved = await runTurn(started.world, "我前往王宫花园", quietNpc());
    const fromBookmark = await runTurn(moved.world, "继续读", quietNpc());
    expect(fromBookmark.turn.resolution.status).toBe("refused");
    expect(fromBookmark.turn.endTime).toBe(moved.turn.endTime);
    const provider = Object.assign(quietNpc(), {
      async interpret(context: ParseContext): Promise<TurnPlan> {
        expect(context.lastDocumentId).toBeUndefined();
        expect(context.referents?.filter(r => r.kind === "document").map(r => r.id)).toEqual([gardenNote.id]);
        return {kind:"read", reading:{}};
      },
    });
    const next = await runTurn(fromBookmark.world, "我扫一眼这里摊开的那份纸。", provider);
    expect(next.turn.narrative).toContain(gardenNote.entries[0].text);
    expect(next.turn.endTime - next.turn.startTime).toBe(1);
  });

  it("连续翻到下一项每次只前进一项，到末尾不会再读一次", async () => {
    const initial = createPalace("one-at-a-time");
    const provider = quietNpc();
    const [first, second, third] = agenda(initial).entries;
    const one = await runTurn(initial, "读议程的第一项", provider);
    const two = await runTurn(one.world, "看下一项", provider);
    const three = await runTurn(two.world, "读议程的下一项", provider);
    const done = await runTurn(three.world, "继续读", provider);
    for (const [result, entry] of [[one, first], [two, second], [three, third]] as const) {
      expect(worldLines(result.turn)).toContain(entry.text);
      expect(result.turn.endTime - result.turn.startTime).toBe(1);
      expect(result.turn.events.filter(e => e.bookmark)).toHaveLength(1);
    }
    expect(done.turn.narrative).toContain("末尾");
    expect(done.turn.endTime).toBe(three.turn.endTime);
  });

  it("读取玩家所在位置的文书内容，不把议事厅议程套用到别的地点", async () => {
    const original = createPalace("another-document");
    const gardener = {
      id:"garden-list", name:"巡园清单", aliases:["夹板"], locationId:"garden",
      entries:[{title:"修整柏篱", text:"先量北侧柏篱的高度，记在木牌上。"}],
    };
    original.readables.push(gardener);
    const entered = await runTurn(original, "走进王宫花园", quietNpc());
    const {turn} = await runTurn(entered.world, "阅读巡园清单", quietNpc());
    expect(worldLines(turn)).toContain(gardener.entries[0].text);
    for (const entry of agenda(original).entries) expect(turn.narrative).not.toContain(entry.text);
    expect(turn.hearing).toBeUndefined();
    expect(turn.endTime - turn.startTime).toBe(1);
  });

  it.each([
    '“请你阅读朝会议程。”我对艾琳说',
    "我没有查看朝会议程",
    "假如我现在阅读朝会议程",
    "艾琳阅读长桌上的议程",
  ])("单靠提到议程不会暴露纸上的内容：%s", async input => {
    const world = createPalace("agency");
    const {turn} = await runTurn(world, input, new MockLLMProvider({
      parse: () => ({kind:"investigate", target:"朝会议程"}),
      decideNpcAction: () => ({kind:"stay"}),
    }));
    for (const entry of agenda(world).entries) expect(turn.narrative).not.toContain(entry.text);
  });

  it("离开议事厅后不能隔着房间继续阅读那份纸", async () => {
    const world = createPalace("absent-document");
    const away = await runTurn(world, "我前往宫门", quietNpc());
    const {turn} = await runTurn(away.world, "阅读朝会议程", quietNpc());
    for (const entry of agenda(world).entries) expect(turn.narrative).not.toContain(entry.text);
    expect(away.world.characters.find(c => c.kind === "player")?.locationId).toBe("gate");
  });
});
