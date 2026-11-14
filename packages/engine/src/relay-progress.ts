import type { Character, NpcCommitment, Observation, WorldEvent, WorldState } from "@worldsim/shared";
import { relayAudience } from "./hearing";
import { commitNpcAction } from "./npc-action";
import { nextStep } from "./regional";
import { perceive, record } from "./state";

export function nextRelayTime(world:WorldState, after:number) {
  let next = Infinity;
  for (const plan of world.commitments) {
    if (plan.status === "pending") next = Math.min(next, Math.max(after + 1,plan.nextAt));
  }
  return next;
}

function reportFailure(world:WorldState, plan:NpcCommitment, actor:Character, reason:string) {
  return record(world,{source:"commitment-failed",kind:"system",locationId:actor.locationId,
    text:actor.name + "没能完成转告：" + reason,perception:"addressed",recipients:[actor.id],
    changes:[{op:"advanceCommitment",id:plan.id,status:"failed",reason}]});
}

function progress(world:WorldState, plan:NpcCommitment, actor:Character):WorldEvent {
  if (actor.condition !== "healthy" || actor.journey) return reportFailure(world,plan,actor,"目前无法行动。");
  if (actor.locationId !== plan.destinationId) {
    const to = nextStep(world,actor.locationId,plan.destinationId);
    const move = to && commitNpcAction(world,actor,{source:"commitment",proposal:{kind:"move",destination:to}},"npc-action",undefined,"ambient");
    if (!move) return reportFailure(world,plan,actor,"到目的地的路线不通。");
    record(world,{source:"commitment-progress",kind:"system",locationId:actor.locationId,perception:"private",recipients:[],text:"转告途中。",
      changes:[{op:"advanceCommitment",id:plan.id,status:"pending",nextAt:world.time+(to === plan.destinationId ? 1 : 5)}]});
    return move;
  }
  const heard = relayAudience(world,actor,plan.audience);
  if (!heard) return reportFailure(world,plan,actor,"到了约定地点，没找到要转告的人。");
  const sender = world.history.find(e => e.id === plan.requestEventId)?.utterance?.speakerId;
  const name = world.characters.find(c=>c.id===sender)?.name;
  if (!name) return reportFailure(world,plan,actor,"无法核实原委托人。");
  return record(world,{source:"commitment-delivery",kind:"npc",locationId:actor.locationId,speakerId:actor.id,speaker:actor.name,
    perception:"addressed",recipients:heard.listenerIds,utterance:heard,text:name+"托我转告：“"+plan.message+"”",
    npcAction:{kind:"speak",actorId:actor.id,source:"commitment",trigger:"ambient"},changes:[{op:"advanceCommitment",id:plan.id,status:"delivered"}]});
}

/** One bodily action per actor per instant, even if several promises are due. */
export function progressRelays(world:WorldState) {
  const observations:Observation[] = [];
  const deliveries:WorldEvent[] = [];
  const acted = new Set<string>();
  for (const plan of world.commitments) {
    if (plan.status !== "pending" || plan.nextAt > world.time || acted.has(plan.actorId)) continue;
    const actor = world.characters.find(c=>c.kind === "npc" && c.id === plan.actorId);
    if (!actor) throw new Error("转告计划缺少执行人。");
    acted.add(actor.id);
    const event = progress(world,plan,actor);
    const seen = perceive(event,world);
    if (seen) observations.push({...seen,time:event.time});
    if (event.source === "commitment-delivery") deliveries.push(event);
  }
  return {observations,deliveries,acted};
}
