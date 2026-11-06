import { arrivalCharacter, WorldStateSchema, type Character, type ReadableDocument, type WorldFact, type ScheduledEvent, type WorldState } from "@worldsim/shared";
import { createCustomScenario, lighthouse } from './authored';
export { ScenarioDefinitionSchema, type ScenarioDefinition } from '@worldsim/shared';
export { createCustomScenario } from './authored';

export const BUILTIN_SCENARIOS = [
  {id:'palace', title:'王宫疑云', description:'晨会将在一刻钟后开始。你是国王，卫队长与宫廷侍从已在议事厅候命。'},
  {id:'lighthouse', title:lighthouse.title, description:'海雾封住航道。你是灯塔的值班员，得赶在渡船进港前查明灯号。'},
] as const;

export function createBuiltinScenario(scenarioId:string, gameId:string): WorldState {
  switch (scenarioId) {
    case 'palace': return createPalace(gameId);
    case 'lighthouse': return createCustomScenario(scenarioId, gameId, lighthouse);
    default: throw new Error('找不到这个内置剧本。');
  }
}

function morningAgenda(): ReadableDocument {
  return {
    id:"morning-agenda", locationId:"hall", name:"朝会议程", preparedBy:"steward",
    aliases:["议程", "议程单", "议程表", "晨会议程", "朝会议程表", "长桌", "桌子", "桌面"],
    entries:[
      {title:"官员点名", text:"由侍从照着名册唱名。到场的官员记在正栏，空着的席位留到会末再点一次。"},
      {title:"宫门交班", text:"请卫队长呈上交接簿，逐岗核对夜班与晨班的当值人、交班时刻。"},
      {title:"各部呈报", text:"各部依次呈上奏件。需当场裁定的另列一页，其余记下承办人，留待散会后办理。"},
    ],
  };
}

interface PalaceDelivery {
  eventId:string;
  locationId:string;
  at:number;
  notice:string;
  documents:Omit<ReadableDocument, "availableAfterEvent" | "locationId">[];
}

const palaceDeliveries: PalaceDelivery[] = [{
  eventId:"dispatch", locationId:"hall", at:512, notice:"门口的侍卫呈上宫门的交接簿，请你在晨会结束前过目。",
  documents:[{
    id:"gate-handover-log", name:"宫门交接簿", aliases:["交接簿", "宫门的交接簿"],
    entries:[
      {title:"正门岗", text:"八时整，夜班一号卫兵将门钥匙一串交给晨班三号卫兵。两人当面点清，在交班栏和接班栏各画了押。"},
      {title:"门楼岗", text:"八时一刻，晨班四号卫兵接替夜班二号卫兵。灯笼两盏、号角一支，逐件照数交接。"},
    ],
  }],
}];

function deliveredDocuments({eventId, locationId, documents}: PalaceDelivery): ReadableDocument[] {
  return documents.map(document => ({...structuredClone(document), locationId, availableAfterEvent:eventId}));
}

function originalPalaceLocations(): WorldState["locations"] {
  return [
    { id: "hall", name: "议事厅", aliases: ["王宫", "大殿", "议政厅"], description: "晨光落在长桌的朝会议程上，高窗外传来卫兵交班的脚步声。", ambience: "高窗外，卫兵交班的脚步声由近而远。", exits: ["archive", "gate", "garden"] },
    { id: "archive", name: "档案室", aliases: ["书房", "档案馆"], description: "一排排卷宗列在木架上，摊开的值夜登记簿正等人查阅。", ambience: "窗缝里有风，书页在桌面轻轻翻动。", exits: ["hall", "garden"] },
    { id: "gate", name: "宫门", aliases: ["城门", "王宫大门", "宫门前"], description: "门楼下摆着换岗的长凳，铁门通向城中。", ambience: "铁门外传来车轮碾过石路的声音。", exits: ["hall", "garden"] },
    { id: "garden", name: "王宫花园", aliases: ["花园", "庭院"], description: "石子路穿过柏树篱，另一端的小门通往档案室。", ambience: "风从柏树篱间穿过，带起轻微的沙沙声。", exits: ["hall", "archive", "gate"] },
  ];
}

function openRiverRoad(rooms: WorldState["locations"]) {
  const gate = rooms.find(room => room.id === "gate")!;
  gate.exits.push("post-road");
  gate.description += "顺着门外的驿道，可以到河谷巡察。";
  rooms.push(
    {id:"post-road", name:"宫外驿道", aliases:["驿道","官道","驿路"],
      description:"驿道沿河而行。背后的门楼仍看得见，前方的里程石指向河谷村。",
      ambience:"河风掠过道旁的柳梢。", exits:["gate","river-village"]},
    {id:"river-village", name:"河谷村", aliases:["河谷村庄","村口"],
      description:"驿道在石桥前分成两岔，路牌上一面写着宫门，一面写着河谷行宫。沿河是一排砖瓦民居。",
      ambience:"岸边传来汲水的声音。", exits:["post-road","river-palace"]},
    {id:"river-palace", name:"河谷行宫", aliases:["行宫","巡察行宫","离宫"],
      description:"行宫的小朝房临水开窗，窗外是河谷的田地。石阶下的回程路通往河谷村。",
      ambience:"廊下的竹帘随风轻响。", exits:["river-village"]},
  );
}

