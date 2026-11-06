import { createHash } from "node:crypto";
import {
  arrivalCharacter, groupCountAt, groupSlotAt, type ParseReferent, type PopulationGroup, type WorldEvent, type WorldState,
} from "@worldsim/shared";

type Heard = NonNullable<WorldEvent["utterance"]>;

function contactId(group:PopulationGroup) {
  return group.id.length <= 140 ? "crowd:" + group.id : "crowd-sha:" + createHash("sha256").update(group.id).digest("hex");
}

export function crowdReferent(world:WorldState, group:PopulationGroup, room:string): ParseReferent | undefined {
  const id = contactId(group);
  if (group.representative || groupCountAt(group,room,world.time) < 1 || world.characters.some(c => c.id === id)) return;
  return {kind:"crowd",id,name:group.name,aliases:[group.name.slice(0,150) + "中的一人"]};
}

export function groupForContact(world:WorldState, id:string, room:string) {
  return world.populationGroups.find(group => crowdReferent(world,group,room)?.id === id);
}

/** The same change replays against the same timetable. The chosen seat stops
 * contributing to anonymous occupancy wherever the new person actually goes. */
export function meetCrowdMember(world:WorldState, groupId:string, room:string) {
  const king = world.characters.find(c => c.kind === "player");
  const group = world.populationGroups.find(g => g.id === groupId);
  if (!king || king.condition !== "healthy" || king.journey || king.locationId !== room || !group)
    throw new Error("这里没有可接触的群体。");
  const ref = crowdReferent(world,group,room);
  const slot = groupSlotAt(group,room,world.time);
  if (!ref || slot === undefined) throw new Error("这个群体在现场没有可结识的新成员。");
  const person = arrivalCharacter({id:ref.id,name:ref.aliases[0],role:group.name,aliases:[group.name],
    locationId:room,publicDuty:group.work.task});
  group.representative = {id:person.id,slot};
  world.characters.push(person);
}

export function witnessedSpeech(world:WorldState, heard:Heard, personId:string) {
  if (personId === heard.speakerId || heard.listenerIds.includes(personId)) return true;
  if (heard.private || !heard.groups) return false;
  const group = world.populationGroups.find(g => g.representative?.id === personId && contactId(g) === personId);
  if (!group?.representative) return false;
  const seat = group.representative.slot;
  return heard.groups.some(g => g.groupId === group.id && g.firstSlot !== undefined &&
    seat >= g.firstSlot && seat < g.firstSlot + g.count);
}
