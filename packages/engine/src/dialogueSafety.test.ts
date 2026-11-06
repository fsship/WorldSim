import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { DialogueContext, DialogueReview } from "@worldsim/shared";
import { prepareOpening, projectTurn, projectWorld, runTurn } from "./index";
import { writeNpcReply } from "./npc-dialogue";

const approved: DialogueReview = {grounded:true, playerAgency:true, citationsAccurate:true};
const ask = '我向艾琳问：“可以禀报晨会的议程吗？”';

function unknownPublicFact() {
  const w = createPalace("dialogue-guard");
  w.characters.find(c => c.id === "king")!.knownFactIds = [];
  w.facts.find(f => f.id === "assembly")!.knownBy = ["steward"];
  return w;
}

describe("未获准的生成草稿不进入玩家历史", () => {
  it.each([
    {text:"陛下，您决定去宫门还是留在这里？", playerAgency:true},
    {text:"陛下，您决定去宫门，转身出了门。", playerAgency:false},
  ])("由模型区分询问打算与代替玩家决定：$text", async ({text, playerAgency}) => {
    const w = createPalace("agency-question");
    const npc = w.characters.find(c => c.id === "steward")!;
    const reviewed: string[] = [];
    const p = new MockLLMProvider({
      dialogue: () => ({text, factIds:[]}),
      reviewDialogue: ({draft}) => {
        reviewed.push(draft.text);
        return {...approved, playerAgency};
      },
    });
    const result = await writeNpcReply(w, npc, "你想问我什么？", "双方正在此地交谈。", [], p);
    expect(reviewed).toContain(text);
    expect(result).toEqual(playerAgency ? {text, factIds:[]} : {failure:"review",verdict:{...approved,playerAgency:false}});
  });
  it("台词改写只发送审核标记，保存的是通过的原文", async () => {
    const w = unknownPublicFact();
    const contexts: DialogueContext[] = [];
    const rejected = "我有一份刚从远方送来的密信。";
    const accepted = "我能核实的是，今天的晨会在议事厅。";
    const provider = new MockLLMProvider({
      dialogue: context => {
        contexts.push(context);
        return context.revision ? {text:accepted, factIds:["assembly"]} : {text:rejected, factIds:[]};
      },
      reviewDialogue: ({draft}) => ({...approved, grounded:draft.text === accepted}),
    });
    const result = await runTurn(w, ask, provider);
    expect(contexts).toHaveLength(2);
    expect(contexts[1].revision).toEqual({...approved, grounded:false});
    expect(JSON.stringify(contexts[1])).not.toContain(rejected);
    expect(JSON.stringify(result.world)).not.toContain(rejected);
    expect(result.turn.observations[0].text).toBe(accepted);
    expect(new Set(result.turn.changes.filter(c => c.op === "learn"))).toEqual(new Set([
      {op:"learn", actor:"king", fact:"assembly"}, {op:"learn", actor:"captain", fact:"assembly"},
    ]));
  });
  it("普通答复两次被退回时，仍可凭亲耳听见的话回应，不能传授世界事实", async () => {
    const contexts: DialogueContext[] = [];
    const rejected = "我猜想是路上耽搁了。";
    const accepted = "我说不上缘由，陛下。";
    const p = new MockLLMProvider({
      dialogue: ctx => {
        contexts.push(ctx);
        return {text:ctx.facts.length ? rejected : accepted, factIds:[]};
      },
      reviewDialogue: ({context, draft}) => ({...approved, grounded:context.facts.length === 0 && draft.text === accepted}),
    });
    const {turn} = await runTurn(unknownPublicFact(), ask, p);
    expect(contexts).toHaveLength(3);
    expect(contexts[2]).toMatchObject({facts:[], revision:{grounded:false}});
    expect(contexts[2].input).toBe(contexts[0].input);
    expect(turn.observations).toContainEqual({kind:"dialogue", speaker:"艾琳", text:accepted});
    expect(turn.events.some(e => e.text === rejected)).toBe(false);
    expect(turn.changes.some(c => c.op === "learn")).toBe(false);
  });

  it("只把 NPC 原话中完整可用的部分重新送审，谁也听不到被剔除的推测", async () => {
    const world = createPalace("clean-excerpt");
    const kept = "我能看见卫队长就在这里。";
    const speculation = "他们肯定遇上了城外的风暴。";
    const reviewed: string[] = [];
    const provider = new MockLLMProvider({
      dialogue: () => ({text:kept + speculation, factIds:[]}),
      reviewDialogue: ({draft}) => {
        reviewed.push(draft.text);
        return draft.text === kept ? approved :
          {...approved, grounded:false, issue:"offstage", excerpt:{text:kept, factIds:[]}};
      },
    });
    const {world:next, turn} = await runTurn(world, "“其他人呢？”我问艾琳", provider);
    expect(reviewed).toEqual([kept + speculation, kept]);
    expect(turn.observations).toContainEqual({kind:"dialogue",speaker:"艾琳",text:kept});
    expect(JSON.stringify(next.history)).not.toContain(speculation);
  });

  it("退回原因能指导重新写台词，审核员自编的‘摘录’不会进入对白", async () => {
    const feedback: DialogueContext["revision"][] = [];
    const p = new MockLLMProvider({
      dialogue: c => {
        feedback.push(c.revision);
        return {text:c.revision ? "我不清楚缘由。" : "他们正在城外。",factIds:[]};
      },
      reviewDialogue: ({draft}) => draft.text === "我不清楚缘由。" ? approved :
        {...approved, grounded:false, issue:"offstage", excerpt:{text:"有人决定出发。",factIds:[]}},
    });
    const {world,turn} = await runTurn(createPalace("unwritten-excerpt"), ask, p);
    expect(feedback).toEqual([undefined,{...approved,grounded:false,issue:"offstage"}]);
    expect(turn.narrative).toContain("我不清楚缘由。");
    expect(JSON.stringify(world.history)).not.toContain("有人决定出发。");
  });

  it("摘掉否定词会改变意思，下一次审核仍可拒绝这段原文", async () => {
    const snippet = "官员已经抵达宫门。";
    const full = "我不能确认" + snippet;
    const reviewed: string[] = [];
    const p = new MockLLMProvider({
      dialogue:()=>({text:full, factIds:[]}),
      reviewDialogue:({draft})=>{
        reviewed.push(draft.text);
        return {...approved,grounded:false,issue:"offstage",excerpt:{text:snippet,factIds:[]}};
      },
    });
    const {turn, world} = await runTurn(createPalace("excerpt-denied"), ask, p);
    expect(reviewed).toContain(snippet);
    expect(turn.events.find(e => e.npcFailure)?.npcReview).toEqual({...approved,grounded:false,issue:"offstage"});
    expect(turn.observations.some(o => o.kind === "dialogue")).toBe(false);
    expect(JSON.stringify(world.history)).not.toContain(snippet);
  });

  it("自己编备的公开文书能支撑答复；同室他人及隐藏正文不能混入", async () => {
    const world = createPalace("prepared-notes");
    world.time = 505;
    const agenda = world.readables[0];
    const secret = world.facts.find(f => f.type === "secret")!.content.text;
    agenda.entries.push({title:"不公开的条目",text:secret});
    const inputs: DialogueContext[] = [];
    const p = new MockLLMProvider({
      dialogue:c=>{ inputs.push(c); return {text:"请讲。",factIds:[]}; }, reviewDialogue:()=>approved,
    });
    for (const who of ["steward","captain"]) {
      const npc = world.characters.find(c => c.id === who)!;
      await writeNpcReply(world, npc, "还有空位吗？", "现场交谈。", [], p);
    }
    expect(inputs[0].currentTime).toBe(505);
    expect(inputs[0].preparedNotes).toContainEqual({document:agenda.name, ...agenda.entries[0]});
    expect(JSON.stringify(inputs)).not.toContain(secret);
    expect(inputs[1].preparedNotes).toBeUndefined();
  });
  it("开场台词也采用模型原文，既不把剧本占位对白作为上下文，也不替玩家消耗一回合", async () => {
    const w = unknownPublicFact();
    const placeholder = w.history.find(e => e.source === "opening" && e.kind === "npc")!.text;
    const contexts: DialogueContext[] = [];
    const text = "陛下早。今天的议程上列着一场晨会，地点就是议事厅。";
    const provider = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text, factIds:["assembly"]}; },
      reviewDialogue: () => approved,
    });
    const world = await prepareOpening(w, provider);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].history).toEqual([]);
    expect(contexts[0].input).toBe("");
    expect(JSON.stringify(contexts[0])).not.toContain(placeholder);
    expect(world.time).toBe(w.time);
    expect(world.version).toBe(0);
    expect(world.history).toHaveLength(w.history.length);
    expect(world.history.find(e => e.kind === "npc")).toMatchObject({
      text, dialogueSource:"provider", reportedFactIds:["assembly"],
    });
    expect(new Set(world.history.find(e => e.kind === "npc")!.changes)).toEqual(new Set([
      {op:"learn", actor:"king", fact:"assembly"}, {op:"learn", actor:"captain", fact:"assembly"},
    ]));
    expect(projectWorld(world).opening).toContain(text);
    expect(projectWorld(world).facts.map(f => f.id)).toEqual(["assembly"]);
    expect(projectWorld(w).facts).toEqual([]);
  });

  it("守备命令的状态由引擎执行，卫队长的回应来自模型", async () => {
    const w = createPalace("guard-order");
    const text = "陛下，我领命。这次宫门守备会按您的安排执行。";
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text, factIds:[]}; },
      reviewDialogue: () => approved,
    });
    const {world, turn} = await runTurn(w,"我命令卫队长加强宫门守备",provider);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].speaker.name).toBe("罗兰");
    expect(turn.observations).toContainEqual({kind:"dialogue", speaker:"罗兰", text});
    expect(world.variables.guardSecured).toBe(true);
    expect(turn.changes.filter(change => change.op !== "clock")).toEqual([{op:"flag",name:"guardSecured",value:true}]);
    expect(world.characters).toEqual(w.characters);
  });

  it.each([
    {label:"引用未获准的事实", text:"还有一封没有公开的信。", ids:["plot"], review:approved},
    {label:"假造世界状态操作", text:"算你已经动身。", ids:["assembly"], review:approved, changes:[{op:"move", actor:"king", to:"gate"}]},
    {label:"用台词替玩家行动", text:"您已经独自前往宫门并宣布了逮捕令。", ids:["assembly"], review:{...approved, playerAgency:false}},
    {label:"自造宫廷事件", text:"典仪官刚刚在西门发布了一道临时法令。", ids:["assembly"], review:{...approved, grounded:false}},
    {label:"借真实事实 ID 伪称传授了它", text:"我还需要想一想。", ids:["assembly"], review:{...approved, citationsAccurate:false}},
  ])("$label 时只显示系统提示，不传递知识或改变玩家", async entry => {
    const w = unknownPublicFact();
    let generationCalls = 0;
    const provider = new MockLLMProvider({
      dialogue: () => {
        generationCalls++;
        return {text:entry.text, factIds:entry.ids, ...("changes" in entry ? {changes:entry.changes} : {})};
      },
      reviewDialogue: () => entry.review,
    });
    const { world, turn } = await runTurn(w, ask, provider);
    const semanticRejection = !entry.review.grounded || !entry.review.playerAgency || !entry.review.citationsAccurate;
    expect(generationCalls).toBe(semanticRejection ? 3 : 1);
    expect(turn.observations.some(o => o.kind === "dialogue")).toBe(false);
    expect(JSON.stringify(projectTurn(turn))).not.toContain(entry.text);
    expect(JSON.stringify(world.history)).not.toContain(entry.text);
    expect(turn.events.find(e => e.npcFailure)).toMatchObject({kind:"system"});
    expect(turn.events.filter(e => e.utterance).map(e => e.utterance!.speakerId)).toEqual(["king"]);
    expect(projectWorld(world).facts).toEqual([]);
    expect(world.characters.find(c => c.id === "king")).toEqual(w.characters.find(c => c.id === "king"));
    expect(turn.changes.every(c => c.op === "clock")).toBe(true);
    expect(turn.endTime - turn.startTime).toBe(2);
  });

  it("模型编出同一条隐藏事实，即使自报通过也不能显示或送给叙事", async () => {
    const w = unknownPublicFact();
    w.queue.find(e => e.id === "bell")!.at = w.time + 1;
    const secret = w.facts.find(f => f.type === "secret")!.content.text;
    let presented: string[] = [];
    let reviewCalls = 0;
    const provider = new MockLLMProvider({
      dialogue: () => ({text:secret, factIds:[]}),
      reviewDialogue: () => { reviewCalls++; return approved; },
      narrate: ctx => {
        presented = ctx.observations.map(o => o.text);
        return {lines:ctx.observations.map((_,index) => ({index,style:"plain"}))};
      },
    });
    const {turn} = await runTurn(w, ask, provider);
    expect(reviewCalls).toBe(0);
    expect(presented.join("")).toContain("钟声");
    expect(presented.join("")).not.toContain(secret);
    expect(turn.narrative).not.toContain(secret);
    expect(turn.events.find(e => e.npcFailure)).toMatchObject({kind:"system", npcFailure:"validation"});
    expect(turn.observations.some(o => o.kind === "dialogue")).toBe(false);
  });

  it("玩家写进台词的私密内容，不能从当前请求或下一回合历史进入台词模型和复核模型", async () => {
    const w = createPalace("private-words");
    const secret = w.facts.find(f => f.type === "secret")!.content.text;
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:"我没有可以证实这件事的消息。",factIds:[]}; },
      reviewDialogue: ({context}) => { contexts.push(context); return approved; },
    });
    const first = await runTurn(w, '我告诉艾琳：“' + secret + '”', provider);
    const second = await runTurn(first.world, '“那你能证实我刚才的话吗？”我问道', provider);
    expect(contexts).toHaveLength(4);
    expect(JSON.stringify(contexts)).not.toContain(secret);
    expect(contexts[2].history).toContainEqual({role:"npc", text:"我没有可以证实这件事的消息。"});
    expect(second.turn.narrative).not.toContain(secret);
    expect(projectWorld(second.world).facts.map(f => f.id)).not.toContain("plot");
  });

  it.each(["dialogue", "reviewDialogue"])("%s 服务异常时保持可继续的对话和一致的日志", async failedStage => {
    const w = unknownPublicFact();
    let allowed = false;
    const text = "晨会就在议事厅举行。";
    const provider = new MockLLMProvider({
      dialogue: () => {
        if (!allowed && failedStage === "dialogue") throw Error("generation interrupted");
        return {text,factIds:["assembly"]};
      },
      reviewDialogue: () => {
        if (!allowed && failedStage === "reviewDialogue") throw Error("review interrupted");
        return approved;
      },
    });
    const first = await runTurn(w, ask, provider);
    expect(first.turn.narrative).not.toContain(text);
    expect(first.turn.events.find(e => e.npcFailure)).toMatchObject({
      kind:"system", npcFailure:failedStage === "dialogue" ? "generation" : "review_unavailable",
    });
    expect(first.turn.changes).not.toContainEqual({op:"learn",actor:"king",fact:"assembly"});
    allowed = true;
    const retry = await runTurn(first.world, ask, provider);
    expect(retry.turn.events).toContainEqual(expect.objectContaining({kind:"npc",dialogueSource:"provider",text}));
    expect(retry.turn.changes).toContainEqual({op:"learn",actor:"king",fact:"assembly"});
    expect(retry.world.version).toBe(2);
  });

  it("艾琳已经行礼但台词未过审，罗兰只记得国王说过的话", async () => {
    const firstWords = "请把今天的议程称为白鸽。";
    const rejected = "大臣们已经搬走全部议程。";
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => ctx.npc.name === "艾琳"
        ? {kind:"gesture", gesture:"bow", thenSpeak:true} : {kind:"speak"},
      dialogue: ctx => {
        contexts.push(ctx);
        return {text:ctx.speaker.name === "艾琳" ? rejected : "陛下，我听到了。", factIds:[]};
      },
      reviewDialogue: ({draft}) => ({...approved, grounded:draft.text !== rejected}),
    });
    const failed = await runTurn(createPalace("failed-hearing"), "我对艾琳说：“" + firstWords + "”", provider);
    expect(failed.turn.events.filter(e => e.npcAction?.kind === "gesture")).toHaveLength(1);
    expect(failed.turn.observations.map(o => o.kind)).toEqual(["world","system"]);
    expect(failed.turn.events.find(e => e.npcFailure)?.npcFailure).toBe("review");
    expect(failed.turn.events.some(e => e.kind === "npc")).toBe(false);
    expect(failed.turn.events.filter(e => e.utterance).map(e => e.text)).toEqual([firstWords]);
    expect(JSON.stringify(failed.world)).not.toContain(rejected);
    const next = await runTurn(JSON.parse(JSON.stringify(failed.world)), "我问罗兰：“你刚听到了什么？”", provider);
    expect(next.turn.observations).toContainEqual({kind:"dialogue",speaker:"罗兰",text:"陛下，我听到了。"});
    expect(contexts.at(-1)?.history).toEqual([{role:"player",text:firstWords}]);
  });

  it("加载旧档后，已标明备用的台词不会作为艾琳的记忆或罗兰的旁听记录", async () => {
    const world = createPalace("legacy-failed-speech");
    const legacy = world.history.find(e => e.kind === "npc")!;
    const question = "能再解释一下晨会吗？";
    const fallback = "陛下，我暂时没有能够核实的答复。";
    world.history.push({...legacy, id:"old-paired", source:"npc-action", text:fallback, spokenInput:question,
      dialogueSource:"fallback", utterance:undefined, perception:"addressed", recipients:["king"]}, {
      ...legacy, id:"older-room-reply", source:"npc-action", text:fallback, dialogueSource:"fallback",
      utterance:{speakerId:"steward", listenerIds:["king","captain"]},
    });
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:"请讲。",factIds:[]}; },
      reviewDialogue: () => approved,
    });
    for (const name of ["艾琳","罗兰"]) {
      await runTurn(JSON.parse(JSON.stringify(world)), "我低声对" + name + "说：“刚才呢？”", provider);
    }
    expect(contexts).toHaveLength(2);
    expect(contexts[0].history).toContainEqual({role:"player",text:question});
    expect(contexts[1].history.map(entry => entry.text)).not.toContain(question);
    for (const context of contexts) expect(context.history.map(entry => entry.text)).not.toContain(fallback);
  });

  it("只有当前可传达的证词能出现在生成上下文中，不能用角色私有目标替代知识", async () => {
    const w = createPalace("testimony-trust");
    const player = w.characters.find(c => c.id === "king")!;
    player.locationId = "gate";
    const messenger = w.characters.find(c => c.id === "messenger")!;
    messenger.relations.king = 0;
    const secret = w.facts.find(f => f.type === "secret")!;
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => {
        contexts.push(ctx);
        return {text:"您需要我说明什么？",factIds:[]};
      },
      reviewDialogue: () => approved,
    });
    await runTurn(w, '“你见过宫门调防令吗？”我问信使', provider);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].facts.map(f => f.id)).not.toContain("duplicate");
    expect(JSON.stringify(contexts[0])).not.toContain(messenger.goals[0]);
    expect(JSON.stringify(contexts[0])).not.toContain(secret.content.text);
  });
});
