import { groupCountAt, groupSlotAt, type Character, type WorldEvent, type WorldState } from "@worldsim/shared";
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

/** Anonymous listeners do not receive thousands of Character or knowledge records.
 * Unrecognized individual knowledge is treated as unavailable to these bystanders. */
export function disclosureAudience(heard: Heard) {
  return [...heard.listenerIds, ...(heard.groups ?? []).map(g => crowdAudienceKey(g.groupId))];
}

export function crowdAudienceName(world:WorldState, key:string) {
  return world.populationGroups.find(g => crowdAudienceKey(g.id) === key)?.name;
}
