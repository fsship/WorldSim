import { groupCountAt, ScheduledEventSchema, type ScheduledEvent, type WorldState, type Observation, type WorldEvent } from "@worldsim/shared";
import { inLocation, knownFacts, perceive, player, record } from "./state";

const QUEUE_LIMIT = 256;
const MAX_WAIT_JUDGMENTS = 8;
function ordered(a: ScheduledEvent, b: ScheduledEvent) { return a.at - b.at || a.id.localeCompare(b.id); }

export function scheduleEvent(world: WorldState, candidate: ScheduledEvent) {
  const event = ScheduledEventSchema.parse(candidate);
  record(world, { source: event.id, locationId: event.locationId, kind: "system", perception: "private",
    recipients: [], text: "计划已登记。", changes: [{op: "schedule", definition: event}] });
}

export function cancelEvent(world: WorldState, id: string) {
  const event = world.queue.find(e => e.id === id && e.status === "pending");
  if (!event) throw new Error("计划已失效。");
  record(world, { source: id, locationId: event.locationId, kind: "system", perception: "private", recipients: [], text: "计划已取消。",
    changes: [{op:"event", event:id, status:"cancelled"}] });
}

export function rescheduleEvent(world: WorldState, id: string, at: number) {
  const e = world.queue.find(e => e.id === id && e.status === "pending");
  if (!e) throw new Error("计划已失效。");
  record(world, { source: id, locationId: e.locationId, kind: "system", perception: "private",
    recipients: [], text: "计划已改期。", changes: [{op: "reschedule", event: id, at}] });
}

function ready(world: WorldState, e: ScheduledEvent) {
  const c = e.condition;
  if (c.flag && world.variables[c.flag] !== c.equals) return false;
  if (c.activeActor) {
    const actor = world.characters.find(a => a.id === c.activeActor);
    if (!actor || actor.condition !== "healthy" || (c.presentAt && !inLocation(actor,c.presentAt))) return false;
    if (c.knows && !knownFacts(world, actor).some(f => f.id === c.knows)) return false;
    if (e.type === "plan" && (!actor.plans.includes(e.id) || e.entities.some(id =>
      !world.characters.some(a => a.id === id && a.condition === "healthy")))) return false;
  } else if (e.type === "plan" || c.knows || c.presentAt) return false;
  return true;
}

function applyDue(world: WorldState, e: ScheduledEvent) {
  let event: WorldEvent;
  if (ready(world, e)) {
    // Scheduled effects cannot advance the clock, execute other events, or transfer knowledge implicitly.
    if (e.effects.some(op => op.op !== "flag")) throw new Error("不支持该计划的状态变更。");
    const changes: WorldEvent["changes"] = [{op:"event", event:e.id, status:"executed"}, ...e.effects];
    if (e.type === "notice" && e.important && e.perception === "public") {
      if (e.arrival) changes.push({op:"muster",event:e.id});
      changes.push({op:"announce", event:e.id});
    }
    event = record(world, { kind:"world", text:e.text, source:e.id, perception:e.perception,
      locationId:e.locationId, recipients:e.recipients, changes });
    if (e.type === "notice" && e.perception !== "private") {
      event.noticeWitnessIds = world.characters
        .filter(person => person.condition !== "dead" && perceive(event, world, person)).map(person => person.id);
    }
  } else {
    event = record(world, { kind:"system", text:"计划条件未满足。", source:e.id, perception:"private",
      locationId:e.locationId, recipients:[], changes:[{op:"event", event:e.id, status:"cancelled"}] });
  }
  return perceive(event, world);
}

const PULSE_MINUTES = 5;
const REGIONAL_MINUTES = 30;
const MAX_TURN_PULSES = 6;
type Interruption = boolean | "reading";
type WaitMatcher = string | ((notices: string[]) => Promise<boolean>);
type WorldPulse = (world: WorldState) => Promise<Observation[]>;
type NextOpportunity = (world: WorldState, after: number) => number;

function targetTime(world: WorldState, minutes: number) {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new Error("无效的等待时长。");
  const target = world.time + Math.min(minutes, world.rules.maxWait);
  if (!Number.isSafeInteger(target)) throw new Error("无效的等待时长。");
  return target;
}

function nextPulse(at: number, interval = PULSE_MINUTES) {
  return at - at % interval + interval;
}

/** A quiet journey has no need to run the detailed cast every five minutes.
 * A change among nearby anonymous residents can be detected from their single
 * timetable without constructing or waking an individual. */
export function nextWorldOpportunity(world: WorldState, after: number, detailed: ReadonlySet<string>): number {
  const next = nextPulse(after);
  if (world.characters.some(c => c.kind === "npc" && c.condition === "healthy" && !c.journey && detailed.has(c.locationId)))
    return next;
  const regional = nextPulse(after, REGIONAL_MINUTES);
  const king = player(world);
  if (king.journey) return regional;
  const local = world.populationGroups.filter(g => g.homeId === king.locationId || g.work.locationId === king.locationId)
    .map(group => ({group, before:groupCountAt(group,king.locationId,after)}));
  // At most five small timetable checks before regional processing would run anyway.
  for (let at = next; local.length && at < regional; at += PULSE_MINUTES) {
    if (local.some(({group,before}) => groupCountAt(group,king.locationId,at) !== before)) return at;
  }
  return regional;
}

/** Both the synchronous fixture clock and live play settle the same event queue.
 * Never replay historical NPC turns when opening a save in the middle of a day. */
