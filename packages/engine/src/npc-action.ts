import {
  NpcActionContextSchema, NpcActionProposalSchema, NpcActionReviewSchema, StateChangeSchema, npcActionProposalSchemaFor,
  type Character, type DialogueContext, type LLMProvider, type NpcActionContext, type NpcActionProposal,
  type StateChange, type WorldEvent, type WorldFact, type WorldState,
} from "@worldsim/shared";
import { npcContext, npcTextIsPrivate } from "./npc-dialogue";
import { disclosureAudience, utterance, withinEarshot } from "./hearing";
import { inLocation, knownFacts, player, record } from "./state";

export interface NpcActionChoice {
  proposal: NpcActionProposal;
  source: "provider" | "fallback";
}
export interface NpcOrder {
  summary: string;
  changes: StateChange[];
}

// An approval belongs to this turn and this exact piece of prose. It cannot be serialized,
// manufactured by a provider, transferred to a different actor, or consumed twice.
interface ReviewedAct {
  world: WorldState;
  actorId: string;
  room: string;
  time: number;
  version: number;
  eventCount: number;
  description: string;
  thenSpeak?: boolean;
  consumed: boolean;
}
const reviewedActs = new WeakMap<NpcActionChoice, ReviewedAct>();

// The offline provider has no semantic reviewer. Keep its conservative
// approximation separate from the path used by model-backed agents.
function offlineSelfDescription(description: string, context: NpcActionContext): boolean {
  // Apply the same player-agency check to the names and roles in this scenario.
  const playerReferences = [context.player.name, context.player.role].sort((a,b) => b.length - a.length);
  let withPlayerLabels = description;
  for (const label of playerReferences) withPlayerLabels = withPlayerLabels.replaceAll(label, "玩家");
  if (/[:：<>【】{}]|^(?:你|您|我|他|她|玩家|国王|陛下|系统|旁白)/u.test(withPlayerLabels) ||
      description.startsWith(context.npc.name)) return false;
  // Fail before remote review on conspicuous attempts to narrate someone else's
  // decision, issue dialogue, or use a free gesture to travel between locations.
  if (/(?:迫使|让|命令|拖着|强迫|带领|抓住|推着|把|将|代替|替)(?:玩家|国王|陛下|你|您)|(?:国王|陛下|玩家|您|你)(?:随后|已经|于是|接着|决定|走进|前往)|(?:说道|喊道|问道|回答道)|执行.{0,8}命令/u.test(withPlayerLabels)) return false;
  return !context.exits.some(exit => description.includes(exit.name) &&
    /走向|走进|走到|前往|赶往|进入|移步|离开|来到|返回/u.test(description));
}

function healthyNpc(world: WorldState, id: string): Character | undefined {
  return world.characters.find(c => c.id === id && c.kind === "npc" && c.condition === "healthy");
}

/** Only the visible part of committed acts, never their underlying effects or knowledge. */
function witnessedActions(world: WorldState, actor: Character, audience: readonly string[],
  scope: "actor" | "audience"): NonNullable<NpcActionContext["recentActions"]> {
  const recent: NonNullable<NpcActionContext["recentActions"]> = [];
  for (let i = world.history.length - 1; i >= 0 && recent.length < 6; i--) {
    const event = world.history[i], action = event.npcAction;
    if (!action || event.kind !== "world" || action.source !== "provider" || action.kind === "stay") continue;
    const side = action.otherSide?.locationId === actor.locationId ? action.otherSide : undefined;
    if (event.locationId !== actor.locationId && !side) continue;
    // Older events only establish what the performer and explicit recipients saw.
    const witnesses = side?.witnessIds ?? action.witnessIds ?? [action.actorId, ...event.recipients];
    if (!witnesses.includes(actor.id) || (scope === "audience" && !audience.every(id => witnesses.includes(id)))) continue;
    const text = side?.text ?? event.text;
    if (text.length <= 2000 && !npcTextIsPrivate(world, actor, [], text, audience))
      recent.push({time:event.time, text});
  }
  return recent.reverse();
}

/** Only clues attached to physical discoveries here can be learned by inspecting the room. */
function localEvidence(world: WorldState, npc: Character): WorldFact[] {
  const atLocation = new Set(world.rules.discoveries.filter(d => d.locationId === npc.locationId).map(d => d.factId));
  return world.facts.filter(f => atLocation.has(f.id) && f.createdAt <= world.time && (f.type === "clue" || f.type === "public"));
}

