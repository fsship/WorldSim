import { describe, expect, it, vi } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { Observation, WorldState } from "@worldsim/shared";
import { planReading, readDocument } from "./reading";
import { createTurnClock, nextWorldOpportunity } from "./scheduler";
import { perceive, player, record } from "./state";
import { detailedLocationIds } from "./npc-response";
import { runTurn } from "./index";

function enterHall(world: WorldState): Observation[] {
  const event = record(world,{
    source:"npc-action", kind:"world", text:"书记员诺亚走进了议事厅。",
    locationId:"hall", recipients:["king"], perception:"local",
    npcAction:{actorId:"scribe",kind:"move",source:"provider",trigger:"ambient",witnessIds:["king","scribe"]},
    changes:[{op:"move",actor:"scribe",to:"hall"}],
  });
  return [perceive(event,world)!];
}

describe("玩家耗时与世界事件共用的时钟", () => {
  it("重要钟声先于同分钟的角色行动，两者均已发生后才交还控制", async () => {
    const world = createPalace("simultaneous-bell");
    world.time = 493;
    const observations: Observation[] = [];
    const clock = createTurnClock(world,observations,async w => {
      expect(w.time).toBe(495);
      expect(w.queue.find(e => e.id === "bell")?.status).toBe("executed");
      return enterHall(w);
    });
    expect(await clock.advance(10,true)).toBe(true);
    expect(world.time).toBe(495);
    expect(observations.map(o => o.kind)).toEqual(["world","world","system"]);
    expect(observations[0].text).toContain("钟声");
    expect(observations[1].text).toContain("走进");
    expect(observations.every(o => o.time === 495)).toBe(true);
    expect(world.characters.find(c => c.id === "scribe")?.locationId).toBe("hall");
  });

  it("明确等人的条件只收到已经目击的动静，能在到场的那一分钟返回", async () => {
    const world = createPalace("witnessed-pulse");
    world.queue = [];
    const observations: Observation[] = [];
    const clock = createTurnClock(world,observations,async w => {
      if (w.time === 490) return enterHall(w);
      record(w,{source:"npc-action",kind:"world",text:"庭院的树梢轻晃。",
        locationId:"garden",perception:"local",recipients:[],changes:[]});
      return [];
    });
    const matches = vi.fn(async (notes:string[]) => notes.some(t => t.includes("走进")));
    expect(await clock.advance(15,true,matches)).toBe(true);
    expect(world.time).toBe(490);
    expect(matches.mock.calls).toEqual([[["书记员诺亚走进了议事厅。"]]]);
    expect(observations.map(o => o.text).join(" ")).not.toContain("庭院");
  });

  it("目标与重要通报同时发生时，两项现场证据一起用于判断", async () => {
    const world = createPalace("bell-and-arrival");
    world.time = 493;
    const matches = vi.fn(async (notes:string[]) => notes.some(t => t.includes("诺亚")));
    const clock = createTurnClock(world,[],async w => enterHall(w));
    await clock.advance(20,true,matches);
    expect(world.time).toBe(495);
    expect(matches.mock.calls[0][0]).toEqual([world.queue.find(e=>e.id === "bell")!.text,"书记员诺亚走进了议事厅。"]);
  });

  it("阅读按实际分钟让出时钟，到场事件打断阅读且保留逐项书签", async () => {
    const world = createPalace("reading-during-arrival");
    world.time = 484;
    const observations: Observation[] = [];
    const clock = createTurnClock(world,observations,async w => enterHall(w));
    const doc = world.readables[0];
    const plan = planReading(world,{target:"",documentId:doc.id});
    if ("notice" in plan) throw Error(plan.notice);
    expect(await readDocument(world,plan,observations,0,clock)).toBe(true);
    expect(world.time).toBe(485);
    expect(observations.map(o => o.text).join(" ")).not.toContain(doc.entries[1].text);
    expect(observations.map(o => o.text).join(" ")).toContain("从第2项");
    const resumed = planReading(world,{target:"",resume:true});
    expect(resumed).toMatchObject({start:1});
    if ("notice" in resumed) throw Error(resumed.notice);
    expect(await readDocument(world,resumed,observations,0,clock)).toBe(false);
    expect(world.history.filter(e=>e.npcAction)).toHaveLength(1);
  });

  it("跨越长等待的处理上限时停在已模拟的分钟，再等时不会跳过或重复任何角色行动", async () => {
    const world = createPalace("bounded-world-clock");
    world.queue = [];
    world.time = 488;
    const times: number[] = [];
    const pulse = async (w:WorldState) => { times.push(w.time); return []; };
    const observations: Observation[] = [];
    expect(await createTurnClock(world,observations,pulse).advance(100,true)).toBe(true);
    expect(times).toEqual([490,495,500,505,510,515]);
    expect(world.time).toBe(515);
    expect(observations.at(-1)?.text).toContain("决定是否继续");
    expect(await createTurnClock(world,observations,pulse).advance(6,true)).toBe(false);
    expect(times.at(-1)).toBe(520);
    expect(times).toHaveLength(7);
    expect(world.time).toBe(521);
  });

  it("起读、载入整分钟的存档或零耗时操作不会补算此前的角色行动", async () => {
    const world = createPalace("no-retroactive-pulse");
    world.time = 490;
    const pulse = vi.fn(async () => []);
    const clock = createTurnClock(world,[],pulse);
    await clock.advance(0,false);
    await clock.advance(4,false);
    expect(pulse).not.toHaveBeenCalled();
    await clock.advance(1,false);
    await clock.advance(0,false);
    expect(pulse).toHaveBeenCalledTimes(1);
    expect(world.time).toBe(495);
  });

  it("同样等九十分钟，安静的行宫可直接度过；王宫附近仍会在六次现场机会后交还控制", async () => {
    const seed = createPalace("adaptive-clock");
    seed.time = 600;
    seed.queue = [];
    const provider = new MockLLMProvider({decideNpcAction:()=>({kind:"stay"})});
    player(seed).locationId = "river-palace";
    const remote = await runTurn(seed,"等待90分钟",provider);
    expect(remote.world.time).toBe(690);
    expect(remote.turn.events.filter(e => e.source === "clock").map(e => e.time)).toEqual([630,660,690]);
    expect(remote.turn.events.some(e => e.npcAction?.worldPulse)).toBe(false);
    expect(remote.turn.narrative).not.toContain("决定是否继续");
    player(seed).locationId = "hall";
    const local = await runTurn(seed,"等待90分钟",provider);
    expect(local.world.time).toBe(630);
    expect(local.turn.narrative).toContain("决定是否继续");
  });

  it("远处的定时通报仍按原分钟执行，人物到达后从下一次五分钟机会开始详算", async () => {
    const world = createPalace("wake-near-cast");
    world.time = 600;
    player(world).locationId = "river-palace";
    const appointment = {...world.queue.find(e => e.id === "breach")!, id:"visitor-arrives",
      at:612, condition:{}, effects:[], locationId:"river-village", text:"书记员抵达河谷村。",
      arrival:{id:"village-clerk",name:"村书记员",role:"书记员",aliases:[],locationId:"river-village",publicDuty:"在本地登记。"}};
    world.queue = [appointment];
    const pulses:number[] = [];
    const observations: Observation[] = [];
    const schedule = (w:WorldState, after:number) => nextWorldOpportunity(w,after,detailedLocationIds(w));
    const clock = createTurnClock(world,observations,async w => {pulses.push(w.time);return [];},schedule);
    const reached = vi.fn();
    expect(await clock.advance(23,false,undefined,reached)).toBe(false);
    expect(world.time).toBe(623);
    expect(observations).toContainEqual({kind:"world",text:appointment.text,time:612});
    expect(pulses).toEqual([615,620]);
    expect(reached).toHaveBeenCalledOnce();
  });

  it("近处的人前往远方后改用半小时结算，六次配额按实际发生的机会核算", async () => {
    const world = createPalace("mix-detailed-and-coarse");
    world.queue = [];
    world.time = 600;
    player(world).locationId = "river-palace";
    const traveller = world.characters.find(c => c.id === "steward")!;
    traveller.locationId = "river-village";
    const times:number[] = [];
    const clock = createTurnClock(world,[],async w => {
      times.push(w.time);
      if (times.length === 1) record(w,{source:"npc-action",kind:"world",locationId:"river-village",perception:"local",
        recipients:[],text:"侍从前往驿道。",changes:[{op:"move",actor:traveller.id,to:"post-road"}]});
      return [];
    }, (w,after) => nextWorldOpportunity(w,after,detailedLocationIds(w)));
    expect(await clock.advance(240,true)).toBe(true);
    expect(times).toEqual([605,630,660,690,720,750]);
    expect(world.time).toBe(750);
  });

  it("空旷场景会先处理本地人群的下一次可见变化，不必逐个居民轮询", () => {
    const world = createPalace("upcoming-local-crowd");
    world.time = 600;
    player(world).locationId = "river-palace";
    world.populationGroups = [{id:"river-staff",name:"办差侍从",size:6,homeId:"river-village",
      work:{locationId:"river-palace",task:"到行宫当值",from:612,by:642,leave:700,homeBy:720}}];
    expect(nextWorldOpportunity(world,600,detailedLocationIds(world))).toBe(620);
    expect(nextWorldOpportunity(world,620,detailedLocationIds(world))).toBe(625);
  });
});
