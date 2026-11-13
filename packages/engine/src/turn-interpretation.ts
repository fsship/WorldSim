import {
  movementLocations, readMovement, ActionIntentSchema, inspectableItems, readablesAt, readPlayerInput, roomDescription, spokenPlanWords, turnPlanSchemaFor,
  type ActionIntent, type Character, type LLMProvider, type ParseContext, type ParseReferent,
  type PlayerInput, type TurnPlan, type WorldState,
} from "@worldsim/shared";
import { adjudicate, refused, type ActionMeaning, type Adjudication } from "./actions";
import { impliedListener, lastNpcLine } from "./conversation";
import { crowdReferent, groupForContact } from "./crowd-contact";
import { considerEncounter, offlineSeeksContact } from "./encounter";
import { visibleSceneState, hasOpenMap, player, present, record } from "./state";

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
    ...visibleSceneState(world).flatMap(entry => entry.objectId ? [{
      kind:"item" as const,id:entry.objectId,name:entry.name,aliases:[],carried:entry.scope === "held",
    }] : []),
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
    ...(world.worldInfo ? {worldInfo:world.worldInfo, openingSituation:world.history.find(event =>
      event.source === "opening" && event.kind === "world" && event.recipients.includes(king.id) && event.perception !== "private")?.text} : {}),
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

