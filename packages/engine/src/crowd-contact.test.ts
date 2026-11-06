import { describe, expect, it, vi } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { groupCountAt, WorldStateSchema, type DialogueContext, type ParseContext, type TurnPlan } from "@worldsim/shared";
import { runTurn } from "./index";
import { applyChanges, player } from "./state";

const village = "river-village", road = "post-road";
const words = "你们现在有什么事要办？";
function newVillage() {
  const world = createPalace("meet-villagers");
  player(world).locationId = village;
  return world;
}
function localProvider(interpret:(ctx:ParseContext)=>TurnPlan, drafts:DialogueContext[] = []) {
  return Object.assign(new MockLLMProvider({
    decideNpcAction:c=>c.trigger === "addressed" ? {kind:"speak"} : {kind:"stay"},
    dialogue:c=>{ drafts.push(c); return {text:"您想问哪一件？",factIds:[]}; },
    reviewDialogue:()=>({grounded:true,playerAgency:true,citationsAccurate:true}),
  }),{interpret:vi.fn(async (ctx:ParseContext)=>interpret(ctx))});
}
const toGroup = (ctx:ParseContext):TurnPlan => {
  const ref = ctx.referents!.find(r=>r.kind === "crowd" && r.name === "河谷居民")!;
  return {kind:"speak",words,targetId:ref.id,private:false};
};

