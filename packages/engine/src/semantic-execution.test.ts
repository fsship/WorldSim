import { describe, expect, it, vi } from "vitest";
import { MockLLMProvider, type MockHandlers } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { ParseContext, TurnPlan, WorldState } from "@worldsim/shared";
import { runTurn } from "./index";

const king = (world: WorldState) => world.characters.find(c => c.kind === "player")!;

function interpreter(plan: TurnPlan, handlers: MockHandlers = {}) {
  const interpret = vi.fn(async (_context: ParseContext): Promise<TurnPlan> => plan);
  const parse = vi.fn(() => { throw Error("不应回到旧的动词解析"); });
  const provider = Object.assign(new MockLLMProvider({...handlers, parse}), {interpret});
  return {provider, interpret, parse};
}

describe("语义计划经正常游戏入口接受引擎裁决", () => {
  it("凭原意察看王印，解释器只收到当时能指称的对象，物品正文由引擎决定", async () => {
    const world = createPalace("semantic-item");
    const p = interpreter({kind:"item", itemId:"seal", interaction:"inspect"});
    const input = "借着高窗投下的光，我想辨清王印底部的纹路。";
    const result = await runTurn(world, input, p.provider);
    expect(p.interpret).toHaveBeenCalledTimes(1);
    expect(p.parse).not.toHaveBeenCalled();
    const ctx = p.interpret.mock.calls[0][0];
    expect(ctx.text).toBe(input);
    expect(ctx.referents).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:"item", id:"seal", name:"王室印玺"}),
      expect.objectContaining({kind:"document", id:"morning-agenda"}),
      expect.objectContaining({kind:"place", id:"gate"}),
      expect.objectContaining({kind:"npc", id:"steward"}),
    ]));
    expect(ctx.referents?.some(r => r.kind === "npc" && r.id === "minister")).toBe(false);
    const view = JSON.stringify(ctx);
    for (const f of world.facts.filter(f => !f.knownBy.includes("king"))) expect(view).not.toContain(f.content.text);
    expect(result.turn.narrative).toContain("黄铜");
    expect(result.turn.narrative).toContain("印面");
    expect(result.turn.endTime - result.turn.startTime).toBe(1);
    expect(result.turn.changes.every(c => c.op === "clock")).toBe(true);
    expect(result.world.characters).toEqual(world.characters);
  });

  it("临时持有或未持有由当前世界核查，不凭模型选中印玺绕过", async () => {
    const world = createPalace("semantic-ownership");
    king(world).inventory = [];
    world.characters.find(c => c.id === "steward")!.inventory.push("seal");
    const p = interpreter({kind:"item", itemId:"seal", interaction:"handle_inspect"});
    const {world:next, turn} = await runTurn(world, "让我把王印托到眼前。", p.provider);
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
    expect(p.interpret.mock.calls[0][0].referents?.some(r => r.kind === "item" && r.id === "seal")).toBe(false);
    expect(turn.resolution.status).toBe("refused");
    expect(turn.changes).toEqual([]);
    expect(turn.narrative).not.toContain("黄铜");
    expect(next.characters).toEqual(world.characters);
  });

  it("可指称的调查对象由场景声明，改写房间描写不会让它消失", async () => {
    const world = createPalace("visible-subject");
    king(world).locationId = "archive";
    world.locations.find(room => room.id === "archive")!.description = "斜阳透过高窗，照亮案头。";
    const unknown = interpreter({kind:"investigate",focus:"other"});
    const first = await runTurn(world,"看看窗框里衬着的东西。",unknown.provider);
    expect(first.turn.resolution.status).toBe("resolved");
    expect(first.turn.changes.some(c => c.op === "learn" && c.actor === "king")).toBe(false);
    const subject = unknown.interpret.mock.calls[0][0].referents!.find(ref => ref.kind === "subject")!;
    expect(subject.name).toBe("值夜登记簿");
    const searching = interpreter({kind:"investigate",focus:subject.id});
    const result = await runTurn(world,"核对案上昨夜交接时留下的记录。",searching.provider);
    expect(result.turn.changes).toContainEqual({op:"learn",actor:"king",fact:"ledger"});
    expect(JSON.stringify(searching.interpret.mock.calls[0][0])).not.toContain(world.facts.find(f => f.id === "ledger")!.content.text);
  });

  it("再问‘它’时只提供确实观察过、而且仍在手边的物品", async () => {
    const p = interpreter({kind:"item", itemId:"seal", interaction:"inspect"});
    const first = await runTurn(createPalace("item-focus"), "我端详手里的王印。", p.provider);
    const next = await runTurn(first.world, "它的边角是什么样的？", p.provider);
    expect(p.interpret.mock.calls[1][0].lastItemId).toBe("seal");
    expect(next.turn.narrative).toContain("棱角");
    king(next.world).inventory = [];
    const gone = await runTurn(next.world, "还能再看看它吗？", p.provider);
    expect(p.interpret.mock.calls[2][0].lastItemId).toBeUndefined();
    expect(gone.turn.changes).toEqual([]);
    expect(gone.turn.narrative).not.toContain("棱角");
    expect(p.parse).not.toHaveBeenCalled();
  });

  it("按语义选择目的地仍要相邻，钟表耗时依照移动规则", async () => {
    const world = createPalace("semantic-travel");
    const p = interpreter({kind:"move", destination:"gate"});
    const input = "我沿着石阶一路下到王宫大门边。";
    const result = await runTurn(world, input, p.provider);
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
    expect(king(result.world).locationId).toBe("gate");
    expect(result.turn.endTime - result.turn.startTime).toBe(5);
    expect(result.turn.changes.filter(c => c.op === "move")).toEqual([{op:"move", actor:"king", to:"gate"}]);
    king(world).locationId = "archive";
    const denied = await runTurn(world, input, p.provider);
    expect(denied.turn.changes).toEqual([]);
    expect(king(denied.world).locationId).toBe("archive");
  });

  it("自然表达的长时间等待仍被重要事件打断", async () => {
    const p = interpreter({kind:"wait", minutes:60});
    const result = await runTurn(createPalace("semantic-wait"), "往后一时辰，我就在这里候着。", p.provider);
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
    expect(result.turn.endTime).toBe(495);
    expect(result.turn.events.some(e => e.source === "bell")).toBe(true);
    expect(king(result.world).locationId).toBe("hall");
  });

  it("一句话问候并默读议程，只向当场的人传达引用的那部分", async () => {
    const world = createPalace("semantic-combination");
    const decisions: string[] = [];
    const words = "早，艾琳";
    const source = "余光落到列着今日安排的纸页";
    const p = interpreter({kind:"speak", words, private:false, targetId:"steward", reading:{documentId:"morning-agenda", source}}, {
      decideNpcAction: ctx => { decisions.push(ctx.input); return {kind:"stay"}; },
    });
    const result = await runTurn(world, "我向侍从道一声「早，艾琳」，" + source + "。", p.provider);
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
    expect(decisions).toEqual([words]);
    const spoken = result.turn.events.filter(e => e.source === "speech");
    expect(spoken.map(e => e.text)).toEqual([words]);
    expect(result.turn.hearing).toEqual({volume:"room", listeners:["艾琳","罗兰"]});
    expect(result.turn.endTime - result.turn.startTime).toBe(3);
    for (const entry of world.readables[0].entries) expect(result.turn.narrative).toContain(entry.text);
  });

  it.each([true, false])("卫队长接到一个场景许可的指令，由他自己决定执行 (%s)", async comply => {
    const world = createPalace("semantic-officer");
    const words = "烦请把宫门值守布置得再严密些。";
    const source = "我向卫队长传令";
    const p = interpreter({kind:"order", words, targetId:"captain", orderId:"secure-gate", private:false, source}, {
      decideNpcAction: ctx => {
        expect(ctx.npc.name).toBe("罗兰");
        expect(ctx.order).toBeTruthy();
        return comply ? {kind:"carryOutOrder"} : {kind:"stay"};
      },
    });
    const result = await runTurn(world, source + "：「" + words + "」", p.provider);
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
    expect(result.turn.endTime - result.turn.startTime).toBe(2);
    expect(result.world.variables.guardSecured).toBe(comply);
    expect(result.turn.changes.filter(c => c.op === "flag")).toHaveLength(comply ? 1 : 0);
    expect(result.turn.events.filter(e => e.source === "speech").map(e => e.text)).toEqual([words]);
  });

  it("语义解释出拘押意图以后仍逐项核对在场、王命与证据", async () => {
    const world = createPalace("semantic-arrest");
    const p = interpreter({kind:"arrest", targetId:"minister"});
    const input = "把掌玺大臣先收监。";
    expect((await runTurn(world, input, p.provider)).turn.changes).toEqual([]);
    king(world).locationId = "archive";
    expect((await runTurn(world, input, p.provider)).turn.changes).toEqual([]);
    king(world).knownFactIds.push("ledger");
    world.facts.find(f => f.id === "ledger")!.knownBy.push("king");
    const authorized = await runTurn(world, input, p.provider);
    expect(authorized.turn.changes).toContainEqual({op:"detain", actor:"minister"});
    king(world).abilities = [];
    expect((await runTurn(world, input, p.provider)).turn.changes).toEqual([]);
    expect(p.interpret).toHaveBeenCalledTimes(4);
    expect(p.parse).not.toHaveBeenCalled();
  });

  it.each<TurnPlan>([
    {kind:"move", destination:"nonexistent"},
    {kind:"item", itemId:"steward", interaction:"inspect"},
    {kind:"read", reading:{documentId:"nonexistent"}},
    {kind:"arrest", targetId:"nonexistent"},
  ])("未知的引用不能被替换成其他人物、地点或物品 ($kind)", async plan => {
    const world = createPalace("invalid-reference");
    const p = interpreter(plan);
    const run = await runTurn(world, "对那个目标照办。", p.provider);
    expect(run.turn.resolution.status).toBe("refused");
    expect(run.turn.changes).toEqual([]);
    expect(run.world.time).toBe(world.time);
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
  });

  it.each([
    {kind:"teleport", destination:"gate"},
    {kind:"item", itemId:"seal", interaction:"inspect", changes:[{op:"flag",name:"guardSecured",value:true}]},
    {kind:"speak", private:false, words:"国王已经决定去宫门。"},
    {kind:"order", targetId:"captain", orderId:"secure-gate", private:false, words:"加强宫门守备"},
  ])("不合法的计划不产生玩家行为，模型不可伪造发言 ($kind)", async invalid => {
    const world = createPalace("invalid-plan");
    const before = structuredClone(world);
    const p = interpreter(invalid as unknown as TurnPlan);
    const run = await runTurn(world, "我在看印玺。", p.provider).catch(() => undefined);
    if (run) {
      expect(run.turn.resolution.status).toBe("refused");
      expect(run.turn.changes).toEqual([]);
      expect(run.turn.hearing).toBeUndefined();
    }
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
    expect(world).toEqual(before);
  });

  it.each(["“去宫门”", "“去宫门”，我对罗兰说。"])("引语里的行动在解释器误报移动时也不会发生：%s", async input => {
    const world = createPalace("spoken-travel");
    const p = interpreter({kind:"move", destination:"gate"});
    const played = await runTurn(world, input, p.provider).catch(() => undefined);
    if (played) {
      expect(played.turn.resolution.status).toBe("refused");
      expect(played.turn.endTime).toBe(480);
      expect(played.turn.changes).toEqual([]);
      expect(king(played.world).locationId).toBe("hall");
    }
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
    expect(king(world).locationId).toBe("hall");
  });

  it("默读证据不能取自说给艾琳听的话", async () => {
    const world = createPalace("not-silently-reading");
    const words = "请你阅读朝会议程。";
    const p = interpreter({kind:"speak", private:false, targetId:"steward", words,
      reading:{documentId:"morning-agenda", source:"阅读朝会议程"}});
    const result = await runTurn(world, "我说：「" + words + "」", p.provider).catch(() => undefined);
    if (result) {
      expect(result.turn.events.some(e => e.bookmark)).toBe(false);
      for (const entry of world.readables[0].entries) expect(result.turn.narrative).not.toContain(entry.text);
    }
    expect(p.interpret).toHaveBeenCalledOnce();
    expect(p.parse).not.toHaveBeenCalled();
  });
});
