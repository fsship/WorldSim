import { describe, expect, it, vi } from "vitest";
import { createPalace, loadScenarioWorld } from "@worldsim/scenarios";
import { MockLLMProvider } from "@worldsim/llm";
import { groupCountAt, type NpcActionContext, type ResolveContext } from "@worldsim/shared";
import { projectWorld, runTurn } from "./index";
import { advanceRegion } from "./regional";
import { advance } from "./scheduler";
import { detailedLocationIds } from "./npc-response";

describe("人群与远处地区", () => {
  it("往返巡察只展开眼前人口；朝会和早集照常进行，往返人数守恒", () => {
    const w = createPalace("coarse-census");
    const king = w.characters.find(c => c.id === "king")!;
    const initial = w.characters.length;
    const court = w.populationGroups.find(g => g.id === "court-officials")!;
    const village = w.populationGroups.find(g => g.id === "valley-residents")!;
    for (const time of [480,495,500,510,530,570,585,590,660]) {
      w.time = time;
      for (const g of [court,village])
        expect(w.locations.reduce((sum,l) => sum + groupCountAt(g,l.id,time),0)).toBe(g.size);
    }
    w.time = 510;
    king.locationId = "river-palace";
    expect(projectWorld(w).location.population).toEqual([]);
    expect(JSON.stringify(projectWorld(w).location)).not.toContain("各部属官");
    king.locationId = "hall";
    expect(projectWorld(w).location.population).toContainEqual({id:court.id,name:court.name,count:9,activity:court.work.task});
    king.locationId = "post-road";
    expect(projectWorld(w).location.population![0].count).toBe(120);
    w.time += 1440;
    expect(projectWorld(w).location.population![0].count).toBe(120);
    expect(groupCountAt(court,"hall",w.time)).toBe(0);
    expect(w.characters).toHaveLength(initial);
  });
  it("半小时结算一次远处的两项公务，逐人决策和通报不会泄露给国王", async () => {
    const world = createPalace("distant-court");
    advance(world,29,false,[]);
    world.characters.find(c => c.id === "king")!.locationId = "river-palace";
    const detailed:NpcActionContext[] = [];
    const regional:ResolveContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction:c => {detailed.push(c);return {kind:"stay"};},
      resolve:c => {regional.push(c);return {optionId:"go-both"};},
    });
    const result = await runTurn(world, "等待一分钟", provider);
    expect(result.world.time).toBe(510);
    expect(regional).toHaveLength(1);
    expect(regional[0].regionalDuty?.duties).toHaveLength(2);
    expect(detailed.every(c => ["河谷村","河谷行宫"].includes(c.location))).toBe(true);
    expect(result.turn.events.filter(e => e.npcAction?.regional && e.npcAction.kind === "move")).toHaveLength(2);
    expect(result.world.characters.filter(c => c.appointments?.length).map(c => c.locationId)).toEqual(["hall","hall"]);
    expect(result.turn.narrative).not.toMatch(/掌玺|诺亚|维克多|赴会|各部属官/);
    const reloaded = loadScenarioWorld(JSON.parse(JSON.stringify(result.world)));
    await advanceRegion(reloaded,provider,detailedLocationIds(reloaded));
    expect(regional).toHaveLength(1);
    await advanceRegion({...reloaded,time:511},provider,detailedLocationIds(reloaded));
    expect(regional).toHaveLength(1);
  });
  it("区域模型失败不会替角色赶路，普通居民没有逐人请求", async () => {
    const w = createPalace("distant-decision-failure");
    w.characters.find(c => c.id === "king")!.locationId = "river-palace";
    w.time = 510;
    w.populationGroups[1].size = 300_000;
    const n = w.characters.length;
    const resolve = vi.fn(() => {throw Error("offline");});
    await advanceRegion(w,new MockLLMProvider({resolve}),detailedLocationIds(w));
    expect(resolve).toHaveBeenCalledOnce();
    expect(w.characters).toHaveLength(n);
    expect(w.characters.filter(c => c.appointments?.length).every(c => c.locationId === "archive")).toBe(true);
    expect(groupCountAt(w.populationGroups[1],"post-road",510)).toBe(150_000);
  });
  it("场内等人能以人群实际到场为依据，不需要创建十八个单独角色", async () => {
    const w = createPalace("collective-arrival");
    advance(w,15,false,[]);
    const n = w.characters.length;
    const p = Object.assign(new MockLLMProvider({
      decideNpcAction:()=>({kind:"stay"}),resolve:c => ({optionId:c.waitEvidence?.notices.some(t=>t.includes("3名各部属官来到议事厅")) ? "met":"continue"}),
    }), {interpret:async () => ({kind:"wait",event:"属官到场",minutes:20} as const)});
    const {world,turn} = await runTurn(w,"等到点名的人抵达。",p);
    expect(world.time).toBe(500);
    expect(turn.observations).toContainEqual({kind:"world",time:500,text:"3名各部属官来到议事厅，眼前已有3人。"});
    expect(world.characters).toHaveLength(n);
  });
});
