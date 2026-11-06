import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { WorldStateSchema, type WorldState } from "@worldsim/shared";
import { npcContext } from "./npc-dialogue";
import { runTurn } from "./index";
import { advance, scheduleEvent } from "./scheduler";
import { perceive } from "./state";

function hall(id: string) {
  const world = createPalace(id);
  world.history = [];
  return world;
}

function say(world: WorldState, speakerId: string, text: string, listeners: string[], whisper = false) {
  const speaker = world.characters.find(person => person.id === speakerId)!;
  const id = "test-speech-" + world.history.length;
  world.history.push({
    id, time:world.time, source:speakerId === "king" ? "speech" : "npc-action",
    kind:speakerId === "king" ? "world" : "npc", text, speakerId, speaker:speaker.name,
    perception:"addressed", locationId:speaker.locationId, recipients:listeners, changes:[],
    utterance:{speakerId, listenerIds:listeners, ...(whisper ? {private:true} : {})},
  });
  return id;
}

function context(world: WorldState, actor: string, audience?: string[], currentId?: string, testimony: string[] = []) {
  return npcContext(world, world.characters.find(person => person.id === actor)!,
    "", "你可以回答。", testimony, false, currentId, audience);
}

describe("NPC 听到的对话", () => {
  it("按发言当时的名单还原说话者，事后到场的人没有那段历史", () => {
    const w = hall("hall-audience");
    const first = "我想听听大家对今日议程的意见。", reply = "陛下，我听见您问议程。";
    say(w, "king", first, ["steward", "captain"]);
    say(w, "steward", reply, ["king", "captain"]);
    // The captain can recall this in another room; the arriving scribe did not hear it.
    w.characters.find(person => person.id === "captain")!.locationId = "gate";
    w.characters.find(person => person.id === "scribe")!.locationId = "hall";
    const loaded = WorldStateSchema.parse(JSON.parse(JSON.stringify(w)));
    expect(context(loaded, "captain", ["king", "scribe"]).history).toEqual([
      {role:"player", text:first}, {role:"overheard", speaker:"艾琳", text:reply},
    ]);
    expect(context(loaded, "scribe").history).toEqual([]);
    expect(context(loaded, "steward").history).toContainEqual({role:"npc", text:reply});
    expect(context(loaded, "captain").facts.map(f => f.text)).not.toContain(reply);
  });

  it("旁听者不能回顾耳语，收件人也不能在有新听众时引用耳语", () => {
    const w = hall("whisper");
    const aside = "我们暂时称这件事为青石。";
    say(w, "king", aside, ["steward"], true);
    say(w, "steward", "我记下这个称呼。", ["king"], true);
    const shared = context(w, "steward", ["king", "captain"]).history;
    expect(shared).toEqual([]);
    expect(context(w, "captain").history).toEqual([]);
    expect(context(w, "steward", ["king"]).history.slice(-2)).toEqual([
      {role:"player", text:aside}, {role:"npc", text:"我记下这个称呼。"},
    ]);
  });

  it("仅跳过本次发言的事件 ID，保留最近 16 句可安全送入提示的原话", () => {
    const w = hall("history-window");
    for (let i = 0; i < 18; i++) say(w, "king", "这是第" + i + "句", ["steward"]);
    const repeated = "再说一次。";
    say(w, "king", repeated, ["steward"]);
    say(w, "king", w.facts.find(f => f.type === "secret")!.content.text, ["steward"]);
    const now = say(w, "king", repeated, ["steward"]);
    const history = context(w, "steward", ["king"], now).history;
    expect(history).toHaveLength(16);
    expect(history[0]).toEqual({role:"player", text:"这是第3句"});
    expect(history.filter(line => line.text === repeated)).toEqual([{role:"player", text:repeated}]);
    expect(JSON.stringify(history)).not.toContain(w.facts.find(f => f.type === "secret")!.content.text);
  });

  it("公共回复不包含只有两人知道的线索，有资格作证时才向众人披露", () => {
    const w = hall("clue-audience");
    const clue = w.facts.find(f => f.id === "ledger")!;
    clue.knownBy.push("king");
    w.characters.find(person => person.id === "king")!.knownFactIds.push(clue.id);
    say(w, "scribe", clue.content.text, ["king"], true);
    const privateReply = context(w, "scribe", ["king"]);
    const publicReply = context(w, "scribe", ["king", "captain"]);
    expect(privateReply.facts).toContainEqual({id:clue.id, text:clue.content.text});
    expect(JSON.stringify(publicReply)).not.toContain(clue.content.text);
    const testimony = context(w, "scribe", ["king", "captain"], undefined, [clue.id]);
    expect(testimony.facts).toContainEqual({id:clue.id, text:clue.content.text});
  });
});

