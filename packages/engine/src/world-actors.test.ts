import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import { WorldStateSchema, type DialogueContext, type NpcActionContext } from "@worldsim/shared";
import { detailedLocationIds, runWorldPulse } from "./npc-response";
import { chooseNpcAction } from "./npc-action";
import { perceive, player, record } from "./state";

describe("世界时钟给各地 NPC 行动机会", () => {
  it("同一异地移动实际落盘，两端各自看见离开或抵达，国王后来赶到也不补发", async () => {
    const world = createPalace("remote-move");
    world.time = 485;
    const actor = world.characters.find(c => c.id === "minister")!;
    const origin = world.characters.find(c => c.id === "scribe")!;
    const destination = world.characters.find(c => c.id === "warden")!;
    const contexts: NpcActionContext[] = [];
    const provider = new MockLLMProvider({decideNpcAction: ctx => {
      contexts.push(ctx);
      return ctx.npc.name === actor.name ? {kind:"move", destination:"garden"} : {kind:"stay"};
    }});
    expect(await runWorldPulse(world, provider)).toEqual([]);
    const travel = world.history.find(e => e.npcAction?.kind === "move")!;
    expect(actor.locationId).toBe("garden");
    expect(travel.time).toBe(485);
    expect(travel.changes).toEqual([{op:"move",actor:actor.id,to:"garden"}]);
    expect(perceive(travel, world, origin)?.text).toContain("离开档案室");
    expect(perceive(travel, world, destination)?.text).toBe(actor.name + "走进王宫花园。");
    player(world).locationId = "garden";
    expect(perceive(travel, world)).toBeUndefined();
    expect(contexts).toHaveLength(2);
    const offsite = contexts.find(c => c.npc.name === actor.name)!;
    expect(offsite.location).toBe("档案室");
    expect(JSON.stringify(offsite)).not.toContain(world.facts.find(f => f.type === "secret")!.content.text);
    const reread = WorldStateSchema.parse(world);
    expect(await runWorldPulse(reread,provider)).toEqual([]);
    expect(contexts).toHaveLength(2);
  });

  it("异地 NPC 可以主动和同室的人交谈；私下的玩家言语和远处的对话互不串场", async () => {
    const world = createPalace("remote-speech");
    const minister = world.characters.find(c => c.id === "minister")!;
    const scribe = world.characters.find(c => c.id === "scribe")!;
    const secretWords = "厅里小声约定的特殊叫法。";
    const whisper = record(world,{source:"speech",kind:"world",text:secretWords,locationId:"hall",
      perception:"addressed",recipients:["steward"],utterance:{speakerId:"king",listenerIds:["steward"], private:true},changes:[]});
    const localWords = "架旁的纸页掉到了地上。";
    const local = record(world,{source:"action",kind:"world",text:localWords,locationId:"archive",
      perception:"local",recipients:[],changes:[]});
    const privateWords = "只有维克多自己看见的私人物件。";
    const personal = record(world,{source:"action",kind:"world",text:privateWords,locationId:"archive",
      perception:"addressed",recipients:[minister.id],changes:[]});
    const drafts: DialogueContext[] = [];
    const plans: NpcActionContext[] = [];
    const words = "这里的卷册收拾妥当了吗？";
    const provider = new MockLLMProvider({
      decideNpcAction: ctx => {
        plans.push(ctx);
        return ctx.npc.name === minister.name ? {kind:"speak"} : {kind:"stay"};
      },
      dialogue: ctx => { drafts.push(ctx); return {text:words,factIds:[]}; },
      reviewDialogue:()=>({grounded:true,playerAgency:true,citationsAccurate:true}),
    });
    const visible = await runWorldPulse(world,provider,{events:[whisper,local,personal]});
    expect(visible).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].input).toBe("");
    expect(drafts[0].listeners).toEqual([scribe.name,"各部属官"]);
    expect(drafts[0].present.map(c=>c.name)).not.toContain("国王");
    const offsite = plans.find(c => c.npc.name === minister.name)!;
    expect(offsite.decision).toContain(localWords);
    expect(drafts[0].decision).toContain(localWords);
    expect(JSON.stringify([offsite,drafts[0]])).not.toContain(privateWords);
    expect(JSON.stringify([offsite,drafts[0]])).not.toContain(secretWords);
    const speech = world.history.find(e => e.dialogueSource === "provider" && e.text === words)!;
    expect(speech.utterance?.listenerIds).toEqual([scribe.id]);
    expect(speech.utterance?.groups).toEqual([{groupId:"court-officials",name:"各部属官",count:18,firstSlot:1}]);
    expect(speech.npcAction?.worldPulse).toBe(true);
    expect(perceive(speech,world)).toBeUndefined();
    await chooseNpcAction(world,scribe,"","独立行动。",[],provider,"ambient");
    expect(plans.at(-1)?.history).toContainEqual({role:"overheard",speaker:minister.name,text:words});
  });

  it("玩家能看到异地 NPC 此刻到达，但不会先看到异地的出发动作", async () => {
    const world = createPalace("world-arrival");
    world.time = 490;
    const minister = world.characters.find(c => c.id === "minister")!;
    const provider = new MockLLMProvider({decideNpcAction:ctx =>
      ctx.npc.name === minister.name ? {kind:"move",destination:"hall"} : {kind:"stay"}});
    const observations = await runWorldPulse(world,provider);
    expect(observations).toEqual([{kind:"world",time:490,text:minister.name + "走进议事厅。"}]);
    expect(player(world).locationId).toBe("hall");
    expect(minister.locationId).toBe("hall");
  });

  it("不同房间的健康角色按上次行动时间轮换，快照和再次调用同一时刻都不会重复行动", async () => {
    const world = createPalace("world-fairness");
    const provider = new MockLLMProvider({decideNpcAction:()=>({kind:"stay"})});
    world.characters.find(c => c.id === "captain")!.condition = "detained";
    for (let i=0; i<4; i++) {
      world.time += 5;
      await runWorldPulse(world,provider);
      const actions = world.history.filter(e => e.npcAction?.worldPulse && e.time === world.time);
      expect(actions).toHaveLength(2);
      const ids = actions.map(e => e.npcAction!.actorId);
      expect(new Set(ids).size).toBe(2);
      expect(ids).not.toContain("king");
      expect(ids).not.toContain("captain");
    }
    const actors = new Set(world.history.filter(e => e.npcAction?.worldPulse).map(e => e.npcAction!.actorId));
    expect(actors).toEqual(new Set(world.characters.filter(c => c.kind === "npc" && c.condition === "healthy").map(c => c.id)));
  });

  it("相隔两步及不可达地点的具名角色即使有当期事务也不单独调用模型；靠近后重新获得机会", async () => {
    const world = createPalace("detailed-range");
    const king = player(world);
    king.locationId = "gate";
    world.locations.push({id:"island",name:"离岛",aliases:[],description:"渡口位于远海。",ambience:"潮声。",exits:[]});
    const warden = world.characters.find(c => c.id === "warden")!;
    warden.locationId = "island";
    const minister = world.characters.find(c => c.id === "minister")!;
    expect(minister.appointments?.length).toBeGreaterThan(0);
    const calls: NpcActionContext[] = [];
    const provider = new MockLLMProvider({decideNpcAction:ctx => {calls.push(ctx); return {kind:"stay"};}});
    const detailed = detailedLocationIds(world);
    expect([...detailed]).toEqual(expect.arrayContaining(["gate","hall","garden"]));
    expect(detailed.has("archive")).toBe(false);
    expect(detailed.has("island")).toBe(false);
    for (let i=0;i<6;i++) {
      world.time = 495 + i*5;
      await runWorldPulse(world,provider,{detailedLocations:detailed});
    }
    expect(calls).toHaveLength(12);
    expect(calls.some(c => c.location === "档案室" || c.location === "离岛")).toBe(false);
    expect(calls.some(c => c.location === "议事厅")).toBe(true);
    expect(calls.filter(c => c.location === "宫门")).toHaveLength(6);
    king.locationId = "hall";
    world.time += 5;
    await runWorldPulse(world,provider);
    expect(calls.some(c => c.npc.name === minister.name)).toBe(true);
    expect(calls.some(c => c.npc.name === warden.name)).toBe(false);
  });

  it("在途时两端及各自相邻的地点保留细节，再远一步仍由地区处理", async () => {
    const world = createPalace("journey-range");
    const king = player(world);
    king.locationId = "archive";
    // Archive -> garden -> gate, plus one extra road beyond the gate.
    world.locations.find(l => l.id === "gate")!.exits.push("outpost");
    world.locations.push({id:"outpost",name:"驿站",aliases:[],description:"路边有马厩。",ambience:"马蹄声。",exits:["gate"]});
    expect(detailedLocationIds(world).has("gate")).toBe(false);
    king.journey = {to:"garden",arrivesAt:490};
    expect(detailedLocationIds(world)).toEqual(new Set(["archive","garden","hall","gate"]));
    const warden = world.characters.find(c => c.id === "warden")!;
    warden.locationId = "outpost";
    const calls: NpcActionContext[] = [];
    const provider = new MockLLMProvider({decideNpcAction:ctx => {calls.push(ctx); return {kind:"stay"};}});
    const options = {excludeActorIds:world.characters.filter(c=>c.locationId === "hall").map(c=>c.id)};
    await runWorldPulse(world,provider,options);
    expect(calls.some(c=>c.location === "宫门")).toBe(true);
    expect(calls.every(c=>c.location !== "驿站" && !c.present.some(p=>p.name === king.name))).toBe(true);
  });
});