/** The king and this officer must still be able to act on this exact, authorized order. */
function canCarryOutOrder(world: WorldState, npc: Character, order?: NpcOrder): order is NpcOrder {
  const king = player(world);
  return Boolean(order && order.summary.trim() && order.changes.length &&
    king.condition === "healthy" && inLocation(king,npc.locationId) && king.abilities.includes(world.rules.arrestAuthority) &&
    order.changes.every(change => change.op === "flag" && StateChangeSchema.safeParse(change).success && change.value === true &&
      Object.hasOwn(world.variables, change.name) && typeof world.variables[change.name] === "boolean" &&
      world.rules.orders.some(rule => rule.npcId === npc.id && rule.flag === change.name)));
}

export async function chooseNpcAction(world: WorldState, npc: Character, input: string, decision: string,
  testimonyIds: string[], provider: LLMProvider, trigger: NpcActionContext["trigger"], order?: NpcOrder,
  currentSpeechEventId?: string, replyAudience?: readonly string[], witnessedScene?: string): Promise<NpcActionChoice> {
  const fallback: NpcActionChoice = {proposal:{kind:"stay"}, source:"fallback"};
  const actor = healthyNpc(world, npc.id);
  if (!actor) return fallback;
  const room = world.locations.find(l => l.id === actor.locationId);
  const nearby = inLocation(player(world),actor.locationId);
  if (!room || (!nearby && trigger !== "ambient")) return fallback;

  try {
    // An offscreen ambient actor may use its own surroundings, but cannot hear
    // a player's input, receive the player's adjudication, or see a distant room.
    const roomAudience = disclosureAudience(utterance(world,actor,withinEarshot(world,actor),false));
    const speakingTo = replyAudience ?? roomAudience;
    const appointments = (actor.appointments ?? []).filter(a => a.from <= world.time && world.time < a.until)
      .flatMap(a => {
        const location = world.locations.find(l => l.id === a.locationId)?.name;
        if (!location || npcTextIsPrivate(world, actor, [], a.task, speakingTo)) return [];
        return [{from:a.from,until:a.until,location,task:a.task}];
      }).slice(0,4);
    const forAction = ({speaker, revision:_, ...scene}: DialogueContext, audience: readonly string[], scope: "actor" | "audience") => NpcActionContextSchema.parse({
      ...scene, npc:speaker, trigger, recentActions:witnessedActions(world, actor, audience, scope),
      exits:world.locations.filter(l => l.id !== room.id && room.exits.includes(l.id))
        .slice(0, 32).map(({id, name}) => ({id, name})),
      // A healthy NPC can examine any room it occupies. Offering this option
      // must not tell the planner whether an undiscovered clue exists there.
      canInspect:true,
      ...(appointments.length ? {appointments} : {}),
      ...(trigger === "addressed" && canCarryOutOrder(world, actor, order) ? {order:order.summary} : {}),
    });
    const offsite = (witnessedScene ?? "") + "现在是你在这里活动的时间。依据自己的职责和亲历的动静自行行动。说话只会传给眼前的人。";
    const context = forAction(npcContext(world, actor, nearby ? input : "", nearby ? decision : offsite,
      nearby ? testimonyIds : [], trigger === "opening", currentSpeechEventId, speakingTo), speakingTo, "actor");
    const actorId = actor.id, roomId = room.id, time = world.time, version = world.version, eventCount = world.history.length;
    // Only the actor's decision can use its authored motives. Reviews and replies
    // keep the audience-scoped context so a motive cannot serve as public evidence.
    const decisionContext = world.rules.useNpcGoals && actor.goals.length
      ? {...context, personalGoals:actor.goals} : context;
    const proposed = await provider.decideNpcAction(structuredClone(decisionContext));
    const proposal = npcActionProposalSchemaFor(context).parse(proposed);
    const choice: NpcActionChoice = {proposal, source:"provider"};
    if (proposal.kind === "act") {
      // Testimony is conveyed via reviewed speech and fact citations, never via stage directions.
      if ((!provider.interpret && !offlineSelfDescription(proposal.description, context)) ||
          npcTextIsPrivate(world, actor, [], proposal.description, roomAudience)) return fallback;
      // The actor can remember a bow they saw before somebody else arrived.
      // Its public description must be reviewed against what this audience saw.
      const privateExchange = roomAudience.some(id => !speakingTo.includes(id));
      const reviewContext = privateExchange
        ? forAction(npcContext(world, actor, "", "只审查此刻可见的身体动作。", [], trigger === "opening", currentSpeechEventId, roomAudience), roomAudience, "audience")
        : {...context, recentActions:witnessedActions(world, actor, roomAudience, "audience")};
      const review = NpcActionReviewSchema.parse(await provider.reviewNpcAction(structuredClone({context:reviewContext, proposal})));
      if (!review.grounded || !review.selfOnly) return fallback;
      reviewedActs.set(choice, {world, actorId, room:roomId, time, version, eventCount,
        description:proposal.description, thenSpeak:proposal.thenSpeak, consumed:false});
    }
    return choice;
  } catch {
    return fallback;
  }
}

