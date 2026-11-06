import {
  ActionTextSchema, GameTurnSchema, NarrationPlanSchema, ResolutionProposalSchema, roomDescription,
  WorldStateSchema, type LLMProvider, type GameTurn, type Observation, type WorldEvent, type WorldState, type PublicTurn,
} from "@worldsim/shared";
import { interpretTurn } from "./turn-interpretation";
import { utterance, withinEarshot } from "./hearing";
import { ambientReaction, detailedLocationIds, npcResponse, runWorldPulse } from "./npc-response";
import { advanceRegion, observePopulation } from "./regional";
import { createTurnClock, nextWorldOpportunity } from "./scheduler";
import { readDocument } from "./reading";
import { perceive, player, present, projectWorld, record } from "./state";

export { projectWorld, perceive, knownFacts } from "./state";
export { scheduleEvent, cancelEvent, rescheduleEvent } from "./scheduler";
export { prepareOpening, retryOpening } from "./npc-response";
export { replyRecovery, retryDialogue, displayReplyRecovery } from "./recovery";

export function projectTurn(turn: GameTurn): PublicTurn {
  const {version, input, startTime, endTime, observations, narrative, hearing} = turn;
  return {version, input, startTime, endTime, observations, narrative, ...(hearing ? {hearing} : {})};
}

async function narrate(observations: Observation[], provider: LLMProvider) {
  let styles: ("plain" | "perceived")[] = [];
  try {
    const plan = observations.some(o => o.kind === "world") ?
      NarrationPlanSchema.parse(await provider.narrate({observations: structuredClone(observations)})) : {lines:[]};
    // Narration cannot change the order of events, forge an observation, or suppress a decision point.
    if (plan.lines.length === observations.length && plan.lines.every((l, i) => l.index === i))
      styles = plan.lines.map(l => l.style);
  } catch {
    // All prose stays anchored to the observations even when the narration service is unavailable.
  }
  return observations.map((o, i) => {
    if (o.kind === "dialogue") return "「" + o.text + "」";
    if (o.kind === "world" && styles[i] === "perceived" && !o.text.startsWith("你")) return "你留意到：" + o.text;
    return o.text;
  }).join("\n");
}

