import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { DialogueContext, GameTurn } from "@worldsim/shared";
import { runTurn } from "./index";

const openingQuestion = "“有哪些消息？”我问道";
const followup = '我不满地回复"可是我现在就在议事厅啊？回答我的问题！"';
const accepted = {grounded:true, playerAgency:true, citationsAccurate:true};

function spokenAnswer(turn: GameTurn, name: string): string {
  const dialogue = turn.observations.filter(o => o.kind === "dialogue");
  expect(dialogue.map(o => o.speaker)).toEqual([name]);
  return dialogue[0].text;
}

describe("有范围的多轮 NPC 对话历史", () => {
  it("连续三轮把双方实际说过的话按顺序送给同一 NPC，直接显示每次新的生成文本", async () => {
    const firstReply = "晨会在议事厅举行，这是我眼下能确认的消息。";
    const secondReply = "是，陛下，我们就在议事厅。除此之外我还没有确切消息。";
    const lastReply = "我先前能确认的只有那份晨会议程。";
    const contexts: DialogueContext[] = [];
    const replies = [firstReply, secondReply, lastReply];
    const p = new MockLLMProvider({
      // All three inputs explicitly authorize only speech.
      parse: () => ({kind:"move", target:"宫门"}),
      dialogue: ctx => {
        const i = contexts.length;
        contexts.push(structuredClone(ctx));
        return {text:replies[i], factIds:i === 1 ? [] : ["assembly"]};
      },
      reviewDialogue: () => accepted,
    });
    const start = createPalace("followup");
    const first = await runTurn(start, openingQuestion, p);
    const second = await runTurn(JSON.parse(JSON.stringify(first.world)), followup, p);
    const third = await runTurn(second.world, '“回到我起初的问题，你刚才说能确认的是哪件事？”我问道', p);
    expect([first, second, third].map(r => spokenAnswer(r.turn, "艾琳"))).toEqual(replies);
    expect(contexts).toHaveLength(3);
    const turns = contexts[2].history;
    const firstQuestionIndex = turns.findIndex(line => line.role === "player" && line.text.includes("有哪些消息"));
    const secondQuestionIndex = turns.findIndex(line => line.role === "player" && line.text.includes("回答我的问题"));
    expect(firstQuestionIndex).toBeGreaterThanOrEqual(0);
    expect(turns[firstQuestionIndex + 1]).toEqual({role:"npc", text:firstReply});
    expect(secondQuestionIndex).toBeGreaterThan(firstQuestionIndex + 1);
    expect(turns[secondQuestionIndex + 1]).toEqual({role:"npc", text:secondReply});
    expect(contexts[1].input).toContain("回答我的问题");
    expect(third.world.characters.find(c => c.kind === "player")).toEqual(start.characters.find(c => c.kind === "player"));
    expect(third.world.facts).toEqual(start.facts);
    for (const {turn} of [first, second, third]) {
      expect(turn.changes.every(change => change.op === "clock")).toBe(true);
      expect(turn.endTime - turn.startTime).toBeLessThanOrEqual(start.rules.maxShort);
    }
  });

  it("旧日志仅还原能够证明的 NPC 发言；中间的系统拒绝不能凭空生成历史玩家问题", async () => {
    const world = createPalace("legacy-followup");
    world.time = 482;
    world.version = 2;
    for (const event of world.history) Reflect.deleteProperty(event, "utterance");
    const oldReply = "陛下，今日的晨会将在议事厅举行。";
    world.history.push({
      id:"old-report", time:482, kind:"npc", source:"action", speaker:"罗兰",
      text:oldReply, perception:"addressed", recipients:["king"], locationId:"hall", changes:[],
    }, {
      id:"old-refusal", time:482, kind:"system", source:"action", text:"请说明你想向谁说些什么。",
      perception:"addressed", recipients:["king"], locationId:"hall", changes:[],
    });
    const contexts: DialogueContext[] = [];
    const p = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:"您就在议事厅，我没有其他可核实的消息。", factIds:[]}; },
      reviewDialogue: () => accepted,
    });
    const result = await runTurn(JSON.parse(JSON.stringify(world)), '我低声对罗兰说：“可是我现在就在议事厅啊？回答我的问题！”', p);
    expect(spokenAnswer(result.turn, "罗兰")).toContain("其他");
    expect(contexts[0].history).toEqual([{role:"npc", text:oldReply}]);
    expect(result.world.history.slice(0, world.history.length)).toEqual(world.history);
  });

  it("转向同在场的 NPC 时可延续此前对话，隔壁房间的人没有那段记忆", async () => {
    const contexts: DialogueContext[] = [];
    const p = new MockLLMProvider({
      dialogue: ctx => {
        contexts.push(ctx);
        return {text:"我会仔细听您的问题。", factIds:[]};
      },
      reviewDialogue: () => accepted,
    });
    const first = await runTurn(createPalace("new-listener"), '我告诉艾琳：“这是我们刚才谈到的话。”', p);
    const next = await runTurn(first.world, '我向罗兰追问：“你知道什么消息？”', p);
    expect(contexts[1].speaker.name).toBe("罗兰");
    expect(contexts[1].history).toEqual(expect.arrayContaining([
      {role:"player", text:"这是我们刚才谈到的话。"},
      {role:"overheard", speaker:"艾琳", text:"我会仔细听您的问题。"},
    ]));
    const moved = await runTurn(next.world, "前往档案室", p);
    const elsewhere = await runTurn(moved.world, followup, p);
    expect(elsewhere.turn.resolution.status).toBe("resolved");
    expect(contexts).toHaveLength(3);
    expect(["诺亚", "维克多"]).toContain(contexts[2].speaker.name);
    expect(contexts[2].history.map(line => line.text)).not.toContain("这是我们刚才谈到的话。");
    expect(contexts[2].history.map(line => line.text)).not.toContain("你知道什么消息？");
    const returned = await runTurn(elsewhere.world, "返回议事厅", p);
    await runTurn(returned.world, '“说说刚才的事？”我问艾琳', p);
    expect(contexts[3].history).toContainEqual({role:"overheard", speaker:"罗兰", text:"我会仔细听您的问题。"});
    expect(contexts[3].history).toContainEqual({role:"player", text:"这是我们刚才谈到的话。"});
    expect(JSON.stringify(contexts[3].history)).not.toContain("回答我的问题");
  });
});
