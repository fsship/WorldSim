import { describe, expect, it } from "vitest";
import type { NpcActionContext, TurnPlan, WorldState } from "@worldsim/shared";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { chooseNpcAction, commitNpcAction, type NpcActionChoice, type NpcOrder } from "./npc-action";
import { perceive, player, projectWorld } from "./state";

const fresh = () => createPalace("npc-action-check");
const actor = (w: WorldState) => w.characters.find(c => c.id === "steward")!;

describe("NPC 的动作权限和感知", () => {
  it("目的地必须是当前相邻房间，模型连同篡改后的上下文返回的目的地也不能执行", async () => {
    const w = fresh(), npc = actor(w);
    const provider = new MockLLMProvider({decideNpcAction: ctx => {
      ctx.exits.push({id:"outside", name:"测试目的地"});
      return {kind:"move", destination:"outside"};
    }});
    const before = structuredClone(w);
    const choice = await chooseNpcAction(w, npc, "", "自主行动。", [], provider, "ambient");
    expect(choice).toEqual({proposal:{kind:"stay"},source:"fallback"});
    expect(commitNpcAction(w, npc, choice)).toBeUndefined();
    expect(w).toEqual(before);
  });

  it("只描述当前可见的离开或到达；时钟、玩家、未来事件不受影响", () => {
    const w = fresh(), npc = actor(w), king = structuredClone(player(w)), queue = structuredClone(w.queue);
    const move = (destination: string): NpcActionChoice => ({source:"provider", proposal:{kind:"move", destination}});
    const out = commitNpcAction(w, npc, move("archive"))!;
    expect(out).toMatchObject({kind:"world", locationId:"hall", recipients:[king.id], npcAction:{actorId:npc.id,kind:"move",source:"provider"}});
    expect(perceive(out, w)?.text).toContain("离开议事厅");
    expect(out.changes).toEqual([{op:"move",actor:npc.id,to:"archive"}]);
    const remote = commitNpcAction(w, npc, move("garden"))!;
    expect(perceive(remote, w)).toBeUndefined();
    expect(remote.recipients).toEqual([]);
    const arrival = commitNpcAction(w, npc, move("hall"))!;
    expect(perceive(arrival, w)?.text).toBe("艾琳走进议事厅。");
    expect(w.time).toBe(480);
    expect(player(w)).toEqual(king);
    expect(w.queue).toEqual(queue);
  });

  it("幕外 NPC 只收到其房间的公开环境，调查所得仅写入该 NPC 知识", async () => {
    const w = fresh(), npc = actor(w);
    npc.locationId = "archive";
    const traces: NpcActionContext[] = [];
    const provider = new MockLLMProvider({decideNpcAction: ctx => { traces.push(ctx); return {kind:"inspect"}; }});
    const choice = await chooseNpcAction(w, npc, "玩家在远处的私人发言", "远处尚未公开的命令", [], provider, "ambient");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({location:"档案室",input:"",history:[],canInspect:true});
    expect(traces[0].present.map(p => p.name)).toEqual(["维克多","诺亚"]);
    expect(JSON.stringify(traces)).not.toMatch(/远处|伪诏|缺了应有的副署/);
    const fact = w.facts.find(f => f.id === "ledger")!;
    const event = commitNpcAction(w, npc, choice)!;
    expect(event.changes).toEqual([{op:"learn",actor:npc.id,fact:fact.id}]);
    expect(event.text).not.toContain(fact.content.text);
    expect(perceive(event, w)).toBeUndefined();
    expect(npc.knownFactIds).toContain(fact.id);
    expect(projectWorld(w).facts.map(f => f.id)).not.toContain(fact.id);
    expect(commitNpcAction(w, npc, choice)?.changes).toEqual([]);
  });

  it("未来材料和私密约定不能通过检查地点解锁", async () => {
    const w = fresh(), npc = actor(w);
    npc.locationId = "archive";
    w.facts.find(f => f.id === "ledger")!.createdAt = w.time + 1;
    w.rules.discoveries.push({locationId:"archive",factId:"plot",description:"未授权",objects:[]});
    let canInspect;
    const p = new MockLLMProvider({decideNpcAction: ctx => { canInspect = ctx.canInspect; return {kind:"inspect"}; }});
    const inspection = await chooseNpcAction(w,npc,"","独立行动。",[],p,"ambient");
    expect(inspection.source).toBe("provider");
    expect(canInspect).toBe(true);
    expect(commitNpcAction(w,npc,inspection)?.changes).toEqual([]);
    expect(npc.knownFactIds).not.toContain("plot");
    expect(npc.knownFactIds).not.toContain("ledger");
  });

  it("提交时重新验证行动资格、真实邻接和真正的 NPC 身份", () => {
    const w = fresh(), npc = actor(w);
    const move: NpcActionChoice = {source:"provider",proposal:{kind:"move", destination:"gate"}};
    // Valid when the proposal was made in the hall, no longer possible from the archive.
    npc.locationId = "archive";
    expect(commitNpcAction(w,npc,move)).toBeUndefined();
    npc.condition = "detained";
    expect(commitNpcAction(w,npc,{source:"provider",proposal:{kind:"gesture", gesture:"bow"}})).toBeUndefined();
    expect(commitNpcAction(w,player(w),move)).toBeUndefined();
    expect(w.history).toHaveLength(2);
  });

  it("卫队长明确接受可执行的命令才应用引擎核准的效果", async () => {
    const w = fresh(), captain = w.characters.find(c => c.id === "captain")!;
    const order: NpcOrder = {summary:"加强宫门守备", changes:[{op:"flag",name:"guardSecured",value:true}]};
    const seen: NpcActionContext[] = [];
    const p = new MockLLMProvider({decideNpcAction: ctx => {seen.push(ctx); return {kind:"carryOutOrder"};}});
    const decide = (trigger: NpcActionContext["trigger"], instruction?: NpcOrder) =>
      chooseNpcAction(w,captain,"请加强宫门守备","决定如何回应。",[],p,trigger,instruction);
    expect((await decide("ambient",order)).source).toBe("fallback");
    expect((await decide("addressed")).source).toBe("fallback");
    const assigned = await decide("addressed",order);
    expect(assigned.source).toBe("provider");
    expect(seen.map(c => c.order)).toEqual([undefined,undefined,"加强宫门守备"]);
    expect(JSON.stringify(seen)).not.toContain("guardSecured");
    expect(commitNpcAction(w,captain,{source:"provider",proposal:{kind:"stay"}},"npc-action",order)).toBeUndefined();
    expect(commitNpcAction(w,captain,assigned,"npc-action",{summary:"",changes:[{op:"clock",to:10000}]})).toBeUndefined();
    expect(w.variables.guardSecured).toBe(false);
    expect(commitNpcAction(w,captain,assigned,"npc-action",order)?.changes).toEqual(order.changes);
    expect(w.variables.guardSecured).toBe(true);
    expect(w.time).toBe(480);
  });
});

