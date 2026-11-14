import {
  DialogueContextSchema, DialogueDraftSchema, DialogueReviewSchema, readablesAt, roomDescription, type DialogueContext,
  type DialogueDraft, type LLMProvider, type RelayAcceptance, type WorldState, type Character, type WorldEvent, type WorldFact,
} from "@worldsim/shared";
import { impliedListener } from "./conversation";
import { relayTerms } from "./accept-commitment";
import { crowdAudienceName } from "./hearing";
import { witnessedSpeech } from "./crowd-contact";
import { inLocation, knownFacts, perceive, player, present, visibleSituations } from "./state";

type DialogueFailure = "generation" | "validation" | "review" | "review_unavailable";
type ReplyFailure = {failure:DialogueFailure; verdict?:DialogueContext["revision"]};
type ReplyResult = (DialogueDraft & {relay?:RelayAcceptance; restrictedRecall?:true}) | ReplyFailure;

export function replyFailureNotice({failure, verdict}: ReplyFailure): string {
  if (failure === "generation") return "的答复暂时未能生成。";
  if (failure === "validation") return "的答复没有符合可展示的格式或事实引用要求。";
  if (failure === "review_unavailable") return "的答复暂时未能核实，核验服务没有返回有效结果。";
  if (verdict && !verdict.playerAgency) return "的答复涉及你还没有作出的决定，未被采用。";
  if (verdict && !verdict.grounded) return "的答复里有现场无法证实的内容，未被采用。";
  if (verdict && !verdict.citationsAccurate) return "的答复未能与所引的消息对应，未被采用。";
  return "的答复未能确认。";
}

function transcript(world: WorldState, king: Character, npc: Character, privateText: (text: string) => boolean,
  currentSpeechEventId?: string, replyAudience: readonly string[] = []): DialogueContext["history"] {
  const reverse: DialogueContext["history"] = [];
  const add = (line: DialogueContext["history"][number]) => {
    if (reverse.length < 16 && !privateText(line.text)) reverse.push(line);
  };
  const here = present(world, king);
  // Unstamped saves only prove a direct exchange between the king and this NPC.
  let readLegacy = inLocation(king,npc.locationId) && replyAudience.every(id => id === npc.id || id === king.id);
  for (let i = world.history.length - 1; i >= 0 && reverse.length < 16; i--) {
    const event = world.history[i];
    const speech = event.utterance;
    if (speech) {
      if (event.id === currentSpeechEventId || event.dialogueSource === "fallback") continue;
      // A character can quote a whisper only to people who already witnessed it.
      const witnessed = (id: string) => !crowdAudienceName(world,id) && witnessedSpeech(world,speech,id);
      if (!witnessed(npc.id) || ((speech.private || event.restrictedRecall) && !replyAudience.every(witnessed))) continue;
      if (speech.speakerId === king.id) add({role:"player", text:event.text});
      else if (speech.speakerId === npc.id) add({role:"npc", text:event.text});
      else {
        readLegacy = false;
        const speaker = world.characters.find(person => person.id === speech.speakerId);
        if (speaker) add({role:"overheard", speaker:speaker.name, text:event.text});
      }
      continue;
    }
    if (!readLegacy) continue;
    if (event.changes.some(change => change.op === "move" && (change.actor === king.id || change.actor === npc.id))) {
      readLegacy = false;
      continue;
    }
    if (event.locationId !== king.locationId || !perceive(event, world, king)) continue;
    if (event.kind === "system") continue;
    if (!event.recipients.includes(king.id) || impliedListener(event, here)?.id !== npc.id ||
        (event.kind !== "npc" && (!event.npcAction || event.npcAction.kind === "move"))) {
      readLegacy = false;
      continue;
    }
    if (event.kind === "npc" && event.dialogueSource !== "fallback") add({role:"npc", text:event.text});
    // Older saves have only the NPC side. Do not invent what the player said.
    if (event.spokenInput) add({role:"player", text:event.spokenInput});
  }
  return reverse.reverse();
}

