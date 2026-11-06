import type { Character, WorldState } from './domain';

function available(world: WorldState, object: {availableAfterEvent?: string}) {
  return !object.availableAfterEvent || world.queue.some(event =>
    event.id === object.availableAfterEvent && event.status === 'executed');
}

export function readablesAt(world: WorldState, locationId: string) {
  return world.readables.filter(doc => doc.locationId === locationId && available(world, doc));
}

export function placedItemsAt(world: WorldState, locationId: string) {
  return world.items.filter(item => item.locationId === locationId && available(world, item) &&
    !world.characters.some(actor => actor.inventory.includes(item.id)));
}

export function carriedItems(world: WorldState, actor: Character) {
  return world.items.filter(item => actor.inventory.includes(item.id) && available(world, item));
}

export function inspectableItems(world: WorldState, actor: Character) {
  const held = carriedItems(world, actor);
  return actor.journey ? held : [...held, ...placedItemsAt(world, actor.locationId)];
}
