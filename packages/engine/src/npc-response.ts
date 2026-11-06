import type { Character, LLMProvider, NpcActionContext, Observation, WorldEvent, WorldState } from "@worldsim/shared";
import { chooseNpcAction, commitNpcAction, type NpcOrder } from "./npc-action";
import { replyFailureNotice, writeNpcReply } from "./npc-dialogue";
import { impliedListener } from "./conversation";
import { disclosureAudience, utterance, withinEarshot } from "./hearing";
import { inLocation, knownFacts, perceive, player, present, projectWorld, record } from "./state";
import { considerEncounter } from "./encounter";

type Trigger = NpcActionContext["trigger"];

export async function npcResponse(world: WorldState, npc: Character, input: string, decision: string, testimonyIds: string[],
  provider: LLMProvider, trigger: Trigger, order?: NpcOrder, speechEventId?: string, quiet = false,
  witnessedScene?: string): Promise<Observation[]> {
  const king = player(world);
  const events: WorldEvent[] = [];
  const source = trigger === "opening" ? "opening" : "npc-action";
  const replyTo = quiet ? king.id : undefined;
  const audienceIds = disclosureAudience(utterance(world,npc,withinEarshot(world,npc,replyTo),quiet));
  const choice = await chooseNpcAction(world, npc, input, decision, testimonyIds, provider, trigger, order, speechEventId, audienceIds, witnessedScene);
  const proposal = choice.proposal;
  const stamp = {actorId:npc.id, kind:proposal.kind, source:choice.source, trigger};
  const physical = commitNpcAction(world, npc, choice, source, order, trigger);
  if (physical) events.push(physical);
  const willSpeak = proposal.kind === "speak" || (physical && "thenSpeak" in proposal && proposal.thenSpeak);
  const recordSilence = (failure?: Exclude<WorldEvent["npcFailure"], "encounter">, verdict?: WorldEvent["npcReview"]) => {
    const failureText = failure === "decision" ? "本轮未能取得有效的行动。" :
      failure ? replyFailureNotice({failure,verdict}) : undefined;
    const notice = trigger === "opening" ? undefined : failureText;
    const visible = (trigger !== "ambient" || notice !== undefined) && inLocation(king,npc.locationId);
    events.push(record(world, {
      source, kind:notice || physical ? "system" : "world", locationId:npc.locationId,
      recipients:visible ? [king.id] : [], perception:visible ? (notice ? "addressed" : "local") : "private",
      text:npc.name + (notice ?? (physical ? "没有继续开口。" : "留在原处，没有开口。")), changes:[],
      ...(physical ? {} : {npcAction:failure === "decision" ? {actorId:npc.id, kind:"stay", source:"fallback", trigger} : stamp}),
      ...(failure ? {npcFailure:failure} : {}), ...(verdict ? {npcReview:verdict} : {}),
    }));
  };
  const hereWithKing = inLocation(king,npc.locationId);
  const listeners = withinEarshot(world, npc, replyTo);
  const heard = utterance(world,npc,listeners,quiet);
  if (willSpeak && (hereWithKing || (trigger === "ambient" && (listeners.length > 0 || heard.groups?.length)))) {
    const speakingScene = hereWithKing ? decision : (witnessedScene ?? "") + "你与同处一室的人交谈，" + king.name + "不在场。";
    const outcome = physical ? physical.text + (proposal.kind === "carryOutOrder" && order ? order.summary + "该命令已经执行。" : "") : speakingScene;
    const reply = await writeNpcReply(world, npc, hereWithKing ? input : "", outcome, hereWithKing ? testimonyIds : [], provider, trigger === "opening",
      speechEventId, disclosureAudience(heard));
    if ("failure" in reply) {
      recordSilence(reply.failure, reply.verdict);
    } else {
      const learned = listeners.flatMap(person => {
        const known = new Set(knownFacts(world, person).map(f => f.id));
        return reply.factIds.filter(id => !known.has(id)).map(fact => ({op:"learn" as const, actor:person.id, fact}));
      });
      events.push(record(world, {
        source, kind:"npc", speaker:npc.name, speakerId:npc.id, text:reply.text,
        utterance:heard, reportedFactIds:reply.factIds, dialogueSource:"provider",
        ...(physical ? {} : {npcAction:stamp}),
        locationId:npc.locationId, perception:"addressed", recipients:heard.listenerIds, changes:learned,
      }));
    }
  } else if (!physical) {
    recordSilence(choice.source === "fallback" || (proposal.kind !== "stay" && !willSpeak) ? "decision" : undefined);
  }

  const observations: Observation[] = [];
  for (const event of events) {
    const observed = perceive(event, world);
    if (observed) observations.push(observed);
  }
  return observations;
}