function witnessedNotices(world: WorldState, npc: Character, privateText: (text: string) => boolean,
  replyAudience: readonly string[] = []): NonNullable<DialogueContext["recentNotices"]> {
  const recent: NonNullable<DialogueContext["recentNotices"]> = [];
  for (let i = world.history.length - 1; i >= 0 && recent.length < 4; i--) {
    const event = world.history[i];
    const witnesses = event.noticeWitnessIds;
    if (!witnesses?.includes(npc.id) || event.perception === "private" ||
        event.changes.some(change => change.op === "respondSituation") ||
        (event.perception === "addressed" && !replyAudience.every(id => witnesses.includes(id)))) continue;
    if (event.text.length <= 2000 && !privateText(event.text)) recent.push({time:event.time, text:event.text});
  }
  return recent.reverse();
}

type WitnessedEvent = NonNullable<DialogueContext["witnessedEvents"]>[number];

function deliveryReceipt(world:WorldState, event:WorldEvent, npc:Character, audience:readonly string[]) {
  const speech = event.utterance;
  const change = event.changes.find(change => change.op === "advanceCommitment" && change.status === "delivered");
  if (event.source !== "commitment-delivery" || !speech || change?.op !== "advanceCommitment" ||
      !witnessedSpeech(world,speech,npc.id)) return;
  const commitment = world.commitments.find(c => c.id === change.id);
  if (!commitment || commitment.status !== "delivered" || commitment.actorId !== speech.speakerId ||
      commitment.destinationId !== event.locationId) return;
  const speaker = world.characters.find(c => c.id === speech.speakerId)?.name;
  const target = commitment.audience;
  let recipient:string|undefined;
  if (target.kind === "group") {
    const group = world.populationGroups.find(g => g.id === target.id);
    if (group && (speech.groups?.some(g => g.groupId === group.id) ||
        (group.representative && speech.listenerIds.includes(group.representative.id)))) recipient = group.name;
  } else if (target.id) {
    recipient = world.characters.find(c => c.id === target.id && speech.listenerIds.includes(c.id))?.name;
  } else if (speech.listenerIds.length || speech.groups?.length) recipient = "当时在场的听众";
  if (!speaker || !recipient) return;
  if (speech.private) {
    const requester = world.history.find(e => e.id === commitment.requestEventId)?.utterance?.speakerId;
    if (!audience.every(id => id === requester || witnessedSpeech(world,speech,id))) return;
  }
  return {source:"commitment" as const,text:event.text,speaker,recipient,...(speech.private ? {restricted:true as const} : {})};
}

function failureReceipt(world:WorldState, event:WorldEvent, npc:Character, audience:readonly string[]) {
  if (event.kind !== "system" || event.perception !== "addressed" || !event.recipients.includes(npc.id)) return;
  const change = event.changes.find(c => c.op === "advanceCommitment" && c.status === "failed");
  if (change?.op !== "advanceCommitment" || !change.reason) return;
  const plan = world.commitments.find(c => c.id === change.id);
  if (plan?.status !== "failed" || plan.actorId !== npc.id || plan.failureReason !== change.reason) return;
  const requester = world.history.find(e => e.id === plan.requestEventId)?.utterance?.speakerId;
  if (!requester || !audience.includes(requester) || audience.some(id => id !== requester)) return;
  return {source:"commitment-failed" as const,text:change.reason};
}

