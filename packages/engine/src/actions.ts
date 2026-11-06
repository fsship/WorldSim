import { carriedItems, inspectableItems, isPrivateSpeech, populationHere, roomDescription, readObjectAction, movementLocations, readMovement, type ActionIntent, type Character, type Observation, type DialogueLine, type PlayerInput, type StateChange, type WorldState } from "@worldsim/shared";
import { impliedListener, lastNpcLine } from "./conversation";
import { knownFacts, player, present } from "./state";
import { planReading, type ReadingPlan } from "./reading";

interface Candidate {
  id: string;
  status: "resolved" | "refused" | "uncertain";
  lines: Observation[];
  changes: StateChange[];
  minutes: number;
}
type SpeechDelivery = {private:false; privateTo?:never} | {private:true; privateTo:string};
type OrderRule = WorldState["rules"]["orders"][number];

/** A semantic plan carries resolved references, never permission to write an effect. */
export interface ActionMeaning {
  speech?: {private:boolean; courteous:boolean; targetId?:string; targetUnavailable?:boolean};
  order?: {private?:boolean; targetId:string; order?:OrderRule; summary?:string};
  discovery?: WorldState["rules"]["discoveries"][number];
  activity?: "listen" | "perform" | "general";
}

function speechTo(npc: Character, quiet: boolean): SpeechDelivery {
  return quiet ? {private:true, privateTo:npc.id} : {private:false};
}

export interface Adjudication {
  candidates: Candidate[];
  itemId?: string;
  speech?: SpeechDelivery;
  dialogue?: { npc: Character; decision: string; allowedTestimonyIds: string[]; order?: { summary:string; changes:StateChange[] } };
  askModel: boolean;
  waiting: boolean;
  eventNeedle?: string;
  reading?: ReadingPlan;
  checks: string[];
}
function line(id: string, text: string, minutes = 1, changes: StateChange[] = []): Candidate {
  return {id, lines:[{kind:"world", text}], changes, minutes, status:"resolved"};
}
function fixed(c: Candidate, ...checks: string[]): Adjudication {
  return {candidates:[c], askModel:false, waiting:false, checks};
}
function conversation(npc: Character, decision: string, id: string, changes: StateChange[], allowedTestimonyIds: string[] = [],
  order?: {summary:string; changes:StateChange[]}): Adjudication {
  return {
    candidates: [{id, lines:[], changes, minutes:2, status:"resolved"}],
    dialogue: {npc, decision, allowedTestimonyIds, order},
    askModel:false, waiting:false, checks:["对方在场且能交流", "状态变更与耗时由引擎裁决"],
  };
}
export function refused(text: string) {
  const c = line("refused", text, 0);
  c.status = "refused";
  c.lines[0].kind = "system";
  return fixed(c, text);
}

type Named = {id:string; name:string; aliases:string[]};

// Only the first direct object confers authority to use an item or detain a person.
// An entity mentioned later in a clause can be a witness, a destination, or part of a quote.
function directObject<T extends Named>(list: T[], object: string, byId: boolean) {
  const matches = list.filter(x => byId ? x.id === object : [x.name, ...x.aliases].includes(object));
  return matches.length === 1 ? matches[0] : undefined;
}

