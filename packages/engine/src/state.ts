import {
  arrivalCharacter, carriedItems, populationHere, roomDescription, StateChangeSchema, type Character, type Observation, type PublicState, type StateChange,
  type WorldEvent, type WorldState, type WorldFact,
} from "@worldsim/shared";
import { meetCrowdMember, witnessedSpeech } from "./crowd-contact";

export function player(world: WorldState) {
  const players = world.characters.filter(c => c.kind === "player");
  if (players.length !== 1) throw new Error("存档中的玩家角色无效。");
  return players[0];
}

export function knownFacts(world: WorldState, c: Character): WorldFact[] {
  return world.facts.filter(f => f.createdAt <= world.time && c.knownFactIds.includes(f.id) && f.knownBy.includes(c.id));
}

/** During travel locationId remains the origin for validating the final edge. */
export function inLocation(c: Character, locationId: string): boolean {
  return !c.journey && c.locationId === locationId;
}

export function present(world: WorldState, c: Character) {
  return c.journey ? [] : world.characters.filter(other => other.id !== c.id && inLocation(other,c.locationId));
}

export function perceive(event: WorldEvent, world: WorldState, observer = player(world)): Observation | undefined {
  const other = event.npcAction?.otherSide;
  if (other?.witnessIds.includes(observer.id) && !event.npcAction?.witnessIds?.includes(observer.id))
    return {kind:"world", text:other.text};
  const sameRoom = inLocation(observer,event.locationId);
  const near = observer.journey
    ? event.locationId === observer.locationId || event.locationId === observer.journey.to
    : world.locations.find(l => l.id === observer.locationId)?.exits.includes(event.locationId);
  const visible = event.utterance ? witnessedSpeech(world,event.utterance,observer.id)
    : event.noticeWitnessIds ? event.noticeWitnessIds.includes(observer.id)
    : event.npcAction?.witnessIds ? event.npcAction.witnessIds.includes(observer.id)
    : event.perception === "public"
    || (event.perception === "local" && sameRoom)
    || (event.perception === "audible" && (sameRoom || near))
    || (event.perception === "addressed" && sameRoom && event.recipients.includes(observer.id));
  if (!visible) return;
  const kind = event.kind === "npc" ? "dialogue" : event.kind;
  return event.speaker ? { kind, text: event.text, speaker: event.speaker } : { kind, text: event.text };
}

export function projectWorld(world: WorldState): PublicState {
  const king = player(world);
  const location = world.locations.find(l => l.id === king.locationId);
  if (!location) throw new Error("存档中的位置无效。");
  const opening = world.history.filter(e => e.source === "opening" && e.recipients.includes(king.id) && e.perception !== "private");
  const failed = opening.find(e => e.npcFailure || e.dialogueSource === "fallback");
  const openingRetryable = !!failed && world.version === 0 && opening.every(e =>
    !e.changes.length && (!e.npcAction || e === failed) && (!e.dialogueSource || e.dialogueSource === "fallback"));
  const notices = {
    decision:"本次开场没有取得有效的 NPC 行动。",
    generation:"开场台词未能生成。",
    validation:"开场台词未通过内容校验。",
    review:"开场台词未通过审查。",
    review_unavailable:"开场答复的核验服务暂时没有返回有效结果。",
  };
  return {
    id: world.id, title: world.scenario, scenarioId: world.scenarioId, time: world.time, version: world.version,
    opening: opening.map(e => e.kind === "npc" && e.speaker ? e.speaker + "：「" + e.text + "」" : e.text).join("\n\n"),
    ...(failed ? {openingUsedFallback:true, openingRetryable,
      openingNotice:failed.npcFailure ? notices[failed.npcFailure] : "这段开场使用了备用回复。"} : {}),
    location: {id:location.id, name:location.name, description:roomDescription(world,location), population:populationHere(world,location.id)},
    exits: world.locations.filter(l => location.exits.includes(l.id)).map(l => ({id: l.id, name: l.name})),
    present: present(world, king).map(c => ({id: c.id, name: c.name, role: c.role})),
    player: { id: king.id, name: king.name, role: king.role, condition: {healthy:"安康", detained:"被拘押", dead:"死亡"}[king.condition],
      ...(king.goals.length ? {goal:king.goals.join("；")} : {}),
      items: carriedItems(world, king).map(({id, name, description}) => ({id, name, description})) },
    facts: knownFacts(world, king).map(f => ({id: f.id, text: f.content.text})),
  };
}

