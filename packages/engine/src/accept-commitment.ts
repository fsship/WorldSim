import { quoteSpans, type CommitmentAudience, type NpcCommitment, type RelayAcceptance, type WorldEvent, type WorldState } from '@worldsim/shared';
import { player, record } from './state';

function resolveAudience(world:WorldState,actorId:string,audience:RelayAcceptance['audience'],instruction:string):CommitmentAudience|undefined {
  if (audience.kind === 'room') {
    // With "in front of X", X is a precondition for the announcement. Bind
    // only real personal names in the attendance clause (not names mentioned
    // in the message). A room label supplied by the reviewer is not a person.
    const clauses = [...instruction.matchAll(/当着([^，。；：:！？]+?)的面|(?:确保|务必让|要让)([^，。；：:！？]+?)(?:在场|听到|听见)/gu)]
      .map(m=>m[1] ?? m[2]);
    const named = world.characters.filter(c=>c.id!==actorId && clauses.some(part=>part.includes(c.name)));
    if (named.length > 1) return; // The protocol currently supports one required named witness.
    if (named.length === 1) {
      const person=named[0];
      const label=audience.name;
      if (label && !label.includes(person.name) && ![person.role,...person.aliases].includes(label) &&
          !world.locations.some(l=>[l.name,...l.aliases].includes(label))) return;
      return {kind:'room',id:person.id};
    }
  }
  if (audience.kind === 'room' && !audience.name) return {kind:'room'};
  if (audience.kind === 'group') {
    const groups = world.populationGroups.filter(group=>group.name === audience.name);
    return groups.length === 1 ? {kind:'group',id:groups[0].id} : undefined;
  }
  const name = audience.name!;
  const candidates = world.characters.filter(c => {
    if (c.id === actorId) return false;
    if ([c.name,c.role,...c.aliases].includes(name)) return true;
    const title = name.endsWith(c.name) ? name.slice(0,-c.name.length) : '';
    return !!title && [c.role,...c.aliases].some(role => role.endsWith(title));
  });
  return candidates.length === 1 ? {kind:audience.kind,id:candidates[0].id} : undefined;
}

const trimSentence = (s:string) => s.trim().replace(/[。.!！?？]+$/u,'').trim();

// Separate the words to be repeated from the instructions about where and to
// whom. A matching substring inside a negation, quotation or condition is not
// evidence that the speaker authorized sending that substring on its own.
function relayInstruction(request:string,relay:RelayAcceptance):string|undefined {
  const message = trimSentence(relay.message);
  if (!message) return;
  const spans = quoteSpans(request);
  let prefix:string;
  if (spans.length) {
    const quoted = spans.filter(s=>trimSentence(s.text) === message);
    if (quoted.length !== 1) return;
    prefix = request.slice(0,quoted[0].start);
  } else {
    const start = request.indexOf(message);
    if (start < 0 || request.indexOf(message,start+1) >= 0) return;
    prefix = request.slice(0,start).trimEnd();
    const tail = request.slice(start+message.length).trimStart();
    if (tail && !/^[。.!！?？\n]/u.test(tail)) return;
    const endOfInstruction = /[，,:：。；;\n]$/u.test(prefix) ||
      (!!relay.audience.name && prefix.endsWith(relay.audience.name)) ||
      /(?:说|转达|转告|告知|传达|带句话|捎句话)(?:的内容是)?$/u.test(prefix);
    if (!endOfInstruction) return;
    // Commas can separate parts of one message. Once the instructions have
    // introduced it with a colon, retain the entire following clause.
    const colon = Math.max(prefix.lastIndexOf('：'),prefix.lastIndexOf(':'));
    if (colon >= 0 && prefix.slice(colon+1).trim()) return;
  }
  if (!prefix.includes(relay.destination) || (relay.audience.name && !prefix.includes(relay.audience.name))) return;
  return prefix;
}

function permittedAudience(instruction:string,audience:RelayAcceptance['audience']):boolean {
  if (audience.kind !== 'room') return true;
  if (/私下|私底下|单独|悄悄|保密|不要公开|别公开|勿公开|(?:只|仅)(?:能)?(?:让|对|向|给|告诉|告知)/u.test(instruction)) return false;
  return /公开|当众|当面向全|广播|全场|在场(?:的)?(?:人|所有|各位|众人)|(?:所有人|每个人|大家|大伙|所有到场者|众人)|当着[^，。；!?？！]+的面/u.test(instruction);
}

/** Resolve names actually uttered, without showing the model a remote roster
 * or treating a claim about the recipient's whereabouts as established. */
export function relayTerms(world:WorldState,actorId:string,request:string,relay:RelayAcceptance) {
  const instruction = relayInstruction(request,relay);
  if (!instruction || !permittedAudience(instruction,relay.audience)) return;
  const places = world.locations.filter(place=>[place.name,...place.aliases].includes(relay.destination));
  const audience = resolveAudience(world,actorId,relay.audience,instruction);
  if (places.length === 1 && audience) return {destinationId:places[0].id,audience};
}

export function acceptSpokenCommitment(world:WorldState,requestId:string,line:WorldEvent,relay:RelayAcceptance) {
  const request = world.history.find(event=>event.id === requestId);
  const actorId = line.speakerId;
  if (!actorId || line !== world.history.at(-1) || line.kind !== 'npc' ||
      line.utterance?.speakerId !== actorId || line.dialogueSource !== 'provider' || !line.utterance.listenerIds.includes(player(world).id) ||
      request?.utterance?.speakerId !== player(world).id || !request.utterance.listenerIds.includes(actorId) ||
      request.source !== 'speech' || request.locationId !== line.locationId || line.text !== relay.acceptance) return;
  const terms = relayTerms(world,actorId,request.text,relay);
  if (!terms) return;
  const commitment:NpcCommitment = {
    id:line.id+'/relay',actorId,...terms,message:relay.message,
    requestEventId:requestId,replyEventId:line.id,createdAt:world.time,nextAt:world.time+1,status:'pending',
  };
  if (world.commitments.some(c=>c.replyEventId === line.id ||
      (c.requestEventId === requestId && c.actorId === actorId))) return;
  record(world,{source:'npc-commitment',kind:'system',text:'角色记下了亲口答应转达的口信。',perception:'private',
    locationId:line.locationId,recipients:[],changes:[{op:'acceptCommitment',commitment}]});
}
