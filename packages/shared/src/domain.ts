import { z } from "zod";
import { sceneValueSchema, ActionIntentSchema, DialogueVerdictSchema, PendingWaitSchema, PublicTurnSchema, TurnPlanSchema } from "./contracts";
import { PopulationGroupSchema } from "./population";

const id = z.string().min(1);
const minute = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const lineKind = z.enum(["world", "npc", "system"]);
const vars = z.record(z.string(), z.union([z.string(), z.boolean(), z.number().finite()]));

export const locationSchema = z.object({
  id, name: id, aliases: z.array(id), description: id, ambience: id, exits: z.array(id),
}).strict();

const sceneObject = {id, name:id, aliases:z.array(id), availableAfterEvent:id.optional()};
export const readableDocumentSchema = z.object({
  ...sceneObject, locationId:id, preparedBy:id.optional(),
  entries: z.array(z.object({ title: id, text: id }).strict()).min(1),
}).strict();
export type ReadableDocument = z.infer<typeof readableDocumentSchema>;

export const characterSchema = z.object({
  id, kind: z.enum(["player", "npc"]), name: id, aliases: z.array(id), role: id, publicDuty: id.optional(), locationId: id,
  journey:z.object({to:id, arrivesAt:minute}).strict().optional(),
  condition: z.enum(["healthy", "detained", "dead"]),
  attributes: z.record(z.string(), z.number().int().min(0).max(10)),
  abilities: z.array(id), inventory: z.array(id), knownFactIds: z.array(id),
  relations: z.record(z.string(), z.number().int().min(-5).max(5)),
  goals: z.array(id), plans: z.array(id),
  appointments:z.array(z.object({
    from:minute, until:minute, locationId:id, task:id.max(300),
  }).strict().refine(a => a.until > a.from, "公务结束时间必须晚于开始时间")).optional(),
}).strict();
export type Character = z.infer<typeof characterSchema>;

export const worldFactSchema = z.object({
  id, type: z.enum(["public", "clue", "secret", "outcome"]),
  content: z.object({ text: id }).strict(), entities: z.array(id), source: id,
  createdAt: minute, knownBy: z.array(id),
}).strict();
export type WorldFact = z.infer<typeof worldFactSchema>;

const flagChange = z.object({ op: z.literal("flag"), name: id, value: z.union([z.boolean(), z.string(), z.number().finite()]) }).strict();
const visibility = z.enum(["local", "audible", "addressed", "public", "private"]);
const arrivalSchema = z.object({id, name:id, role:id, locationId:id, publicDuty:id.max(240), aliases:z.array(id)}).strict();

export function arrivalCharacter(spec: z.infer<typeof arrivalSchema>): Character {
  return {...spec, aliases:[...spec.aliases], kind:"npc", condition:"healthy", attributes:{observation:2,diplomacy:1},
    abilities:[], inventory:[], knownFactIds:[], relations:{}, goals:[], plans:[]};
}

export const scheduledEventSchema = z.object({
  id, at: minute, type: z.enum(["notice", "plan"]), entities: z.array(id),
  status: z.enum(["pending", "executed", "cancelled"]),
  condition: z.object({ activeActor: id.optional(), knows: id.optional(), presentAt: id.optional(), flag: id.optional(), equals: z.boolean().optional() }).strict(),
  locationId: id, perception: visibility, recipients: z.array(id),
  important: z.boolean(), text: id, effects: z.array(flagChange), arrival:arrivalSchema.optional(),
}).strict();
export type ScheduledEvent = z.infer<typeof scheduledEventSchema>;

export const stateChangeSchema = z.discriminatedUnion("op", [
  z.object({op:z.literal("openingAssets"),locationId:id,assets:z.array(z.object({scope:z.enum(["held","scene"]),name:id,value:id}).strict()).max(32)}).strict(),
  z.object({op:z.literal("sceneStep"), locationId:id, sets:z.array(sceneValueSchema).max(4), clears:z.array(sceneValueSchema).max(4).optional()}).strict(),
  z.object({op:z.literal("depart"), actor:id, to:id, arrivesAt:minute}).strict(),
  z.object({ op:z.literal("discoverPlace"), from:id, to:id, name:z.string().trim().min(1).max(80) }).strict(),
  z.object({ op: z.literal("move"), actor: id, to: id, using:id.optional() }).strict(),
  z.object({ op:z.literal("meet"), group:id, locationId:id }).strict(),
  z.object({
    op:z.literal("encounter"), locationId:id, trigger:z.enum(["opening", "arrival", "contact", "event"]), cue:id.optional(),
    witnessedEventIds:z.array(id).max(256).optional(),
    person:z.object({id, name:id.max(60), role:id.max(60), duty:id.max(240), goal:id.max(240).optional()}).strict().optional(),
  }).strict(),
  z.object({ op: z.literal("relation"), actor: id, other: id, delta: z.number().int().min(-1).max(1) }).strict(),
  z.object({ op: z.literal("detain"), actor: id }).strict(),
  z.object({ op: z.literal("learn"), actor: id, fact: id }).strict(),
  flagChange,
  z.object({ op: z.literal("event"), event: id, status: z.enum(["executed", "cancelled"]) }).strict(),
  z.object({ op: z.literal("announce"), event: id }).strict(),
  z.object({ op: z.literal("muster"), event: id }).strict(),
  z.object({ op: z.literal("schedule"), definition: scheduledEventSchema }).strict(),
  z.object({ op: z.literal("reschedule"), event: id, at: minute }).strict(),
  z.object({ op: z.literal("clock"), to: minute }).strict(),
]);
export type StateChange = z.infer<typeof stateChangeSchema>;

