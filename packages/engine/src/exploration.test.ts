import { expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createCustomScenario } from "@worldsim/scenarios";
import { WorldStateSchema, type TurnPlan } from "@worldsim/shared";
import { runTurn } from "./index";

it.each(["offline","semantic"])("默认地图可以前往第一站，存档恢复后可原路返回（%s）", async mode => {
  const initial = createCustomScenario("custom", "game", {worldInfo:"2026年的城市", opening:"你准备出门上班。"});
  const offline = new MockLLMProvider();
  const provider = mode === "offline" ? offline : Object.assign(new MockLLMProvider(), {
    interpret:async ():Promise<TurnPlan> => ({kind:"explore", destination:"公交站台"}),
  });
  const input = "我前往公交站台，准备去公司上班";
  const arrived = await runTurn(initial, input, provider);
  expect(arrived.world.locations.map(place => place.name)).toEqual(["开场地点","公交站台"]);
  const station = arrived.world.locations[1];
  expect(arrived.world.characters[0].locationId).toBe(station.id);
  expect(arrived.world.time).toBe(initial.time + 5);
  expect(arrived.turn.changes.map(change => change.op)).toContain("discoverPlace");
  const back = await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(arrived.world))), "返回开场地点", offline);
  expect(back.world.characters[0].locationId).toBe("start");
  const again = await runTurn(back.world, input, offline);
  expect(again.world.characters[0].locationId).toBe(station.id);
  expect(again.world.locations).toHaveLength(2);
});