// Only explicit action clauses confer irreversible authority. Statements, quotes, hypotheticals and negations do not.
const reported = /告诉|转述|自称|宣称|声称|说道?|问道|表示|听说|想象|设想|假如|如果|假设|不(?:要|去|想|会|该|准|必|再|能|打算)|没(?:有|去|打算)|别|并非|是否|之前|曾经|昨天|[“「"？?]/;
const prefix = /^(?:(?:我(?:想要|打算|决定|准备|想|要|先)?|请|试着|尝试)\s*)+/;
const waitVerb = /^(?:原地)?(?:等候|等待|等到|等|静候|休息|小憩|休整|睡到|睡觉|歇息)/;
const secureVerb = /^(?:加强|严守|守住|封锁|封闭|核验|戒备|戒严|驻守|加派|布防|把守|看守|守卫|封住)/u;
// Only a directive to guard the location covered by the rule authorizes its
// effect. Investigating the guard or reinforcing a different room does not.
function isGuardDirective(instruction: string, keywords: string[], world: WorldState): boolean {
  let words = instruction.trim().replace(/^(?:立即|立刻|马上|务必|尽快|请|先)/u, "");
  const sites = world.locations.filter(l => [l.name, ...l.aliases].some(name => keywords.includes(name)))
    .flatMap(l => [l.name, ...l.aliases]).sort((a,b) => b.length - a.length);
  let atSite = false;
  if (/^(?:在|到|去)/u.test(words)) {
    words = words.slice(1);
    const site = sites.find(name => words.startsWith(name));
    if (!site) return false;
    atSite = true;
    words = words.slice(site.length);
  }
  const verb = words.match(secureVerb)?.[0];
  if (!verb) return false;
  const target = words.slice(verb.length);
  if (sites.includes(target)) return true;
  const site = sites.find(name => target.startsWith(name));
  const duty = site ? target.slice(site.length).replace(/^的/u, "") : target;
  return (atSite || !!site || keywords.includes(duty)) &&
    /^(?:守备|守卫|防守|警备|戒备|警戒|兵力|岗哨|卫兵|巡逻|防务|值守|布防)$/u.test(duty);
}
const overtClaim = /我(?:已经|早已|突然|现在)?(?:觉醒|获得|成了|成为|变成|拥有无敌|刀枪不入)/;
const speechVerb = /^(?:告诉|告知|说|问|询|打听|与|和|向|跟|对|交谈|攀谈|对话|套话|商谈|声明|自称|声称|招呼|问候|劝|安抚|赞扬|感谢|致谢|赞许)/;
const nonActionOpening = /^(?:告诉|告知|转述|询问|问|说|打听|交谈|声明|声称|自称|(?:并)?[不没未]|[“「『‘"'])/;

/** Prefer the longest explicit name/role and refuse ties rather than inventing a recipient. */
function directListener(people: Character[], words: string): Character | undefined {
  const matches = people.map(npc => ({
    npc, length:Math.max(0, ...[npc.name, ...npc.aliases].filter(a => words.startsWith(a)).map(a => a.length)),
  })).filter(m => m.length > 0);
  const length = Math.max(0, ...matches.map(m => m.length));
  const longest = matches.filter(m => m.length === length);
  return longest.length === 1 && !words.slice(length).startsWith("的") ? longest[0].npc : undefined;
}

// For unquoted speech the parser can recognize free-form dialogue. Its choice
// cannot override contrary evidence that the player is reporting or doing something else.
function plausibleSpeech(verb: string, people: Character[]): boolean {
  if (/[“”「」『』‘’"']/u.test(verb)) return false;
  if (readMovement(verb) || waitVerb.test(verb) ||
      readObjectAction(verb, people.flatMap(c => [c.name, ...c.aliases]))) return false;
  if (/^(?:取出|拿出|使用|拔出|掏出|攻击|拔剑|冲向|跑向|跪下|看向|推开|举起|默不作声|保持沉默|不.{0,3}(?:离开|去)|(?:如果|假如|假设|设想).{0,12}(?:我|自己).{0,6}(?:说|问|答|回复|告诉|告知))/.test(verb)) return false;
  if (/^(?:绝|并|从来)?(?:未曾|未|没有|没|不愿|不想|不会|不曾|不敢|不|拒绝)(?:打算|准备|要|再|继续)?(?:向.{1,15}|对.{1,15}|跟.{1,15})?(?:说|问|答|回复|开口|发言|告诉|告知)/.test(verb)) return false;
  const thirdPerson = ["他", "她", ...people.flatMap(npc => [npc.name, ...npc.aliases])];
  return !thirdPerson.some(name => verb.startsWith(name) &&
    /^[^，,。：:！？?!]{0,10}?(?:说|问道|回答|回复|命令|前往|走到)/.test(verb.slice(name.length)));
}

const groupNames = ["在场的所有人", "所有在场的人", "在场所有人", "在场的人们", "在场的人", "在场的各位", "在场各位",
  "在场的诸位", "在场诸位", "在场众人", "大家", "各位", "诸位", "众人", "所有人"];
type Listener = Character | "unavailable" | undefined;

function speechListener(world: WorldState, king: Character, people: Character[], line: DialogueLine | undefined,
  verb: string, privateSpeech: boolean, suggested?: string): Listener {
  const listeners = people.filter(person => person.condition === "healthy");
  const previous = impliedListener(lastNpcLine(world, king), listeners);
  // Everyone present hears ordinary speech. The responder is only the NPC offered this turn.
  const automatic = privateSpeech ? (previous ?? (listeners.length === 1 ? listeners[0] : "unavailable"))
    : previous ?? listeners[0];
  const addressed = (name: string): Listener => {
    if (groupNames.includes(name)) return privateSpeech ? "unavailable" : automatic;
    const matches = people.filter(npc => [npc.name, ...npc.aliases].includes(name));
    return matches.length === 1 && matches[0].condition !== "dead" ? matches[0] : "unavailable";
  };
  if (line) {
    if (line.addressee) return addressed(line.addressee);
    const vocative = line.text.match(/^([\p{L}·]{1,30})\s*[，,：:]/u)?.[1];
    if (vocative && (groupNames.includes(vocative) ||
      world.characters.some(person => [person.name, ...person.aliases].includes(vocative)))) return addressed(vocative);
    return automatic;
  }
  const lead = verb.split(/[，,。：:]/u, 1)[0].trim();
  if (lead !== verb && groupNames.includes(lead)) return addressed(lead);
  const address = lead.match(/^(告诉|告知|询问|问|感谢|称赞|赞扬|安抚|向|跟|对|与|和)\s*(.+)$/);
  if (address) {
    const object = address[2].trim();
    const group = groupNames.find(name => object.startsWith(name) && !object.slice(name.length).startsWith("的"));
    if (group) return addressed(group);
    if (/^(?:我|你|您|道|一下)/.test(object)) return automatic;
    const namedListener = directListener(people, object);
    if (namedListener) return namedListener.condition !== "dead" ? namedListener : "unavailable";
    // With an explicit unknown recipient we cannot substitute the previous speaker.
    // 对 also introduces a topic, as in “对这件事你怎么看？”
    if (address[1] !== "对" || (suggested && object.startsWith(suggested)) || /(?:说|讲|问|道)/.test(object))
      return "unavailable";
  }
  if (lead !== verb) {
    if (world.characters.some(npc => [npc.name, ...npc.aliases].includes(lead))) return addressed(lead);
    if (suggested === lead || /[:：]/.test(verb[lead.length])) return "unavailable";
  }
  // Without a parsed attribution, do not silently send a whisper to a guessed recipient.
  return privateSpeech ? "unavailable" : automatic;
}
function plannedListener(world: WorldState, king: Character, people: Character[], speech: NonNullable<ActionMeaning["speech"]>): Listener {
  if (speech.targetUnavailable) return "unavailable";
  if (speech.targetId) return people.find(c => c.id === speech.targetId && c.condition !== "dead") ?? "unavailable";
  if (speech.private) return "unavailable";
  const available = people.filter(c => c.condition === "healthy");
  return impliedListener(lastNpcLine(world, king), available) ?? available[0];
}

export function adjudicate(world: WorldState, text: string, intent: ActionIntent, explicit?: PlayerInput, meaning?: ActionMeaning): Adjudication {
  if (!explicit?.reading || player(world).condition !== "healthy") return singleAction(world, text, intent, explicit, meaning);
  const reading = planReading(world, explicit.reading);
  const spoken = explicit.dialogue ? singleAction(world, explicit.speechInput ?? text, intent, explicit, meaning) : undefined;
  if ("notice" in reading) {
    if (!spoken) return refused(reading.notice);
    for (const response of spoken.candidates) response.lines.push({kind:"system", text:reading.notice});
    return spoken;
  }
  const action = spoken ?? fixed({id:"read", lines:[], changes:[], minutes:0, status:"resolved"});
  // A missed addressee cannot prevent the player from looking at a local document.
  for (const response of action.candidates) {
    if (response.status === "refused") { response.status = "resolved"; response.id = "read"; }
  }
  return {...action, reading, checks:[...action.checks, "文书在场，只展示实际读到的条目"]};
}

function singleAction(world: WorldState, text: string, intent: ActionIntent, explicit?: PlayerInput, meaning?: ActionMeaning): Adjudication {
  const speechLine = explicit?.dialogue;
  const verb = meaning ? "" : text.replace(prefix, "");
  const king = player(world);
  const room = world.locations.find(l => l.id === king.locationId)!;
  const people = present(world, king);
  const facts = knownFacts(world, king);
  const hasFact = (id: string) => facts.some(f => f.id === id);
  if (king.condition !== "healthy") return refused("你现在的身体状态无法执行这项行动。");
  if (intent.kind === "assert" || (!meaning && !speechLine && overtClaim.test(text) && !speechVerb.test(verb)))
    return refused("你所声称的变化没有得到可验证的依据。");
  if (intent.kind === "move") {
    const exits = world.locations.filter(l => room.exits.includes(l.id));
    const options = exits.length ? "从" + room.name + "可直达" + exits.map(l => l.name).join("、") + "。" : room.name + "目前没有可走的出口。";
    const request = explicit?.movement;
    if (request?.kind === "compound") return refused("这一回合只能执行一次移动，请选择先去哪里。" + options);
    if (request?.kind === "ambiguous") return refused("提到了多个目的地，请选择一个。" + options);
    const suggestion = intent.target;
    if (!meaning && !request && suggestion && text.includes(suggestion) && exits.some(l => [l.name, ...l.aliases].includes(suggestion)))
      return refused("你提到了" + suggestion + "。如果要亲自过去，可以说「前往" + suggestion + "」。" + options);
    if (request?.kind !== "destination") return refused("请说明你要去哪里。" + options);
    if (request.origin && (meaning ? request.origin !== room.id :
      !["这里", "这儿", "此处", "原地"].includes(request.origin) && !movementLocations([room], request.origin).length))
      return refused("你目前在" + room.name + "，与所说的出发地不一致。" + options);
    const matches = meaning ? world.locations.filter(place => place.id === request.target) : movementLocations(world.locations, request.target);
    if (!matches.length) return refused("当前位置没有通往这个地点的出口。" + options);
    if (matches.length !== 1) return refused("这个称呼对应多个地点，请用地点全名。" + options);
    const dest = matches[0];
    if (dest.id === room.id) return refused("你已经在" + room.name + "。" + options);
    if (!room.exits.includes(dest.id)) return refused("从" + room.name + "不能直接到" + dest.name + "。" + options);
    const operation = line("travel", "你来到" + dest.name + "。", 5, [{op:"move", actor:king.id, to:dest.id}]);
    if (request.followUp) operation.lines.push({kind:"system", text:"本回合已完成移动。接下来的行动请在新地点继续。"});
    return fixed(operation, "目的地与当前位置相邻", "行动明确指定了目的地");
  }
  if (["wait", "rest", "wait_event"].includes(intent.kind)) {
    const wait = explicit?.waiting;
    if (!wait) return refused("请说明你要在当前位置等待多久，或要等什么事情发生。");
    if (wait.invalidTime) return refused("请用整分钟或有效的时刻说明等待时间，例如“五分钟”或“到八点一刻”。");
    const requested = wait.intent;
    let minutes = requested.minutes ?? world.rules.maxWait;
    if (requested.clock) {
      const [hour, minute] = requested.clock.split(":").map(Number);
      const delta = hour * 60 + minute - world.time % 1440;
      if (delta < 0 && wait.day === "今天") return refused("今天的这个时刻已经过去，请指定新的时刻。");
      minutes = wait.day === "明天" ? 1440 + delta : (delta + 1440) % 1440;
    }
    minutes = Math.min(minutes, world.rules.maxWait);
    const c = line("wait", requested.kind === "rest" ? "你在此歇息，听着四周的动静。" : "你在原处等候，留意着周围。", minutes);
    return {...fixed(c, "时长由游戏时钟计算并受单次上限约束"), waiting:true, eventNeedle:wait.eventNeedle};
  }
  if (intent.kind === "use") {
    const action = explicit?.object;
    if (action?.kind !== "use" || !action.object) return refused("请说明你要查看或使用哪件物品。");
    const inventoryOnly = !action.inspection || action.inventoryOnly;
    const candidates = inventoryOnly ? carriedItems(world, king) : inspectableItems(world, king);
    const item = directObject(candidates, action.object, !!meaning);
    if (!item) return refused(inventoryOnly ? "你身上没有这件物品。" : "这里找不到能与这个称呼唯一对应的物品。");
    const handling = action.inspection === "look" ? "你仔细端详" + item.name + "。" :
      "你拿起" + item.name + (action.inspection === "handle" ? "，仔细端详。" : "。");
    const detail = action.inspection ? item.appearance ?? item.description : item.description;
    const check = king.inventory.includes(item.id) ? "该物品已归玩家持有" : "该物品在场可查看";
    return {...fixed(line("use", handling + detail, 1), check), itemId:item.id};
  }
  if (intent.kind === "arrest") {
    const action = explicit?.object;
    if (action?.kind !== "arrest" || !action.object) return refused("请明确说出要在此拘押的对象。");
    const suspect = directObject(people, action.object, !!meaning);
    if (!suspect) return refused("在场没有能与这个称呼唯一对应的人。");
    if (suspect.condition !== "healthy") return refused("对方当前无法被拘押。");
    if (!king.abilities.includes(world.rules.arrestAuthority) || !world.rules.arrestEvidence.some(e => e.suspect === suspect.id && hasFact(e.factId)))
      return refused("你手头还缺少指向此人的可核验凭据。");
    return fixed(line("detain", "卫兵应你的王命扣住了" + suspect.name + "，等候审问。", 4, [{op:"detain", actor:suspect.id}]),
      "目标在场且可被拘押", "玩家具有王命与指向此人的证据");
  }
  if (intent.kind === "investigate") {
    const action = explicit?.object;
    if (action?.kind !== "investigate") return refused("请指出你想亲自检查的地方或物件。");
    const focus = action.object;
    const searchRoom = meaning ? focus === "room" :
      ["", "四周", "周围", "这里", "房间", "整个房间", "附近", room.name, ...room.aliases].includes(focus);
    const clue = world.rules.discoveries.find(d => {
      if (d.locationId !== room.id || hasFact(d.factId)) return false;
      const fact = world.facts.find(f => f.id === d.factId);
      if (!fact || fact.createdAt > world.time || (fact.type !== "clue" && fact.type !== "public")) return false;
      if (meaning) return searchRoom ||
        (meaning.discovery?.locationId === d.locationId && meaning.discovery.factId === d.factId);
      return searchRoom || d.objects.includes(focus) || (!d.objects.length && focus.length >= 2 && fact.source.endsWith(focus));
    });
    if (!clue) return fixed(line("inspect", searchRoom ? "你仔细查看了四周。" + room.description :
      "你在" + room.name + "检查了所指的地方，没有发现新的线索。", 3), "仅检查当前位置");
    const f = world.facts.find(f => f.id === clue.factId);
    if (!f) throw new Error("调查线索无效。");
    return fixed(line("discover", clue.description + f.content.text, 4, [{op:"learn", actor:king.id, fact:f.id}]), "证据在可观察的地点");
  }
  if (intent.kind === "order") {
    let npc: Character | undefined;
    let order: OrderRule | undefined;
    let quiet: boolean;
    if (meaning) {
      const planned = meaning.order;
      if (!planned) return refused("请说出你现在要下达的指令。");
      npc = people.find(c => c.id === planned.targetId);
      const selected = planned.order;
      order = selected && world.rules.orders.find(rule => rule.npcId === planned.targetId && rule.npcId === selected.npcId &&
        rule.flag === selected.flag && rule.id === selected.id);
      quiet = planned.private === true;
    } else {
      const action = explicit?.object;
      if (action?.kind !== "order") return refused("请说出你现在要下达的指令。");
      const command = action.object;
      npc = directListener(people, command);
      if (npc) {
        const recipientId = npc.id;
        const name = [npc.name, ...npc.aliases].filter(alias => command.startsWith(alias))
          .sort((a, b) => b.length - a.length)[0];
        const instruction = command.slice(name.length).replace(/^[\s，,：:]+/, "")
          .split(/[，,；;。]|然后|随后|接着/, 1)[0];
        order = world.rules.orders.find(o => o.npcId === recipientId && isGuardDirective(instruction, o.keywords, world));
      }
      quiet = isPrivateSpeech(text);
    }
    if (!npc) return refused("请明确指出要向哪位在场的人下达命令。");
    if (npc.condition !== "healthy") return refused("对方目前无法执行这项命令。");
    const summary = order?.summary ?? meaning?.order?.summary ?? "传达国王交付的命令";
    const resolution = !king.abilities.includes(world.rules.arrestAuthority) || !order || typeof world.variables[order.flag] !== "boolean"
      ? conversation(npc, "收到了命令；本回合没有落实新的安排。", "clarify", [])
      : conversation(npc, "国王向你下令：" + summary + "。命令尚未执行。", "order", [], [],
        {summary, changes:[{op:"flag", name:order.flag, value:true}]});
    return {...resolution, speech:speechTo(npc, quiet)};
  }
  if (intent.kind === "speak") {
    const planned = meaning?.speech;
    if (meaning ? !planned : !speechLine && !plausibleSpeech(verb, people)) return refused("请明确你的发言或行动。");
    const privateSpeech = planned ? planned.private : isPrivateSpeech(text);
    const npc = planned ? plannedListener(world, king, people, planned) :
      speechListener(world, king, people, speechLine, verb, privateSpeech, intent.target);
    if (!npc || npc === "unavailable" || npc.condition === "detained") {
      if (privateSpeech && (!npc || npc === "unavailable")) return refused("请指明你要向哪位在场的人私语。");
      const note = npc ? "你说出了这句话，你称呼的人没有回应。" : "你说出了这句话，附近没有人应声。";
      const c = line("speak", note, 2);
      c.lines[0].kind = "system";
      return {...fixed(c, "发言已传到在场听者，没有指定其他角色代答"),
        speech:npc && npc !== "unavailable" ? speechTo(npc, privateSpeech) : {private:false}};
    }

    const known = knownFacts(world, npc);
    const trust = npc.relations[king.id] ?? 0;
    const allowedTestimonyIds = world.rules.testimonies
      .filter(t => t.npcId === npc.id && trust >= t.minTrust && known.some(f => f.type === "clue" && f.id === t.factId))
      .map(t => t.factId);

    // A positive relationship change requires an explicit courtesy from the player.
    // Merely mentioning gratitude, including in a negation, grants no trust.
    const courtesy = planned ? planned.courteous : /^(?:感谢|谢谢|多谢|称赞|赞许|赞扬|安抚|慰问|致谢)/.test(speechLine?.text ?? verb);
    const changes: StateChange[] = courtesy ? [{op:"relation", actor:npc.id, other:king.id, delta:1}] : [];
    return {...conversation(npc, "双方正在此地交谈。", "conversation", changes, allowedTestimonyIds),
      speech:speechTo(npc, privateSpeech)};
  }
  // A mistaken fallback classification does not turn speech or a negation into a physical action.
  if (!meaning && (nonActionOpening.test(verb) || (intent.kind === "attempt" && reported.test(text))))
    return refused("请明确你此刻想亲自尝试的行动。");
  if (intent.kind === "look") {
    const gathered = people.map(c => c.role + "·" + c.name).join("、");
    const others = gathered ? gathered + "也在这里。" : populationHere(world,room.id).length ? "" : "这里没有其他人。";
    return fixed(line("observe", "你眼前是" + room.name + "。" + roomDescription(world,room) + others, 0));
  }
  if (meaning ? meaning.activity === "listen" : /^(?:屏息|静下心|仔细|侧耳|停下来)?(?:聆听|倾听|听听|听)/.test(verb)) {
    const c = line("listen-room", "你静下心来。" + room.ambience, 1);
    return { candidates:[c, line("listen-quiet", "你凝神听了一会儿，只辨得近处的动静。", 1)], askModel:true, waiting:false,
      checks:["只能听取当前位置的环境音"] };
  }
  if (meaning ? meaning.activity === "perform" : /^(?:练习|试着|试一试|试)?(?:吟唱|试唱|唱|朗诵|朗读|演讲)/.test(verb)) {
    const success = king.attributes.diplomacy >= 3 && people.some(c => c.condition === "healthy");
    const c = line("voice", success ? "你的声音在" + room.name + "里响起。近处有人朝你望来，安静听完了这一段。" : "你的声音在" + room.name + "里响起，最后一个音节慢慢消散。", 2);
    return {candidates:[c, line("hesitate", "你试了第一个音，气息一时没有跟上。", 1)], askModel:true, waiting:false,
      checks:["声音来自玩家明确尝试的活动", "结果考虑在场听者与表达属性"]};
  }
  // Free-form activities remain possible without a skill entry. Ambiguous attempts cannot create durable facts.
  const candidates = [line("partial", "眼下只有初步的迹象，结果尚未明朗。", 2), line("unclear", "眼前的动静一时难以判断。", 2)];
  candidates[1].status = "uncertain";
  if (king.attributes.observation < 2) candidates.shift();
  return { candidates, askModel:true, waiting:false, checks:["开放行动仅允许低风险、可观察的即时反馈"] };
}