/** Revalidate references at commit time. No NPC proposal writes arbitrary effects or advances time. */
export function commitNpcAction(world: WorldState, npc: Character, choice: NpcActionChoice,
  source: "opening" | "npc-action" = "npc-action", order?: NpcOrder,
  trigger?: NpcActionContext["trigger"]): WorldEvent | undefined {
  const actor = healthyNpc(world, npc.id);
  if (!actor || choice.source !== "provider") return;
  const parsed = NpcActionProposalSchema.safeParse(choice.proposal);
  if (!parsed.success) return;
  const proposal = parsed.data;
  const approval = reviewedActs.get(choice);
  if (approval) {
    if (approval.consumed) return;
    approval.consumed = true;
    if (proposal.kind !== "act" || proposal.description !== approval.description || proposal.thenSpeak !== approval.thenSpeak ||
        world !== approval.world || world.time !== approval.time || world.version !== approval.version ||
        world.history.length !== approval.eventCount || actor.id !== approval.actorId || actor.locationId !== approval.room) return;
  } else if (proposal.kind === "act") return;
  if (proposal.kind === "speak" || proposal.kind === "stay") return;

  const room = world.locations.find(l => l.id === actor.locationId);
  if (!room) return;
  const king = player(world);
  let locationId = room.id;
  let text: string;
  let otherSide: NonNullable<WorldEvent["npcAction"]>["otherSide"];
  const changes: StateChange[] = [];
  if (proposal.kind === "move") {
    const dest = world.locations.find(l => l.id === proposal.destination);
    if (!dest || dest.id === room.id || !room.exits.includes(dest.id)) return;
    changes.push({op:"move", actor:actor.id, to:dest.id});
    const from = {locationId:room.id, text:actor.name + "离开" + room.name + "，朝" + dest.name + "走去。"};
    const to = {locationId:dest.id, text:actor.name + "走进" + dest.name + "。"};
    const [main, opposite] = inLocation(king,dest.id) ? [to, from] : [from, to];
    locationId = main.locationId;
    text = main.text;
    otherSide = {...opposite, witnessIds:world.characters.filter(c => c.condition !== "dead" &&
      (inLocation(c,opposite.locationId) || c.id === actor.id)).map(c => c.id)};
  } else if (proposal.kind === "inspect") {
    const evidence = localEvidence(world, actor);
    const known = new Set(knownFacts(world, actor).map(f => f.id));
    const found = evidence.find(f => !known.has(f.id));
    if (found) changes.push({op:"learn", actor:actor.id, fact:found.id});
    // Observers can see the inspection, not what the inspector learned.
    text = actor.name + "仔细查看了" + room.name + "里的物件。";
  } else if (proposal.kind === "carryOutOrder") {
    if (source === "opening" || !canCarryOutOrder(world, actor, order)) return;
    changes.push(...order.changes);
    text = actor.name + "应下了" + king.name + "的命令，随即传达下去。";
  } else if (proposal.kind === "act") {
    text = actor.name + proposal.description + (/[。！？.!?…]$/u.test(proposal.description) ? "" : "。");
  } else {
    const gesture = {bow:"欠身行了一礼。", nod:"点了点头。", look:"环顾四周。"};
    text = actor.name + gesture[proposal.gesture];
  }

  const visible = inLocation(king,locationId);
  const witnessIds = world.characters.filter(c => c.condition !== "dead" && (inLocation(c,locationId) || c.id === actor.id)).map(c => c.id);
  return record(world, {
    source, kind:"world", text, locationId, perception:"local",
    recipients:visible ? [king.id] : [], changes,
    npcAction:{actorId:actor.id, kind:proposal.kind, source:choice.source, trigger:source === "opening" ? "opening" : trigger,
      witnessIds, ...(otherSide ? {otherSide} : {})},
  });
}
