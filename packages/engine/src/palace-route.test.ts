import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace, loadScenarioWorld } from "@worldsim/scenarios";
import type { WorldState } from "@worldsim/shared";
import { runTurn } from "./index";
import { player } from "./state";

const courtRoomIds = ["hall","archive","gate","garden"];
function oldSave() {
  const world = createPalace("inspection-old-save");
  world.locations = world.locations.filter(room => courtRoomIds.includes(room.id));
  const gate = world.locations.find(room => room.id === "gate")!;
  gate.exits = ["hall","garden"];
  gate.description = "门楼下摆着换岗的长凳，铁门通向城中。";
  return world;
}

describe("从王宫往返河谷巡察", () => {
  it.each([
    ["新开局",()=>createPalace("inspection-new-save")],
    ["原地图的存档",()=>loadScenarioWorld(oldSave())],
  ] as const)("%s 可经三段城外路程抵达行宫，再沿原路返宫", async (_label,start) => {
    let world = start();
    const provider = new MockLLMProvider({decideNpcAction:()=>({kind:"stay"})});
    const path = ["gate","post-road","river-village","river-palace","river-village","post-road","gate","hall"];
    for (const [i,id] of path.entries()) {
      const from = world.locations.find(room => room.id === player(world).locationId)!;
      const to = world.locations.find(room => room.id === id)!;
      expect(from.exits).toContain(id);
      expect(to.exits).toContain(from.id);
      const result = await runTurn(world,"前往" + to.name,provider);
      expect(result.turn.resolution.optionId).toBe("travel");
      expect(result.turn.endTime).toBe(480 + (i + 1) * 5);
      expect(player(result.world).locationId).toBe(id);
      world = result.world;
    }
    expect(world.time).toBe(520);
  });

  it("补地图可重入，原先的进度和角色位置不变", () => {
    const old = oldSave();
    old.time = 532;
    player(old).locationId = "garden";
    const original = structuredClone(old);
    const withRoad = loadScenarioWorld(old);
    expect(withRoad.locations).toEqual(createPalace("canonical-map").locations);
    expect(withRoad.time).toBe(old.time);
    expect(withRoad.characters).toEqual(old.characters);
    expect(withRoad.history).toEqual(old.history);
    expect(old).toEqual(original);
    expect(loadScenarioWorld(withRoad).locations).toEqual(withRoad.locations);
  });

  it.each<[string,(w:WorldState)=>void]>([
    ["其他剧本",w => { w.scenario = "自定义边城"; }],
    ["自订宫门",w => { w.locations.find(r=>r.id === "gate")!.description = "城门已经封闭。"; }],
    ["自订路径",w => { w.locations.find(r=>r.id === "garden")!.exits = ["hall","gate"]; }],
    ["部分地图",w => { w.locations = w.locations.filter(r=>r.id !== "archive"); }],
    ["已有同标识村庄",w => {
      w.locations.push({id:"river-village",name:"我的村庄",aliases:[],description:"一处漕运码头。",ambience:"流水声。",exits:[]});
    }],
  ])("加载%s时保留已有地图", (_name, customize) => {
    const w = oldSave();
    customize(w);
    expect(loadScenarioWorld(w).locations).toEqual(w.locations);
  });
});
