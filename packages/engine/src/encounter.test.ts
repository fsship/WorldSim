import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createCustomScenario } from "@worldsim/scenarios";
import { WorldStateSchema, type EncounterContext, type ParseContext, type ScenarioDefinition } from "@worldsim/shared";
import { prepareOpening, projectWorld, retryOpening, runTurn } from "./index";
import { applyChanges } from "./state";

const scenario:ScenarioDefinition = {
  title:"雨港", worldInfo:"雨港里的店铺常有过客。", opening:"你刚进当铺，门铃响了。",
  locations:[{id:"shop",name:"当铺",description:"铺面通向后院。"}, {id:"yard",name:"后院",description:"院角有一口井。"}],
  player:{name:"白露",role:"行旅",locationId:"shop"}, npcs:[],
};
const keeper = {kind:"npc",name:"叶晚",role:"掌柜",duty:"接待客人",goal:"重购一把玉梳"};
const doctor = {kind:"npc",name:"夏扬",role:"医生",duty:"诊治伤者"};
const mail = {kind:"npc",name:"李远",role:"邮差",duty:"递送信件"};
const none = {kind:"none"};
const create = (s = scenario) => createCustomScenario("custom-rain", "game", s);
const save = (w:ReturnType<typeof create>) => WorldStateSchema.parse(JSON.parse(JSON.stringify(w)));

