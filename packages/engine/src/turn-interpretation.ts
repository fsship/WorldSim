import {
  ActionIntentSchema, inspectableItems, readablesAt, readPlayerInput, roomDescription, spokenPlanWords, turnPlanSchemaFor,
  type ActionIntent, type Character, type LLMProvider, type ParseContext, type ParseReferent,
  type PlayerInput, type TurnPlan, type WorldState,
} from "@worldsim/shared";
import { adjudicate, refused, type ActionMeaning, type Adjudication } from "./actions";
import { impliedListener, lastNpcLine } from "./conversation";
import { crowdReferent, groupForContact } from "./crowd-contact";
import { player, present, record } from "./state";

interface Interpretation {
  intent: ActionIntent;
  resolution: Adjudication;
  words?: string;
  plan?: TurnPlan;
}

/** Offer only handles for things the player can currently perceive or use.
 * Hidden goals, undiscovered facts, rule effects and pending events stay in the engine. */
function sceneContext(world: WorldState, king: Character, text: string): ParseContext {
  const room = world.locations.find(l => l.id === king.locationId)!;
  const nearby = present(world, king).filter(c => c.condition !== "dead");
  const places = world.locations.filter(l => l.id === room.id || room.exits.includes(l.id));
  const items = inspectableItems(world, king);
  const docs = readablesAt(world, room.id);
  const referents: ParseReferent[] = [
    ...places.map(({id,name,aliases}) => ({kind:"place" as const,id,name,aliases})),
    ...nearby.map(({id,name,aliases}) => ({kind:"npc" as const,id,name,aliases})),
    ...items.map(({id,name,aliases}) => ({kind:"item" as const,id,name,aliases,carried:king.inventory.includes(id)})),
    ...docs.map(({id,name,aliases,entries}) => ({
      kind:"document" as const, id, name, aliases, sectionTitles:entries.map(entry => entry.title),
    })),
  ];
  for (const group of world.populationGroups) {
    const ref = crowdReferent(world,group,room.id);
    if (ref) referents.push(ref);
  }
  for (const [index, search] of world.rules.discoveries.entries()) {
    if (search.locationId === room.id && search.visibleSubject)
      referents.push({kind:"subject",id:"subject-"+index, ...search.visibleSubject});
  }
  for (const rule of world.rules.orders) {
    if (rule.id && rule.summary && nearby.some(c => c.id === rule.npcId)) {
      referents.push({kind:"order",id:rule.id,name:rule.summary,aliases:[],actorId:rule.npcId});
    }
  }
  let bookmarkedId: string | undefined, observedId: string | undefined;
  for (let i = world.history.length - 1; i >= 0 && !(bookmarkedId && observedId); i--) {
    const event = world.history[i];
    if (!event.recipients.includes(king.id)) continue;
    bookmarkedId ??= event.bookmark?.documentId;
    observedId ??= event.observedItemId;
  }
  const lastDocumentId = docs.find(doc => doc.id === bookmarkedId)?.id;
  const lastItemId = items.find(item => item.id === observedId)?.id;
  const lastSpeaker = impliedListener(lastNpcLine(world, king), nearby);
  let previousWait: ParseContext["previousWait"];
  for (let i = world.history.length - 1; i >= 0; i--) {
    const event = world.history[i];
    if (event.source !== "action" && event.source !== "reading" && event.source !== "speech") continue;
    if (event.locationId === king.locationId && event.pendingWait && event.pendingWait.until > world.time)
      previousWait = event.pendingWait;
    break;
  }
  return {
    text, location:room.name, surroundings:roomDescription(world,room).slice(0,800), referents,
    ...(previousWait ? {previousWait} : {}),
    exits:places.filter(p => p.id !== room.id).map(p => p.name), items:items.map(i => i.name),
    people:referents.filter(r=>r.kind === "npc" || r.kind === "crowd").flatMap(r=>[r.name,...r.aliases]),
    lastSpeakerId:lastSpeaker?.id, lastDocumentId, lastItemId,
  };
}

