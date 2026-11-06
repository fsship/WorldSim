import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { ParseContext, TurnPlan, WorldState } from "@worldsim/shared";
import { projectTurn, projectWorld, runTurn, scheduleEvent } from "./index";

const screenshotInput = "我拿起王室印玺仔细看";
const carriedBy = (world: WorldState, item: string) =>
  world.characters.filter(person => person.inventory.includes(item)).map(person => person.id);
const wrongGuess = new MockLLMProvider({
  parse: () => ({kind:"use", item:"王室印玺"}),
  decideNpcAction: () => ({kind:"stay"}),
});

it("同一趟送货能把物件和文书放到指定房间，玩家到场后可以分别按别名查看", async () => {
  const world = createPalace("workshop-delivery");
  const locationId = "bell-workshop";
  const availableAfterEvent = "foundry-courier";
  world.locations.push({id:locationId, name:"铸钟室", aliases:[], description:"窗下有一张木案。", ambience:"炉火正旺。", exits:["hall"]});
  world.locations.find(room => room.id === "hall")!.exits.push(locationId);
  const gauge = {id:"casting-gauge", name:"铸钟量规", aliases:["铜尺"], description:"用来核对钟壁的厚度。",
    appearance:"尺缘有三条朱砂刻线。", locationId, availableAfterEvent};
  const slip = {id:"inspection-slip", name:"检验手记", aliases:["验单"], locationId, availableAfterEvent,
    entries:[{title:"初验", text:"第一口钟的壁厚与样规相符。"}]};
  world.items.push(gauge);
  world.readables.push(slip);
  scheduleEvent(world, {...world.queue[0], id:availableAfterEvent, at:490, locationId, perception:"local", text:"工匠把两件货送到了木案上。"});

  const offline = new MockLLMProvider({decideNpcAction:() => ({kind:"stay"})});
  const beforeDelivery = await runTurn(world, "前往铸钟室", offline);
  expect(projectWorld(beforeDelivery.world).location.id).toBe(locationId);
  const stillInHall = await runTurn(world, "等待十分钟", offline);
  expect(stillInHall.world.queue.find(event => event.id === availableAfterEvent)?.status).toBe("executed");
  const input = "我端详铜尺";
  const interpretInspection = (visible: boolean) => Object.assign(new MockLLMProvider(), {
    async interpret(context: ParseContext): Promise<TurnPlan> {
      for (const object of [gauge, slip]) {
        const ref = context.referents?.find(ref => ref.id === object.id && ref.aliases.includes(object.aliases[0]));
        expect(Boolean(ref)).toBe(visible);
        expect(context.surroundings?.includes(object.name)).toBe(visible);
      }
      expect(JSON.stringify(context)).not.toContain(gauge.appearance);
      expect(JSON.stringify(context)).not.toContain(slip.entries[0].text);
      return {kind:"item", itemId:gauge.id, interaction:"inspect"};
    },
  });
  for (const inaccessible of [beforeDelivery.world, stillInHall.world]) {
    const {turn} = await runTurn(inaccessible, input, interpretInspection(false));
    expect(turn.resolution.status).toBe("refused");
    expect(turn.narrative).not.toContain(gauge.appearance);
  }

  const entered = await runTurn(stillInHall.world, "前往铸钟室", offline);
  const room = projectWorld(entered.world).location;
  expect(room.description).toContain(gauge.name);
  expect(room.description).toContain(slip.name);
  const inspected = await runTurn(entered.world, input, interpretInspection(true));
  expect(inspected.turn.narrative).toContain(gauge.appearance);
  expect((await runTurn(entered.world, input, offline)).turn.narrative).toContain(gauge.appearance);
  const bag = "我从背包里拿出铜尺仔细看";
  const bagPlan = Object.assign(new MockLLMProvider(), {
    async interpret(context: ParseContext): Promise<TurnPlan> {
      expect(context.referents?.find(ref => ref.id === gauge.id)?.carried).toBe(false);
      return {kind:"item", itemId:gauge.id, interaction:"handle_inspect", inventoryOnly:true};
    },
  });
  for (const provider of [offline, bagPlan]) {
    const {turn} = await runTurn(inspected.world, bag, provider);
    expect(turn.resolution.status).toBe("refused");
    expect(turn.narrative).not.toContain(gauge.appearance);
  }
  const read = await runTurn(inspected.world, "阅读验单", offline);
  expect(read.turn.narrative).toContain(slip.entries[0].text);
  expect(carriedBy(read.world, gauge.id)).toEqual([]);
  expect(projectWorld(read.world).player.items.map(item => item.id)).not.toContain(gauge.id);
});

