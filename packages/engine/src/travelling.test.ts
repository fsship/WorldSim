import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "@worldsim/llm";
import { createPalace } from "@worldsim/scenarios";
import type { NpcActionContext, WorldState } from "@worldsim/shared";
import { runTurn } from "./index";
import { advance, scheduleEvent } from "./scheduler";
import { applyChanges, player } from "./state";

function localNotice(world:WorldState, id:string, minute:number, room:string, text:string) {
  scheduleEvent(world,{...world.queue[0],id,at:minute,locationId:room,perception:"local",text});
}
function putFirst(world:WorldState, ids:string[]) {
  world.characters.sort((a,b) => Number(ids.includes(b.id)) - Number(ids.includes(a.id)));
}

describe("玩家在两处地点之间赶路", () => {
  it("在路上能听见敲钟，不能旁听两端的私下动静；抵达时才获得目的地的现场", async () => {
    const world = createPalace("between-rooms");
    for (const c of world.characters) {
      if (c.kind === "npc" && c.id !== "steward" && c.id !== "messenger") c.condition = "detained";
    }
    advance(world,12,false,[]);
    localNotice(world,"in-hall",494,"hall","窗边的铃铛被放下。");
    localNotice(world,"at-gate",496,"gate","旅人缓缓摇头。");
    localNotice(world,"at-arrival",497,"gate","门岗当面递来书简。");
    const seen: NpcActionContext[] = [];
    const provider = new MockLLMProvider({decideNpcAction:c=>{
      seen.push(c);
      return {kind:"gesture",gesture:"nod"};
    }});
    const {world:next,turn} = await runTurn(world,"我从议事厅走到宫门。",provider);
    expect(seen.map(c=>c.location).sort()).toEqual(["宫门","议事厅"]);
    for (const c of seen) {
      expect(c.currentTime).toBe(495);
      expect(c.present.some(p=>p.name === "国王")).toBe(false);
      expect(c.listeners).not.toContain("国王");
    }
    expect(turn.events.filter(e=>e.npcAction).every(e=>!e.npcAction!.witnessIds?.includes("king"))).toBe(true);
    expect(turn.narrative).not.toContain("点了点头");
    expect(turn.narrative).not.toContain("铃铛");
    expect(turn.narrative).not.toContain("摇头");
    expect(turn.observations).toContainEqual({kind:"world",text:world.queue.find(e=>e.id === "bell")!.text,time:495});
    const arrival = turn.events.findIndex(e=>e.changes.some(c=>c.op === "move" && c.actor === "king"));
    expect(turn.events[arrival].time).toBe(497);
    expect(turn.events.findIndex(e=>e.source === "at-arrival")).toBeGreaterThan(arrival);
    expect(turn.observations).toContainEqual({kind:"world",text:"门岗当面递来书简。",time:497});
    expect(player(next)).toMatchObject({locationId:"gate"});
    expect(player(next).journey).toBeUndefined();
    const replay = structuredClone(world);
    for (const e of turn.events) applyChanges(replay,e.changes);
    expect(replay.characters).toEqual(next.characters);
    expect(replay.queue).toEqual(next.queue);
    expect(replay.time).toBe(497);
  });

  it("抵达时间恰逢角色行动时，目的地的角色可以看见国王", async () => {
    const world = createPalace("arrive-at-pulse");
    putFirst(world,["scribe","messenger"]);
    const seen: NpcActionContext[] = [];
    const {turn} = await runTurn(world,"我前往宫门。",new MockLLMProvider({decideNpcAction:c=>{
      seen.push(c); return {kind:"stay"};
    }}));
    expect(seen.find(c=>c.npc.name === "米拉")?.present).toContainEqual({name:"国王",role:"国王"});
    expect(turn.events.find(e=>e.changes.some(c=>c.op === "move" && c.actor === "king"))?.time).toBe(485);
    expect(turn.events.findIndex(e=>e.source === "action")).toBeLessThan(turn.events.findIndex(e=>e.npcAction));
  });

  it("途中无法提前抵达、改道或发起关系变更，旧日志里的移动依然可重放", () => {
    const world = createPalace("travel-guard");
    applyChanges(world,[{op:"depart",actor:"king",to:"gate",arrivesAt:485}]);
    expect(() => applyChanges(world,[{op:"move",actor:"king",to:"gate"}])).toThrow();
    expect(() => applyChanges(world,[{op:"relation",actor:"steward",other:"king",delta:1}])).toThrow();
    applyChanges(world,[{op:"clock",to:485}]);
    expect(() => applyChanges(world,[{op:"move",actor:"king",to:"archive"}])).toThrow();
    applyChanges(world,[{op:"move",actor:"king",to:"gate"}]);
    applyChanges(world,[{op:"move",actor:"king",to:"hall"}]);
    expect(player(world).locationId).toBe("hall");
  });
});