describe("NPC 亲历的通报", () => {
  it("08:32 的追问把刚见的钟声和交接簿送给行动与台词模型，在档案室的人只听见钟声", async () => {
    const w = hall("hall-notices");
    w.characters.find(c => c.id === "captain")!.condition = "detained";
    w.characters.find(c => c.id === "warden")!.condition = "dead";
    advance(w, 32, false, []);
    const loaded = WorldStateSchema.parse(JSON.parse(JSON.stringify(w)));
    const bell = loaded.history.find(e => e.source === "bell")!;
    const dispatch = loaded.history.find(e => e.source === "dispatch")!;
    expect(bell.noticeWitnessIds).toContain("scribe");
    expect(bell.noticeWitnessIds).not.toContain("warden");
    expect(new Set(dispatch.noticeWitnessIds)).toEqual(new Set(["king","steward","captain"]));
    const scribe = loaded.characters.find(c => c.id === "scribe")!;
    scribe.locationId = "hall";
    const captain = loaded.characters.find(c => c.id === "captain")!;
    captain.locationId = "gate";
    expect(perceive(dispatch, loaded, scribe)).toBeUndefined();
    expect(perceive(dispatch, loaded, captain)?.text).toBe(dispatch.text);
    expect(context(loaded, "scribe").recentNotices).toEqual([{time:495, text:bell.text}]);
    const expected = [{time:495, text:bell.text}, {time:512, text:dispatch.text}];
    const captured: unknown[] = [];
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => { captured.push(ctx.recentNotices); return {kind:"speak"}; },
      dialogue: ctx => { captured.push(ctx.recentNotices); return {text:"方才钟已经响过了。", factIds:[]}; },
      reviewDialogue: ({context}) => {
        captured.push(context.recentNotices);
        return {grounded:true, citationsAccurate:true, playerAgency:true};
      },
    });
    const turn = await runTurn(loaded, '我问艾琳：“怎么官员还没来？”', provider);
    expect(captured).toEqual([expected, expected, expected]);
    expect(turn.turn.narrative).toContain("方才钟已经响过了。");
    for (const event of loaded.history) Reflect.deleteProperty(event, "noticeWitnessIds");
    expect(context(loaded, "steward").recentNotices).toBeUndefined();
  });

  it("通报按次序保留最近四条；定向通报仅供原听众，私密、取消或计划事件均不进入投影", () => {
    const w = hall("notice-disclosure");
    const sample = w.queue[0];
    for (let i = 1; i <= 5; i++) scheduleEvent(w, {...sample, id:"local" + i, at:480+i,
      perception:"local", text:"门口第" + i + "声鼓响。"});
    const aside = "随从悄声禀报窗帘已经换好。";
    scheduleEvent(w, {...sample, id:"addressed", at:486, perception:"addressed", recipients:["king","steward"], text:aside});
    scheduleEvent(w, {...sample, id:"hidden", at:486, perception:"private", text:"密室中送来一碗米汤。"});
    scheduleEvent(w, {...sample, id:"cancelled", at:486, condition:{flag:"sealSwapped", equals:true}, text:"钟楼的门打开了。"});
    const secret = w.facts.find(f => f.type === "secret")!.content.text;
    scheduleEvent(w, {...sample, id:"unsafe", at:486, perception:"local", text:secret});
    advance(w, 6, false, []);
    const quiet = context(w, "steward", ["king"]);
    expect(quiet.listeners).toEqual(["国王"]);
    expect(quiet.present.map(person => person.name)).toContain("罗兰");
    expect(quiet.recentNotices?.map(e => e.text)).toEqual(["门口第3声鼓响。","门口第4声鼓响。","门口第5声鼓响。",aside]);
    const everyone = context(w, "steward", ["king","captain"]);
    expect(everyone.listeners).toEqual(["国王","罗兰"]);
    expect(everyone.recentNotices?.map(e => e.text)).toEqual([2,3,4,5].map(i => "门口第" + i + "声鼓响。"));
    expect(context(w, "captain").recentNotices?.some(notice => notice.text === aside)).toBe(false);
    expect(w.history.find(event => event.source === "hidden" && event.kind === "world")?.noticeWitnessIds).toBeUndefined();
    expect(w.history.filter(event => event.source === "cancelled").every(event => !event.noticeWitnessIds)).toBe(true);
    advance(w, 44, false, []);
    const executedPlan = w.history.find(event => event.source === "switch" && event.kind === "world")!;
    expect(executedPlan.noticeWitnessIds).toBeUndefined();
    expect(JSON.stringify(context(w, "messenger"))).not.toContain(executedPlan.text);
  });
});