export const worldEventSchema = z.object({
  id, time: minute, source: id, kind: lineKind, text: id, speaker: id.optional(), speakerId: id.optional(),
  reportedFactIds: z.array(id).optional(),
  spokenInput: z.string().max(2000).optional(),
  bookmark: z.object({ documentId: id, nextIndex: z.number().int().nonnegative() }).strict().optional(),
  observedItemId: id.optional(),
  pendingWait: PendingWaitSchema.optional(),
  utterance: z.object({ speakerId: id, listenerIds: z.array(id), private: z.boolean().optional(),
    groups:z.array(z.object({groupId:id, name:id, count:z.number().int().positive(), firstSlot:z.number().int().positive().optional()}).strict()).optional(),
  }).strict().optional(),
  noticeWitnessIds: z.array(id).optional(),
  dialogueSource: z.enum(["provider", "fallback"]).optional(),
  replyToFailureId: id.optional(),
  npcAction: z.object({
    actorId: id, kind: z.enum(["stay", "speak", "move", "inspect", "gesture", "act", "carryOutOrder"]),
    source: z.enum(["provider", "fallback"]), trigger: z.enum(["opening", "addressed", "ambient"]).optional(),
    witnessIds: z.array(id).optional(),
    otherSide: z.object({ locationId:id, text:id, witnessIds:z.array(id) }).strict().optional(),
    worldPulse: z.literal(true).optional(),
    regional: z.literal(true).optional(),
  }).strict().optional(),
  npcFailure: z.enum(["encounter", "decision", "generation", "validation", "review", "review_unavailable"]).optional(),
  npcReview: DialogueVerdictSchema.optional(),
  perception: visibility,
  locationId: id, recipients: z.array(id), changes: z.array(stateChangeSchema),
}).strict();
export type WorldEvent = z.infer<typeof worldEventSchema>;

const discoverySchema = z.object({
  locationId: id, factId: id, description: id, objects: z.array(id).default([]),
  visibleSubject: z.object({name:id, aliases:z.array(id)}).strict().optional(),
}).strict();
const testimonySchema = z.object({
  npcId: id, factId: id, minTrust: z.number().int().min(-5).max(5),
}).strict();
const orderSchema = z.object({
  npcId: id, keywords: z.array(id).min(1), flag: id, response: id.optional(), id: id.optional(), summary: id.optional(),
}).strict();

export const worldStateSchema = z.object({
  id, scenario: id, scenarioId:id.optional(), version: z.number().int().nonnegative(), time: minute,
  worldInfo:z.string().trim().min(1).max(2000).optional(),
  rules: z.object({
    maxWait: z.number().int().min(1).max(1440), maxShort: z.number().int().min(1).max(30),
    useNpcGoals:z.boolean().optional(),
    discoveries: z.array(discoverySchema), testimonies: z.array(testimonySchema),
    orders: z.array(orderSchema), arrestAuthority: id, arrestEvidence: z.array(z.object({ factId: id, suspect: id }).strict()),
  }).strict(),
  locations: z.array(locationSchema), characters: z.array(characterSchema),
  populationGroups:z.array(PopulationGroupSchema).refine(groups => new Set(groups.map(g => g.id)).size === groups.length,
    "群体标识重复").default([]),
  readables: z.array(readableDocumentSchema)
    .refine(documents => new Set(documents.map(document => document.id)).size === documents.length, "文书标识重复")
    .default([]),
  items: z.array(z.object({ ...sceneObject, locationId:id.optional(), description:id, appearance:id.optional() }).strict()),
  facts: z.array(worldFactSchema), queue: z.array(scheduledEventSchema),
  sceneState:z.array(sceneValueSchema.extend({locationId:id, objectId:id.optional()})).default([]),
  history: z.array(worldEventSchema), variables: vars,
}).strict();
export type WorldState = z.infer<typeof worldStateSchema>;

export const GameTurnSchema = PublicTurnSchema.extend({
  intent: ActionIntentSchema,
  plan: TurnPlanSchema.optional(),
  resolution: z.object({
    status: z.enum(["resolved", "refused", "uncertain"]), optionId: id,
    preconditions: z.array(z.string()),
  }).strict(),
  events: z.array(worldEventSchema), changes: z.array(stateChangeSchema),
}).strict();
export type GameTurn = z.infer<typeof GameTurnSchema>;
export const WorldStateSchema = worldStateSchema;
export const CharacterSchema = characterSchema;
export const WorldFactSchema = worldFactSchema;
export const StateChangeSchema = stateChangeSchema;
export const ScheduledEventSchema = scheduledEventSchema;