function palaceLocations(): WorldState["locations"] {
  const rooms = originalPalaceLocations();
  openRiverRoad(rooms);
  return rooms;
}

function palacePopulation(): WorldState["populationGroups"] {
  return [
    {id:"court-officials",name:"各部属官",size:18,homeId:"archive",
      work:{locationId:"hall",task:"参加晨会点名与呈报",from:495,by:525,leave:570,homeBy:590}},
    {id:"valley-residents",name:"河谷居民",size:240,homeId:"river-village",
      work:{locationId:"post-road",task:"赶早集、交接货物",from:480,by:540,leave:630,homeBy:660,repeatEvery:1440}},
  ];
}

/** Add the route only to the exact original map. A custom gate, an intentional
 * partial map or an existing settlement must retain its own terrain and exits. */
function upgradePalaceLocations(rooms: WorldState["locations"]) {
  const original = originalPalaceLocations();
  if (rooms.length !== original.length) return;
  const stock = original.every(old => {
    const room = rooms.find(r => r.id === old.id);
    return room && room.name === old.name && room.description === old.description && room.ambience === old.ambience &&
      room.exits.length === old.exits.length && old.exits.every(exit => room.exits.includes(exit)) &&
      room.aliases.length === old.aliases.length && old.aliases.every(alias => room.aliases.includes(alias));
  });
  if (stock) openRiverRoad(rooms);
}

const sealDescription = "一枚可用于核验王命的黄铜印玺。";
const sealAppearance = "印玺是黄铜铸的，四周的棱角已经磨亮。印面上，阴刻的笔画凹进铜里。";
const guardOrder = {id:"secure-gate", summary:"加强宫门守备"};
const ledgerSubject = {name:"值夜登记簿", aliases:["卷宗", "登记簿"]};
const heldGateNews = "晨会通报传遍王宫：两份相互矛盾的调防令已被扣下，宫门仍由原班卫队守护。";
const changedGateNews = "晨会通报传遍王宫：新来的兵士接管了宫门。卫队长要求彻查那份临时调防令。";

function gateWatch(relieved: boolean): NonNullable<ScheduledEvent["arrival"]> {
  return {id:relieved ? "relief-watch" : "original-watch", name:relieved ? "接防卫兵" : "原班卫兵",
    role:"宫门守卫", aliases:["值守卫兵","守门卫兵","卫兵"], locationId:"gate",
    publicDuty:"代表此刻在宫门执勤的卫兵。留守岗哨、查验出入，并回应在场者的询问。"};
}

function assignCourtBusiness(characters: Character[]) {
  const assignments = [
    {id:"minister", name:"维克多", task:"出席晨会，呈报待裁的公文。"},
    {id:"scribe", name:"诺亚", task:"到晨会点名，负责记录各部呈报。"},
  ];
  for (const {id,name,task} of assignments) {
    const actor = characters.find(c => c.kind === "npc" && c.id === id && c.name === name);
    if (actor && actor.appointments === undefined)
      actor.appointments = [{from:495, until:570, locationId:"hall", task}];
  }
}

