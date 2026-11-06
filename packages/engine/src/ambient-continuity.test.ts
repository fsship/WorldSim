import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { groupCountAt, WorldStateSchema, type NpcActionContext } from "@worldsim/shared";
import { runTurn } from "./index";
import { chooseNpcAction, commitNpcAction } from "./npc-action";
import { advance } from "./scheduler";
import { perceive } from "./state";

describe("等待时在场 NPC 的连续感知", () => {
  it("连续等待时，下一位 NPC 看得到刚刚的行礼，可以自行决定安静留下", async () => {
    const world = createPalace("ongoing-wait");
    advance(world, 15, false, []);
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({decideNpcAction:ctx => {
      decisions.push(ctx);
      return ctx.recentActions?.length ? {kind:"stay"} : {kind:"gesture", gesture:"bow"};
    }});
    const first = await runTurn(world, "继续等待", provider);
    const second = await runTurn(WorldStateSchema.parse(first.world), "继续等待", provider);
    const gesture = first.turn.events.find(e => e.npcAction?.kind === "gesture" && e.locationId === "hall")!;
    const inHall = decisions.filter(ctx => ctx.location === "议事厅");
    expect(inHall).toHaveLength(2);
    expect(inHall[1].npc.name).not.toBe(inHall[0].npc.name);
    expect(inHall[0].recentNotices?.map(n => n.time)).toContain(495);
    expect(inHall[1].recentActions).toEqual([{time:500, text:gesture.text}]);
    const officials = world.populationGroups.find(g => g.id === "court-officials")!;
    expect(groupCountAt(officials,"hall",505)).toBeGreaterThan(groupCountAt(officials,"hall",500));
    for (const ctx of inHall) expect(ctx.decision).toContain("已经过了5分钟");
    for (const ctx of decisions.filter(ctx => ctx.location !== "议事厅")) expect(ctx.decision).not.toContain("国王仍在原处");
    expect(second.world.time).toBe(505);
    expect(second.turn.observations.some(o => o.text === gesture.text)).toBe(false);
    expect(second.turn.events.some(e => e.npcAction?.kind === "stay" && e.npcAction.source === "provider")).toBe(true);
  });

  it("侍从记得自己亲眼见过的动作，但公开动作审查不会把新来的旁听者当成当时的见证人", async () => {
    const world = createPalace("private-action-memory");
    world.time = 500;
    const steward = world.characters.find(c => c.id === "steward")!;
    const captain = world.characters.find(c => c.id === "captain")!;
    const bow = commitNpcAction(world,captain,{source:"provider",proposal:{kind:"gesture",gesture:"bow"}})!;
    world.time = 505;
    const decisions: NpcActionContext[] = [], reviews: NpcActionContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction:ctx => {decisions.push(ctx);return {kind:"act",description:"理了理衣袖"};},
      reviewNpcAction:({context}) => {reviews.push(context);return {grounded:true,selfOnly:true};},
    });
    const choice = await chooseNpcAction(world,steward,"","依据亲历的动静自行决定。",[],provider,"ambient");
    expect(choice.source).toBe("provider");
    expect(decisions[0].recentActions).toEqual([{text:bow.text,time:500}]);
    expect(reviews[0].recentActions).toEqual([]);
    expect(JSON.stringify(reviews[0])).not.toContain(bow.text);
  });

  it("晚到的人不会因为现在在场而回忆起之前的动作；未盖见证戳的老存档同样从严读取", async () => {
    const world = createPalace("witnessed-acts"), byId = (id:string) => world.characters.find(c => c.id === id)!;
    const actor = byId("steward"), late = byId("captain");
    late.locationId = "archive";
    const event = commitNpcAction(world, actor, {source:"provider", proposal:{kind:"gesture",gesture:"bow"}})!;
    expect(event.npcAction?.witnessIds).toEqual(expect.arrayContaining(["king", "steward"]));
    expect(event.npcAction?.witnessIds).not.toContain(late.id);
    late.locationId = actor.locationId;
    expect(perceive(event, world, late)).toBeUndefined();
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({decideNpcAction:ctx => {decisions.push(ctx); return {kind:"stay"};}});
    await chooseNpcAction(world, late, "", "有何动静？", [], provider, "ambient");
    delete event.npcAction!.witnessIds;
    await chooseNpcAction(world, late, "", "有何动静？", [], provider, "ambient");
    expect(decisions.map(c => c.recentActions)).toEqual([[], []]);
  });
});