describe("端详随身物品", () => {
  it("开局拿起王室印玺仔细看，纪事写出所见，印玺依然由国王持有", async () => {
    const initial = createPalace("royal-seal");
    const {world, turn} = await runTurn(initial, screenshotInput, new MockLLMProvider());
    expect(turn.resolution.status).toBe("resolved");
    expect(turn.observations.some(line => line.kind === "world" &&
      line.text.includes("王室印玺") && line.text.includes("黄铜"))).toBe(true);
    expect(projectTurn(turn).narrative).toContain("黄铜");
    expect(turn.narrative).toContain("印面");
    expect(turn.endTime - turn.startTime).toBe(1);
    expect(carriedBy(world, "seal")).toEqual(["king"]);
    expect(world.characters).toEqual(initial.characters);
    expect(world.facts).toEqual(initial.facts);
    expect(world.variables).toEqual(initial.variables);
    expect(turn.changes.every(c => c.op === "clock")).toBe(true);
    expect(turn.hearing).toBeUndefined();
    for (const hidden of initial.facts.filter(f => !f.knownBy.includes("king"))) {
      expect(turn.narrative).not.toContain(hidden.content.text);
    }
  });

  it("原文指定的别名指向自己的物品，后面的移动意图留给下一回合", async () => {
    const initial = createPalace("owned-custom-object");
    const object = {id:"bell", name:"小银铃", aliases:["铃铛"], description:"铃口刻着三条细线。"};
    initial.items.push(object);
    initial.characters.find(c => c.id === "king")!.inventory.push(object.id);
    const {world, turn} = await runTurn(initial, "我拿起铃铛仔细看，然后前往宫门", wrongGuess);
    expect(turn.resolution.status).toBe("resolved");
    expect(turn.narrative).toContain(object.description);
    expect(turn.narrative).not.toContain("黄铜");
    expect(turn.endTime - turn.startTime).toBe(1);
    expect(world.characters).toEqual(initial.characters);
    expect(turn.changes.every(c => c.op === "clock")).toBe(true);
  });

  it("另一个人持有物品时，引擎不能凭玩家或模型的声明替玩家取得它", async () => {
    const initial = createPalace("seal-with-another-person");
    initial.characters.find(c => c.id === "king")!.inventory = [];
    initial.characters.find(c => c.id === "steward")!.inventory.push("seal");
    const {world, turn} = await runTurn(initial, screenshotInput, wrongGuess);
    expect(turn.resolution.status).toBe("refused");
    expect(turn.endTime).toBe(turn.startTime);
    expect(turn.narrative).not.toContain("黄铜");
    expect(carriedBy(world, "seal")).toEqual(["steward"]);
    expect(turn.changes).toHaveLength(0);
  });

  it("两个随身物品共用别名时，需要更明确的对象", async () => {
    const initial = createPalace("ambiguous-seal");
    initial.items.push({id:"second-seal", name:"礼仪印章", aliases:["印玺"], description:"木柄上绕着细绳。"});
    initial.characters.find(c => c.id === "king")!.inventory.push("second-seal");
    const {world, turn} = await runTurn(initial, "我拿起印玺仔细看", wrongGuess);
    expect(turn.resolution.status).toBe("refused");
    expect(turn.narrative).not.toContain("木柄");
    expect(turn.narrative).not.toContain("黄铜");
    expect(world.characters).toEqual(initial.characters);
    expect(turn.changes).toHaveLength(0);
  });

  it.each(["我拿起王室印玺的画像仔细看", "我拿起假印玺仔细看"])("不能从另一个宾语中抠出印玺来执行：%s", async text => {
    const initial = createPalace("exact-item-binding");
    const {world, turn} = await runTurn(initial, text, wrongGuess);
    expect(turn.resolution.status).toBe("refused");
    expect(turn.narrative).not.toContain("黄铜");
    expect(world.characters).toEqual(initial.characters);
    expect(turn.changes).toHaveLength(0);
  });
});