/** Add authored defaults absent from older saves without changing custom scene content. */
export function loadScenarioWorld(saved: unknown): WorldState {
  const world = WorldStateSchema.parse(saved);
  // Older scenarios marked searchable objects with aliases only. Import just
  // those names already visible in the room prose, never the hidden clue.
  for (const rule of world.rules.discoveries) {
    if (rule.visibleSubject) continue;
    const room = world.locations.find(l => l.id === rule.locationId);
    const visible = rule.objects.filter(name => room?.description.includes(name)).sort((a,b) => b.length-a.length);
    if (visible.length) rule.visibleSubject = {name:visible[0], aliases:visible.slice(1)};
  }
  if (world.scenario !== "王宫疑云" || (world.scenarioId && world.scenarioId !== 'palace')) return world;
  world.scenarioId = 'palace';
  upgradePalaceLocations(world.locations);
  if (!Object.hasOwn(saved as object,"populationGroups")) {
    const defaults = palaceLocations();
    const usesStockPlace = (id:string) => world.locations.some(l =>
      l.id === id && defaults.some(original => original.id === l.id && original.name === l.name && original.description === l.description));
    world.populationGroups = palacePopulation().filter(g => usesStockPlace(g.homeId) && usesStockPlace(g.work.locationId));
  }
  if (world.locations.some(l => l.id === "hall")) assignCourtBusiness(world.characters);
  // A stock older save may already have published this report. Materialize only
  // the watch confirmed by that report, at its last known post, without replaying time.
  if (world.locations.some(l => l.id === "gate")) {
    for (const e of world.queue) {
      if (e.arrival || e.type !== "notice" || !e.important || e.perception !== "public") continue;
      if (e.id !== "breach" || e.text !== changedGateNews) {
        if (e.id !== "intercepted" || e.text !== heldGateNews) continue;
      }
      const arrival = gateWatch(e.id === "breach");
      if (world.characters.some(c => c.id === arrival.id)) continue;
      e.arrival = arrival;
      const report = world.facts.find(f => f.id === "notice/" + e.id);
      if (e.status === "executed" && report) {
        const watch = arrivalCharacter(arrival);
        world.characters.push(watch);
        watch.knownFactIds.push(report.id);
        if (!report.knownBy.includes(watch.id)) report.knownBy.push(watch.id);
      }
    }
  }
  const hasHall = world.locations.some(location => location.id === "hall");
  const original = morningAgenda();
  if (hasHall && !Object.hasOwn(saved as object, "readables")) world.readables = [original];
  const agenda = world.readables.find(doc => doc.id === original.id && doc.name === original.name && doc.locationId === original.locationId);
  if (agenda && agenda.entries.length === original.entries.length &&
      agenda.entries.every((e,i) => e.title === original.entries[i].title && e.text === original.entries[i].text)) {
    if (agenda.preparedBy === undefined) agenda.preparedBy = original.preparedBy;
    // The former stock collection consisted of this agenda alone. Restore the
    // bundle from each authored delivery whose notice is present in this save.
    if (hasHall && world.readables.length === 1 && agenda.preparedBy === original.preparedBy && !agenda.availableAfterEvent &&
        agenda.aliases.length === original.aliases.length && original.aliases.every(alias => agenda.aliases.includes(alias))) {
      for (const delivery of palaceDeliveries) {
        const hasNotice = world.queue.some(e => e.id === delivery.eventId && e.type === "notice" &&
          e.perception === "local" && e.locationId === delivery.locationId && e.text === delivery.notice);
        if (hasNotice && world.locations.some(l => l.id === delivery.locationId)) world.readables.push(...deliveredDocuments(delivery));
      }
    }
  }
  const seal = world.items.find(item => item.id === "seal" && item.name === "王室印玺" && item.description === sealDescription);
  if (seal && seal.appearance === undefined) seal.appearance = sealAppearance;
  const guard = world.rules.orders.find(rule => rule.npcId === "captain" && rule.flag === "guardSecured");
  if (guard && guard.id === undefined && guard.summary === undefined) Object.assign(guard, guardOrder);
  return world;
}

// Public assignments may be shared with a decision provider. Personal goals and plans stay in the world.
const publicDuties: Record<string, string> = {
  steward: "在议事厅接待国王，备好朝会议程。",
  captain: "负责宫门的日常值守并传达守备命令。",
  minister: "经手宫廷公文与用印。",
  scribe: "保管档案，协助查阅登记簿。",
  messenger: "递送宫门与议事厅之间的消息。",
  warden: "在庭院巡视，协助值勤。",
};

function courtier(id: string, name: string, role: string, locationId: string, goals: string[], aliases: string[] = []): Character {
  return {
    id, kind: "npc", name, role, locationId, aliases: [role, ...aliases], publicDuty: publicDuties[id], goals,
    condition: "healthy", attributes: { observation: 2, diplomacy: 2 }, abilities: [],
    inventory: [], knownFactIds: [], relations: { king: 0 }, plans: [],
  };
}

function fact(id: string, type: WorldFact["type"], text: string, entities: string[], source: string, knownBy: string[]): WorldFact {
  return { id, type, content: { text }, entities, source, createdAt: 465, knownBy };
}

function scheduled(id: string, at: number, text: string, body: Partial<ScheduledEvent> = {}): ScheduledEvent {
  return {
    id, at, text, type: "notice", entities: [], status: "pending", important: true,
    condition: {}, locationId: "hall", perception: "public", recipients: [], effects: [], ...body,
  };
}