function* checkpoints(world: WorldState, target: number, opportunities?: {next:NextOpportunity; remaining:()=>number}, atTarget?: () => void) {
  let processed = 0;
  do {
    const pulseAt = opportunities ? opportunities.next(world, world.time) : Infinity;
    if (opportunities && (!Number.isSafeInteger(pulseAt) || pulseAt <= world.time))
      throw new Error("下一次世界行动必须在当前时刻之后。");
    if (opportunities && opportunities.remaining() <= 0 && pulseAt <= target) return;
    const pending = world.queue.filter(e => e.status === "pending" && e.at <= target).sort(ordered);
    const at = Math.max(world.time, Math.min(pending[0]?.at ?? target, pulseAt, target));
    if (at !== world.time) record(world, {kind:"system", text:"时间流逝。", source:"clock", perception:"private",
      locationId:player(world).locationId, recipients:[], changes:[{op:"clock",to:at}]});
    // A completed journey places the traveller in the room before this minute's
    // local notices are witnessed and before its NPCs choose their next action.
    if (at === target) atTarget?.();
    const visible: Observation[] = [];
    let important = false;
    for (const event of pending) {
      if (event.at > at) break;
      if (++processed > QUEUE_LIMIT) throw new Error("本回合待处理事件过多。");
      const observation = applyDue(world, event);
      if (observation) {
        visible.push(observation);
        important ||= event.important;
      }
    }
    const pulse = at === pulseAt;
    yield {at, pulse, visible, important};
    // A callback may legitimately change a later event's preconditions. Read
    // the queue again only after this instant's actions have been committed.
  } while (world.time < target);
}

function append(observations: Observation[], lines: Observation[], time?: number) {
  for (const line of lines) observations.push(time === undefined ? line : {...line,time});
}

function stopped(observations: Observation[], at: number, target: number, interruptible: Interruption) {
  if (interruptible === true && at < target)
    observations.push({kind:"system", text:"你留意到新的动静，等待在这里停下。", time:at});
  return true;
}

function missed(observations: Observation[]) {
  observations.push({kind:"system", text:"本次等候已达到时长上限，你没有察觉到所等的事件。"});
}

export function advance(world: WorldState, minutes: number, interruptible: Interruption, observations: Observation[], eventNeedle?: string) {
  const target = targetTime(world,minutes);
  for (const tick of checkpoints(world,target)) {
    append(observations,tick.visible,interruptible === "reading" ? tick.at : undefined);
    if (interruptible && (tick.important || eventNeedle && tick.visible.some(o=>o.text.includes(eventNeedle))))
      return stopped(observations,tick.at,target,interruptible);
  }
  if (eventNeedle) missed(observations);
  return false;
}

export interface TurnClock {
  advance(minutes: number, interruptible: Interruption, match?: WaitMatcher, atTarget?: () => void): Promise<boolean>;
}

export function createTurnClock(world: WorldState, observations: Observation[], onPulse?: WorldPulse,
  nextOpportunity: NextOpportunity = (_world, after) => nextPulse(after),
  onNotices?: () => Promise<Observation[]>): TurnClock {
  let pulsesLeft = MAX_TURN_PULSES;
  const opportunities = onPulse ? {next:nextOpportunity, remaining:() => pulsesLeft} : undefined;
  return {async advance(minutes, interruptible, match, atTarget) {
    const target = targetTime(world,minutes);
    const witnessed: string[] = [];
    let checks = 0;

    for (const tick of checkpoints(world,target,opportunities,atTarget)) {
      append(observations,tick.visible,onPulse || interruptible === "reading" ? tick.at : undefined);
      const visible = tick.visible.map(o => o.text);
      if (onNotices && tick.visible.length) {
        const encounters = await onNotices();
        append(observations, encounters, tick.at);
        visible.push(...encounters.map(o => o.text));
      }
      let sceneChanged = false;
      if (tick.pulse && onPulse) {
        pulsesLeft--;
        const index = world.history.length;
        const lines = await onPulse(world);
        append(observations,lines,tick.at);
        for (const o of lines) {
          if (o.kind !== "system") visible.push(o.speaker ? o.speaker + "：" + o.text : o.text);
        }
        // Ordinary greetings do not continually interrupt a reader. Arrivals,
        // departures and executed orders can present a new decision point.
        sceneChanged = lines.length > 0 && world.history.slice(index).some(e =>
          (e.npcAction?.kind === "move" || e.npcAction?.kind === "carryOutOrder") && !!perceive(e,world));
      }
      if (!interruptible) continue;
      if (!match || !visible.length) {
        if (tick.important || sceneChanged && !match) return stopped(observations,tick.at,target,interruptible);
        continue;
      }
      witnessed.push(...visible);
      if (typeof match === "string") {
        if (tick.important || visible.some(text => text.includes(match))) return stopped(observations,tick.at,target,interruptible);
        continue;
      }
      let met: boolean | undefined;
      if (checks++ < MAX_WAIT_JUDGMENTS) {
        try { met = await match([...witnessed]); } catch { /* Pause without assuming what happened. */ }
      }
      // An important event always interrupts. Its already perceived evidence
      // can still establish whether a continuing wait has achieved its goal.
      if (tick.important || met) return stopped(observations,tick.at,target,interruptible);
      if (met === undefined) {
        observations.push({kind:"system",text:"新的动静已出现在眼前，暂时无法确认是否等到了你要的事。等候在这里暂停。",time:tick.at});
        return true;
      }
    }
    if (world.time < target) {
      observations.push({kind:"system",text:"这次行动先到这里。你可以查看这段时间的动静，再决定是否继续。",time:world.time});
      return true;
    }
    if (match) missed(observations);
    return false;
  }};
}

export async function advanceUntil(world: WorldState, minutes: number, observations: Observation[],
  matches: (notices: string[]) => Promise<boolean>) {
  return createTurnClock(world,observations).advance(minutes,true,matches);
}