describe("自由动作原文的审核和提交", () => {
  it("耳语中的动作按全场可见的依据审核，私下的原话只用于角色决定", async () => {
    const w = fresh(), npc = actor(w), aside = "我们私下称它为青石。";
    const contexts: NpcActionContext[] = [];
    const p = new MockLLMProvider({
      decideNpcAction: ctx => { contexts.push(ctx); return {kind:"act", description:"微微抬起头"}; },
      reviewNpcAction: ({context}) => { contexts.push(context); return {grounded:true, selfOnly:true}; },
    });
    const choice = await chooseNpcAction(w, npc, aside, "国王正低声说话。", [], p, "addressed", undefined, undefined, ["king"]);
    expect(choice.source).toBe("provider");
    expect(contexts.map(ctx => ctx.listeners)).toEqual([["国王"], ["国王", "罗兰"]]);
    expect(contexts[0].input).toBe(aside);
    expect(JSON.stringify(contexts[1])).not.toContain(aside);
  });
  it.each(["收回目光，把手安稳地叠在身前", "微微侧过头，停了一拍。"])("只呈现经独立审核的原地动作 %s", async description => {
    const w = fresh(), npc = actor(w), original = structuredClone(w);
    const reviews: string[] = [];
    const p = new MockLLMProvider({
      decideNpcAction: () => ({kind:"act", description, thenSpeak:true}),
      reviewNpcAction: ({context, proposal}) => {
        expect(context.npc.name).toBe(npc.name);
        reviews.push(proposal.description);
        return {grounded:true,selfOnly:true};
      },
    });
    const choice = await chooseNpcAction(w,npc,"","自行开场。",[],p,"opening");
    expect(reviews).toEqual([description]);
    const event = commitNpcAction(w,npc,choice,"opening");
    expect(event?.text).toBe(npc.name + description + (description.endsWith("。") ? "" : "。"));
    expect(event).toMatchObject({kind:"world",changes:[],npcAction:{actorId:npc.id,kind:"act",source:"provider"}});
    expect(w.characters).toEqual(original.characters);
    expect(w.variables).toEqual(original.variables);
    expect(w.facts).toEqual(original.facts);
    expect(w.time).toBe(original.time);
    expect(commitNpcAction(w,npc,choice,"opening")).toBeUndefined(); // the approved draft was already consumed
  });

  it("在送审之前拦下私密文字、控制玩家、越过相邻位置及混入的台词", async () => {
    const w = fresh(), npc = actor(w);
    const privateFact = w.facts.find(f => f.type === "secret")!.content.text;
    const historyLength = w.history.length;
    for (const text of [privateFact.replace("维克多","维、克、多"), "迫使国王跪下", "走进档案室", "大声喊道：门开了", "<script>x()</script>"]) {
      let reviewed = 0;
      const p = new MockLLMProvider({
        decideNpcAction: () => ({kind:"act", description:text}),
        reviewNpcAction: () => { reviewed++; return {grounded:true,selfOnly:true}; },
      });
      const choice = await chooseNpcAction(w,npc,"","自行反应。",[],p,"addressed");
      expect(choice).toEqual({proposal:{kind:"stay"},source:"fallback"});
      expect(reviewed).toBe(0);
      expect(commitNpcAction(w,npc,choice)).toBeUndefined();
    }
    expect(w.history).toHaveLength(historyLength);
  });

  it.each([
    {description:"走到长桌旁，望向宫门的方向", grounded:true, selfOnly:true},
    {description:"走进档案室", grounded:false, selfOnly:true},
    {description:"迫使国王跪下", grounded:true, selfOnly:false},
  ])("模型复核原地动作的含义：$description", async ({description, grounded, selfOnly}) => {
    const w = fresh(), npc = actor(w);
    const initialCharacters = structuredClone(w.characters);
    const reviewed: string[] = [];
    const provider = Object.assign(new MockLLMProvider({
      decideNpcAction: () => ({kind:"act",description}),
      reviewNpcAction: ({proposal}) => {
        reviewed.push(proposal.description);
        return {grounded, selfOnly};
      },
    }), {interpret:async (): Promise<TurnPlan> => ({kind:"look"})});
    const choice = await chooseNpcAction(w, npc, "", "自行反应。", [], provider, "ambient");
    expect(reviewed).toEqual([description]);
    const event = commitNpcAction(w, npc, choice);
    if (grounded && selfOnly) {
      expect(event).toMatchObject({text:npc.name + description + "。", changes:[]});
    } else {
      expect(event).toBeUndefined();
    }
    expect(w.characters).toEqual(initialCharacters);
  });

  it("复核拒绝的动作、伪造来源及改变过的提案都不能提交", async () => {
    const w = fresh(), npc = actor(w);
    const proposal = {kind:"act" as const, description:"略微抬起头", thenSpeak:true};
    const provider = (approved: boolean) => new MockLLMProvider({
      decideNpcAction: () => proposal,
      reviewNpcAction: () => ({grounded:approved, selfOnly:true}),
    });
    const decide = (approved: boolean) => chooseNpcAction(w,npc,"","独立行动。",[],provider(approved),"addressed");
    const rejected = await decide(false);
    expect(rejected).toEqual({proposal:{kind:"stay"},source:"fallback"});
    expect(commitNpcAction(w,npc,{source:"provider",proposal})).toBeUndefined();

    const accepted = await decide(true);
    const forged = structuredClone(accepted);
    expect(commitNpcAction(w,npc,forged)).toBeUndefined();
    accepted.proposal = {...proposal,description:"转头看向另一侧"};
    expect(commitNpcAction(w,npc,accepted)).toBeUndefined();
    accepted.proposal = proposal;
    expect(commitNpcAction(w,npc,accepted)).toBeUndefined();

    const switched = await decide(true);
    switched.proposal = {kind:"move",destination:"gate"};
    expect(commitNpcAction(w,npc,switched)).toBeUndefined();
    const wrongActor = await decide(true);
    expect(commitNpcAction(w,w.characters.find(c => c.id === "captain")!,wrongActor)).toBeUndefined();
    const wrongRoom = await decide(true);
    npc.locationId = "archive";
    expect(commitNpcAction(w,npc,wrongRoom)).toBeUndefined();
    expect(w.history).toHaveLength(2);
    expect(player(w).locationId).toBe("hall");
  });
});
