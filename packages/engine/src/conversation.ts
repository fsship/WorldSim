import type { Character, WorldEvent, WorldState } from "@worldsim/shared";
import { perceive } from "./state";

/** Find the last NPC line actually addressed to the player in this scene. */
export function lastNpcLine(world: WorldState, king: Character): WorldEvent | undefined {
  for (let i = world.history.length - 1; i >= 0; i--) {
    const event = world.history[i];
    if (event.changes.some(c => c.op === "move" && c.actor === king.id)) return;
    if (event.utterance?.speakerId === king.id) continue;
    if (event.locationId !== king.locationId || !perceive(event, world, king)) continue;
    if (event.kind === "system") continue; // A clarification does not end the conversation.
    const addressed = event.kind === "npc" || (event.npcAction && event.npcAction.trigger !== "ambient");
    return addressed && event.recipients.includes(king.id) ? event : undefined;
  }
}

/** Match old saves by their displayed speaker label, newer saves by stable ID. */
export function impliedListener(event: WorldEvent | undefined, people: Character[]): Character | undefined {
  if (!event) return people.length === 1 && people[0].condition === "healthy" ? people[0] : undefined;
  const id = event.npcAction?.actorId ?? event.speakerId;
  const matches = people.filter(person => id ? person.id === id :
    event.speaker === person.name || event.speaker === person.role + "·" + person.name);
  return matches.length === 1 && matches[0].condition === "healthy" ? matches[0] : undefined;
}
