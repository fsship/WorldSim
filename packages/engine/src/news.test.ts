import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { DialogueContext, DialogueReviewContext, WorldFact } from "@worldsim/shared";
import { projectWorld, runTurn } from "./index";

const ask = "询问艾琳有哪些消息？";
const accepted = {grounded:true, playerAgency:true, citationsAccurate:true};

describe("独立生成 NPC 台词与事实授权", () => {
  it.each([
    "陛下，今天的晨会就在我们所在的议事厅举行。",
    "晨会的地点定在议事厅，陛下。",
  ])("相同行动可逐字采用不同模型原文 %s", async text => {
    // A pre-fix save has no transcript fields on its opening lines.
    const snapshot = JSON.parse(JSON.stringify(createPalace("existing-game")));
    delete snapshot.rules.discoveries[0].objects;
    const generated: DialogueContext[] = [], reviewed: DialogueReviewContext[] = [];
    const draft = {text, factIds:["assembly"]};
    const provider = new MockLLMProvider({
      resolve: () => { throw Error("对话不能从候选台词中挑选"); },
      dialogue: ctx => { generated.push(ctx); return draft; },
      reviewDialogue: ctx => { reviewed.push(ctx); return accepted; },
    });
    const { world, turn } = await runTurn(snapshot, ask, provider);
    expect(generated).toHaveLength(1);
    expect(generated[0].speaker).toMatchObject({name:"艾琳"});
    expect(generated[0]).not.toHaveProperty("options");
    expect(reviewed).toEqual([{context:generated[0], draft}]);
    expect(turn.observations).toContainEqual({kind:"dialogue", speaker:"艾琳", text});
    expect(turn.narrative).toBe("「" + text + "」");
    expect(turn.changes.filter(c => c.op !== "clock")).toEqual([]);
    expect(projectWorld(world).facts.map(f => f.id)).toEqual(["assembly"]);
  });

  it("生成器和复核器都只收到当前 NPC 确知且允许公开的事实", async () => {
    const w = createPalace("filtered-news");
    const steward = w.characters.find(c => c.id === "steward")!;
    const shared = w.facts.find(f => f.id === "assembly")!;
    const hidden: WorldFact[] = [
      { ...shared, id:"confidential", type:"secret", content:{text:"不对外公开的私信。"}, knownBy:["steward"] },
      { ...shared, id:"clue", type:"clue", content:{text:"尚未获准公开的证词。"}, knownBy:["steward"] },
      { ...shared, id:"absent", content:{text:"只有别的角色听到的消息。"}, knownBy:["captain"] },
      { ...shared, id:"future", content:{text:"尚未发生的新闻。"}, createdAt:w.time+5, knownBy:["steward"] },
    ];
    w.facts.push(...hidden);
    steward.knownFactIds.push("confidential", "clue", "future");
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:"我手头的议程写的是今日的晨会。", factIds:["assembly"]}; },
      reviewDialogue: ({context}) => { contexts.push(context); return accepted; },
    });
    const { world, turn } = await runTurn(w, ask, provider);
    expect(contexts).toHaveLength(2);
    for (const ctx of contexts) {
      expect(ctx.facts).toEqual([{id:"assembly", text:shared.content.text}]);
      expect(ctx).not.toHaveProperty("world");
      for (const f of hidden) expect(JSON.stringify(ctx)).not.toContain(f.content.text);
    }
    expect(projectWorld(world).facts.map(f => f.id)).toEqual(["assembly"]);
    expect(turn.changes.filter(c => c.op === "learn")).toEqual([]);
  });

  it("玩家仅学到已获准又被实际引用的事实，重复发问不重复学习", async () => {
    const w = createPalace("new-public-fact");
    const king = w.characters.find(c => c.id === "king")!;
    king.knownFactIds = [];
    const agenda = w.facts.find(f => f.id === "assembly")!;
    agenda.knownBy = agenda.knownBy.filter(id => id !== king.id);
    const silence = new MockLLMProvider({
      dialogue: () => ({text:"您想先问哪件事？", factIds:[]}), reviewDialogue: () => accepted,
    });
    const unseen = await runTurn(w, ask, silence);
    expect(projectWorld(unseen.world).facts).toEqual([]);
    const provider = new MockLLMProvider({
      dialogue: () => ({text:agenda.content.text, factIds:["assembly"]}), reviewDialogue: () => accepted,
    });
    const first = await runTurn(unseen.world, ask, provider);
    expect(first.turn.changes).toContainEqual({op:"learn", actor:"king", fact:"assembly"});
    expect(projectWorld(first.world).facts).toEqual([{id:"assembly", text:agenda.content.text}]);
    const again = await runTurn(first.world, ask, provider);
    expect(again.turn.changes.filter(c => c.op === "learn")).toEqual([]);
  });

  it("剧本授权的证人可以用自己的话告知证词，仍不能披露其他人的密谋", async () => {
    const p = new MockLLMProvider();
    const entered = await runTurn(createPalace("witness-news"), "前往档案室", p);
    const text = "值夜登记簿里有一份调防令，缺了副署。";
    const contexts: DialogueContext[] = [];
    const witness = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text, factIds:["ledger"]}; },
      reviewDialogue: () => accepted,
    });
    const result = await runTurn(entered.world, "我低声问诺亚：“有关调防令的消息吗？”", witness);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].facts.map(f => f.id)).toContain("ledger");
    expect(contexts[0].facts.map(f => f.id)).not.toContain("plot");
    expect(result.turn.observations[0]).toEqual({kind:"dialogue", speaker:"诺亚", text});
    expect(result.turn.changes).toContainEqual({op:"learn", actor:"king", fact:"ledger"});
    expect(projectWorld(result.world).facts.map(f => f.id)).not.toContain("plot");
  });
});