// Only committed journal entries supply testimony. An action in a queue or
// someone's current address says nothing about who witnessed it earlier.
function witnessedEvents(world:WorldState, npc:Character, privateText:(text:string)=>boolean, audience:readonly string[] = []) {
  const events:WitnessedEvent[] = [];
  let routineCount = 0;
  for (let i = world.history.length - 1; i >= 0 && events.length < 8; i--) {
    const event = world.history[i];
    if (event.time > world.time || event.perception === "private") continue;
    let locationId = event.locationId;
    let memory:Omit<WitnessedEvent,"time"|"location"> | undefined;
    if (event.source === "commitment-delivery") {
      memory = deliveryReceipt(world,event,npc,audience);
    } else if (event.source === "commitment-failed") {
      memory = failureReceipt(world,event,npc,audience);
    } else if (event.changes.some(change => change.op === "respondSituation")) {
      const witnesses = event.noticeWitnessIds;
      if (witnesses?.includes(npc.id) && audience.every(id => witnesses.includes(id)))
        memory = {source:"decision",text:event.text};
    } else if (routineCount < 3 && event.kind === "world" && event.npcAction && event.npcAction.kind !== "stay" &&
        (event.npcAction.source === "provider" || (event.npcAction.source === "commitment" && event.npcAction.kind === "move"))) {
      const action = event.npcAction;
      const witnesses = action.witnessIds ?? [action.actorId,...event.recipients];
      const side = !witnesses.includes(npc.id) ? action.otherSide : undefined;
      const who = side?.witnessIds ?? witnesses;
      // The performer can report their own public work later. Other people can
      // corroborate a gesture they saw together, from their own side of a move.
      if (who.includes(npc.id) && (npc.id === action.actorId || audience.every(id => who.includes(id)))) {
        memory = {source:"npc-action",text:side?.text ?? event.text};
        locationId = side?.locationId ?? locationId;
      }
    }
    if (!memory || memory.text.length > 2000 || privateText(memory.text) ||
        (memory.speaker && privateText(memory.speaker)) || (memory.recipient && privateText(memory.recipient))) continue;
    const location = world.locations.find(l => l.id === locationId)?.name;
    if (!location || privateText(location)) continue;
    if (memory.source === "npc-action") routineCount++;
    events.push({...memory,time:event.time,location});
  }
  return events.reverse();
}

function allowedFacts(world: WorldState, npc: Character, testimonyIds: string[], replyAudience: readonly string[] = []): WorldFact[] {
  const shared = new Set(knownFacts(world, player(world)).map(f => f.id));
  const crowdPresent = replyAudience.some(id => crowdAudienceName(world,id));
  const knownToAudience = replyAudience.map(id => {
    const listener = crowdAudienceName(world,id) ? undefined : world.characters.find(person => person.id === id);
    return new Set(listener ? knownFacts(world, listener).map(f => f.id) : []);
  });
  return knownFacts(world, npc)
    .filter(f => f.type !== "secret" && (f.type === "public" || (!crowdPresent && f.type === "clue" && testimonyIds.includes(f.id)) ||
      (shared.has(f.id) && knownToAudience.every(ids => ids.has(f.id)))))
    .sort((a, b) => Number(testimonyIds.includes(b.id)) - Number(testimonyIds.includes(a.id)) || b.createdAt - a.createdAt)
    .filter(f => f.content.text.length <= 2000)
    .slice(0, 32);
}

function compact(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{White_Space}\p{P}\p{Cf}]/gu, "");
}

// A local backstop for verbatim private details (including player-injected text).
// The only facts supplied to either remote task are those in the allowlist.
function privateGuard(world: WorldState, permitted: WorldFact[]): (text: string) => boolean {
  const ids = new Set(permitted.map(f => f.id));
  const visible = permitted.map(f => compact(f.content.text));
  const protectedText = [
    ...world.facts.filter(f => !ids.has(f.id)).map(f => f.content.text),
    ...world.characters.flatMap(c => c.goals),
    ...world.queue.filter(e => e.type === "plan" || e.perception === "private").map(e => e.text),
  ];
  const fragments = new Set<string>();
  for (const line of protectedText) {
    const full = compact(line);
    if (full && !visible.some(text => text.includes(full))) fragments.add(full);
    for (const part of line.split(/[，。；！？、,;.!?]/u)) {
      const clause = compact(part);
      if (clause.length >= 4 && !visible.some(text => text.includes(clause))) fragments.add(clause);
    }
  }
  return text => {
    const value = compact(text);
    for (const fragment of fragments) if (value.includes(fragment)) return true;
    return false;
  };
}

