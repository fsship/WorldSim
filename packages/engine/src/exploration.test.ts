import { expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createCustomScenario } from "@worldsim/scenarios";
import { WorldStateSchema, type ParseContext, type TurnPlan } from "@worldsim/shared";
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

const service = Object.assign(new MockLLMProvider(), {
  interpret:async (ctx:ParseContext):Promise<TurnPlan> => ({
    kind:"wait", event:"公交车", ...(ctx.text.includes("两分钟") ? {minutes:2} : {}),
    routine:{afterMinutes:5, notice:"一辆公交车停稳，打开了车门。"},
  }),
  resolve:async () => ({optionId:"met"}),
});

it("站台短等后读档，继续等到原班公交进站", async () => {
  const provider = new MockLLMProvider();
  const world = createCustomScenario("custom", "game", {worldInfo:"2026年的城市", opening:"你准备出门上班。"});
  const {world:station} = await runTurn(world, "前往公交站台", provider);
  const short = await runTurn(station, "我等待公交车到来，最多两分钟", service);
  expect(short.turn.endTime).toBe(487);
  expect(short.turn.narrative).not.toContain("打开了车门");
  expect(short.world.queue).toHaveLength(1);
  const arrived = await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(short.world))), "我等待公交车到来", provider);
  expect(arrived.turn.endTime).toBe(490);
  expect(arrived.turn.narrative).toContain("打开了车门");
  expect(arrived.world.queue).toHaveLength(1);
  expect(arrived.world.queue[0].status).toBe("executed");
});

it("乘车引用读档后仍可见的到站事件，车辆尚未到站或事件过期时无法引用", async () => {
  const offline = new MockLLMProvider();
  const initial = createCustomScenario("custom", "ride", {worldInfo:"2026年的城市", opening:"你准备出门上班。"});
  const station = await runTurn(initial, "我前往公交站台", offline);
  const bus = await runTurn(station.world, "我等待公交车到来", service);
  const arrival = bus.turn.events.find(event => event.text.includes("车门打开") || event.text.includes("打开了车门"))!;
  const provider = Object.assign(new MockLLMProvider(), {
    interpret:async (context:ParseContext):Promise<TurnPlan> => {
      if (context.currentNotices) expect(context.currentNotices).toContainEqual({id:arrival.id, text:arrival.text});
      return {kind:"ride", noticeId:arrival.id, destination:"公司"};
    },
  });
  const input = "我上车去公司上班";
  await expect(runTurn(station.world,input,provider)).rejects.toThrow("到站事件");
  const delayed = await runTurn(bus.world,"等待五分钟",offline);
  await expect(runTurn(delayed.world,input,provider)).rejects.toThrow("到站事件");
  const result = await runTurn(WorldStateSchema.parse(JSON.parse(JSON.stringify(bus.world))),input,provider);
  const lead = result.world.characters.find(actor => actor.kind === "player")!;
  expect(result.world.locations.find(place => place.id === lead.locationId)?.name).toBe("公司");
  expect(result.turn.changes.map(change => change.op)).toEqual(expect.arrayContaining(["depart","move"]));
  expect(result.turn.narrative).toContain("搭乘");
});