function meetAddressedGroup(world:WorldState, ref:ParseReferent) {
  const king = player(world);
  if (king.condition !== "healthy" || king.journey) return;
  const group = groupForContact(world,ref.id,king.locationId);
  if (!group) return;
  record(world,{source:"introduction",kind:"system",text:king.name + "向" + group.name + "中的一人搭话。",
    locationId:king.locationId,perception:"private",recipients:[],
    changes:[{op:"meet",group:group.id,locationId:king.locationId}]});
}

function readSelection(selection: Extract<TurnPlan, {kind:"read"}>["reading"]): NonNullable<PlayerInput["reading"]> {
  return {target:"", documentId:selection.documentId, section:selection.section,
    ...(selection.resume || selection.nextOnly ? {resume:true} : {}), ...(selection.nextOnly ? {nextOnly:true} : {})};
}

function executeMeaning(world: WorldState, context: ParseContext, plan: TurnPlan): Interpretation {
  const offered = (kind: ParseReferent["kind"], id: string) => {
    const matches = context.referents!.filter(ref => ref.kind === kind && ref.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const rejected = (text: string, intent: ActionIntent = {kind:"attempt"}): Interpretation =>
    ({intent, plan, resolution:refused(text)});
  const run = (intent: ActionIntent, args: Omit<PlayerInput, "intent"> = {}, meaning: ActionMeaning = {}, words?: string): Interpretation =>
    ({intent, plan, words, resolution:adjudicate(world, context.text, intent, {intent, ...args}, meaning)});
  switch (plan.kind) {
    case "clarify": return rejected("这句话还不能确定你现在要做什么。请说明这回合想亲自做的事。");
    case "assert": return run({kind:"assert"});
    case "look": return run({kind:"look"});
    case "unavailable": {
      const notes = {item:"你现在没有可用于这项行动的物品。", place:"这里没有通往那个地点的出口。",
        person:"你要找的人目前不在场。", document:"这里看不到你要读的那份文书。"};
      return rejected(notes[plan.subject]);
    }
    case "move": {
      const intent: ActionIntent = {kind:"move", target:plan.destination};
      if (!offered("place", plan.destination)) return rejected(context.exits.length
        ? "从" + context.location + "可直达" + context.exits.join("、") + "。"
        : "这里没有可走的出口。", intent);
      return run(intent, {movement:{kind:"destination",target:plan.destination}});
    }
    case "item": {
      const intent: ActionIntent = {kind:"use", item:plan.itemId};
      if (!offered("item", plan.itemId)) return rejected("此刻无法接触到这件物品。", intent);
      const inspection = plan.interaction === "use" ? undefined : plan.interaction === "inspect" ? "look" : "handle";
      return run(intent,{object:{kind:"use",object:plan.itemId,inspection,inventoryOnly:plan.inventoryOnly}});
    }
    case "investigate": {
      const subject = offered("subject", plan.focus);
      if (!subject && plan.focus !== "room" && plan.focus !== "other")
        return rejected("眼前没有这个可检查的对象。", {kind:"investigate"});
      const discovery = subject ? world.rules.discoveries[Number(subject.id.slice("subject-".length))] : undefined;
      return run({kind:"investigate",target:plan.focus}, {object:{kind:"investigate",object:plan.focus}}, {discovery});
    }
    case "read": return run({kind:"investigate",target:plan.reading.documentId}, {reading:readSelection(plan.reading)});
    case "speak": {
      const words = spokenPlanWords(plan.words);
      const who = plan.targetId ? offered("npc",plan.targetId) ?? offered("crowd",plan.targetId) : undefined;
      if (who?.kind === "crowd" && !plan.targetUnavailable) meetAddressedGroup(world,who);
      return run({kind:"speak",target:who?.name}, {dialogue:{text:words, addressee:who?.name},
        reading:plan.reading ? readSelection(plan.reading) : undefined},
        {speech:{private:plan.private, courteous:plan.courteous ?? false, targetId:who?.id,
          targetUnavailable:plan.targetUnavailable || (!!plan.targetId && !who)}}, words);
    }
    case "order": {
      const intent: ActionIntent = {kind:"order",target:plan.targetId};
      if (!offered("npc",plan.targetId)) return rejected("接收这道命令的人目前不在场。", intent);
      const option = plan.orderId ? offered("order",plan.orderId) : undefined;
      if (plan.orderId && (!option || option.actorId !== plan.targetId)) return rejected("这个人无法执行所选的命令。", intent);
      const rule = option ? world.rules.orders.find(r => r.id === option.id && r.npcId === plan.targetId) : undefined;
      return run(intent, {}, {order:{targetId:plan.targetId, private:plan.private, order:rule, summary:option?.name}}, plan.words);
    }
    case "arrest": {
      const intent: ActionIntent = {kind:"arrest", target:plan.targetId};
      if (!offered("npc",plan.targetId)) return rejected("拘押对象目前不在场。", intent);
      return run(intent, {object:{kind:"arrest",object:plan.targetId}});
    }
    case "wait": {
      const previous = plan.resume ? context.previousWait : undefined;
      if (plan.resume && !previous) return rejected("没有尚未完成的等待目标，请说明想等多久或等什么事。");
      const event = previous?.event ?? plan.event;
      const kind = event ? "wait_event" : (previous?.rest || plan.rest) ? "rest" : "wait";
      const minutes = previous ? previous.until - world.time : plan.minutes ?? (plan.clock || event ? undefined : 5);
      const intent: ActionIntent = {kind, minutes, clock:plan.clock};
      return run(intent, {waiting:{intent,day:plan.day,eventNeedle:event}});
    }
    case "attempt": return run({kind:"attempt"}, {}, {activity:plan.activity});
  }
}

export async function interpretTurn(world: WorldState, text: string, provider: LLMProvider): Promise<Interpretation> {
  const king = player(world);
  const context = sceneContext(world, king, text);
  if (provider.interpret) {
    const plan = turnPlanSchemaFor(context).parse(await provider.interpret(structuredClone(context)));
    return executeMeaning(world, context, plan);
  }
  // Offline simulation and legacy injected providers share the deterministic reader.
  // The real provider never enters this branch, including on a model or validation error.
  const room = world.locations.find(l => l.id === king.locationId)!;
  const readableIds = new Set(world.history.flatMap(e => e.bookmark && e.recipients.includes(king.id) ? [e.bookmark.documentId] : []));
  const readableNames = context.referents!.filter(ref => ref.kind === "document").flatMap(ref => [ref.name, ...ref.aliases]);
  for (const doc of world.readables) {
    if (doc.locationId !== room.id && readableIds.has(doc.id)) readableNames.push(doc.name, ...doc.aliases);
  }
  const itemNames = context.referents!.filter(ref => ref.kind === "item").flatMap(ref => [ref.name, ...ref.aliases]);
  const explicit = readPlayerInput(text, context.people, [room.name, ...room.aliases], readableNames, itemNames);
  if (explicit?.waiting?.resume && context.previousWait) {
    const {intent,resolution} = executeMeaning(world, context, {kind:"wait", resume:true});
    return {intent,resolution};
  }
  const parsed = explicit?.reading ? explicit.intent : ActionIntentSchema.parse(await provider.parse(context));
  const intent = explicit?.intent ?? parsed;
  const addressed = explicit?.dialogue?.addressee;
  if (addressed && intent.kind === "speak") {
    const targets = context.referents!.filter(r=>(r.kind === "npc" || r.kind === "crowd") && [r.name,...r.aliases].includes(addressed));
    if (targets.length === 1 && targets[0].kind === "crowd") meetAddressedGroup(world,targets[0]);
  }
  return {intent, words:explicit?.dialogue?.text, resolution:adjudicate(world, text, intent, explicit)};
}