/** Only engine-created, scoped effect lists reach this reducer. It independently checks references and invariants. */
export function applyChanges(world: WorldState, changes: StateChange[]) {
  const actor = (id: string) => {
    const c = world.characters.find(x => x.id === id);
    if (!c) throw new Error("变更涉及未知角色。");
    return c;
  };
  for (const raw of changes) {
    const change = StateChangeSchema.parse(raw);
    switch (change.op) {
      case "meet":
        meetCrowdMember(world,change.group,change.locationId);
        break;
      case "depart": {
        const c = actor(change.actor);
        if (c.kind !== "player" || c.condition !== "healthy" || c.journey || change.arrivesAt <= world.time ||
            !world.locations.find(l => l.id === c.locationId)?.exits.includes(change.to))
          throw new Error("角色无法开始这段路程。");
        c.journey = {to:change.to,arrivesAt:change.arrivesAt};
        break;
      }
      case "move": {
        const c = actor(change.actor);
        if (c.condition !== "healthy" || (c.journey && (c.journey.to !== change.to || c.journey.arrivesAt !== world.time)) ||
            !world.locations.find(l => l.id === c.locationId)?.exits.includes(change.to))
          throw new Error("角色无法到达该地点。");
        delete c.journey;
        c.locationId = change.to;
        break;
      }
      case "relation": {
        const c = actor(change.actor), other = actor(change.other);
        if (c.condition !== "healthy" || other.condition !== "healthy" || c.journey || !inLocation(other,c.locationId))
          throw new Error("角色无法交流。");
        c.relations[other.id] = Math.max(-5, Math.min(5, (c.relations[other.id] ?? 0) + change.delta));
        break;
      }
      case "detain": {
        const c = actor(change.actor);
        if (c.kind !== "npc" || c.condition !== "healthy") throw new Error("无法拘押该角色。");
        c.condition = "detained";
        break;
      }
      case "learn": {
        const c = actor(change.actor), fact = world.facts.find(f => f.id === change.fact);
        if (!fact || c.condition === "dead") throw new Error("知识来源无效。");
        if (!c.knownFactIds.includes(fact.id)) c.knownFactIds.push(fact.id);
        if (!fact.knownBy.includes(c.id)) fact.knownBy.push(c.id);
        break;
      }
      case "flag": {
        if (!Object.hasOwn(world.variables, change.name) || typeof world.variables[change.name] !== typeof change.value)
          throw new Error("世界变量不合法。");
        world.variables[change.name] = change.value;
        break;
      }
      case "muster": {
        const notice = world.queue.find(e => e.id === change.event);
        const arrival = notice?.arrival;
        if (!notice || !arrival || notice.status !== "executed" || notice.at !== world.time || !notice.important ||
            notice.type !== "notice" || notice.perception !== "public" ||
            !world.locations.some(l => l.id === arrival.locationId)) throw new Error("到岗事件尚未生效。");
        if (world.characters.some(c => c.id === arrival.id)) throw new Error("到岗单位已在世界中。");
        world.characters.push(arrivalCharacter(arrival));
        break;
      }
      case "announce": {
        const notice = world.queue.find(e => e.id === change.event);
        if (!notice || notice.status !== "executed" || notice.at !== world.time || !notice.important ||
          notice.type !== "notice" || notice.perception !== "public") throw new Error("通报尚未公开执行。");
        const id = "notice/" + notice.id;
        if (world.facts.some(f => f.id === id)) throw new Error("通报事实已经登记。");
        // A public proclamation is heard throughout the palace, including by detainees.
        const audience = world.characters.filter(c => c.condition !== "dead" && world.locations.some(l => l.id === c.locationId));
        const fact: WorldFact = {
          id, type:"outcome", content:{text:notice.text}, entities:[...notice.entities],
          source:notice.id, createdAt:world.time, knownBy:audience.map(c => c.id),
        };
        world.facts.push(fact);
        for (const listener of audience) listener.knownFactIds.push(id);
        break;
      }
      case "schedule": {
        const e = change.definition;
        if (e.status !== "pending" || e.at < world.time || world.queue.some(item => item.id === e.id)
          || world.queue.filter(item => item.status === "pending").length >= 256)
          throw new Error("无法添加该计划。");
        world.queue.push(e);
        world.queue.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        break;
      }
      case "reschedule": {
        const e = world.queue.find(item => item.id === change.event && item.status === "pending");
        if (!e || change.at < world.time) throw new Error("无法调整该计划。");
        e.at = change.at;
        world.queue.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        break;
      }
      case "event": {
        const event = world.queue.find(e => e.id === change.event);
        if (!event || event.status !== "pending" || (change.status === "executed" && event.at !== world.time))
          throw new Error("计划不能重复执行或提早发生。");
        event.status = change.status;
        break;
      }
      case "clock":
        if (change.to < world.time || change.to - world.time > world.rules.maxWait) throw new Error("时钟超出范围。");
        world.time = change.to;
        break;
    }
  }
}

export function record(world: WorldState, details: Omit<WorldEvent, "id" | "time">) {
  applyChanges(world, details.changes);
  const event: WorldEvent = { ...details, id: world.id + "/event/" + (world.history.length + 1), time: world.time };
  world.history.push(event);
  return event;
}