function permittedDraft(draft: DialogueDraft, context: DialogueContext, privateText: (text: string) => boolean): boolean {
  if (privateText(draft.text) || draft.factIds.some(id => !context.facts.some(f => f.id === id))) return false;
  // Format, disclosure and citation checks depend only on the actual data.
  // Distinguishing a question about the player's plans from narrating their
  // decision is the independent reviewer's playerAgency check.
  if (/^(?:玩家|旁白|系统|国王|NPC|player|system)\s*[:：]|<\/?[a-z][^>]*>/iu.test(draft.text)) return false;
  const prefix = draft.text.match(/^([^:：]+?)\s*[:：]/u)?.[1];
  if (prefix && [context.player.name, context.player.role, context.speaker.name, context.speaker.role].includes(prefix)) return false;
  const text = compact(draft.text);
  return !context.facts.some(f => !draft.factIds.includes(f.id) && text.includes(compact(f.text)));
}

export function npcTextIsPrivate(world: WorldState, npc: Character, testimonyIds: string[], text: string,
  replyAudience?: readonly string[]): boolean {
  return privateGuard(world, allowedFacts(world, npc, testimonyIds, replyAudience))(text);
}

/** Public, present-tense context shared by action planning and dialogue. */
export function npcContext(world: WorldState, npc: Character, input: string, decision: string,
  testimonyIds: string[], opening = false, currentSpeechEventId?: string, replyAudience?: readonly string[]): DialogueContext {
  const king = player(world);
  const permitted = allowedFacts(world, npc, testimonyIds, replyAudience);
  const privateText = privateGuard(world, permitted);
  const history = opening ? [] : transcript(world, king, npc, privateText, currentSpeechEventId, replyAudience);
  const recentNotices = witnessedNotices(world, npc, privateText, replyAudience);
  const firsthand = witnessedEvents(world,npc,privateText,replyAudience);
  const room = world.locations.find(room => room.id === npc.locationId);
  const listeners = (replyAudience ?? []).map(id => {
    const listener = world.characters.find(c => c.id === id);
    return listener ? visibleSituations(world,listener) : [];
  });
  const reports = visibleSituations(world,npc).filter(s => {
    const source = world.queue.find(e => e.id === s.eventId);
    if (!source?.situation || source.perception === "private" || privateText(s.summary)) return false;
    const broadcast = source.perception === "public" && source.at === s.updatedAt && source.situation.summary === s.summary;
    // A public announcement can be followed by a decision witnessed in only
    // one room. For a local report the listeners need that same known version.
    return broadcast || listeners.every(reports => reports
      .some(known => known.id === s.id && known.updatedAt === s.updatedAt && known.summary === s.summary));
  }).sort((a,b) => b.updatedAt - a.updatedAt);
  const surroundings = room && [roomDescription(world,room), ...reports.map(s =>
    "第" + (Math.floor(s.updatedAt / 1440) + 1) + "天获知：" + s.summary)].join(" ");
  const community = world.populationGroups.find(g => g.representative?.id === npc.id);
  const workplace = community && world.locations.find(l => l.id === community.work.locationId);
  const duty = community && workplace ? "所在群体的事务是"+community.work.task+"，办理地点在"+workplace.name+"。" : npc.publicDuty;
  return DialogueContextSchema.parse({
    speaker:{name:npc.name, role:npc.role}, player:{name:king.name, role:king.role},
    ...(world.worldInfo ? {worldInfo:world.worldInfo} : {}),
    location:room?.name, currentTime:world.time,
    ...(surroundings && !privateText(surroundings) ? {surroundings:surroundings.slice(0,800)} : {}),
    ...(duty && !privateText(duty) ? {duty:duty.slice(0,240)} : {}),
    present:present(world, npc).filter(person => person.condition !== "dead").slice(0, 32).map(({name, role}) => ({name, role})),
    ...(replyAudience ? {listeners:replyAudience.flatMap(id => {
      const crowd = crowdAudienceName(world,id);
      if (crowd) return [crowd];
      const who = world.characters.find(c => c.id === id && c.id !== npc.id && c.condition !== "dead");
      return who ? [who.name] : [];
    })} : {}),
    facts:permitted.map(f => ({id:f.id, text:f.content.text})),
    history,
    ...(recentNotices.length ? {recentNotices} : {}),
    ...(firsthand.length ? {witnessedEvents:firsthand} : {}),
    input:privateText(input) ? "（涉及未经核实的消息）" : input,
    decision:privateText(decision) ? "只根据可确认的信息行动。" : decision,
  });
}

