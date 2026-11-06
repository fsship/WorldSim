import { describe, expect, it } from "vitest";
import { createPalace, loadScenarioWorld } from "@worldsim/scenarios";
import { MockLLMProvider } from "@worldsim/llm";
import { WorldStateSchema, type ParseContext, type TurnPlan } from "@worldsim/shared";
import { projectWorld, runTurn } from "./index";
import { advance } from "./scheduler";

describe("同一时钟上的玩家、其他角色和世界事件", () => {
  it("钟声打断等候后重载，继续原目标直到官员自己走进厅里", async () => {
    const world = createPalace("wait-for-attendance");
    advance(world,10,false,[]);
    const contexts:ParseContext[] = [];
    const p = Object.assign(new MockLLMProvider({
      decideNpcAction:ctx => {
        const due = ctx.appointments?.some(a => a.location === "议事厅");
        return due && ctx.currentTime === 500 && ctx.location === "档案室" ? {kind:"move",destination:"hall"} : {kind:"stay"};
      },
      resolve:ctx => ({optionId:ctx.waitEvidence?.notices.some(text => text.includes("走进议事厅")) ? "met" : "continue"}),
    }), {interpret:async (ctx:ParseContext):Promise<TurnPlan> => {
      contexts.push(ctx);
      return contexts.length === 1 ? {kind:"wait",event:"有参加点名的官员来到厅里",minutes:20} : {kind:"wait",resume:true};
    }});
    const first = await runTurn(world,"等参加点名的人来，至多二十分钟。",p);
    expect(first.world.time).toBe(495);
    expect(first.turn.observations.some(o => o.text.includes("钟声"))).toBe(true);
    const next = await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(first.world))),"接着等刚才那些人吧。",p);
    expect(contexts[1].previousWait).toMatchObject({event:"有参加点名的官员来到厅里",until:510});
    expect(next.world.time).toBe(500);
    expect(next.turn.observations.some(o => o.time === 500 && o.text.includes("走进议事厅"))).toBe(true);
    expect(next.world.characters.some(c => c.appointments?.length && c.locationId === "hall")).toBe(true);
    expect(next.turn.events.some(e => e.pendingWait)).toBe(false);
  });

  it("本回合在交谈，别处的角色仍可获得行动机会", async () => {
    const world = createPalace("while-speaking");
    advance(world,4,false,[]);
    const secretWords = "为什么要改名为白羽？";
    const remoteInputs:string[] = [];
    const speaking = new MockLLMProvider({
      decideNpcAction:ctx => {
        if (ctx.trigger === "addressed") return {kind:"speak"};
        if (ctx.location === "档案室") {
          remoteInputs.push(ctx.input);
          expect(JSON.stringify(ctx)).not.toContain(secretWords);
          return {kind:"move",destination:"garden"};
        }
        return {kind:"stay"};
      },
    });
    const result = await runTurn(world,"我向艾琳耳语：「" + secretWords + "」",speaking);
    expect(result.world.time).toBe(486);
    expect(remoteInputs).toEqual([""]);
    expect(result.turn.events.some(e => e.time === 485 && e.npcAction?.worldPulse && e.npcAction.kind === "move")).toBe(true);
    expect(result.turn.narrative).not.toContain("花园");
  });

  it.each([false,true])("通报里的卫兵实际在岗，能在宫门被点名交谈，也只登记一次 (%s)", async held => {
    const world = createPalace("watch-at-gate");
    world.variables.guardSecured = held;
    advance(world,51,false,[]);
    const id = held ? "original-watch" : "relief-watch";
    const watch = world.characters.find(c => c.id === id)!;
    expect(watch.locationId).toBe("gate");
    const report = world.queue.find(e => e.id === (held ? "intercepted" : "breach"))!;
    expect(watch.knownFactIds).toContain("notice/"+report.id);
    expect(world.history.find(e => e.source === report.id)?.changes).toContainEqual({op:"muster",event:report.id});
    expect(world.characters.filter(c => c.role === "宫门守卫")).toHaveLength(1);
    expect(projectWorld(world).present.map(c => c.id)).not.toContain(id);
    const quiet = new MockLLMProvider({decideNpcAction:ctx => ({kind:ctx.trigger === "addressed" ? "speak" : "stay"})});
    const arrival = await runTurn(world,"我去宫门",quiet);
    expect(projectWorld(arrival.world).present.map(c => c.id)).toContain(id);
    const spoken = await runTurn(arrival.world,"我对" + watch.name + "说：「宫门由谁值守？」",quiet);
    expect(spoken.turn.hearing?.listeners).toContain(watch.name);
    expect(spoken.turn.observations.some(o => o.kind === "dialogue" && o.speaker === watch.name)).toBe(true);

    const legacy = structuredClone(world);
    legacy.queue.forEach(e => {delete e.arrival;});
    legacy.characters = legacy.characters.filter(c => c.id !== id);
    const fixed = loadScenarioWorld(legacy);
    const again = loadScenarioWorld(fixed);
    expect(again.characters.filter(c => c.id === id)).toHaveLength(1);
    expect(again.time).toBe(531);
    expect(again.history).toEqual(legacy.history);
  });
});
