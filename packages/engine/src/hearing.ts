import { groupCountAt, groupSlotAt, type Character, type CommitmentAudience, type WorldEvent, type WorldState } from "@worldsim/shared";
import { present } from "./state";

type Heard = NonNullable<WorldEvent["utterance"]>;
const crowdAudienceKey = (id:string) => "anonymous-audience:" + id;

/** Take the snapshot when the words are spoken, before anyone can move. */
export function withinEarshot(world: WorldState, speaker: Character, privateTo?: string): Character[] {
  return present(world, speaker).filter(c => c.condition !== "dead" && (privateTo === undefined || c.id === privateTo));
}

export function utterance(world:WorldState, speaker: Character, listeners: Character[], quiet: boolean): Heard {
  const heard: Heard = {speakerId:speaker.id, listenerIds:listeners.map(c => c.id), ...(quiet ? {private:true} : {})};
  if (quiet || speaker.journey) return heard;
  const groups = world.populationGroups.flatMap(g => {
    const count = groupCountAt(g,speaker.locationId,world.time);
    if (!count) return [];
    const firstSlot = groupSlotAt(g,speaker.locationId,world.time);
    return [{groupId:g.id, name:g.name, count, ...(firstSlot !== undefined ? {firstSlot} : {})}];
  });
  if (groups.length) heard.groups = groups;
  return heard;
}

/** Resolve the intended listeners from the room as it is now, not as it
 * was when the messenger agreed. A named group never includes bystanders. */
export function relayAudience(world:WorldState, speaker:Character, audience:CommitmentAudience):Heard|undefined {
  if (audience.kind === "person") {
    const listeners = withinEarshot(world,speaker,audience.id);
    if (listeners.length) return utterance(world,speaker,listeners,true);
    return;
  }
  const locals = withinEarshot(world,speaker);
  const here = utterance(world,speaker,locals,false);
  if (audience.kind === "room") {
    const reached = audience.id ? here.listenerIds.includes(audience.id) : here.listenerIds.length || here.groups?.length;
    return reached ? here : undefined;
  }
  const group = world.populationGroups.find(g => g.id === audience.id);
  if (!group) return;
  const groups = here.groups?.filter(g => g.groupId === group.id);
  const listenerIds = here.listenerIds.filter(id => id === group.representative?.id);
  if (!listenerIds.length && !groups?.length) return;
  return {speakerId:speaker.id,private:true,groupOnly:group.id,listenerIds,...(groups?.length ? {groups} : {})};
}

/** Anonymous listeners do not receive thousands of Character or knowledge records.
 * Unrecognized individual knowledge is treated as unavailable to these bystanders. */
export function disclosureAudience(heard: Heard) {
  return [...heard.listenerIds, ...(heard.groups ?? []).map(g => crowdAudienceKey(g.groupId))];
}

export function crowdAudienceName(world:WorldState, key:string) {
  return world.populationGroups.find(g => crowdAudienceKey(g.id) === key)?.name;
}