/** Make at most one local NPC decision in an otherwise uninterrupted player turn. */
export async function ambientReaction(world: WorldState, events: WorldEvent[], provider: LLMProvider, waited?: number): Promise<Observation[]> {
  const king = player(world);
  const candidates = present(world, king).filter(c => c.kind === "npc" && c.condition === "healthy");
  if (!candidates.length) return [];
  let last: WorldEvent | undefined;
  for (let i = world.history.length - 1; i >= 0; i--) {
    if (world.history[i].npcAction?.trigger === "ambient") { last = world.history[i]; break; }
  }
  if (last?.time === world.time) return [];
  const lastIndex = candidates.findIndex(c => c.id === last?.npcAction?.actorId);
  const actor = candidates[(lastIndex + 1) % candidates.length];
  return npcResponse(world, actor, "", ambientScene(world, actor, events, waited), [], provider, "ambient");
}

function ambientScene(world: WorldState, actor: Character, events: readonly WorldEvent[], waited?: number): string {
  const king = player(world);
  const audience = withinEarshot(world, actor);
  const anonymous = utterance(world,actor,audience,false).groups?.length;
  const roomMembers = new Set([actor.id,...audience.map(c => c.id)]);
  let lastArrival: WorldEvent | undefined;
  for (let i = world.history.length - 1; i >= 0; i--) {
    const event = world.history[i];
    if (event.changes.some(change => change.op === "move" && roomMembers.has(change.actor))) {
      lastArrival = event;
      break;
    }
  }
  const witnessed: string[] = [];
  for (const event of events) {
    // The dialogue and notice projections already enforce who heard each line,
    // including whether a whispered remark can be repeated to this audience.
    if (event.noticeWitnessIds || event.utterance) continue;
    if (anonymous && (event.perception === "addressed" || event.npcAction?.witnessIds ||
        (event.perception === "local" && event.time !== world.time))) continue;
    // Unstamped player actions predate some present listeners. Their current
    // proximity cannot prove they witnessed an earlier detention or arrival.
    if (!event.npcAction?.witnessIds && lastArrival && event !== lastArrival && event.time <= lastArrival.time) continue;
    const seen = perceive(event, world, actor);
    if (seen) {
      // The same scene can ground a subsequent aloud reply. An observation
      // remembered by only this NPC is not evidence shared by the whole room.
      if (audience.every(listener => perceive(event, world, listener)?.text === seen.text)) witnessed.push(seen.text);
    }
    // The text of a player's private observation is withheld, even if an NPC
    // in that room can independently see the king enter or a guard detain someone.
    else if (event.changes.some(c => c.op === "move" && c.actor === king.id && c.to === actor.locationId)) {
      witnessed.push(king.name + "刚刚来到这里。");
    } else if (event.locationId === actor.locationId && event.changes.some(c => c.op === "detain")) {
      witnessed.push("这里刚发生了一次拘押。");
    }
  }
  // The bystanders can see the king remain in place; the private reason for waiting stays with the player.
  const observedWait = Math.min(waited ?? 0, world.time - (lastArrival?.time ?? 0));
  if (observedWait > 0 && inLocation(king,actor.locationId))
    witnessed.push(king.name + "仍在原处，已经过了" + observedWait + "分钟。");
  const scene = witnessed.length ? "你在场看见或听到：" + witnessed.slice(-2).join(" ").slice(0, 300) :
    "这段时间没有新的现场动静引起你的注意。";
  return scene + "你可自行决定下一步行动。";
}

interface WorldPulseOptions {
  excludeActorIds?: readonly string[];
  events?: readonly WorldEvent[];
  waited?: number;
  detailedLocations?: ReadonlySet<string>;
}

/** Detailed NPC decisions extend one traversable edge from the player's
 * position, or from either end of their current journey. */
export function detailedLocationIds(world: WorldState): Set<string> {
  const king = player(world);
  const endpoints = new Set([king.locationId]);
  if (king.journey) endpoints.add(king.journey.to);
  const nearby = new Set(endpoints);
  for (const location of world.locations) {
    if (endpoints.has(location.id)) for (const exit of location.exits) nearby.add(exit);
  }
  return nearby;
}

