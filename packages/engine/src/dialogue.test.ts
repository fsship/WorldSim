import { describe, expect, it } from "vitest";
import { MockLLMProvider, OpenAICompatibleProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { ActionIntent, DialogueContext, GameTurn } from "@worldsim/shared";
import { runTurn } from "./index";

const openingQuestion = "“有哪些消息？”我问道";
const namedQuestion = "“有哪些消息？”我问艾琳问道";
const start = () => createPalace("dialogue-test");
const accepted = {grounded:true, playerAgency:true, citationsAccurate:true};
const mock = new MockLLMProvider({
  dialogue: () => ({text:"您问的是晨会；今日就在这座议事厅举行。", factIds:["assembly"]}),
  reviewDialogue: () => accepted,
});

function speakers(turn: GameTurn) {
  return turn.observations.filter(o => o.kind === "dialogue").map(o => o.speaker);
}

function expectClarification(turn: GameTurn) {
  expect(turn.resolution.status).toBe("refused");
  expect(turn.observations.map(o => o.kind)).toEqual(["system"]);
  expect(turn.changes).toEqual([]);
  expect(turn.endTime).toBe(turn.startTime);
}

describe("玩家引述发言与当前听者", () => {
  it.each(["offline", "interpret"])("插入动作描写的两段台词完整传给听者，动作本身不会被念出（%s）", async mode => {
    const first = "如果他能现在自守，我可以既往不咎，否则，";
    const second = "他的下场可不会好";
    const direction = "我审视着在场的诸多人物";
    const input = "“" + first + "”" + direction + "“" + second + "”";
    const contexts: DialogueContext[] = [];
    const npc = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:"我听清了。", factIds:[]}; },
      reviewDialogue: () => accepted,
    });
    const adapter = new OpenAICompatibleProvider({
      mode:"openai", baseUrl:"https://example.invalid", model:"fixture", temperature:0, timeoutMs:1000, maxTokens:300, retries:0,
    }, async () => Response.json({choices:[{message:{content:JSON.stringify({kind:"speak", words:first, source:direction, private:false})}}]}));
    const provider = mode === "offline" ? npc : Object.assign(npc, {interpret:adapter.interpret.bind(adapter)});
    const {turn, world} = await runTurn(start(), input, provider);
    const spoken = first + "\n" + second;
    expect(turn.resolution.status).toBe("resolved");
    expect(turn.input).toBe(input);
    expect(turn.endTime - turn.startTime).toBe(2);
    expect(turn.events.filter(event => event.source === "speech").map(event => event.text)).toEqual([spoken]);
    expect(turn.hearing).toEqual({volume:"room", listeners:["艾琳","罗兰"]});
    expect(contexts[0].input).toBe(spoken);
    const followup = new MockLLMProvider({
      dialogue: ctx => { contexts.push(ctx); return {text:"陛下请讲。", factIds:[]}; },
      reviewDialogue: () => accepted,
    });
    await runTurn(world, "“你听清了吗？”我问道", followup);
    expect(contexts.at(-1)?.history).toContainEqual({role:"player", text:spoken});
  });

  it.each([openingQuestion, namedQuestion])("开场原话 %s 得到艾琳的晨报", async input => {
    const world = start();
    const result = await runTurn(world, input, mock);
    expect(result.turn.intent.kind).toBe("speak");
    expect(speakers(result.turn)).toEqual(["艾琳"]);
    expect(result.turn.narrative).toContain("晨会");
    expect(result.world.facts).toEqual(world.facts);
  });

  it("载入带有两次系统拒绝的旧存档，仍能接着开场对话", async () => {
    const world = start();
    const greeting = world.history.find(event => event.kind === "npc")!;
    Reflect.deleteProperty(greeting, "speakerId");
    Reflect.deleteProperty(greeting, "utterance");
    greeting.speaker = "宫廷侍从·艾琳";
    for (let i = 1; i <= 2; i++) {
      world.history.push({
        id: "prior-refusal-" + i, source: "action", time: world.time, kind: "system",
        text: "请说明你想向谁说些什么。", perception: "addressed", recipients: ["king"],
        locationId: "hall", changes: [],
      });
    }
    world.version = 2;
    const { world: after, turn } = await runTurn(JSON.parse(JSON.stringify(world)), openingQuestion, mock);
    expect(turn.version).toBe(3);
    expect(speakers(turn)).toEqual(["艾琳"]);
    expect(after.history.slice(0, world.history.length)).toEqual(world.history);
  });

  it("引号里的第三人只是话题，点名的听者优先且可继续对话", async () => {
    const mistakenTarget = new MockLLMProvider({parse: () => ({kind: "speak", target: "艾琳"})});
    const named = await runTurn(start(), "“艾琳刚才说了什么？”我问罗兰问道", mistakenTarget);
    expect(speakers(named.turn)).toEqual(["罗兰"]);
    const followup = await runTurn(named.world, "“艾琳还有别的消息吗？”我问道", mistakenTarget);
    expect(speakers(followup.turn)).toEqual(["罗兰"]);
  });

  it.each([
    ['我用平静的语气问罗兰：“宫门怎么样？”', 'room'],
    ['我用平静的语气问罗兰，宫门怎么样？', 'room'],
    ['我用很小的声音问罗兰，宫门怎么样？', 'private'],
  ])('说话方式不能被误分为使用物品：%s', async (input, volume) => {
    const p = new MockLLMProvider({parse:() => ({kind:'use', item:'王室印玺'})});
    const {turn} = await runTurn(start(), input, p);
    expect(turn.intent).toEqual({kind:'speak', target:'罗兰'});
    expect(turn.hearing).toEqual({volume, listeners:volume === 'private' ? ['罗兰'] : ['艾琳','罗兰']});
    expect(turn.events.find(e => e.source === 'speech')?.text).toBe('宫门怎么样？');
    expect(turn.changes.every(c => c.op === 'clock')).toBe(true);
  });

  it("当众呼唤场外或不存在的人时，艾琳可以听见但不会代答；私语缺席则不传给艾琳", async () => {
    const world = start();
    world.characters.find(c => c.id === "captain")!.locationId = "gate";
    for (const addressee of ["罗兰", "陌生访客"]) {
      const { turn } = await runTurn(world, "“有哪些消息？”我问" + addressee + "问道", mock);
      expect(turn.resolution.status).toBe("resolved");
      expect(speakers(turn)).toEqual([]);
      expect(turn.narrative).toContain("没有回应");
      expect(turn.endTime - turn.startTime).toBe(2);
      expect(turn.events.find(event => event.source === "speech")).toMatchObject({
        text:"有哪些消息？", utterance:{speakerId:"king", listenerIds:["steward"]},
      });
      const whisper = await runTurn(world, "我低声对" + addressee + "说：“有哪些消息？”", mock);
      expectClarification(whisper.turn);
      expect(whisper.turn.events.some(event => event.source === "speech")).toBe(false);
    }
  });

  it("换房间和返回原处时分别由当前房间的人回应", async () => {
    const archive = await runTurn(start(), "前往档案室", mock);
    const inArchive = await runTurn(archive.world, openingQuestion, mock);
    expect(speakers(inArchive.turn)).toHaveLength(1);
    expect(["诺亚","维克多"]).toContain(speakers(inArchive.turn)[0]);
    const hall = await runTurn(inArchive.world, "返回议事厅", mock);
    const back = await runTurn(hall.world, openingQuestion, mock);
    expect(speakers(back.turn)).toHaveLength(1);
    expect(["艾琳","罗兰"]).toContain(speakers(back.turn)[0]);
  });

  it("没有可用的前一位说话者时也可以向全场发问", async () => {
    const privateOpening = start();
    privateOpening.history.find(e => e.kind === "npc")!.perception = "private";
    const noPrior = await runTurn(privateOpening, openingQuestion, mock);
    expect(speakers(noPrior.turn)).toHaveLength(1);
    expect(["艾琳","罗兰"]).toContain(speakers(noPrior.turn)[0]);

    const deadSpeaker = start();
    deadSpeaker.characters.find(c => c.id === "steward")!.condition = "dead";
    deadSpeaker.characters.find(c => c.id === "scribe")!.locationId = "hall";
    const living = await runTurn(deadSpeaker, openingQuestion, mock);
    expect(speakers(living.turn)).toHaveLength(1);
    expect(["罗兰","诺亚"]).toContain(speakers(living.turn)[0]);
  });

  it.each<ActionIntent["kind"]>(["move", "attempt"])("误解析为 %s 时引语仍只作为发言", async kind => {
    const world = start();
    const contexts: DialogueContext[] = [];
    const provider = new MockLLMProvider({
      parse: () => ({kind, target: "宫门"}),
      dialogue: ctx => { contexts.push(ctx); return {text:"我听见了，这只是您的打算。", factIds:[]}; },
      reviewDialogue: () => accepted,
    });
    const { world: after, turn } = await runTurn(world, "“我要去宫门等两天。”我问艾琳问道", provider);
    expect(turn.intent.kind).toBe("speak");
    expect(speakers(turn)).toEqual(["艾琳"]);
    expect(contexts).toHaveLength(1);
    const steward = world.characters.find(c => c.id === "steward")!;
    const facts = world.facts.filter(f => f.knownBy.includes(steward.id) && steward.knownFactIds.includes(f.id));
    expect(contexts[0].speaker.name).toBe(steward.name);
    expect(contexts[0].facts).toEqual(facts.map(f => ({id:f.id, text:f.content.text})));
    expect(turn.narrative).toContain("我听见了，这只是您的打算。");
    expect(after.characters.find(c => c.kind === "player")).toEqual(world.characters.find(c => c.kind === "player"));
    expect(after.facts).toEqual(world.facts);
    expect(after.time - world.time).toBeLessThanOrEqual(world.rules.maxShort);
  });
});
