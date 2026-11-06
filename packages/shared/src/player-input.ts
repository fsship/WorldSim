import type { ActionIntent } from './contracts';
import { readMovement, type MovementRequest } from './movement';
import { readObjectAction } from './objects';
import { readDialogueLine, quotedFollowUps, type DialogueLine } from './speech';
import { readReadingAction, type ReadingRequest } from './reading';
import { isDirectedLook, readWaitAction } from './waiting';

export interface PlayerInput {
  intent: ActionIntent;
  dialogue?: DialogueLine;
  speechInput?: string;
  reading?: ReadingRequest;
  movement?: MovementRequest;
  waiting?: ReturnType<typeof readWaitAction>;
  object?: ReturnType<typeof readObjectAction>;
}

/** Classify an explicit player clause. World permissions are checked separately. */
export function readPlayerInput(text: string, people: readonly string[], roomNames: readonly string[],
  readableNames: readonly string[] = [], itemNames: readonly string[] = []): PlayerInput | undefined {
  for (const part of quotedFollowUps(text, people)) {
    const reading = readReadingAction(part.followUp, readableNames);
    if (!reading) continue;
    const greeting = part.dialogue.text.match(/^(?:早|早安|早上好|你好|您好|晚安|谢谢|多谢)[，,]\s*([^，,。！？!?]+)[。！？!！]?$/u);
    const addressee = part.dialogue.addressee ?? (greeting && people.includes(greeting[1]) ? greeting[1] : undefined);
    const dialogue = addressee ? {...part.dialogue, addressee} : part.dialogue;
    return {dialogue, speechInput:part.speechInput, reading,
      intent:addressee ? {kind:'speak',target:addressee} : {kind:'speak'}};
  }
  const dialogue = readDialogueLine(text, people);
  if (dialogue) {
    return {dialogue, intent:dialogue.addressee ? {kind:'speak', target:dialogue.addressee} : {kind:'speak'}};
  }
  const reading = readReadingAction(text, readableNames);
  if (reading) return {reading, intent:reading.target ? {kind:'investigate', target:reading.target} : {kind:'investigate'}};
  const waiting = readWaitAction(text, roomNames);
  if (waiting) return {intent:waiting.intent, waiting};
  const action = readObjectAction(text, people, itemNames);
  if (!action?.inspection && isDirectedLook(text)) return {intent:{kind:'look'}};

  const movement = readMovement(text);
  if (movement) {
    const intent: ActionIntent = {kind:'move'};
    if (movement.kind === 'destination' && movement.target.length <= 160) intent.target = movement.target;
    return {intent, movement};
  }
  if (!action) return;
  const intent: ActionIntent = {kind:action.kind};
  if (action.kind === 'use' && action.object && action.object.length <= 160) intent.item = action.object;
  if (action.kind === 'order' || action.kind === 'arrest') {
    const name = [...people].sort((a, b) => b.length - a.length).find(n => action.object.startsWith(n));
    if (name) intent.target = name;
  }
  return {intent, object:action};
}
