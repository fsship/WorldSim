import { createHash } from "node:crypto";
import {
  EncounterProposalSchema, quoteSpans, roomDescription, type EncounterContext,
  type LLMProvider, type WorldEvent, type WorldState,
} from "@worldsim/shared";
import { player, present, record, sameCharacterName } from "./state";

function actionWords(text: string) {
  let unquoted = text;
  for (const span of quoteSpans(text).reverse()) unquoted = unquoted.slice(0, span.start) + unquoted.slice(span.end);
  return unquoted.trim();
}

/** The offline reader only recognizes explicit attempts, never a story or a quotation about meeting someone. */
export function offlineSeeksContact(text: string) {
  const action = actionWords(text).replace(/^(?:我(?:想要|打算|准备|试着|想|要|先)?|请|试着|尝试)\s*/u, "");
  if (/^(?:(?:敲|叩).{0,4}门|(?:高声|大声)?(?:喊|呼喊).{0,10}(?:有人|来人)|(?:这里|附近)?有人(?:吗|在吗))/u.test(action)) return true;
  const focus = action.split(/(?:帮我|替我|帮忙)/u).at(-1)!.trim();
  const target = focus.match(/^(?:四处|到处|在附近|在这里)?(?:寻找|寻访|找|问问?|叫|对|向)(?:一下)?(?:另[一个名位]+|其他|一?[个名位])?(.+)/u)?.[1];
  if (!target) return false;
  // Open-ended object searches stay with the ordinary inspection rules.
  return /^(?:(?:当班|值班|路过)的?)?(?:人|陌生人|过路人|路人|行人|当地人|医生|大夫|护士|摊主|摊贩|掌柜|店员|老板|守卫|卫兵|船夫|邮差|邮递员|旅客|站务员|技术员)(?:$|[\s，,。！？!?：:]|说|问|聊|谈|搭话|道谢|打听)/u.test(target);
}

function targetsKnownPerson(words: string, names: string[]) {
  // "请掌柜帮我找医生" targets the doctor. Mentioning the shopkeeper is not a request to recreate him.
  const focus = words.split(/(?:帮我|替我|帮忙)/u).at(-1)!.trim();
  const target = focus.match(/^(?:我(?:想要|想|要|打算|准备|先)?)?(?:请)?(?:寻找|找|问问|问|拜访|叫|对|向|跟|与|和)(?:一下)?(?:一[个名位])?\s*(.+)$/u)?.[1];
  if (!target) return false;
  return names.some(name => target.startsWith(name) &&
    /^(?:$|[，,。！？!?：:\s]|说|打听|搭话|询问|问|交谈|聊|道谢|致意)/u.test(target.slice(name.length)));
}

/** Only the referee sees this proposal. The engine supplies the stable identity, place and effects. */
export async function considerEncounter(world: WorldState, provider: LLMProvider, trigger: EncounterContext["trigger"],
  input?: string, notices:WorldEvent[] = []): Promise<WorldEvent | undefined> {
  const lead = player(world);
  if (!world.worldInfo || lead.condition !== "healthy" || lead.journey) return;
  const room = world.locations.find(l => l.id === lead.locationId)!;
  const nearby = present(world, lead).filter(c => c.condition !== "dead");
  if (nearby.length >= 32) return;
  const words = actionWords(input ?? "");
  const cue = trigger === "event" ? JSON.stringify(notices.map(e => e.id)) : trigger === "contact"
    ? createHash("sha256").update(words.normalize("NFKC").replace(/[\p{White_Space}\p{P}]/gu, "")).digest("hex") : undefined;
  if (trigger === "contact") {
    // A player's request cannot move a known offsite person or replace an existing listener.
    const names = [...world.characters.filter(c => c.kind === "npc").map(c => c.name),
      ...nearby.flatMap(c => [c.role, ...c.aliases])];
    if (targetsKnownPerson(words,names)) return;
  } else if (trigger === "event") {
    if (!notices.length) return;
  } else if (nearby.length) return;
  const alreadyChecked = world.history.some(e => e.locationId === room.id && e.changes.some(c => {
    if (c.op !== "encounter") return false;
    if (trigger === "event") return c.trigger === "event" && c.cue === cue;
    if (trigger === "contact") return c.trigger === "contact" && c.cue === cue &&
      (world.time - e.time < 30 || nearby.some(npc => npc.id === c.person?.id));
    return c.trigger === "opening" || c.trigger === "arrival";
  }));
  if (alreadyChecked) return;
  const situation = world.history.find(e => e.source === "opening" && e.kind === "world")?.text;
  if (!provider.encounter || !situation) throw new Error("无法判定现场是否会遇见新人物。");
  const recentEvents = trigger === "event" ? notices.slice(-24) : world.history.filter(e =>
    e.locationId === room.id && e.kind === "world" && e.source !== "opening" &&
    e.noticeWitnessIds?.includes(lead.id) && (e.perception === "local" || e.perception === "public" || e.perception === "audible")).slice(-4);
  const recent = recentEvents.map(e => e.text.slice(0,2000));
  const proposal = EncounterProposalSchema.parse(await provider.encounter({
    trigger, worldInfo:world.worldInfo, situation, player:{name:lead.name, role:lead.role},
    location:{name:room.name, description:roomDescription(world,room).slice(0,4000)}, time:world.time,
    present:nearby.map(({name,role}) => ({name,role})), ...(input ? {input} : {}), ...(recent.length ? {recent} : {}),
  }));
  // A same-name NPC living elsewhere is private information. Resolving this as no new encounter
  // lets the current action proceed without relocating that NPC or revealing its whereabouts.
  const fresh = proposal.kind === "npc" && !world.characters.some(c => sameCharacterName(c.name, proposal.name));
  let person;
  if (fresh) {
    let n = world.characters.length + 1;
    while (world.characters.some(c => c.id === "encounter-" + n)) n++;
    person = {id:"encounter-" + n, name:proposal.name, role:proposal.role, duty:proposal.duty, goal:proposal.goal};
  }
  const visible = !!person || trigger === "contact";
  return record(world, {
    source:trigger === "opening" ? "opening" : "encounter", kind:"world", locationId:room.id,
    text:person ? "你在" + room.name + "遇见了" + person.role + "·" + person.name + "。" : "你留意了周围，没有遇到新的交谈对象。",
    perception:visible ? "addressed" : "private", recipients:visible ? [lead.id] : [],
    ...(person ? {noticeWitnessIds:[lead.id, ...nearby.map(c => c.id), person.id]} : {}),
    changes:[{op:"encounter", trigger, locationId:room.id, cue, person,
      ...(trigger === "event" ? {witnessedEventIds:notices.map(e => e.source)} : {})}],
  });
}