/** Share two opportunities between the immediate scene and its neighbours.
 * Within each group, those waiting longest go first, including after reload. */
export async function runWorldPulse(world: WorldState, provider: LLMProvider,
  options: WorldPulseOptions = {}): Promise<Observation[]> {
  const king = player(world);
  const detailed = options.detailedLocations ?? detailedLocationIds(world);
  const unavailable = new Set(options.excludeActorIds);
  const localCast = world.characters.filter(c => c.kind === "npc" && c.condition === "healthy" && !c.journey &&
    detailed.has(c.locationId) && !unavailable.has(c.id));
  if (!localCast.length) return [];
  const unranked = new Set(localCast.map(c => c.id));
  const lastTurn = new Map<string, number>();
  for (let i = world.history.length - 1; i >= 0; i--) {
    const event = world.history[i], action = event.npcAction;
    if (event.time !== world.time && !unranked.size) break;
    if (!action) continue;
    if (event.time === world.time) {
      if (action.worldPulse) return [];
      unavailable.add(action.actorId);
    }
    if (unranked.delete(action.actorId)) lastTurn.set(action.actorId, event.time);
  }
  const candidates = localCast.filter(c => !unavailable.has(c.id))
    .sort((a,b) => (lastTurn.get(a.id) ?? -1) - (lastTurn.get(b.id) ?? -1));
  const atEndpoint = (c:Character) => c.locationId === king.locationId || c.locationId === king.journey?.to;
  const first = candidates.find(atEndpoint) ?? candidates[0];
  if (!first) return [];
  const second = candidates.find(c => c.locationId !== first.locationId) ?? candidates.find(c => c.id !== first.id);
  const roster = second ? [first, second] : [first];
  const observations: Observation[] = [];
  for (const actor of roster) {
    const start = world.history.length;
    const scene = ambientScene(world, actor, options.events ?? [], options.waited);
    const seen = await npcResponse(world, actor, "", scene, [], provider, "ambient", undefined, undefined, false, scene);
    for (const event of world.history.slice(start))
      if (event.npcAction) event.npcAction.worldPulse = true;
    observations.push(...seen.map(o => ({...o,time:world.time})));
  }
  return observations;
}

function openingActor(world: WorldState, event: WorldEvent) {
  return impliedListener(event, present(world, player(world)));
}

/** A fresh scenario supplies an opening speaker, not a committed line of dialogue. */
export async function prepareOpening(initial: WorldState, provider: LLMProvider): Promise<WorldState> {
  const world = structuredClone(initial);
  if (world.version !== 0 || world.history.some(e => e.source === "opening" &&
      (e.npcAction || e.dialogueSource || e.npcFailure || e.changes.some(c => c.op === "encounter")))) return world;
  const seed = world.history.find(e => e.source === "opening" && e.kind === "npc" && perceive(e, world));
  let npc: Character | undefined;
  if (seed) {
    npc = openingActor(world, seed);
    world.history = world.history.filter(e => e !== seed);
  } else if (world.worldInfo) {
    const lead = player(world);
    try {
      const event = await considerEncounter(world, provider, "opening");
      const change = event?.changes.find(c => c.op === "encounter");
      npc = change?.person && world.characters.find(c => c.id === change.person?.id);
    } catch {
      record(world,{source:"opening", kind:"system", text:"开场人物暂时无法生成。",
        perception:"addressed", locationId:lead.locationId, recipients:[lead.id], changes:[], npcFailure:"encounter"});
    }
  }
  if (npc) await npcResponse(world, npc, "", player(world).name + "在场，尚未开口，请自行决定此刻做什么。",
    [], provider, "opening");
  return world;
}

/** Retry only an unplayed, failed opening before it had any successful NPC effect. */
export async function retryOpening(initial: WorldState, provider: LLMProvider): Promise<WorldState> {
  if (!projectWorld(initial).openingRetryable) return initial;
  const world = structuredClone(initial);
  const failed = world.history.find(e => e.source === "opening" && (e.npcFailure || e.dialogueSource === "fallback"));
  if (!failed) return initial;
  if (failed.npcFailure === "encounter") {
    world.history = world.history.filter(e => e !== failed);
    return prepareOpening(world, provider);
  }
  const npc = openingActor(world, failed);
  if (!npc) return initial;
  world.history = world.history.filter(e => e !== failed);
  await npcResponse(world, npc, "", player(world).name + "在场，尚未发言。请自行决定如何开启这一幕。", [], provider, "opening");
  return world;
}
