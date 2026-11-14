import type { GameTurn, LLMProvider, PublicTurn, WorldState } from "@worldsim/shared";
import { disclosureAudience, utterance, withinEarshot } from "./hearing";
import { replyFailureNotice, writeNpcReply } from "./npc-dialogue";
import { knownFacts, player, record } from "./state";
import { acceptSpokenCommitment } from "./accept-commitment";

// A saved failure has no rejected prose. Use the original witnessed speech and
// the NPC's completed action; a retry never runs the action interpreter again.
export function replyRecovery(world: WorldState, turn: GameTurn) {
  if (turn.intent.kind !== "speak") return;
  const failure = turn.events.find(e => e.source === "npc-action" && e.npcFailure && e.npcFailure !== "decision");
  if (!failure || failure.changes.length) return;
  const observation = turn.observations.findIndex(o => o.kind === "system" && o.text === failure.text);
  if (observation < 0) return;
  const replacement = world.history.find(e => e.replyToFailureId === failure.id && e.dialogueSource === "provider");
  if (replacement) return {failure, observation, replacement} as const;
  if (turn.version !== world.version || turn.endTime !== world.time) return;

  const index = world.history.findIndex(e => e.id === failure.id);
  if (index < 0 || world.history.slice(index + 1).some(e => e.source !== "clock" || e.changes.some(c => c.op !== "clock"))) return;
  const original = turn.events.slice(0,turn.events.indexOf(failure));
  const speech = original.find(e => e.source === "speech" && e.utterance?.speakerId === player(world).id);
  const physical = original.find(e => e.npcAction?.trigger === "addressed");
  const action = failure.npcAction ?? physical?.npcAction;
  if (!action || action.source !== "provider" || action.trigger !== "addressed" || !speech?.utterance ||
      !speech.utterance.listenerIds.includes(action.actorId)) return;
  const npc = world.characters.find(c => c.id === action.actorId);
  if (!npc || npc.condition !== "healthy" || npc.locationId !== failure.locationId || speech.locationId !== npc.locationId) return;
  const king = player(world);
  if (king.locationId !== npc.locationId || king.condition !== "healthy") return;
  const quiet = speech.utterance.private === true;
  const audience = withinEarshot(world, npc, quiet ? king.id : undefined);
  const expected = [king.id,...speech.utterance.listenerIds.filter(id => id !== npc.id)];
  if (audience.length !== expected.length || audience.some(c => !expected.includes(c.id))) return;
  const heard = utterance(world,npc,audience,quiet);
  const originalGroups = speech.utterance.groups ?? [];
  const presentGroups = heard.groups ?? [];
  if (originalGroups.length !== presentGroups.length || originalGroups.some(old =>
    !presentGroups.some(now => now.groupId === old.groupId && now.count === old.count && now.firstSlot === old.firstSlot))) return;
  return {failure, observation, npc, speech, physical, index, heard, audience} as const;
}

/** Overlay the journal of this specific world. The turn row and old snapshots
 * stay immutable even if a response is recovered later in another branch. */
export function displayReplyRecovery(world: WorldState, turn: GameTurn, view: PublicTurn): PublicTurn {
  const state = replyRecovery(world, turn);
  if (!state) {
    if (turn.version !== world.version || turn.intent.kind !== "speak") return view;
    const failure = turn.events.find(e => e.source === "npc-action" && e.npcFailure && e.npcFailure !== "decision");
    if (!failure) return view;
    const index = view.observations.findIndex(o => o.kind === "system" && o.text === failure.text);
    if (index < 0) return view;
    const observation = view.observations[index];
    const note = "这次提问的原现场无法完整还原，可以按眼下的情况重新询问。";
    return replaceObservation(view,index,{...observation,text:observation.text + note});
  }
  if (!state.replacement) return {...view, replyRetry:{observation:state.observation,speaker:state.npc.name}};
  const line = state.replacement;
  return replaceObservation(view,state.observation,{kind:"dialogue",speaker:line.speaker,text:line.text,time:line.time});
}

function replaceObservation(view: PublicTurn, index: number, observation: PublicTurn["observations"][number]): PublicTurn {
  const observations = [...view.observations];
  observations[index] = observation;
  let lines = view.narrative.split("\n");
  const narrativeFor = (o: typeof observation) => o.kind === "dialogue" ? "「" + o.text + "」" : o.text;
  if (lines.length !== observations.length) lines = observations.map(narrativeFor);
  else lines[index] = narrativeFor(observation);
  return {...view, observations,narrative:lines.join("\n")};
}

export async function retryDialogue(world: WorldState, turn: GameTurn, provider: LLMProvider): Promise<{world:WorldState} | {notice:string}> {
  const state = replyRecovery(world,turn);
  if (!state || state.replacement) return {notice:"原提问的现场无法还原。"};
  const {failure, npc, speech, index, physical, heard, audience} = state;
  const then = {...world, time:failure.time, history:world.history.slice(0,index)};
  // For old saves the original testimony allowance was not persisted. Limit a
  // recovered line to facts already shareable with the original audience.
  const reply = await writeNpcReply(then, npc, speech.text, physical?.text ?? "双方正在此地交谈。",
    [], provider, false, speech.id, disclosureAudience(heard));
  if ("failure" in reply) return {notice:npc.name + replyFailureNotice(reply)};
  const next = structuredClone(world);
  const learned = audience.flatMap(person => {
    const known = new Set(knownFacts(then,person).map(f => f.id));
    return reply.factIds.filter(id => !known.has(id)).map(fact => ({op:"learn" as const,actor:person.id,fact}));
  });
  const line = record(next,{source:"dialogue-retry",kind:"npc",speaker:npc.name,speakerId:npc.id,text:reply.text,
    dialogueSource:"provider",replyToFailureId:failure.id,reportedFactIds:reply.factIds,utterance:heard,
    ...(reply.restrictedRecall ? {restrictedRecall:true} : {}),
    perception:"addressed",locationId:npc.locationId,recipients:heard.listenerIds,changes:learned});
  if (reply.relay) acceptSpokenCommitment(next,speech.id,line,reply.relay);
  return {world:next};
}
