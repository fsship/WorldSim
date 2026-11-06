import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { WorldStateSchema, type DialogueContext, type NpcActionContext, type WorldState } from "@worldsim/shared";
import { knownFacts, perceive, projectTurn, runTurn } from "./index";

const approved = {grounded:true, playerAgency:true, citationsAccurate:true};
const actor = (world: WorldState, id: string) => world.characters.find(c => c.id === id)!;
const reload = (world: WorldState) => WorldStateSchema.parse(JSON.parse(JSON.stringify(world)));

describe("当场说话与旁听", () => {
  it("钟声和交接簿打断等待后，08:32 的两个无名提问都能被在场人听到", async () => {
    const decisions: NpcActionContext[] = [];
    const provider = new MockLLMProvider({
      parse: ({text}) => text.startsWith("等") ? {kind:"wait_event"} : {kind:"speak"},
      decideNpcAction: ctx => {
        decisions.push(ctx);
        return ctx.trigger === "addressed" ? {kind:"speak"} : {kind:"stay"};
      },
      dialogue: () => ({text:"陛下，我也在等候。", factIds:[]}),
      reviewDialogue: () => approved,
    });
    const bell = await runTurn(createPalace("hearing-after-bell"), "等待钟声", provider);
    expect(bell.turn.endTime).toBe(495);
    expect(bell.turn.narrative).toContain("钟声");
    const dispatch = await runTurn(bell.world, "等待各部官员到场", provider);
    expect(dispatch.turn.endTime).toBe(512);
    expect(dispatch.turn.narrative).toContain("交接簿");
    const question = "怎么官员们还没来？";
    let world = dispatch.world;
    for (const suffix of ["我问道", "我说道"]) {
      const calls = decisions.length;
      const result = await runTurn(reload(world), "“" + question + "”" + suffix, provider);
      const {turn} = result;
      expect(turn.resolution.status).toBe("resolved");
      expect(turn.endTime).toBe(world.time + 2);
      const interval = decisions.slice(calls);
      expect(interval[0].trigger).toBe("addressed");
      expect(interval.slice(1).every(ctx => ctx.trigger === "ambient" && !ctx.input)).toBe(true);
      const priorQuestions = decisions[calls].history.filter(entry => entry.role === "player" && entry.text === question);
      expect(priorQuestions).toHaveLength(suffix === "我问道" ? 0 : 1);
      const playerLine = turn.events.find(event => event.source === "speech");
      expect(playerLine?.text).toBe(question);
      expect(playerLine?.utterance?.speakerId).toBe("king");
      expect(new Set(playerLine?.utterance?.listenerIds)).toEqual(new Set(["steward","captain"]));
      const heard = projectTurn(turn).hearing;
      expect(heard?.volume).toBe("room");
      expect(new Set(heard?.listeners)).toEqual(new Set(["艾琳","罗兰"]));
      expect(turn.observations.filter(o => o.kind === "dialogue")).toHaveLength(1);
      expect(turn.observations.some(o => o.kind === "system")).toBe(false);
      expect(result.world.facts).toEqual(world.facts);
      expect(actor(result.world, "king")).toEqual(actor(world, "king"));
      world = result.world;
    }
  });

  it("点名交谈时同室的人都能听见，后来进屋的人没有这段记忆", async () => {
    const initial = createPalace("named-public-speech");
    Object.assign(actor(initial, "scribe"), {locationId:"hall", condition:"detained"});
    Object.assign(actor(initial, "warden"), {locationId:"hall", condition:"dead"});
    const claim = "我已经让银盘飞到了窗台。";
    const reply = "这件事我还需要核实。";
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:reply, factIds:[]}; },
      reviewDialogue: () => approved,
    });
    const first = await runTurn(initial, "我对艾琳说：“" + claim + "”", provider);
    const line = first.turn.events.find(e => e.source === "speech");
    const answer = first.turn.events.find(e => e.kind === "npc");
    expect(line?.utterance?.speakerId).toBe("king");
    expect(new Set(line?.utterance?.listenerIds)).toEqual(new Set(["steward","captain","scribe"]));
    expect(answer?.utterance?.speakerId).toBe("steward");
    expect(new Set(answer?.utterance?.listenerIds)).toEqual(new Set(["king","captain","scribe"]));
    expect(first.world.facts).toEqual(initial.facts);
    expect(first.world.characters).toEqual(initial.characters);
    expect(first.turn.changes.every(change => change.op === "clock")).toBe(true);
    const saved = reload(first.world);
    const ask = (name: string) => "我问" + name + "：“刚才你听见什么？”";
    await runTurn(saved, ask("罗兰"), provider);
    expect(contexts.at(-1)?.speaker.name).toBe("罗兰");
    expect(contexts.at(-1)?.history).toEqual(expect.arrayContaining([
      {role:"player", text:claim}, {role:"overheard", speaker:"艾琳", text:reply},
    ]));
    // The messenger was at the gate during both lines and enters only after reload.
    actor(saved, "messenger").locationId = "hall";
    await runTurn(saved, ask("米拉"), provider);
    expect(contexts.at(-1)?.speaker.name).toBe("米拉");
    const history = contexts.at(-1)!.history.map(entry => entry.text);
    expect(history).not.toContain(claim);
    expect(history).not.toContain(reply);
  });

  it("玩家先开口，随后离开的艾琳到档案室仍记得听到的原话", async () => {
    const dialogues: DialogueContext[] = [];
    const claim = "今天先给那个摆件取名叫白鸽。";
    let firstAddress = true;
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => {
        if (ctx.trigger === "ambient") return {kind:"stay"};
        if (firstAddress) { firstAddress = false; return {kind:"move", destination:"archive"}; }
        return {kind:"speak"};
      },
      dialogue: ctx => { dialogues.push(ctx); return {text:"陛下，我听到了。", factIds:[]}; },
      reviewDialogue: () => approved,
    });
    const first = await runTurn(createPalace("hearing-before-move"), "我对艾琳说：“" + claim + "”", provider);
    expect(actor(first.world, "steward").locationId).toBe("archive");
    expect(first.turn.observations.some(o => o.kind === "dialogue")).toBe(false);
    const arrival = await runTurn(reload(first.world), "前往档案室", provider);
    await runTurn(arrival.world, "我问艾琳：“我刚才给它取了什么名字？”", provider);
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0].history.filter(entry => entry.text === claim)).toEqual([{role:"player", text:claim}]);
  });

  it("在押者可以听见给自己的私语，同室的艾琳不能旁听或代答", async () => {
    const initial = createPalace("whisper-to-detained-captain");
    actor(initial, "captain").condition = "detained";
    let decisions = 0;
    const provider = new MockLLMProvider({decideNpcAction: () => { decisions++; return {kind:"speak"}; }});
    const words = "谢谢你，今日的暗号是梅花。";
    const {world,turn} = await runTurn(initial, "我低声对卫队长说：“" + words + "”", provider);
    expect(turn.resolution.status).toBe("resolved");
    expect(projectTurn(turn).hearing).toEqual({volume:"private", listeners:["罗兰"]});
    const line = turn.events.find(event => event.source === "speech")!;
    expect(perceive(line, world, actor(world,"captain"))?.text).toBe(words);
    expect(perceive(line, world, actor(world,"steward"))).toBeUndefined();
    expect(decisions).toBe(0);
    expect(turn.observations.some(o => o.kind === "dialogue")).toBe(false);
    expect(turn.endTime - turn.startTime).toBe(2);
    expect(world.characters).toEqual(initial.characters);
    expect(world.facts).toEqual(initial.facts);
  });

  it.each(["我偷偷地对艾琳说：“口令是青鸢。”", "我对艾琳秘密地说：“口令是青鸢。”",
    "我只告诉艾琳，口令是青鸢。"])("明确限制听众的发言和答复只留在两人之间：%s", async input => {
    const contexts: DialogueContext[] = [];
    const reply = "我记住这句口令了。";
    const provider = new MockLLMProvider({
      parse: () => ({kind:"speak", target:"罗兰"}),
      dialogue: ctx => { contexts.push(ctx); return {text:reply, factIds:[]}; },
      reviewDialogue: () => approved,
    });
    const {world, turn} = await runTurn(createPalace("explicit-private-audience"), input, provider);
    expect(turn.resolution.status).toBe("resolved");
    expect(projectTurn(turn).hearing).toEqual({volume:"private", listeners:["艾琳"]});
    const lines = turn.events.filter(e => e.utterance);
    expect(lines.map(e => [e.text, e.utterance])).toEqual([
      ["口令是青鸢。", {speakerId:"king", listenerIds:["steward"], private:true}],
      [reply, {speakerId:"steward", listenerIds:["king"], private:true}],
    ]);
    await runTurn(reload(world), "我问罗兰：“刚才你听到了什么？”", provider);
    const bystander = contexts.at(-1)!;
    expect(bystander.speaker.name).toBe("罗兰");
    expect(JSON.stringify(bystander)).not.toContain("青鸢");
    expect(bystander.history.map(h => h.text)).not.toContain(reply);
  });

  it.each(["我只告诉艾琳娜，口令是青鸢。", "我秘密地对陌生访客说：“口令是青鸢。”"])(
    "私语称呼的对象不在场时不会广播或改投其他角色：%s", async input => {
      const {turn} = await runTurn(createPalace("unknown-private-audience"), input, new MockLLMProvider());
      expect(turn.resolution.status).toBe("refused");
      expect(turn.events.some(e => e.utterance)).toBe(false);
      expect(projectTurn(turn).hearing).toBeUndefined();
      expect(turn.endTime).toBe(turn.startTime);
    });

  it("旧存档的本地台词缺少听众名单，只还原有凭据的说话人记忆", async () => {
    const old = createPalace("hearing-legacy");
    const line = "这份记录的封面是灰色的。";
    const question = "请看看记录的封面。";
    old.history.push({id:"legacy-line", source:"action", time:480, kind:"npc", locationId:"hall",
      speakerId:"steward", speaker:"艾琳", spokenInput:question, text:line,
      perception:"local", recipients:["king"], changes:[]});
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:"我听着。", factIds:[]}; },
      reviewDialogue: () => approved,
    });
    const saved = reload(old);
    for (const name of ["艾琳", "罗兰"]) await runTurn(saved, "我低声对" + name + "说：“封面呢？”", provider);
    expect(contexts[0].history).toEqual(expect.arrayContaining([
      {role:"player",text:question}, {role:"npc",text:line},
    ]));
    const otherHistory = contexts[1].history.map(entry => entry.text);
    expect(otherHistory).not.toContain(question);
    expect(otherHistory).not.toContain(line);
  });

  it("空厅里也能说话，没有听众和 NPC 回应", async () => {
    const world = createPalace("speech-in-empty-hall");
    for (const npc of world.characters.filter(c => c.kind === "npc" && c.locationId === "hall")) npc.locationId = "archive";
    let decisions = 0;
    const provider = new MockLLMProvider({decideNpcAction: () => { decisions++; return {kind:"stay"}; }});
    const {turn} = await runTurn(world, "“厅里有人吗？”我问道", provider);
    expect(turn.resolution.status).toBe("resolved");
    expect(turn.endTime - turn.startTime).toBe(2);
    expect(turn.events.find(e => e.source === "speech")).toMatchObject({
      text:"厅里有人吗？", utterance:{speakerId:"king",listenerIds:[]},
    });
    expect(projectTurn(turn).hearing).toEqual({volume:"room", listeners:[]});
    expect(decisions).toBe(0);
    expect(turn.observations.some(o => o.kind === "dialogue")).toBe(false);
  });
});

