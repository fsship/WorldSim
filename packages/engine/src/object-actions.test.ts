import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { ActionIntent } from "@worldsim/shared";
import { runTurn } from "./index";

const offline = new MockLLMProvider();
const archive = async () => (await runTurn(createPalace("object-actions"), "前往档案室", offline)).world;

describe("按玩家实际表达的动作和宾语裁决", () => {
  it("用手或用力做事不要求背包里有一件同名物品", async () => {
    for (const text of ["我用手拍了拍桌沿", "我用力推了一下长桌"]) {
      const {turn} = await runTurn(createPalace("instrument"), text, offline);
      expect(turn.intent.kind).toBe("attempt");
      expect(turn.resolution.status).not.toBe("refused");
    }
    for (const text of ["我用双手拿起印玺", "我用手里的王印"]) {
      expect((await runTurn(createPalace("held"), text, offline)).turn.resolution.optionId).toBe("use");
    }
  });
  it.each(["我把王室印玺拿出来", "我从背包里取出印玺。", "我向艾琳出示我的王印"])("可使用自己持有的物品：%s", async text => {
    const result = await runTurn(createPalace("item"), text, offline);
    expect(result.turn.resolution.optionId).toBe("use");
    expect(result.turn.endTime - result.turn.startTime).toBe(1);
  });
  it.each(["我仔细看了看登记簿", "翻看桌上的值夜登记簿。", "我把这本登记簿翻阅了一遍", "我查看桌上那本登记簿"])("在档案室调查原文指定的物件：%s", async text => {
    const result = await runTurn(await archive(), text, offline);
    expect(result.turn.resolution.optionId).toBe("discover");
    expect(result.turn.changes).toContainEqual({op:"learn", actor:"king", fact:"ledger"});
  });
  it("换了语序仍须有指向被拘押者的证据", async () => {
    const world = await archive();
    const input = "我把掌玺大臣拘押起来。";
    expect((await runTurn(world, input, offline)).turn.narrative).toContain("可核验凭据");
    const studied = await runTurn(world, "查阅登记簿", offline);
    const arrested = await runTurn(studied.world, input, offline);
    expect(arrested.turn.changes).toContainEqual({op:"detain", actor:"minister"});
  });
  it.each(["我请卫队长加强宫门守备", "请罗兰在城门加强守备"])("客气地下指令仍需卫队长自己决定是否执行：%s", async text => {
    const world = createPalace("request");
    expect((await runTurn(world, text, offline)).world.variables.guardSecured).toBe(true);
    const declines = new MockLLMProvider({decideNpcAction: () => ({kind:"stay"})});
    expect((await runTurn(world, text, declines)).world.variables.guardSecured).toBe(false);
  });
  it.each<[string, ActionIntent["kind"]]>([
    ["我把印玺的画像拿出来","use"], ["我从艾琳的口袋里取出印玺","use"],
    ["我不打算把印玺拿出来","use"], ["我让艾琳取出印玺","use"],
    ["我问：要不要查阅登记簿？","investigate"], ["把值夜登记簿放在一边，查看鞋印","investigate"],
    ["我要检查的是登记簿旁边的鞋印","investigate"], ["我把掌玺大臣的侍从拘押起来","arrest"],
    ["如果他来了，我就把掌玺大臣拘押起来","arrest"], ["把掌玺大臣拘押起来吗？","arrest"],
    ["逮捕维克多，别真的拘押他","arrest"], ["我命令卫队长加强宫门守备，不，我收回命令。","order"],
    ["我请卫队长的朋友加强宫门守备","order"], ["我请卫队长加强档案室守备","order"],
    ["我命令卫队长加强对宫门守备问题的调查","order"], ["我请卫队长考虑是否加强宫门守备","order"],
  ])("模型误判也不能替玩家绑定对象或授权状态变更：%s", async (text, kind) => {
    const world = kind === "investigate" || kind === "arrest" ? await archive() : createPalace("wrong-object");
    if (kind === "arrest") {
      world.characters.find(c => c.id === "king")!.knownFactIds.push("ledger");
      world.facts.find(f => f.id === "ledger")!.knownBy.push("king");
    }
    const result = await runTurn(world, text, new MockLLMProvider({parse:() => ({kind, target:"卫队长", item:"王室印玺"})}));
    expect(result.turn.changes.some(c => c.op === "learn" || c.op === "detain" || c.op === "flag")).toBe(false);
    expect(result.turn.resolution.optionId).not.toBe("use");
  });
});
