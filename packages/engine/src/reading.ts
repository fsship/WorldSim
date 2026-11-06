import type { Observation, ReadableDocument, ReadingRequest, WorldState } from "@worldsim/shared";
import { createTurnClock, type TurnClock } from "./scheduler";
import { player, record } from "./state";

export interface ReadingPlan {
  document: ReadableDocument;
  start: number;
  end: number;
}

function lastBookmark(world: WorldState, readerId: string, documentId?: string) {
  for (let i = world.history.length - 1; i >= 0; i--) {
    const event = world.history[i];
    if (event.bookmark && event.recipients.includes(readerId) &&
        (documentId === undefined || event.bookmark.documentId === documentId)) return event.bookmark;
  }
}

export function planReading(world: WorldState, request: ReadingRequest): ReadingPlan | {notice:string} {
  const reader = player(world);
  const local = world.readables.filter(doc => doc.locationId === reader.locationId);
  const previous = lastBookmark(world, reader.id);
  let candidates = local;
  if (request.documentId !== undefined) {
    candidates = local.filter(doc => doc.id === request.documentId);
  } else if (request.target) {
    candidates = local.filter(doc => doc.name === request.target || doc.aliases.includes(request.target));
  } else if (previous && (request.resume || request.section !== undefined && local.some(doc => doc.id === previous.documentId))) {
    candidates = local.filter(doc => doc.id === previous.documentId);
  }
  if (!candidates.length) return {notice:"这里看不到要读的那份文书。"};
  if (candidates.length > 1) return {notice:"这里有几份文书，请指明要读哪一份：" + candidates.map(doc => doc.name).join("、") + "。"};
  const document = candidates[0];
  const count = document.entries.length;
  if (request.section !== undefined) {
    let index: number;
    if (typeof request.section === "number") index = request.section - 1;
    else {
      const matching = document.entries.filter(entry => entry.title === request.section);
      if (matching.length > 1) return {notice:"《" + document.name + "》有同名条目，请用序号指定。"};
      index = document.entries.indexOf(matching[0]);
    }
    if (!Number.isInteger(index) || index < 0 || index >= count)
      return {notice:"《" + document.name + "》有 " + count + " 项，没有找到你指定的那一项。"};
    return {document, start:index, end:index + 1};
  }
  const start = request.resume ? lastBookmark(world, reader.id, document.id)?.nextIndex ?? 0 : 0;
  if (start >= count) return {notice:"你已读到《" + document.name + "》的末尾，可以指定一项重看。"};
  return {document, start, end:request.nextOnly ? start + 1 : count};
}

/** Reveal one entry at a time; the event log itself is the durable bookmark. */
export async function readDocument(world: WorldState, plan: ReadingPlan, observations: Observation[], otherMinutes: number,
  clock: TurnClock = createTurnClock(world,observations)): Promise<boolean> {
  const reader = player(world);
  const startTime = world.time;
  const {document} = plan;
  let next = plan.start;
  const note = (kind: "world" | "system", text: string) => {
    const event = record(world, {source:"reading", kind, text, locationId:reader.locationId, perception:"addressed",
      recipients:[reader.id], changes:[], bookmark:{documentId:document.id, nextIndex:next}});
    observations.push({kind, text, time:event.time});
  };
  // An event already due at the start gets priority over the first line of text.
  let interrupted = await clock.advance(0, "reading");
  while (!interrupted && next < plan.end && world.time - startTime < world.rules.maxShort) {
    const entry = document.entries[next++];
    const heading = next - 1 === plan.start
      ? "你在《" + document.name + "》上读到第" + next + "项「" + entry.title + "」。"
      : "第" + next + "项是「" + entry.title + "」。";
    note("world", heading + entry.text);
    interrupted = await clock.advance(1, "reading");
  }
  if (next < plan.end) {
    const position = next > plan.start ? "你刚读完「" + document.entries[next - 1].title + "」。" : "";
    note("world", position + (interrupted ? "阅读被打断了。" : "这次先读到这里。") +
      "再翻阅时，可以从第" + (next + 1) + "项接着读。");
  }
  // A greeting and an incidental glance share the same minutes.
  const remaining = Math.min(otherMinutes, world.rules.maxShort) - (world.time - startTime);
  if (!interrupted && remaining > 0) interrupted = await clock.advance(remaining, "reading");
  return interrupted;
}