function executeMeaning(world: WorldState, context: ParseContext, plan: Exclude<TurnPlan, {kind:"seekContact"}>): Interpretation {
  const offered = (kind: ParseReferent["kind"], id: string) => {
    const matches = context.referents!.filter(ref => ref.kind === kind && ref.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const rejected = (text: string, intent: ActionIntent = {kind:"attempt"}): Interpretation =>
    ({intent, plan, resolution:refused(text)});
  const run = (intent: ActionIntent, args: Omit<PlayerInput, "intent"> = {}, meaning: ActionMeaning = {}, words?: string): Interpretation =>
    ({intent, plan, words, resolution:adjudicate(world, context.text, intent, {intent, ...args}, meaning)});
  const move = (to:string, using?:string) => {
    const result = run({kind:"move",target:to},{movement:{kind:"destination",target:to}});
    if (!using) return result;
    const asset = visibleSceneState(world).find(entry => entry.objectId === using);
    if (!asset) return rejected("出行物品不在这里。");
    const travel = result.resolution.candidates[0];
    const change = travel.changes.find(c => c.op === "move");
    if (change?.op === "move") {
      change.using = using;
      travel.lines[0].text = "你使用" + asset.name + "来到" + world.locations.find(l=>l.id === to)!.name + "。";
    }
    return result;
  };
  switch (plan.kind) {
    case "itinerary":
    case "sequence": return {plan, intent:{kind:"attempt"}, resolution:{
      candidates:[{id:"sequence", status:"resolved", minutes:0, changes:[], lines:[]}],
      checks:["按顺序核对每一步的现场条件"], waiting:false, askModel:false,
    }};
    case "clarify": return rejected("这句话还不能确定你现在要做什么。请说明这回合想亲自做的事。");
    case "assert": return run({kind:"assert"});
    case "look": return run({kind:"look"});
    case "unavailable": {
      const notes = {item:"你现在没有可用于这项行动的物品。", place:"这里没有通往那个地点的出口。",
        person:"你要找的人目前不在场。", document:"这里看不到你要读的那份文书。"};
      return rejected(notes[plan.subject]);
    }
    case "ride":
    case "explore": {
      if (!context.allowExploration || !hasOpenMap(world)) return rejected("当前地点没有通往那里的出口。");
      const matches = movementLocations(world.locations, plan.destination);
      if (matches.length > 1) return rejected("这个称呼对应多个地点，请用地点全名。");
      const from = player(world).locationId;
      const to = matches[0]?.id ?? "explored-" + world.locations.length;
      if (!matches.length) {
        record(world, {source:"exploration", kind:"world", text:"从这里可以前往" + plan.destination + "。",
          locationId:from, perception:"addressed", recipients:[player(world).id],
          changes:[{op:"discoverPlace", from, to, name:plan.destination}]});
      }
      const result = move(to,plan.kind === "explore" ? plan.using : undefined);
      const travel = result.resolution.candidates[0];
      const method = plan.kind === "ride" ? "刚刚到站的车" : plan.via?.method;
      if (method && travel.id === "travel") {
        travel.minutes = world.rules.maxShort;
        travel.lines[0].text = "你搭乘" + method + "，抵达" + (matches[0]?.name ?? plan.destination) + "。";
      }
      return result;
    }
    case "move": {
      const intent: ActionIntent = {kind:"move", target:plan.destination};
      if (!offered("place", plan.destination)) return rejected(context.exits.length
        ? "从" + context.location + "可直达" + context.exits.join("、") + "。"
        : "这里没有可走的出口。", intent);
      return move(plan.destination,plan.using);
    }
    case "item": {
      const intent: ActionIntent = {kind:"use", item:plan.itemId};
      if (!offered("item", plan.itemId)) return rejected("此刻无法接触到这件物品。", intent);
      const asset = visibleSceneState(world).find(entry => entry.objectId === plan.itemId);
      if (asset) {
        if (plan.inventoryOnly && asset.scope !== "held") return rejected("这件物品不在你身上。",intent);
        const take = plan.interaction === "handle_inspect" && asset.scope === "scene";
        const {scope,name,value} = asset;
        const changes:WorldState["history"][number]["changes"] = take ? [{op:"sceneStep",locationId:player(world).locationId,
          clears:[{scope,name,value}],sets:[{scope:"held",name,value:"拿在手中（原状态：" + value.slice(0,140) + "）"}]}] : [];
        const verb = take ? "拿起并查看" : plan.interaction === "use" ? "使用" : "查看";
        return {intent, plan, resolution:{candidates:[{id:"item",status:"resolved",minutes:1,changes,
          lines:[{kind:"world",text:"你" + verb + name + "。" + value + "。"}]}], askModel:false,
          waiting:false,checks:["物品编号在当前场景可见"],itemId:asset.objectId}};
      }
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

function contactResult(plan: Extract<TurnPlan, {kind:"seekContact"}>, introduced: boolean): Interpretation {
  return {intent:{kind:"attempt"}, plan, resolution:{
    candidates:[{id:"seek-contact", status:"resolved", minutes:2, changes:[],
      lines:introduced ? [] : [{kind:"world", text:"你查看了现场，没有遇到新的人。"}]}],
    askModel:false, waiting:false, checks:["只接触当前位置的人物"],
  }};
}

export async function interpretTurn(world: WorldState, text: string, provider: LLMProvider, segment?:ParseContext["segment"]): Promise<Interpretation> {
  const king = player(world);
  let context = sceneContext(world, king, text);
  const dynamic = !!world.worldInfo && king.condition === "healthy" && !king.journey;
  if (dynamic) context.sceneState = visibleSceneState(world);
  if (dynamic && hasOpenMap(world)) {
    context.allowExploration = true;
    context.localTime = world.time;
    context.allowRoutineEvent = true;
  }
  if (dynamic) {
    const notices = world.history.filter(event => event.time === world.time && event.locationId === king.locationId &&
      event.noticeWitnessIds?.includes(king.id) && event.changes.some(change => change.op === "event" && change.status === "executed"));
    if (notices.length) context.currentNotices = notices.slice(-8).map(({id,text}) => ({id,text}));
  }
  if (segment) context.segment = segment;
  if (provider.interpret) {
    if (dynamic) context.allowEncounter = true;
    const plan = turnPlanSchemaFor(context).parse(await provider.interpret(structuredClone(context)));
    if (plan.kind === "seekContact") {
      const event = await considerEncounter(world, provider, "contact", text);
      // Resolve only actual speech against the now-visible cast. A search never authorizes
      // a second physical operation (movement, orders, arrest) in this turn.
      const after = sceneContext(world, king, text);
      const follow = turnPlanSchemaFor(after).parse(await provider.interpret(structuredClone(after)));
      if (follow.kind === "speak") return executeMeaning(world, after, follow);
      return contactResult(plan, !!event);
    }
    return executeMeaning(world, context, plan);
  }
  // Offline simulation and legacy injected providers share the deterministic reader.
  // The real provider never enters this branch, including on a model or validation error.
  const search = dynamic && offlineSeeksContact(text);
  const encounter = search ? await considerEncounter(world, provider, "contact", text) : undefined;
  if (encounter) context = sceneContext(world, king, text);
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
  if (context.allowExploration && explicit?.intent.kind === "move") {
    // A stated future purpose does not add another stop to this trip.
    const first = text.replace(/[，,]\s*(?:准备|打算)(?:去|到)[^，,。！？?！]+[。！]?$/u, "");
    const trip = readMovement(first);
    if (trip?.kind === "destination" && !trip.origin && /^[\p{L}\p{N}· -]{1,80}$/u.test(trip.target) &&
        (first !== text || !movementLocations(world.locations, trip.target).length))
      return executeMeaning(world, context, {kind:"explore", destination:trip.target});
  }
  const parsed = explicit?.reading ? explicit.intent : ActionIntentSchema.parse(await provider.parse(context));
  const intent = explicit?.intent ?? parsed;
  if (search && intent.kind !== "speak") return contactResult({kind:"seekContact"}, !!encounter);
  const addressed = explicit?.dialogue?.addressee;
  if (addressed && intent.kind === "speak") {
    const targets = context.referents!.filter(r=>(r.kind === "npc" || r.kind === "crowd") && [r.name,...r.aliases].includes(addressed));
    if (targets.length === 1 && targets[0].kind === "crowd") meetAddressedGroup(world,targets[0]);
  }
  return {intent, words:explicit?.dialogue?.text, resolution:adjudicate(world, text, intent, explicit)};
}