export async function runTurn(previous: WorldState, input: string, provider: LLMProvider): Promise<{world: WorldState; turn: GameTurn}> {
  const text = ActionTextSchema.parse(input);
  // Zod constructs an independent working state. Nothing in the caller's save is touched by a failed turn.
  const world = WorldStateSchema.parse(previous);
  const startTime = world.time, offset = world.history.length;
  const king = player(world), view = projectWorld(world);
  const {intent, words, resolution, plan} = await interpretTurn(world, text, provider);
  let choice = resolution.candidates[0];
  let minutes = choice.minutes;
  if (resolution.askModel) {
    const proposal = ResolutionProposalSchema.parse(await provider.resolve({
      text, intent:structuredClone(intent), location:view.location.name,
      actor:{name:king.name, role:king.role, abilities:[...king.abilities]},
      options:resolution.candidates.map(c => ({id:c.id, summary:c.lines.map(l => l.text).join(" ")})),
    }));
    const chosen = resolution.candidates.find(c => c.id === proposal.optionId);
    if (!chosen) throw new Error("模型选择了未授权的裁决。");
    choice = chosen;
    minutes = Math.max(1, Math.min(proposal.minutes ?? chosen.minutes, world.rules.maxShort));
  }
  const observations: Observation[] = [];
  let speechEventId: string | undefined;
  let hearing: PublicTurn["hearing"];
  if (resolution.speech) {
    const quiet = resolution.speech.private;
    const privateTo = resolution.speech.privateTo;
    const listeners = quiet && !privateTo ? [] : withinEarshot(world, king, privateTo);
    const heard = utterance(world, king, listeners, quiet);
    speechEventId = record(world, {
      source:"speech", kind:"world", speakerId:king.id, speaker:king.name, text:words ?? text,
      locationId:king.locationId, perception:"addressed", recipients:heard.listenerIds, utterance:heard, changes:[],
    }).id;
    hearing = {volume:quiet ? "private" : "room", listeners:listeners.map(c => c.name),
      ...(heard.groups ? {groups:heard.groups.map(({name,count})=>({name,count}))} : {})};
  }
  if (resolution.dialogue) {
    const {npc, decision, allowedTestimonyIds, order} = resolution.dialogue;
    // Only player-authorized social effects belong to the player's action.
    // An NPC order is committed separately, and only if the NPC actually complies.
    if (choice.changes.length) record(world, {source:"action", kind:"system", text:"交谈产生了影响。",
      perception:"private", recipients:[], locationId:king.locationId, changes:choice.changes});
    observations.push(...await npcResponse(world, npc, words ?? text, decision, allowedTestimonyIds,
      provider, "addressed", order, speechEventId, resolution.speech?.private));
  }
  const trip = choice.changes.find(c => c.op === "move" && c.actor === king.id);
  const duration = Math.min(minutes, world.rules.maxShort, world.rules.maxWait);
  let waitEvent: WorldEvent | undefined;
  const commitAction = () => {
    for (const [i, response] of choice.lines.entries()) {
      const dest = i === 0 && trip?.op === "move" ? world.locations.find(l => l.id === trip.to) : undefined;
      const e = record(world, {source:"action", kind:response.kind === "dialogue" ? "npc" : response.kind,
        text:response.text + (dest ? roomDescription(world,dest) : ""), speaker:response.speaker, perception:"addressed", recipients:[king.id], observedItemId:resolution.itemId,
        locationId:trip?.op === "move" ? trip.to : king.locationId, changes:i === 0 ? choice.changes : []});
      const observation = perceive(e, world);
      if (resolution.waiting && !waitEvent) waitEvent = e;
      if (observation) observations.push(trip ? {...observation,time:e.time} : observation);
    }
  };
  if (trip?.op === "move") {
    record(world,{source:"departure", kind:"world", text:"国王离开了" + view.location.name + "。",
      perception:"addressed", recipients:present(world,king).filter(c => c.condition !== "dead").map(c => c.id),
      locationId:king.locationId, changes:[{op:"depart",actor:king.id,to:trip.to,arrivesAt:world.time + duration}]});
  } else commitAction();
  if (resolution.reading) {
    for (const observation of observations) observation.time = world.time;
  }
  const beforeClock = observations.length;
  let ticked = false;
  let sincePulse = offset;
  let previousTime = startTime;
  let horizon: {origin:string; destination?:string; locations:Set<string>} | undefined;
  function detailedHere() {
    const destination = king.journey?.to;
    if (!horizon || horizon.origin !== king.locationId || horizon.destination !== destination)
      horizon = {origin:king.locationId, destination, locations:detailedLocationIds(world)};
    return horizon.locations;
  }
  const clock = createTurnClock(world, observations, async () => {
    ticked = true;
    const detailed = detailedHere();
    const interval = world.history.slice(sincePulse);
    const stationary = !interval.some(e => e.changes.some(c => (c.op === "depart" || c.op === "move") && c.actor === king.id));
    const crowd = observePopulation(world,previousTime,stationary);
    const nearby = await runWorldPulse(world, provider, {
      events:world.history.slice(sincePulse), detailedLocations:detailed,
      waited:resolution.waiting ? world.time - startTime : undefined,
      excludeActorIds:resolution.dialogue && world.time - startTime < 5 ? [resolution.dialogue.npc.id] : [],
    });
    const distant = await advanceRegion(world,provider,detailed);
    previousTime = world.time;
    sincePulse = world.history.length;
    return [...crowd,...nearby,...distant];
  }, (current,after) => nextWorldOpportunity(current,after,detailedHere()));
  let interrupted: boolean;
  let goalMet = false;
  if (trip) {
    interrupted = await clock.advance(duration,false,undefined,commitAction);
  } else if (resolution.reading) {
    interrupted = await readDocument(world, resolution.reading, observations, minutes, clock);
  } else if (resolution.waiting && resolution.eventNeedle) {
    const condition = resolution.eventNeedle;
    interrupted = await clock.advance(minutes, true, async notices => {
      if (!plan) {
        goalMet = notices.some(text => text.includes(condition));
        return goalMet;
      }
      const decision = ResolutionProposalSchema.parse(await provider.resolve({
        text, intent:structuredClone(intent), location:view.location.name,
        actor:{name:king.name, role:king.role, abilities:[...king.abilities]},
        options:[{id:"met", summary:"已观察到所等的事件"}, {id:"continue", summary:"尚未观察到所等的事件"}],
        waitEvidence:{condition, notices},
      }));
      if (decision.optionId !== "met" && decision.optionId !== "continue") throw new Error("无效的等待判定。");
      goalMet = decision.optionId === "met";
      return goalMet;
    });
  } else {
    interrupted = await clock.advance(resolution.waiting ? minutes : Math.min(world.rules.maxShort, minutes),
      resolution.waiting, resolution.eventNeedle);
  }
  if (waitEvent && interrupted && !goalMet && startTime + minutes > world.time)
    waitEvent.pendingWait = {until:startTime + minutes, event:resolution.eventNeedle || undefined, rest:intent.kind === "rest"};
  // The journal normally labels an unstamped line with the turn's end. When
  // other events intervened, label the initial action at its actual time.
  if (ticked) {
    for (const observation of observations.slice(0,beforeClock)) observation.time ??= startTime;
  }
  if (!ticked && !resolution.speech && !resolution.dialogue && choice.status !== "refused" && !interrupted && king.condition === "healthy") {
    const waited = resolution.waiting ? world.time - startTime : undefined;
    observations.push(...await ambientReaction(world, world.history.slice(offset), provider, waited));
  }
  const narrative = await narrate(observations, provider);
  world.version++;
  const events = world.history.slice(offset);
  const turn = GameTurnSchema.parse({
    version:world.version, input:text, startTime, endTime:world.time, intent, plan, ...(hearing ? {hearing} : {}),
    resolution:{status:choice.status, optionId:choice.id, preconditions:resolution.checks},
    events, changes:events.flatMap(e => e.changes), observations, narrative,
  });
  return {world, turn};
}