describe("剧情触发的临场人物", () => {
  it("开场人物真实在场，记得开场和后续交谈；重开及恢复沿用同一人", async () => {
    const calls:EncounterContext[] = [];
    const p = new MockLLMProvider({encounter:ctx => {calls.push(ctx); return keeper}});
    const original = create();
    const first = await prepareOpening(original,p);
    const who = first.characters[1];
    expect(original.characters).toHaveLength(1);
    expect(who).toMatchObject({name:"叶晚",role:"掌柜",publicDuty:"接待客人",goals:["重购一把玉梳"]});
    expect(first.history[0].noticeWitnessIds).toContain(who.id);
    expect(projectWorld(first).opening).toContain("遇见了掌柜·叶晚");
    expect(JSON.stringify(projectWorld(first))).not.toContain(keeper.goal);
    expect(await prepareOpening(save(first),p)).toEqual(save(first));
    const spoken = await runTurn(save(first), "我对掌柜说：“你好。”", p);
    expect(spoken.turn.hearing?.listeners).toEqual(["叶晚"]);
    expect(spoken.world.history.some(e => e.utterance?.speakerId === who.id && e.text.includes("当铺"))).toBe(true);
    const reload = save(spoken.world);
    expect(reload.characters[1].id).toBe(who.id);
    expect(calls.map(c => c.trigger)).toEqual(["opening"]);
  });

  it("无人开场先独处；主动敲门只判定一次，重试相同动作不重抽", async () => {
    const triggers:string[] = [];
    const p = new MockLLMProvider({encounter:ctx => {triggers.push(ctx.trigger); return none}});
    const first = await prepareOpening(create(),p);
    expect(projectWorld(first).opening).toBe(scenario.opening);
    expect(await prepareOpening(save(first),p)).toEqual(save(first));
    const wait = await runTurn(first, "等待二分钟",p);
    const knock = await runTurn(wait.world, "我敲门",p);
    const repeat = await runTurn(save(knock.world), "我敲门",p);
    expect(repeat.world.characters).toHaveLength(1);
    expect(triggers).toEqual(["opening","contact"]);
    expect(knock.turn.narrative).toContain("没有遇到新的交谈对象");
  });

  it("进新地点时补一次场景判断，异地人物不知开场，返回已到访地点不再抽角", async () => {
    const calls:EncounterContext[] = [];
    const p = new MockLLMProvider({encounter:ctx => {calls.push(ctx); return ctx.trigger === "opening" ? keeper : doctor}});
    const first = await prepareOpening(create(),p);
    const trip = await runTurn(first, "前往后院",p);
    expect(trip.turn.narrative).toContain("遇见了医生·夏扬");
    const traveler = trip.world.characters.find(c => c.name === doctor.name)!;
    expect(trip.world.history[0].noticeWitnessIds).not.toContain(traveler.id);
    expect(calls[1]).toMatchObject({location:{name:"后院"}, present:[]});
    expect(JSON.stringify(calls[1])).not.toContain(keeper.goal);
    const back = await runTurn(save(trip.world), "回到当铺",p);
    const again = await runTurn(back.world, "前往后院",p);
    expect(calls.map(c => c.trigger)).toEqual(["opening","arrival"]);
    expect(projectWorld(again.world).present).toEqual([{id:traveler.id, name:doctor.name, role:doctor.role}]);
  });

  it.each(["我寻找丢失的钥匙", "我找一个空箱子", "我对自己说：“找一位医生。”"])("离线不会把找物或引用误解为相遇：%s", async input => {
    const p = new MockLLMProvider({encounter:ctx => ctx.trigger === "opening" ? none : doctor});
    const initial = await prepareOpening(create(),p);
    const played = await runTurn(initial,input,p);
    expect(played.world.characters).toHaveLength(1);
    expect(played.turn.resolution.optionId).not.toBe("seek-contact");
  });

  it("寻人可以提及掌柜，同时在已有角色的现场寻找不同职业；有原话时同回合交谈", async () => {
    const base = await prepareOpening(create(),new MockLLMProvider({encounter:()=>keeper}));
    const input = "我请掌柜帮我找医生，问医生：“你能看伤吗？”";
    const contexts:ParseContext[] = [];
    const p = Object.assign(new MockLLMProvider({encounter: ctx => {
      expect(ctx.present).toEqual([{name:"叶晚",role:"掌柜"}]); return doctor;
    }}), {interpret:async (ctx:ParseContext) => {
      contexts.push(ctx);
      return ctx.allowEncounter ? {kind:"seekContact" as const,source:"请掌柜帮我找医生"} :
        {kind:"speak" as const, targetId:ctx.referents!.find(r => r.name === doctor.name)!.id, words:"你能看伤吗？", private:false};
    }});
    const met = await runTurn(base,input,p);
    expect(contexts.map(c=>!!c.allowEncounter)).toEqual([true,false]);
    expect(met.turn.hearing?.listeners).toEqual(["叶晚","夏扬"]);
    expect(met.turn.observations[0].text).toContain("遇见了医生·夏扬");
    expect(met.turn.observations).toContainEqual(expect.objectContaining({kind:"dialogue",speaker:"夏扬"}));
  });

  it("同分钟现场通报只判断一次，事件中的新人物只见证当时的本地事件", async () => {
    const callLog:EncounterContext[] = [];
    const p = new MockLLMProvider({encounter:ctx => {callLog.push(ctx); return ctx.trigger === "opening" ? keeper : mail}});
    const system = await prepareOpening(create({...scenario,events:[
      {afterMinutes:1,locationId:"yard",text:"后院来了另一位访客。"},
      {afterMinutes:3,locationId:"shop",text:"一名邮差推开店门。"},
      {afterMinutes:3,locationId:"shop",text:"柜台上的铃铛响了。"},
    ]}),p);
    const waiting = await runTurn(system,"等待十分钟",p);
    const courier = waiting.world.characters.find(c => c.name === mail.name)!;
    expect(callLog.map(c => c.trigger)).toEqual(["opening","event"]);
    expect(callLog[1].recent).toEqual(["一名邮差推开店门。","柜台上的铃铛响了。"]);
    expect(JSON.stringify(callLog[1])).not.toContain("后院来了另一位访客");
    expect(waiting.turn.narrative).toContain("遇见了邮差·李远");
    expect(waiting.world.history.filter(e => e.noticeWitnessIds?.includes(courier.id)).map(e => e.text)).toEqual([
      "一名邮差推开店门。","柜台上的铃铛响了。","你在当铺遇见了邮差·李远。",
    ]);
    const replay = save(system);
    for (const event of waiting.turn.events) applyChanges(replay, event.changes);
    expect(replay.characters).toEqual(waiting.world.characters);
    const later = await runTurn(save(waiting.world), "再等两分钟",p);
    expect(callLog).toHaveLength(2);
    expect(later.world.characters.filter(c => c.name === mail.name)).toHaveLength(1);
  });

  it("抵达新地点时，恰逢环境通报仍独立判断地点本身是否有人", async () => {
    const triggers:string[] = [];
    const p = new MockLLMProvider({encounter:ctx => {triggers.push(ctx.trigger); return ctx.trigger === "arrival" ? doctor : none}});
    const game = await prepareOpening(create({...scenario,events:[
      {afterMinutes:5,locationId:"yard",text:"井边的钟响了。"},
    ]}),p);
    const trip = await runTurn(game,"前往后院",p);
    expect(triggers).toEqual(["opening","event","arrival"]);
    expect(projectWorld(trip.world).present).toContainEqual(expect.objectContaining({name:doctor.name}));
  });

  it("开场请求异常可重试；成功建角后的答复异常只补原人物的答复", async () => {
    let calls = 0, writes = 0;
    const p = new MockLLMProvider({
      encounter:() => {if (++calls === 1) throw Error("temporarily unavailable"); return keeper},
      dialogue:() => {if (++writes === 1) throw Error("temporarily unavailable"); return {text:"欢迎。",factIds:[]}},
      reviewDialogue:() => ({grounded:true,playerAgency:true,citationsAccurate:true}),
    });
    const failed = await prepareOpening(create(),p);
    expect(projectWorld(failed)).toMatchObject({openingRetryable:true, present:[]});
    const generated = await retryOpening(save(failed),p);
    expect(projectWorld(generated).openingRetryable).toBe(true);
    const retry = await retryOpening(save(generated),p);
    expect(projectWorld(retry).opening).toContain("欢迎。");
    expect(retry.characters).toEqual(generated.characters);
    expect(calls).toBe(2);
    expect(writes).toBe(2);
  });

  it("移动时模型出错，已处理的旅行和时钟不会写入原存档", async () => {
    const p = new MockLLMProvider({encounter:ctx => {if (ctx.trigger === "arrival") throw Error("failed"); return none}});
    const initial = await prepareOpening(create(),p);
    const before = save(initial);
    await expect(runTurn(initial,"前往后院",p)).rejects.toThrow("failed");
    expect(save(initial)).toEqual(before);
  });
});