describe("在现场向群体中的一人搭话", () => {
  it("以一个持久的人承接对话，公开发言还会被剩余的人听见，人数保持守恒", async () => {
    const previous = newVillage();
    const group = previous.populationGroups.find(g=>g.id === "valley-residents")!;
    group.size = 1000000;
    const drafts:DialogueContext[] = [];
    const first = await runTurn(previous,"我问河谷居民：“" + words + "”",localProvider(toGroup,drafts));
    const updated = first.world.populationGroups.find(g=>g.id === group.id)!;
    const contact = first.world.characters.find(c=>c.id === updated.representative?.id)!;
    expect(contact.locationId).toBe(village);
    expect(contact.knownFactIds).toEqual([]);
    expect(group.representative).toBeUndefined();
    expect(first.world.characters.length).toBe(previous.characters.length + 1);
    expect(groupCountAt(updated,village,first.world.time) + groupCountAt(updated,road,first.world.time)).toBe(999999);
    expect(first.turn.changes).toContainEqual({op:"meet",group:group.id,locationId:village});
    expect(first.turn.hearing).toEqual({volume:"room",listeners:[contact.name],groups:[{name:group.name,count:999999}]});
    expect(drafts[0].facts).toEqual([]);
    expect(drafts[0].listeners).toEqual(["国王",group.name]);

    const restored = WorldStateSchema.parse(JSON.parse(JSON.stringify(first.world)));
    const followup = await runTurn(restored,"“然后呢？”",localProvider(ctx=>{
      expect(ctx.referents!.filter(r=>r.kind === "npc" && r.id === contact.id)).toHaveLength(1);
      expect(ctx.referents!.some(r=>r.kind === "crowd" && r.name === group.name)).toBe(false);
      return {kind:"speak",words:"然后呢？",private:true,targetId:contact.id};
    },drafts));
    expect(followup.turn.changes.some(c=>c.op === "meet")).toBe(false);
    expect(followup.turn.hearing).toEqual({volume:"private",listeners:[contact.name]});
    expect(drafts[1].history).toContainEqual({role:"player",text:words});
    expect(followup.world.characters).toHaveLength(first.world.characters.length);

    // An individual who has left town is no longer among that town's bystanders.
    applyChanges(restored,[{op:"move",actor:contact.id,to:road}]);
    const away = await runTurn(restored,"“有人吗？”",localProvider(ctx=>{
      expect(ctx.referents?.some(r=>r.id === contact.id)).toBe(false);
      return {kind:"speak",words:"有人吗？",private:false,targetUnavailable:true};
    }));
    expect(away.world.characters.find(c=>c.id === contact.id)?.locationId).toBe(road);
    expect(away.turn.hearing).toEqual({volume:"room",listeners:[],groups:[
      {name:group.name,count:groupCountAt(updated,village,away.turn.startTime)},
    ]});
  });

  it("未点名的公开问题只记录可听人数；提到群体或指向不在场的群体不生成代表", async () => {
    const w = newVillage();
    const mentioned = "河谷居民有多少？";
    const general = await runTurn(w,"“" + mentioned + "”",localProvider(()=>({kind:"speak",words:mentioned,private:false})));
    expect(general.turn.hearing).toEqual({volume:"room",listeners:[],groups:[{name:"河谷居民",count:240}]});
    expect(general.turn.changes.some(c=>c.op === "meet")).toBe(false);
    const remote = await runTurn(w,"我向王宫的属官低声说：“晚上好。”",localProvider(ctx=>{
      expect(ctx.referents!.some(r=>r.name === "各部属官")).toBe(false);
      return {kind:"speak",words:"晚上好。",private:true,targetId:"crowd:court-officials"};
    }));
    expect(remote.turn.hearing).toBeUndefined();
    expect(remote.world.characters).toEqual(w.characters);
    const invalid = await runTurn(w,"下令集合。",localProvider(()=>({kind:"order",words:"集合",private:false,targetId:"crowd:valley-residents"})));
    expect(invalid.turn.changes).toEqual([]);
  });

  it("代表只记得自己所在那部分人实际听见的发言；其余地点与耳语都不成为记忆", async () => {
    const w = newVillage();
    w.time = 500; w.queue = [];
    w.characters.find(c=>c.id === "captain")!.locationId = village;
    const heard = "我们把这片田叫青禾。";
    const whisper = "几个人商量的是银杏。";
    const a = await runTurn(w,"“" + heard + "”",localProvider(()=>({kind:"speak",words:heard,private:false})));
    const stamp = a.turn.events.find(e=>e.source === "speech")!.utterance!;
    expect(stamp.groups?.[0]).toMatchObject({groupId:"valley-residents",firstSlot:81,count:160});
    const b = await runTurn(a.world,"我向罗兰耳语：“" + whisper + "”",localProvider(()=>({kind:"speak",words:whisper,private:true,targetId:"captain"})));
    expect(b.turn.events.find(e=>e.source === "speech")!.utterance?.groups).toBeUndefined();
    const drafts:DialogueContext[]=[];
    await runTurn(b.world,"我问一位河谷居民：“" + words + "”",localProvider(toGroup,drafts));
    expect(drafts[0].history.map(h=>h.text)).toContain(heard);
    expect(drafts[0].history.map(h=>h.text)).not.toContain(whisper);
    const away = await runTurn(b.world,"前往宫外驿道",localProvider(()=>({kind:"move",destination:road})));
    const other:DialogueContext[]=[];
    await runTurn(away.world,"我问早集里的河谷居民：“" + words + "”",localProvider(toGroup,other));
    expect(other[0].history.map(h=>h.text)).not.toContain(heard);
    expect(other[0].history.map(h=>h.text)).not.toContain(whisper);
  });

  it("即使在场的国王与证人都已知某条线索，一群不知情者也不能成为秘密披露的通道", async () => {
    const world = createPalace("crowd-disclosure");
    player(world).locationId = "archive";
    world.time = 480;
    const drafts:DialogueContext[]=[];
    applyChanges(world,[{op:"learn",actor:"king",fact:"ledger"}]);
    const said = "这个登记簿是真的吗？";
    for (const quiet of [false,true]) {
      await runTurn(world,"我问诺亚：“" + said + "”",
        localProvider(()=>({kind:"speak",targetId:"scribe",words:said,private:quiet}),drafts));
    }
    expect(drafts[0].listeners).toContain("各部属官");
    expect(drafts[0].facts.map(f=>f.id)).not.toContain("ledger");
    expect(drafts[1].listeners).toEqual(["国王"]);
    expect(drafts[1].facts.map(f=>f.id)).toContain("ledger");
  });

  it("离线模式仅凭明确指名的现场发言建立联系，存档的有名人物不受覆盖", async () => {
    const w = newVillage();
    const a = await runTurn(w,"我问河谷居民：“你好。”",new MockLLMProvider());
    expect(a.world.populationGroups.find(g=>g.id === "valley-residents")?.representative).toBeDefined();
    const impostor = w.characters.find(c=>c.id === "captain")!;
    impostor.id = "crowd:valley-residents";
    const b = await runTurn(w,"我问河谷居民：“你好。”",new MockLLMProvider());
    expect(b.world.characters).toHaveLength(w.characters.length);
    expect(b.world.characters.find(c=>c.id === impostor.id)?.name).toBe(impostor.name);
  });
});
