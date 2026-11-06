import { describe, expect, it, vi } from "vitest";
import { MockLLMProvider, OpenAICompatibleProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { ParseContext, ResolveContext, ScheduledEvent, TurnPlan } from "@worldsim/shared";
import { runTurn, scheduleEvent } from "./index";

const condition = "百官到场";
const rumor = "有人问：“百官到场了吗？”厅门仍旧安静。";
const arrival = "六部的官员鱼贯进了议事厅，向国王施礼。";
function scene() {
  const world = createPalace("wait-at-a-visible-event");
  const base = world.queue.find(e => e.type === "notice")!;
  world.queue = [];
  const add = (id:string, at:number, text:string, extra:Partial<ScheduledEvent> = {}) =>
    scheduleEvent(world, {...base, id, at, text, important:false, perception:"local", locationId:"hall", ...extra});
  add("private", 481, "暗道中的私语。", {perception:"private"});
  add("rumor", 482, rumor);
  add("arrival", 484, arrival);
  add("second", 484, "门边有人掀起了帘子。");
  add("later", 487, "更晚才会发生的事情。");
  return world;
}
function realInterpretation(maxMinutes:number, resolve:(ctx:ResolveContext)=>Promise<{optionId:string}>) {
  const interpret = vi.fn(async (_:ParseContext):Promise<TurnPlan> => ({kind:"wait", event:condition, minutes:maxMinutes}));
  return Object.assign(new MockLLMProvider(), {interpret, resolve});
}

describe("等待中的语义判断只读取已经发生的可见动静", () => {
  it("略过提到原词的疑问，在换一种说法的事件实际发生时停下，同刻事件均获处理", async () => {
    const evidence: object[] = [];
    const fetcher: typeof fetch = async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      evidence.push(JSON.parse(body.messages[1].content));
      return Response.json({choices:[{message:{content:JSON.stringify({optionId:evidence.length === 2 ? "met" : "continue"})}}]});
    };
    const adapter = new OpenAICompatibleProvider({
      mode:"openai", baseUrl:"https://fixture.invalid/v1", model:"fixture", temperature:0.4, maxTokens:800, timeoutMs:1000, retries:0,
    }, fetcher);
    const {turn, world} = await runTurn(scene(), "等他们进来再叫我。", realInterpretation(10, adapter.resolve.bind(adapter)));
    expect(evidence).toEqual([{condition, notices:[rumor]}, {condition, notices:[rumor, arrival, "门边有人掀起了帘子。"]}]);
    expect(turn.endTime).toBe(484);
    expect(turn.narrative).toContain(arrival);
    expect(turn.narrative).not.toContain("暗道");
    expect(world.queue.find(e=>e.id === "later")?.status).toBe("pending");
  });

  it("时限内只有私下的动静，不询问模型，也不透露事件", async () => {
    const decide = vi.fn(async () => ({optionId:"met"}));
    const {turn} = await runTurn(scene(), "只等片刻。", realInterpretation(1, decide));
    expect(decide).not.toHaveBeenCalled();
    expect(turn.endTime).toBe(481);
    expect(turn.narrative).toContain("没有察觉到");
    expect(turn.narrative).not.toContain("暗道");
  });

  it("可见的重要事件无条件中断，仍按实际所见区分目标是否达成", async () => {
    const world = scene();
    world.queue.find(e=>e.id === "rumor")!.important = true;
    const decide = vi.fn(async () => ({optionId:"continue"}));
    const {turn} = await runTurn(world, "留在这里等人来。", realInterpretation(10, decide));
    expect(turn.endTime).toBe(482);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("判断出错时停在已发生的动静，不越过它也不冒称已等到", async () => {
    const {turn} = await runTurn(scene(), "留在这里等人来。", realInterpretation(10, async () => { throw Error("offline"); }));
    expect(turn.endTime).toBe(482);
    expect(turn.narrative).toContain(rumor);
    expect(turn.narrative).toContain("暂时无法确认");
    expect(turn.narrative).not.toContain(arrival);
  });
});
