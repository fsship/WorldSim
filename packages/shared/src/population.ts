import { z } from "zod";
import type { WorldState } from "./domain";
import { placedItemsAt, readablesAt } from "./scene-objects";

const name = z.string().trim().min(1).max(160);
const minute = z.number().int().safe().nonnegative();
export const PopulationGroupSchema = z.object({
  id:name, name, size:z.number().int().min(1).max(1_000_000), homeId:name,
  work:z.object({locationId:name, task:name, from:minute, by:minute, leave:minute, homeBy:minute,
    repeatEvery:z.number().int().safe().positive().optional()}).strict(),
  representative:z.object({id:name,slot:z.number().int().positive()}).strict().optional(),
}).strict().refine(g => g.homeId !== g.work.locationId && g.work.from < g.work.by &&
  g.work.by <= g.work.leave && g.work.leave < g.work.homeBy &&
  (!g.work.repeatEvery || g.work.repeatEvery >= g.work.homeBy - g.work.from) && (!g.representative || g.representative.slot <= g.size),
  "群体的出发、集结、散去时间或代表席位无效");
export type PopulationGroup = z.infer<typeof PopulationGroupSchema>;

// The whole group has one timetable. Slots are numbers, never an array of people.
function working(g:PopulationGroup,time:number): number {
  const {from,by,leave,homeBy,repeatEvery} = g.work;
  const at = repeatEvery && time >= from ? from + (time - from) % repeatEvery : time;
  if (at <= from || at >= homeBy) return 0;
  if (at >= by && at <= leave) return g.size;
  return at < by ? Math.floor(g.size * (at-from) / (by-from)) :
    Math.ceil(g.size * (homeBy-at) / (homeBy-leave));
}

/** Anonymous members only. Once met, a representative has their own position and history. */
export function groupCountAt(g:PopulationGroup,locationId:string,time:number): number {
  const onDuty = working(g,time);
  let count = locationId === g.work.locationId ? onDuty : locationId === g.homeId ? g.size - onDuty : 0;
  if (g.representative && locationId === (g.representative.slot <= onDuty ? g.work.locationId : g.homeId)) count--;
  return count;
}

/** Take a slot from the local part of the group, maintaining headcount on promotion. */
export function groupSlotAt(g:PopulationGroup,locationId:string,time:number):number|undefined {
  if (g.representative || groupCountAt(g,locationId,time) === 0) return;
  return locationId === g.work.locationId ? 1 : working(g,time) + 1;
}

export function populationHere(world:WorldState,locationId:string) {
  return world.populationGroups.flatMap(g => {
    const count = groupCountAt(g,locationId,world.time);
    return count ? [{id:g.id,name:g.name,count,activity:locationId === g.work.locationId ? g.work.task : "在本地活动"}] : [];
  });
}

export function roomDescription(world:WorldState,room:WorldState["locations"][number]):string {
  const people = populationHere(world,room.id);
  const readables = readablesAt(world, room.id).filter(doc => !room.description.includes(doc.name));
  const documents = readables.length ? "这里可以翻阅" + readables.map(doc => "《" + doc.name + "》").join("、") + "。" : "";
  const placed = placedItemsAt(world, room.id);
  const objects = placed.length ? "这里放着" + placed.map(item => item.name).join("、") + "。" : "";
  return room.description + documents + objects + people.map(g => g.count + "名" + g.name + "在这里" +
    (g.activity === "在本地活动" ? "活动。" : g.activity + "。")).join("");
}