function testimonyScene() {
  const world = createPalace("testimony-audience");
  actor(world, "scribe").locationId = "hall";
  actor(world, "captain").condition = "detained";
  Object.assign(actor(world,"warden"), {locationId:"hall", condition:"dead"});
  // These listeners have not yet heard even the public agenda item.
  const agenda = world.facts.find(f => f.id === "assembly")!;
  agenda.knownBy = ["scribe"];
  for (const person of world.characters.filter(c => c.id !== "scribe"))
    person.knownFactIds = person.knownFactIds.filter(id => id !== "assembly");
  const ledger = world.facts.find(f => f.id === "ledger")!;
  return {world, draft:{text:agenda.content.text + ledger.content.text, factIds:["assembly","ledger"]}};
}

describe("听到的引述与事实授权", () => {
  it.each([
    {mode:"当众", input:"我对诺亚说：“请介绍晨会和登记簿。”", whispered:false},
    {mode:"低声", input:"我低声对诺亚说：“请介绍晨会和登记簿。”", whispered:true},
    {mode:"耳语", input:"我对诺亚耳语：“请介绍晨会和登记簿。”", whispered:true},
  ])("$mode 传递获准且实际讲出的事实，旁人只记住当场听到的词", async ({input, whispered}) => {
    const {world, draft} = testimonyScene();
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      dialogue: ctx => {
        contexts.push(ctx);
        return ctx.speaker.name === "诺亚" ? draft : {text:"我会仔细想一想。",factIds:[]};
      },
      reviewDialogue: () => approved,
    });
    const first = await runTurn(world, input, provider);
    expect(first.turn.observations).toContainEqual({kind:"dialogue", speaker:"诺亚", text:draft.text});
    const learns = first.turn.changes.filter(change => change.op === "learn");
    const listeners = whispered ? ["king"] : ["king","steward","captain"];
    expect(learns).toHaveLength(listeners.length * draft.factIds.length);
    const answer = first.turn.events.find(event => event.kind === "npc")!;
    expect(new Set(answer.utterance?.listenerIds)).toEqual(new Set(listeners));
    const question = first.turn.events.find(event => event.source === "speech")!;
    expect(new Set(question.utterance?.listenerIds)).toEqual(new Set(whispered ? ["scribe"] : ["scribe","steward","captain"]));
    if (whispered) expect(projectTurn(first.turn).hearing).toEqual({volume:"private", listeners:["诺亚"]});
    for (const person of world.characters) {
      const before = knownFacts(world, person).map(f => f.id);
      const after = knownFacts(first.world, actor(first.world, person.id)).map(f => f.id);
      expect(new Set(after)).toEqual(new Set(listeners.includes(person.id) ? [...before, ...draft.factIds] : before));
    }
    await runTurn(reload(first.world), "我问艾琳：“你听到了什么？”", provider);
    const bystander = contexts.at(-1)!;
    expect(bystander.speaker.name).toBe("艾琳");
    if (whispered) {
      expect(bystander.history.map(line => line.text)).not.toContain(question.text);
      expect(bystander.history.map(line => line.text)).not.toContain(answer.text);
    } else {
      expect(bystander.history).toEqual(expect.arrayContaining([
        {role:"player", text:question.text}, {role:"overheard", speaker:"诺亚", text:draft.text},
      ]));
    }
  });

  it.each(["沉默","假传"])("%s 时不传播任何事实", async mode => {
    const {world} = testimonyScene();
    const falseReport = "宫门前聚集着整整百名大臣。";
    const provider = new MockLLMProvider({
      decideNpcAction: () => mode === "沉默" ? {kind:"stay"} : {kind:"speak"},
      dialogue: () => ({text:falseReport, factIds:["ledger"]}),
      reviewDialogue: () => ({...approved, grounded:false, citationsAccurate:false}),
    });
    const {world:next, turn} = await runTurn(world, "我对诺亚说：“能禀报一件实情吗？”", provider);
    expect(turn.changes.some(change => change.op === "learn")).toBe(false);
    expect(next.facts).toEqual(world.facts);
    expect(next.characters).toEqual(world.characters);
    expect(next.history.some(event => event.text === falseReport)).toBe(false);
  });
});
