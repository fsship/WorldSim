import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createCustomScenario } from "@worldsim/scenarios";
import type { DialogueContext, NpcActionContext, ScenarioDefinition } from "@worldsim/shared";
import { prepareOpening, projectWorld, runTurn } from "./index";

const station: ScenarioDefinition = {
  title:"末班车", opening:"停运广播响起，站台上还留着两名旅客。",
  locations:[
    {id:"platform", name:"站台", description:"长椅旁有一张列车时刻表。"},
    {id:"office", name:"值班室", description:"窗边的电台等待接通。"},
  ],
  player:{name:"林秋", role:"调度员", locationId:"platform", goal:"确认末班车的去向"},
  npcs:[
    {name:"梁安", role:"列车员", locationId:"platform", duty:"向乘客解释停运安排", goal:"私下找到走失的弟弟"},
    {name:"周远", role:"电报员", locationId:"office", goal:"把旧电码藏好"},
  ],
  events:[{afterMinutes:3, locationId:"platform", text:"站台上的信号灯亮了。"}],
};

describe("自定义剧本的实际游玩", () => {
  it("只有角色本人的决策使用其目标，公开行动和回复只依据现场", async () => {
    const decisions: NpcActionContext[] = [], reviews: NpcActionContext[] = [], replies: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => {
        decisions.push(ctx);
        return {kind:"act", description:"抬手轻轻挥了挥", thenSpeak:true};
      },
      reviewNpcAction: ({context}) => {
        reviews.push(context);
        return {grounded:true, selfOnly:true};
      },
      dialogue: ctx => {
        replies.push(ctx);
        return {text:"我在站台上。", factIds:[]};
      },
      reviewDialogue: () => ({grounded:true, playerAgency:true, citationsAccurate:true}),
    });
    const world = await prepareOpening(createCustomScenario("station", "play", station), provider);
    const view = projectWorld(world);
    expect(view).toMatchObject({scenarioId:"station", player:{name:"林秋", role:"调度员", goal:station.player.goal}});
    expect(view.opening).toContain(station.opening);
    expect(view.opening).toContain("我在站台上。");
    expect(decisions[0]).toMatchObject({
      player:{name:"林秋", role:"调度员"}, npc:{name:"梁安"}, location:"站台",
      decision:expect.stringContaining("林秋"), personalGoals:[station.npcs[0].goal],
      recentNotices:expect.arrayContaining([expect.objectContaining({text:station.opening})]),
    });
    expect(reviews).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify([reviews, replies, view])).not.toContain(station.npcs[0].goal);
    expect(JSON.stringify(decisions)).not.toContain(station.npcs[1].goal);
    expect(JSON.stringify([decisions, reviews, replies])).not.toMatch(/国王|议事厅/);
  });

  it("现场事件中断等待，之后能走到自定义地点并与新遇到的角色交谈", async () => {
    const provider = new MockLLMProvider();
    const nightShift = {...station, startTime:23 * 60 + 58};
    const game = await prepareOpening(createCustomScenario("station", "play", nightShift), provider);
    const wait = await runTurn(game, "等待十分钟", provider);
    expect(game.time).toBe(nightShift.startTime);
    expect(wait.world.time).toBe(24 * 60 + 1);
    expect(wait.turn.narrative).toContain("站台上的信号灯亮了");
    const travel = await runTurn(wait.world, "走到值班室", provider);
    expect(projectWorld(travel.world).location.name).toBe("值班室");
    expect(travel.turn.events.find(event => event.source === "departure")?.text).toBe("林秋离开了站台。");
    const talk = await runTurn(travel.world, "我对周远说：“你好。”", provider);
    expect(talk.turn.hearing?.listeners).toEqual(["周远"]);
    expect(talk.turn.observations).toContainEqual(expect.objectContaining({kind:"dialogue", speaker:"周远"}));
  });

  it("自定义玩家姓名也受行动权和台词格式校验", async () => {
    const initial = createCustomScenario("station", "play", station);
    const forcedAction = new MockLLMProvider({
      decideNpcAction: () => ({kind:"act", description:"迫使林秋离开站台"}),
      reviewNpcAction: () => ({grounded:true, selfOnly:true}),
    });
    const action = projectWorld(await prepareOpening(initial, forcedAction));
    expect(action.openingUsedFallback).toBe(true);
    expect(action.opening).not.toContain("迫使林秋");
    const falseSpeaker = new MockLLMProvider({
      dialogue: () => ({text:"调度员：我决定离开。", factIds:[]}),
      reviewDialogue: () => ({grounded:true, playerAgency:true, citationsAccurate:true}),
    });
    const dialogue = projectWorld(await prepareOpening(initial, falseSpeaker));
    expect(dialogue.openingUsedFallback).toBe(true);
    expect(dialogue.opening).not.toContain("我决定离开");
  });
});