export function createPalace(gameId: string): WorldState {
  const king = courtier("king", "国王", "国王", "hall", ["守护王宫与臣民"]);
  king.kind = "player";
  king.inventory = ["seal"];
  king.abilities = ["王命"];
  king.relations = {};
  king.attributes = { observation: 3, diplomacy: 4 };
  const characters = [
    king,
    courtier("steward", "艾琳", "宫廷侍从", "hall", ["让晨会如期进行"], ["侍从"]),
    courtier("captain", "罗兰", "卫队长", "hall", ["使宫门守备完备"], ["卫兵", "卫队"]),
    courtier("minister", "维克多", "掌玺大臣", "archive", ["以伪诏调离宫门卫队"], ["大臣", "掌玺官"]),
    courtier("scribe", "诺亚", "档案官", "archive", ["让登记簿里留下真实记录"], ["书记官"]),
    courtier("messenger", "米拉", "信使", "gate", ["将口信递给可靠的人"]),
    courtier("warden", "尤安", "副官", "garden", ["替大臣接应密使"]),
  ];
  assignCourtBusiness(characters);
  const facts = [
    fact("assembly", "public", "今日的晨会将在议事厅举行。", ["hall"], "公开议程", characters.map(c => c.id)),
    fact("ledger", "clue", "值夜登记簿里，一份带掌玺大臣维克多署名的调防令缺了应有的副署。", ["minister", "archive"], "值夜登记簿", ["scribe", "minister"]),
    fact("duplicate", "clue", "信使米拉见过两份编号相同、内容却不同的宫门调防令。", ["minister", "messenger"], "信使所见", ["messenger"]),
    fact("plot", "secret", "维克多与尤安约定在晨会后用伪诏换走宫门卫队。", ["minister", "warden"], "密室约定", ["minister", "warden"]),
  ];
  for (const c of characters) {
    c.knownFactIds = facts.filter(f => f.knownBy.includes(c.id)).map(f => f.id);
    if (c.id === "minister" || c.id === "warden") c.plans = ["switch"];
  }
  const opening = "晨光穿过议事厅的高窗。长桌上摊着今日的朝会议程，王室印玺就在你的手边。卫队长与宫廷侍从立在阶下，等候你的吩咐。";
  const queue = [
    scheduled("bell", 495, "一阵钟声掠过长廊。晨会即将开始，议事厅的门已经敞开。", { perception: "audible" }),
    ...palaceDeliveries.map(({eventId, at, notice, locationId}) =>
      scheduled(eventId, at, notice, {perception:"local", locationId})),
    scheduled("switch", 530, "一份调防令递到门房，旧班卫队开始撤岗。", {
      type: "plan", entities: ["minister", "warden"], locationId: "gate", perception: "local", important: false,
      condition: { activeActor: "minister", knows: "plot", flag: "guardSecured", equals: false },
      effects: [{ op: "flag", name: "sealSwapped", value: true }],
    }),
    scheduled("intercepted", 531, heldGateNews, {
      arrival:gateWatch(false),
      entities: ["gate"], condition: { flag: "sealSwapped", equals: false }, effects: [{ op: "flag", name: "outcome", value: "intercepted" }],
    }),
    scheduled("breach", 531, changedGateNews, {
      arrival:gateWatch(true),
      entities: ["gate"], condition: { flag: "sealSwapped", equals: true }, effects: [{ op: "flag", name: "outcome", value: "breach" }],
    }),
  ];
  return WorldStateSchema.parse({
    id: gameId, scenario: "王宫疑云", scenarioId:'palace', version: 0, time: 480, characters, facts, queue,
    readables:[morningAgenda(), ...palaceDeliveries.flatMap(deliveredDocuments)],
    rules: {
      maxWait: 720, maxShort: 10,
      discoveries: [{ locationId: "archive", factId: "ledger", visibleSubject:ledgerSubject, objects: ["登记簿", "值夜登记簿", "摊开的登记簿", "案卷", "卷宗", "档案", "交接簿"], description: "你沿着登记簿逐行核对，辨出了那一处缺失的副署。" }],
      testimonies: [
        { npcId: "scribe", factId: "ledger", minTrust: 0 },
        { npcId: "messenger", factId: "duplicate", minTrust: 1 },
      ],
      orders: [{ ...guardOrder, npcId: "captain", keywords: ["宫门", "守备", "调防", "换防", "布防", "戒备", "戒严", "加强守卫"], flag: "guardSecured" }],
      arrestAuthority: "王命", arrestEvidence: [{factId: "ledger", suspect: "minister"}, {factId: "duplicate", suspect: "minister"}],
    },
    locations:palaceLocations(), populationGroups:palacePopulation(),
    items: [{ id: "seal", name: "王室印玺", aliases: ["印玺", "王印"], description: sealDescription, appearance:sealAppearance }],
    variables: { guardSecured: false, sealSwapped: false, outcome: "pending" },
    history: [
      { id: "opening-1", source: "opening", time: 480, kind: "world", text: opening, perception: "public", locationId: "hall", recipients: ["king"], changes: [] },
      { id: "opening-2", source: "opening", time: 480, kind: "npc", speaker: "宫廷侍从·艾琳", speakerId: "steward", text: "陛下，各处的晨报已经送到。您想先听哪一件？", perception: "local", locationId: "hall", recipients: ["king"], changes: [] },
    ],
  });
}
