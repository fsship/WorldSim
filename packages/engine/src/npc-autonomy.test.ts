import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { WorldStateSchema, type NpcActionContext, type WorldState } from "@worldsim/shared";
import { prepareOpening, projectTurn, projectWorld, runTurn } from "./index";

const palace = () => createPalace("npc-autonomy");
const actor = (world: WorldState, id: string) => world.characters.find(c => c.id === id)!;
const askSteward = '“有什么晨报？”我问艾琳';
const unspoken = () => { throw Error("没有选择发言，不应请求台词"); };

describe("NPC 自主行动的回合边界", () => {
  it("开场 NPC 可主动行礼，玩家继续发问时仍能联系到她", async () => {
    const initial = palace();
    const decisions: NpcActionContext[] = [];
    let linesWritten = 0;
    const provider = new MockLLMProvider({
      decideNpcAction: context => {
        decisions.push(context);
        return context.trigger === "opening" ? {kind:"gesture", gesture:"bow"} : {kind:"speak"};
      },
      dialogue: () => { linesWritten++; return {text:"我听着，陛下。", factIds:[]}; },
      reviewDialogue: () => ({grounded:true, playerAgency:true, citationsAccurate:true}),
    });

    const opened = await prepareOpening(initial, provider);
    expect(decisions.map(c => [c.trigger, c.npc.name])).toEqual([["opening", "艾琳"]]);
    expect(linesWritten).toBe(0);
    expect(opened.history.some(e => e.kind === "npc" && e.source === "opening")).toBe(false);
    const gesture = opened.history.find(e => e.npcAction?.kind === "gesture")!;
    expect(gesture.npcAction).toMatchObject({actorId:"steward", source:"provider"});
    expect(gesture.text).toContain("礼");
    expect(projectWorld(opened).opening).toContain(gesture.text);
    expect(projectWorld(opened).openingUsedFallback).not.toBe(true);
    expect(opened.version).toBe(0);
    expect(opened.time).toBe(initial.time);
    expect(opened.characters).toEqual(initial.characters);
    expect(await prepareOpening(opened, provider)).toEqual(opened);
    expect(decisions).toHaveLength(1);

    const resumed = WorldStateSchema.parse(JSON.parse(JSON.stringify(opened)));
    const next = await runTurn(resumed, '“你有什么消息？”', provider);
    expect(decisions.map(c => [c.trigger, c.npc.name])).toEqual([["opening", "艾琳"], ["addressed", "艾琳"]]);
    expect(linesWritten).toBe(1);
    expect(next.turn.observations).toContainEqual({kind:"dialogue", speaker:"艾琳", text:"我听着，陛下。"});
    expect(next.world.time - resumed.time).toBe(2);
  });

  it("被搭话的 NPC 可以选择离开；变更和离开时的观察出现在同一回合", async () => {
    const first = palace();
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => { decisions.push(ctx); return {kind:"move", destination:"archive"}; },
      dialogue: unspoken,
    });
    const {world, turn} = await runTurn(first, askSteward, provider);
    expect(decisions.map(c => [c.trigger, c.npc.name])).toEqual([["addressed", "艾琳"]]);
    expect(actor(world,"steward").locationId).toBe("archive");
    expect(actor(first,"steward").locationId).toBe("hall");
    expect(actor(world,"king")).toEqual(actor(first,"king"));
    expect(projectWorld(world).present.map(c => c.id)).not.toContain("steward");
    const moved = turn.events.find(e => e.npcAction?.kind === "move")!;
    expect(moved.npcAction).toMatchObject({actorId:"steward", source:"provider"});
    expect(moved.text).toContain("档案室");
    expect(moved.changes).toContainEqual({op:"move",actor:"steward",to:"archive"});
    expect(turn.observations).toContainEqual({kind:"world",text:moved.text});
    expect(turn.observations.some(o => o.kind === "dialogue")).toBe(false);
    expect(turn.endTime-turn.startTime).toBe(2);
    expect(world.history).toContainEqual(moved);

    const restored = WorldStateSchema.parse(JSON.parse(JSON.stringify(world)));
    const again = await runTurn(restored, askSteward, provider);
    expect(again.turn.resolution.status).toBe("resolved");
    expect(again.turn.observations.every(o => o.kind === "system")).toBe(true);
    expect(again.turn.events.find(e => e.source === "speech")?.utterance?.listenerIds).toEqual(["captain"]);
    expect(again.turn.endTime - again.turn.startTime).toBe(2);
    expect(again.turn.changes.every(change => change.op === "clock")).toBe(true);
    expect(decisions).toHaveLength(1);
    const implicit = await runTurn(restored, '“刚才的话，还能说明一下吗？”', provider);
    expect(implicit.turn.resolution.status).toBe("resolved");
    expect(decisions.map(ctx => ctx.npc.name)).toEqual(["艾琳","罗兰"]);
    expect(implicit.turn.changes).toContainEqual({op:"move", actor:"captain", to:"archive"});
  });

  it("一次决定可先行礼再开口，玩家按实际发生顺序看到动作和模型台词", async () => {
    const first = palace();
    let decisions = 0, drafts = 0;
    const line = "陛下，请讲。";
    const provider = new MockLLMProvider({
      decideNpcAction: () => { decisions++; return {kind:"gesture",gesture:"bow",thenSpeak:true}; },
      dialogue: () => { drafts++; return {text:line,factIds:[]}; },
      reviewDialogue: () => ({grounded:true, playerAgency:true, citationsAccurate:true}),
    });
    const {world, turn} = await runTurn(first, askSteward, provider);
    expect(decisions).toBe(1);
    expect(drafts).toBe(1);
    const gesture = turn.events.find(e => e.npcAction?.kind === "gesture")!;
    expect(turn.observations).toEqual([
      {kind:"world", text:gesture.text}, {kind:"dialogue",speaker:"艾琳",text:line},
    ]);
    expect(turn.events.findIndex(e => e.id === gesture.id)).toBeLessThan(turn.events.findIndex(e => e.kind === "npc"));
    expect(world.characters).toEqual(first.characters);
    expect(turn.endTime-turn.startTime).toBe(2);
  });

  it("开场完成的行礼在后续台词失败时仍然维持对话焦点", async () => {
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => {
        decisions.push(ctx);
        return ctx.trigger === "opening" ? {kind:"gesture",gesture:"bow",thenSpeak:true} : {kind:"speak"};
      },
      dialogue: ctx => {
        if (!ctx.input) throw Error("开场台词服务暂不可用");
        return {text:"陛下，我在听。", factIds:[]};
      },
      reviewDialogue: () => ({grounded:true, playerAgency:true, citationsAccurate:true}),
    });
    const opened = await prepareOpening(palace(), provider);
    expect(projectWorld(opened).openingUsedFallback).toBe(true);
    expect(projectWorld(opened).openingRetryable).toBe(false);
    expect(opened.history.some(e => e.npcAction?.kind === "gesture")).toBe(true);
    const {turn} = await runTurn(opened, '“怎么了？”', provider);
    expect(decisions.map(c => [c.trigger,c.npc.name])).toEqual([["opening","艾琳"],["addressed","艾琳"]]);
    expect(turn.observations).toContainEqual({kind:"dialogue",speaker:"艾琳",text:"陛下，我在听。"});
  });

  it("被点名后的无声动作保留玩家原话，续聊不会把手势编成台词", async () => {
    let calls = 0;
    const nextInput: string[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: () => ++calls === 1 ? {kind:"gesture",gesture:"nod"} : {kind:"speak"},
      dialogue: ctx => {
        nextInput.push(...ctx.history.filter(line => line.role === "player").map(line => line.text));
        return {text:"我听到了。", factIds:[]};
      },
      reviewDialogue: () => ({grounded:true, playerAgency:true, citationsAccurate:true}),
    });
    const first = await runTurn(palace(), '“咱们把那件事叫作晨签。”我对艾琳说', provider);
    expect(first.turn.observations.some(o => o.kind === "dialogue")).toBe(false);
    const next = await runTurn(first.world, '“我刚才怎么称呼它？”', provider);
    expect(nextInput).toContain("咱们把那件事叫作晨签。");
    expect(next.turn.observations.some(o => o.speaker === "艾琳")).toBe(true);
  });

  it("普通有效行动只唤醒一个在场且能行动的 NPC，手势不额外推进时钟", async () => {
    const first = palace();
    actor(first,"steward").condition = "detained";
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => { decisions.push(ctx); return {kind:"gesture",gesture:"nod"}; },
      dialogue: unspoken,
    });
    const {world,turn} = await runTurn(first, "拿起王室印玺", provider);
    expect(turn.resolution.status).toBe("resolved");
    expect(decisions.map(c => [c.trigger, c.npc.name])).toEqual([["ambient", "罗兰"]]);
    expect(turn.events.filter(e => e.npcAction)).toHaveLength(1);
    const gesture = turn.events.find(e => e.npcAction)!;
    expect(gesture.npcAction).toMatchObject({actorId:"captain", kind:"gesture", source:"provider"});
    expect(gesture.text).toContain("头");
    expect(turn.observations.map(o => o.text)).toContain(gesture.text);
    expect(turn.endTime-turn.startTime).toBe(1);
    expect(world.characters).toEqual(first.characters);
  });

  it("模型自行描述的可见动作经独立审核后原样发生，只记入世界观察", async () => {
    const first = palace();
    const description = "将双手交叠在身前。";
    let reviews = 0;
    const provider = new MockLLMProvider({
      decideNpcAction: () => ({kind:"act",description}),
      reviewNpcAction: ({context, proposal}) => {
        reviews++;
        expect(context.npc.name).toBe("艾琳");
        expect(proposal).toMatchObject({kind:"act",description});
        return {grounded:true,selfOnly:true};
      },
      dialogue: unspoken,
    });
    const {world,turn} = await runTurn(first,askSteward,provider);
    expect(reviews).toBe(1);
    const action = turn.events.find(e => e.npcAction?.kind === "act")!;
    expect(action.npcAction).toMatchObject({actorId:"steward",source:"provider"});
    expect(action.text).toContain(description);
    expect(action.changes).toEqual([]);
    expect(turn.observations).toContainEqual({kind:"world",text:action.text});
    expect(turn.observations.some(o => o.kind === "dialogue")).toBe(false);
    expect(turn.changes.filter(c => c.op !== "clock")).toEqual([]);
    expect(world.characters).toEqual(first.characters);
    expect(world.variables).toEqual(first.variables);
    expect(turn.endTime-turn.startTime).toBe(2);
  });

  it("无效的玩家行动不额外驱动 NPC 或改变时钟", async () => {
    const first = palace();
    let calls = 0;
    const provider = new MockLLMProvider({decideNpcAction: () => { calls++; return {kind:"move", destination:"gate"}; }});
    const {world,turn} = await runTurn(first, "我取出背包里的核弹", provider);
    expect(turn.resolution.status).toBe("refused");
    expect(calls).toBe(0);
    expect(turn.changes).toEqual([]);
    expect(world.characters).toEqual(first.characters);
    expect(world.time).toBe(first.time);
  });

  it("同一道合法命令允许卫队长选择执行或不执行，只有执行动作才会变更守备", async () => {
    const initial = palace();
    const order = "命令卫队长加强宫门守备";
    const decisions: NpcActionContext[] = [];
    const declined = await runTurn(initial, order, new MockLLMProvider({
      decideNpcAction: ctx => { decisions.push(ctx); return {kind:"stay"}; }, dialogue: unspoken,
    }));
    expect(decisions.map(c => c.npc.name)).toEqual(["罗兰"]);
    expect(decisions[0].order).toBeTruthy();
    expect(declined.world.variables.guardSecured).toBe(false);
    expect(declined.turn.changes.some(c => c.op === "flag")).toBe(false);

    const accepted = await runTurn(initial, order, new MockLLMProvider());
    const action = accepted.turn.events.find(e => e.npcAction?.kind === "carryOutOrder")!;
    expect(action.npcAction?.actorId).toBe("captain");
    expect(action.changes).toContainEqual({op:"flag", name:"guardSecured", value:true});
    expect(accepted.world.variables.guardSecured).toBe(true);
    expect(accepted.turn.observations.some(o => o.kind === "dialogue" && o.speaker === "罗兰")).toBe(true);
    expect(accepted.turn.endTime-accepted.turn.startTime).toBe(2);
    expect(actor(accepted.world, "king")).toEqual(actor(initial, "king"));
  });

  it("玩家没有下令权限时，模型的 carryOutOrder 提案不能写入世界变量", async () => {
    const initial = palace();
    actor(initial,"king").abilities = [];
    const decisions: NpcActionContext[] = [];
    const {world, turn} = await runTurn(initial,"命令卫队长加强宫门守备",new MockLLMProvider({
      decideNpcAction: ctx => { decisions.push(ctx); return {kind:"carryOutOrder"}; }, dialogue: unspoken,
    }));
    expect(decisions.map(c => c.order)).toEqual([undefined]);
    expect(world.variables.guardSecured).toBe(false);
    expect(turn.changes.some(c => c.op === "flag")).toBe(false);
    expect(world.characters).toEqual(initial.characters);
  });

  it.each([
    {kind:"move", destination:"archive", actor:"king"},
    {kind:"move", destination:"archive", minutes:1440},
    {kind:"move", destination:"nonexistent-room"},
    {kind:"gesture", gesture:"nod", changes:[{op:"move",actor:"king",to:"gate"}]},
  ] as const)("错误的行动提案不能变成位移或代替国王行动 %#", async proposal => {
    const first = palace();
    let calls = 0;
    // Bypass the adapter's schema: the engine must enforce its own boundary on any provider.
    const provider = new MockLLMProvider({dialogue:unspoken});
    provider.decideNpcAction = async () => { calls++; return proposal; };
    const {world,turn} = await runTurn(first, askSteward, provider);
    expect(calls).toBe(1);
    expect(world.characters).toEqual(first.characters);
    expect(world.variables).toEqual(first.variables);
    expect(turn.changes.filter(c => c.op !== "clock")).toEqual([]);
    expect(turn.events.some(e => e.npcAction?.source === "provider" && e.npcAction.kind === "move")).toBe(false);
    expect(turn.endTime-turn.startTime).toBe(2);
  });

  it("NPC 查阅现场证据只更新自己的知识，不把证据原文或秘密带入公开观察和决策", async () => {
    const first = palace();
    actor(first,"king").locationId = "archive";
    const steward = actor(first,"steward");
    steward.locationId = "archive";
    const secret = first.facts.find(f => f.id === "plot")!;
    secret.knownBy.push(steward.id);
    steward.knownFactIds.push(secret.id);
    const clue = first.facts.find(f => f.id === "ledger")!;
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => { decisions.push(ctx); return {kind:"inspect"}; }, dialogue: unspoken,
    });
    const {world,turn} = await runTurn(first, askSteward, provider);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].canInspect).toBe(true);
    expect(JSON.stringify(decisions[0])).not.toContain(secret.content.text);
    expect(JSON.stringify(decisions[0])).not.toContain(steward.goals[0]);
    expect(JSON.stringify(decisions[0])).not.toContain(clue.content.text);
    expect(actor(world,"steward").knownFactIds).toContain(clue.id);
    expect(world.facts.find(f => f.id === clue.id)?.knownBy).toContain(steward.id);
    expect(actor(world,"king")).toEqual(actor(first,"king"));
    const event = turn.events.find(e => e.npcAction?.kind === "inspect")!;
    expect(event.changes).toContainEqual({op:"learn", actor:steward.id, fact:clue.id});
    const publicView = JSON.stringify({state:projectWorld(world), turn:projectTurn(turn)});
    expect(publicView).not.toContain(secret.content.text);
    expect(publicView).not.toContain(clue.content.text);
    expect(turn.endTime-turn.startTime).toBe(2);
  });
});
