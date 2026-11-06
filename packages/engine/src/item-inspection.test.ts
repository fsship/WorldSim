import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { WorldState } from "@worldsim/shared";
import { projectTurn, runTurn } from "./index";

const screenshotInput = "我拿起王室印玺仔细看";
const carriedBy = (world: WorldState, item: string) =>
  world.characters.filter(person => person.inventory.includes(item)).map(person => person.id);
const wrongGuess = new MockLLMProvider({
  parse: () => ({kind:"use", item:"王室印玺"}),
  decideNpcAction: () => ({kind:"stay"}),
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