export async function writeNpcReply(world: WorldState, npc: Character, input: string, decision: string,
  testimonyIds: string[], provider: LLMProvider, opening = false, currentSpeechEventId?: string,
  replyAudience?: readonly string[]): Promise<ReplyResult> {
  let stage: DialogueFailure = "generation";
  try {
    const context = npcContext(world, npc, input, decision, testimonyIds, opening, currentSpeechEventId, replyAudience);
    let privateText = privateGuard(world, allowedFacts(world, npc, testimonyIds, replyAudience));
    // The speaker can cite public paperwork they personally prepared here.
    // Seeing the player leaf through a document never makes its text NPC memory.
    const prepared = readablesAt(world, npc.locationId).filter(doc => doc.preparedBy === npc.id)
      .flatMap(doc => doc.entries.map(entry => ({document:doc.name, ...entry})))
      .filter(e => e.document.length <= 160 && e.title.length <= 160 && e.text.length <= 2000 &&
        ![e.document,e.title,e.text].some(privateText)).slice(0,8);
    if (prepared.length) context.preparedNotes = prepared;
    // Only the failed checks are fed back. Never send rejected prose or private state.
    let sources = context;
    let revision: DialogueContext["revision"];
    let excerpt: DialogueDraft | undefined;
    const attempts = input && !opening ? 3 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // After two semantic rejections, an addressed NPC can still answer from the
      // conversation itself. This pass cannot deliver or teach a world fact.
      if (attempt === 2 && !excerpt) {
        privateText = privateGuard(world, []);
        sources = {...context, facts:[], duty:undefined, worldInfo:undefined, surroundings:undefined, recentNotices:undefined, witnessedEvents:undefined, preparedNotes:undefined,
          input:privateText(context.input) ? "（提到了当前无法核实的消息）" : context.input,
          decision:"这次只依据亲耳听到的对话答复。可复述谁说过什么，也可表示自己无从证实。请用一句自己的话回应，不报告世界消息。",
          history:context.history.filter(line => !privateText(line.text))};
      }
      stage = "generation";
      const draft = excerpt ?? DialogueDraftSchema.parse(await provider.dialogue(structuredClone(revision ? {...sources, revision} : sources)));
      const reviewingExcerpt = excerpt !== undefined;
      excerpt = undefined;
      if (!permittedDraft(draft, sources, privateText)) return {failure:"validation"};
      stage = "review_unavailable";
      const review = DialogueReviewSchema.parse(await provider.reviewDialogue(structuredClone({context:sources, draft})));
      const {excerpt:proposed,relay,...verdict} = review;
      if (review.grounded && review.playerAgency && review.citationsAccurate) {
        const accepted = currentSpeechEventId && relay ? {acceptance:draft.text,destination:relay.destination,
          audience:relay.audience,message:relay.message} : undefined;
        if (accepted) {
          const request=world.history.find(e=>e.id===currentSpeechEventId);
          // Do not publish "I will deliver it" as an ordinary line if we
          // can't bind those words to a real request, message and audience.
          if (!request || request.source !== "speech" || request.utterance?.speakerId !== player(world).id ||
            !request.utterance.listenerIds.includes(npc.id) || request.locationId !== npc.locationId ||
            !relayTerms(world,npc.id,request.text,accepted)) return {failure:"validation"};
        }
        // A receipt shared in a room with only authorized listeners can still
        // carry private information. Remember that audience on later retellings.
        const restrictedRecall = sources.witnessedEvents?.some(e => e.source === "commitment-failed" || e.restricted);
        return {...draft,...(accepted ? {relay:accepted} : {}),...(restrictedRecall ? {restrictedRecall:true} : {})};
      }
      revision = verdict;
      // The reviewer may identify a usable part of the NPC's own words. Treat it as
      // a new draft and obtain a fresh verdict before anyone hears or learns it.
      if (!reviewingExcerpt && proposed && proposed.text !== draft.text && draft.text.includes(proposed.text) &&
          proposed.factIds.every(id => draft.factIds.includes(id)) && permittedDraft(proposed, sources, privateText))
        excerpt = proposed;
    }
    return {failure:"review", verdict:revision};
  } catch {
    return {failure:stage};
  }
}
