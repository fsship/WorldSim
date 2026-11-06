import {
  DialogueContextSchema, DialogueDraftSchema, DialogueReviewSchema, roomDescription, type DialogueContext,
  type DialogueDraft, type LLMProvider, type WorldState, type Character, type WorldFact,
} from "@worldsim/shared";
import { impliedListener } from "./conversation";
import { crowdAudienceName } from "./hearing";
import { witnessedSpeech } from "./crowd-contact";
import { inLocation, knownFacts, perceive, player, present } from "./state";

type DialogueFailure = "generation" | "validation" | "review" | "review_unavailable";
type ReplyFailure = {failure:DialogueFailure; verdict?:DialogueContext["revision"]};
type ReplyResult = DialogueDraft | ReplyFailure;

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
      if (!witnessed(npc.id) || (speech.private && !replyAudience.every(witnessed))) continue;
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
        (event.perception === "addressed" && !replyAudience.every(id => witnesses.includes(id)))) continue;
    if (event.text.length <= 2000 && !privateText(event.text)) recent.push({time:event.time, text:event.text});
  }
  return recent.reverse();
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
  const room = world.locations.find(room => room.id === npc.locationId);
  const surroundings = room ? roomDescription(world,room) : undefined;
  const community = world.populationGroups.find(g => g.representative?.id === npc.id);
  const workplace = community && world.locations.find(l => l.id === community.work.locationId);
  const duty = community && workplace ? "所在群体的事务是"+community.work.task+"，办理地点在"+workplace.name+"。" : npc.publicDuty;
  return DialogueContextSchema.parse({
    speaker:{name:npc.name, role:npc.role}, player:{name:king.name, role:king.role},
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
    const prepared = world.readables.filter(doc => doc.preparedBy === npc.id && doc.locationId === npc.locationId)
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
        sources = {...context, facts:[], duty:undefined, surroundings:undefined, recentNotices:undefined, preparedNotes:undefined,
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
      if (review.grounded && review.playerAgency && review.citationsAccurate) return draft;
      const {excerpt:proposed, ...verdict} = review;
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
