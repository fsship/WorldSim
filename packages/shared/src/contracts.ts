import { z } from 'zod';
import { quoteSpans, readSegmentedSpeech } from './speech';

const nonempty = z.string().min(1);
const minute = z.number().int().safe().nonnegative();
export const ActionTextSchema = z.string().trim().min(1).max(2000);
const referenceText = z.string().trim().min(1).max(160);
export const ActionIntentSchema = z.object({
  kind: z.enum(['look', 'move', 'speak', 'investigate', 'order', 'arrest', 'use', 'wait', 'rest', 'wait_event', 'assert', 'attempt']),
  target: z.string().min(1).max(160).optional(),
  item: z.string().min(1).max(160).optional(),
  minutes: minute.optional(),
  clock: z.string().regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/).optional(),
}).strict();
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

export const ObservationSchema = z.object({
  kind: z.enum(['world', 'dialogue', 'system']), text: nonempty, speaker: nonempty.optional(), time: minute.optional(),
}).strict();
export type Observation = z.infer<typeof ObservationSchema>;
export const PublicTurnSchema = z.object({
  version: minute, input: ActionTextSchema, startTime: minute, endTime: minute,
  hearing: z.object({ volume: z.enum(['room', 'private']), listeners: z.array(nonempty),
    groups:z.array(z.object({name:nonempty,count:z.number().int().positive()}).strict()).optional() }).strict().optional(),
  replyRetry: z.object({ observation:minute, speaker:nonempty }).strict().optional(),
  observations: z.array(ObservationSchema), narrative: nonempty,
}).strict();
export type PublicTurn = z.infer<typeof PublicTurnSchema>;
const entity = z.object({ id: nonempty, name: nonempty }).strict();
export const PublicStateSchema = z.object({
  id: nonempty, title: nonempty, time: minute, version: minute, opening: nonempty,
  openingUsedFallback: z.boolean().optional(),
  openingRetryable: z.boolean().optional(),
  openingNotice: z.string().optional(),
  location: entity.extend({ description: nonempty, population:z.array(entity.extend({
    count:z.number().int().positive(),activity:nonempty,
  })).optional() }),
  exits: z.array(entity), present: z.array(entity.extend({ role: nonempty })),
  player: entity.extend({
    role: nonempty, condition: nonempty, items: z.array(entity.extend({ description: nonempty })),
  }),
  facts: z.array(z.object({ id: nonempty, text: nonempty }).strict()),
}).strict();
export type PublicState = z.infer<typeof PublicStateSchema>;
export const GameViewSchema = z.object({ state: PublicStateSchema, turns: z.array(PublicTurnSchema) }).strict();
export type GameView = z.infer<typeof GameViewSchema>;
export const GameSummarySchema = z.object({
  id: nonempty, title: nonempty, time: minute, version: minute, updatedAt: z.string().datetime(),
}).strict();
export type GameSummary = z.infer<typeof GameSummarySchema>;
export const SnapshotSummarySchema = z.object({
  id: nonempty, time: minute, version: minute, createdAt: z.string().datetime(),
}).strict();
export type SnapshotSummary = z.infer<typeof SnapshotSummarySchema>;
export const TurnRequestSchema = z.object({
  requestId: z.string().min(1).max(100), version: minute, input: ActionTextSchema,
}).strict();

export const ProviderConfigSchema = z.object({
  mode: z.enum(['mock', 'openai']),
  baseUrl: z.string().max(2048).url().refine(value => {
    try {
      const url = new URL(value);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || (loopback && url.protocol === 'http:')) &&
        !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, '请使用 HTTPS 地址，本机模型也可使用 HTTP，地址中不能包含凭据或查询参数。'),
  model: nonempty.trim().min(1).max(160),
  temperature: z.number().finite().min(0).max(2),
  timeoutMs: z.number().int().min(1000).max(120000),
  maxTokens: z.number().int().min(32).max(8192),
  retries: z.number().int().min(0).max(3),
  apiKey: z.string().max(4096).optional(),
}).strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export const PublicConfigSchema = ProviderConfigSchema.omit({ apiKey: true }).extend({ hasApiKey: z.boolean() });
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

const parseReferentSchema = z.object({
  kind: z.enum(['place', 'npc', 'crowd', 'item', 'document', 'subject', 'order']),
  id: referenceText, name: referenceText, aliases: z.array(referenceText), actorId: referenceText.optional(),
  sectionTitles: z.array(nonempty).optional(), carried:z.boolean().optional(),
}).strict().refine(value => value.actorId === undefined || value.kind === 'order', '只有命令选项可带执行人')
  .refine(value => value.sectionTitles === undefined || value.kind === 'document', '只有文书可带目录')
  .refine(value => value.carried === undefined || value.kind === 'item', '只有物品可标记是否随身携带');
export type ParseReferent = z.infer<typeof parseReferentSchema>;
export const PendingWaitSchema = z.object({
  until:minute, event:referenceText.optional(), rest:z.boolean().optional(),
}).strict();
export const ParseContextSchema = z.object({
  text: ActionTextSchema, location: nonempty, exits: z.array(nonempty),
  people: z.array(nonempty), items: z.array(nonempty),
  referents: z.array(parseReferentSchema).optional(),
  surroundings: z.string().trim().max(800).optional(),
  lastSpeakerId: referenceText.optional(), lastDocumentId: referenceText.optional(), lastItemId: referenceText.optional(),
  previousWait: PendingWaitSchema.optional(),
}).strict();
export type ParseContext = z.infer<typeof ParseContextSchema>;

const readSelection = z.object({
  documentId: referenceText.optional(),
  source: ActionTextSchema.optional(),
  section: z.union([z.number().int().positive().safe(), referenceText]).optional(),
  resume: z.boolean().optional(), nextOnly: z.boolean().optional(),
}).strict();

export function spokenPlanWords(words: string | string[]): string {
  return Array.isArray(words) ? words.join('\n') : words;
}
const spokenWords = z.union([ActionTextSchema, z.array(ActionTextSchema).min(1)
  .refine(parts => ActionTextSchema.safeParse(spokenPlanWords(parts)).success, '发言过长')]);

// The interpreter selects an operation and its arguments. No variant can carry
// effects, set a result, or author observable prose on behalf of the engine.
export const TurnPlanSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('clarify')}).strict(),
  z.object({kind:z.literal('assert')}).strict(),
  z.object({kind:z.literal('look'), source:ActionTextSchema.optional()}).strict(),
  z.object({kind:z.literal('move'), destination:referenceText, source:ActionTextSchema.optional()}).strict(),
  z.object({kind:z.literal('item'), itemId:referenceText, interaction:z.enum(['use', 'inspect', 'handle_inspect']),
    inventoryOnly:z.boolean().optional(), source:ActionTextSchema.optional()}).strict(),
  z.object({kind:z.literal('investigate'), focus:referenceText, source:ActionTextSchema.optional()}).strict(),
  z.object({kind:z.literal('read'), reading:readSelection}).strict(),
  z.object({
    kind:z.literal('speak'), words:spokenWords, targetId:referenceText.optional(), source:ActionTextSchema.optional(),
    private:z.boolean(), courteous:z.boolean().optional(), reading:readSelection.optional(),
    targetUnavailable:z.boolean().optional(),
  }).strict(),
  z.object({kind:z.literal('order'), words:ActionTextSchema, targetId:referenceText, private:z.boolean(), orderId:referenceText.optional(), source:ActionTextSchema.optional()}).strict(),
  z.object({kind:z.literal('arrest'), targetId:referenceText, source:ActionTextSchema.optional()}).strict(),
  z.object({
    kind:z.literal('wait'), rest:z.boolean().optional(), minutes:minute.optional(), clock:ActionIntentSchema.shape.clock,
    day:z.enum(['今天', '明天']).optional(), event:referenceText.optional(), resume:z.boolean().optional(), source:ActionTextSchema.optional(),
  }).strict(),
  z.object({kind:z.literal('attempt'), activity:z.enum(['listen', 'perform', 'general']), source:ActionTextSchema.optional()}).strict(),
  z.object({kind:z.literal('unavailable'), subject:z.enum(['item', 'place', 'document', 'person'])}).strict(),
]).superRefine((plan, ctx) => {
  if (plan.kind === 'wait' && ((plan.clock && (plan.event || plan.minutes !== undefined)) || (plan.day && !plan.clock))) {
    ctx.addIssue({code:'custom', message:'等待时刻不能与等待时长或事件混用，日别只适用于时刻'});
  }
  if (plan.kind === 'wait' && plan.resume && (plan.clock || plan.event || plan.minutes !== undefined || plan.rest || plan.day))
    ctx.addIssue({code:'custom',message:'继续原等待时使用已保存的条件和截止时刻；改变目标请发起新的等待'});
  if (plan.kind === 'speak' && plan.targetUnavailable && plan.targetId) {
    ctx.addIssue({code:'custom', message:'缺席者不能同时指向在场人物'});
  }
});
export type TurnPlan = z.infer<typeof TurnPlanSchema>;

function verifiedSpeech(context: ParseContext, words: string | string[]): string | string[] | undefined {
  const quotes = quoteSpans(context.text).map(span => span.text.trim());
  const oneSpeaker = quotes.length > 1 && readSegmentedSpeech(context.text, context.people);
  if (typeof words === 'string') {
    if (quotes.length < 2) return context.text.includes(words) ? words : undefined;
    // Older plans may select just one line, or join the lines into a single string.
    // Complete them only when the input clearly attributes every quote to the player.
    if (quotes.includes(words)) return oneSpeaker ? quotes : words;
    if (oneSpeaker && (words === quotes.join('') || words === quotes.join('\n') || words === quotes.join(' '))) return quotes;
    return;
  }
  let after = 0;
  for (const part of words) {
    const at = quotes.indexOf(part, after);
    if (at === -1) return;
    after = at + 1;
  }
  return oneSpeaker ? quotes : words;
}

function unquotedRanges(text: string): [number, number][] {
  const closing: Record<string, string> = {'“':'”', '‘':'’', '「':'」', '『':'』', '"':'"', "'":"'"};
  const parts: [number, number][] = [];
  let outsideStart = 0;
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && /[a-z]/iu.test(text[i-1] ?? '') && /[a-z]/iu.test(text[i+1] ?? '')) continue;
    if (stack.length && stack[stack.length - 1] === c) {
      stack.pop();
      if (!stack.length) outsideStart = i + 1;
    } else if (closing[c]) {
      if (!stack.length) parts.push([outsideStart, i]);
      stack.push(closing[c]);
    }
  }
  parts.push([outsideStart, stack.length ? outsideStart : text.length]);
  return parts;
}
export function turnPlanSchemaFor(context: ParseContext) {
  // Quotation boundaries check provenance only. The model decides the meaning
  // of the action and the referent; no particular verb or word order is required.
  const outside = unquotedRanges(context.text);
  const containsActionSource = (source: string) => {
    for (let at = context.text.indexOf(source); at !== -1; at = context.text.indexOf(source, at + 1)) {
      // A player can quote a title or a place name within their own action.
      if (outside.some(([begin,end]) =>
        /[\p{L}\p{N}]/u.test(context.text.slice(Math.max(at,begin), Math.min(at + source.length,end))))) return true;
    }
    return false;
  };
  return TurnPlanSchema.transform((plan, ctx): TurnPlan => {
    if (plan.kind === 'speak') {
      const words = verifiedSpeech(context, plan.words);
      if (words === undefined) ctx.addIssue({code:'custom',path:['words'],message:'发言必须按原序引用玩家的原话'});
      else plan = {...plan, words};
      const beat = plan.source;
      if (beat && (!/[\p{L}\p{N}]/u.test(beat) || !outside.some(([start,end]) => context.text.slice(start,end).includes(beat))))
        ctx.addIssue({code:'custom',path:['source'],message:'发言的动作描写必须完整引用引语外的原文'});
    }
    if (plan.kind === 'order' && !context.text.includes(plan.words)) {
      ctx.addIssue({code:'custom',path:['words'],message:'指令必须引用玩家的原话'});
    }
    if (plan.kind === 'clarify' || plan.kind === 'assert' || plan.kind === 'unavailable' || plan.kind === 'order' ||
        (plan.kind === 'speak' && !plan.reading)) return plan;
    const source = plan.kind === 'read' || plan.kind === 'speak' ? plan.reading?.source : plan.source;
    if (source ? !containsActionSource(source) : outside.length > 1) {
      ctx.addIssue({code:'custom',message:'含引语的行动必须引用引语之外的动作原文'});
    }
    if (source && plan.kind === 'speak' && spokenPlanWords(plan.words).includes(source)) {
      ctx.addIssue({code:'custom',message:'默读的动作原文不能是向旁人说出的台词'});
    }
    return plan;
  });
}

export const ResolutionOptionSchema = z.object({ id: nonempty, summary: nonempty }).strict();
export type ResolutionOption = z.infer<typeof ResolutionOptionSchema>;
const waitEvidenceSchema = z.object({
  condition: referenceText, notices: z.array(nonempty).min(1).max(256),
}).strict();
export const ResolveContextSchema = z.object({
  text: ActionTextSchema, intent: ActionIntentSchema, location: nonempty,
  actor: z.object({ name: nonempty, role: nonempty, abilities: z.array(nonempty) }).strict(),
  options: z.array(ResolutionOptionSchema).min(1),
  waitEvidence: waitEvidenceSchema.optional(),
  regionalDuty:z.object({
    time:minute, duties:z.array(z.object({role:referenceText,place:referenceText,task:nonempty,destination:referenceText}).strict()).min(1).max(2),
    options:z.array(ResolutionOptionSchema).min(2).max(4),
  }).strict().optional(),
}).strict();
export type ResolveContext = z.infer<typeof ResolveContextSchema>;
export const ResolutionProposalSchema = z.object({ optionId: nonempty, minutes: minute.optional() }).strict();
export type ResolutionProposal = z.infer<typeof ResolutionProposalSchema>;

const participant = z.object({
  name: z.string().trim().min(1).max(160), role: z.string().trim().min(1).max(160),
}).strict();
const factId = z.string().trim().min(1).max(160);
const dialogueLineSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('player'), text: ActionTextSchema }).strict(),
  z.object({ role: z.literal('npc'), text: ActionTextSchema }).strict(),
  z.object({ role: z.literal('overheard'), speaker: participant.shape.name, text: ActionTextSchema }).strict(),
]);
const dialogueIssue = z.enum(['offstage', 'prediction', 'unattributed', 'player-action', 'citation', 'other']);
export const DialogueVerdictSchema = z.object({
  grounded:z.boolean(), playerAgency:z.boolean(), citationsAccurate:z.boolean(),
  issue:dialogueIssue.optional(),
}).strict();
export const DialogueContextSchema = z.object({
  speaker: participant, player: participant,
  location: z.string().trim().min(1).max(160), currentTime:minute.optional(), present: z.array(participant).max(32),
  listeners: z.array(participant.shape.name).optional(),
  surroundings: z.string().trim().max(800).optional(), duty: z.string().trim().max(240).optional(),
  facts: z.array(z.object({ id: factId, text: z.string().trim().min(1).max(2000) }).strict()).max(32)
    .refine(facts => new Set(facts.map(f => f.id)).size === facts.length, '事实标识重复'),
  history: z.array(dialogueLineSchema).max(16),
  recentNotices: z.array(z.object({ time: minute, text: ActionTextSchema }).strict()).max(4).optional(),
  preparedNotes: z.array(z.object({ document:referenceText, title:referenceText, text:ActionTextSchema }).strict()).max(8).optional(),
  input: z.string().trim().max(2000), decision: z.string().trim().min(1).max(500),
  revision: DialogueVerdictSchema.optional(),
}).strict();
export type DialogueContext = z.infer<typeof DialogueContextSchema>;

export const NpcActionContextSchema = DialogueContextSchema.pick({
  player: true, location: true, surroundings: true, duty: true, present: true, listeners: true, facts: true, history: true, recentNotices: true,
  input: true, decision: true, currentTime:true,
}).extend({
  trigger: z.enum(['opening', 'addressed', 'ambient']),
  npc: participant,
  recentActions: z.array(z.object({time:minute, text:ActionTextSchema}).strict()).max(6).optional(),
  appointments:z.array(z.object({from:minute,until:minute,location:participant.shape.name,task:z.string().min(1).max(300)}).strict()).max(4).optional(),
  exits: z.array(z.object({id: z.string().trim().min(1).max(160), name: participant.shape.name}).strict()).max(32),
  canInspect: z.boolean(),
  order: z.string().trim().min(1).max(500).optional(),
}).strict();
export type NpcActionContext = z.infer<typeof NpcActionContextSchema>;
export const NpcFreeActionSchema = z.object({
  kind: z.literal('act'),
  description: z.string().trim().min(1).max(120).regex(/\p{Script=Han}/u, '动作描述需要中文动词短语')
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"'“”‘’「」『』]+$/u, '动作描述必须是单行可见的动词短语'),
  thenSpeak: z.boolean().optional(),
}).strict();
export type NpcFreeAction = z.infer<typeof NpcFreeActionSchema>;
export const NpcActionProposalSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('stay')}).strict(),
  z.object({kind:z.literal('speak')}).strict(),
  z.object({kind:z.literal('inspect'), thenSpeak:z.boolean().optional()}).strict(),
  z.object({kind:z.literal('carryOutOrder'), thenSpeak:z.boolean().optional()}).strict(),
  z.object({kind:z.literal('move'), destination:z.string().trim().min(1).max(160)}).strict(),
  z.object({kind:z.literal('gesture'), gesture:z.enum(['bow', 'nod', 'look']), thenSpeak:z.boolean().optional()}).strict(),
  NpcFreeActionSchema,
]);
export type NpcActionProposal = z.infer<typeof NpcActionProposalSchema>;
export function npcActionProposalSchemaFor(context: NpcActionContext) {
  return NpcActionProposalSchema.refine(action => {
    if (action.kind === 'move') return context.exits.some(exit => exit.id === action.destination);
    if (action.kind === 'carryOutOrder') return context.trigger === 'addressed' && context.order !== undefined;
    if (action.kind === 'act') {
      return ![context.npc.name, context.npc.role, '我', '他', '她'].some(subject => action.description.startsWith(subject));
    }
    return action.kind !== 'inspect' || context.canInspect;
  }, '行动超出当前 NPC 可以采取的选项');
}
export const NpcActionReviewContextSchema = z.object({
  context: NpcActionContextSchema,
  proposal: NpcFreeActionSchema,
}).strict();
export type NpcActionReviewContext = z.infer<typeof NpcActionReviewContextSchema>;
export const NpcActionReviewSchema = z.object({ grounded: z.boolean(), selfOnly: z.boolean() }).strict();
export type NpcActionReview = z.infer<typeof NpcActionReviewSchema>;

export const DialogueDraftSchema = z.object({
  text: z.string().trim().min(1).max(400).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, '台词必须为单行可见文本'),
  factIds: z.array(factId).max(32).refine(ids => new Set(ids).size === ids.length, '引用事实标识重复'),
}).strict();
export type DialogueDraft = z.infer<typeof DialogueDraftSchema>;
export const DialogueReviewContextSchema = z.object({
  context: DialogueContextSchema, draft: DialogueDraftSchema,
}).strict().refine(({ context, draft }) => draft.factIds.every(id => context.facts.some(f => f.id === id)),
  '待审台词引用了不可披露的事实');
export type DialogueReviewContext = z.infer<typeof DialogueReviewContextSchema>;
// Optional revision hints cannot turn an otherwise usable verdict into a service outage.
// The three decisions themselves must always be explicit booleans.
export const DialogueReviewSchema = DialogueVerdictSchema.extend({
  issue:dialogueIssue.optional().catch(undefined),
  excerpt:DialogueDraftSchema.optional().catch(undefined),
}).strict();
export type DialogueReview = z.infer<typeof DialogueReviewSchema>;

export const NarrateContextSchema = z.object({ observations: z.array(ObservationSchema) }).strict();
export type NarrateContext = z.infer<typeof NarrateContextSchema>;
export const NarrationPlanSchema = z.object({
  lines: z.array(z.object({ index: minute, style: z.enum(['plain', 'perceived']) }).strict()).max(128),
}).strict();
export type NarrationPlan = z.infer<typeof NarrationPlanSchema>;
export interface LLMProvider {
  interpret?(context: ParseContext): Promise<TurnPlan>;
  parse(context: ParseContext): Promise<ActionIntent>;
  resolve(context: ResolveContext): Promise<ResolutionProposal>;
  decideNpcAction(context: NpcActionContext): Promise<NpcActionProposal>;
  reviewNpcAction(context: NpcActionReviewContext): Promise<NpcActionReview>;
  dialogue(context: DialogueContext): Promise<DialogueDraft>;
  reviewDialogue(context: DialogueReviewContext): Promise<DialogueReview>;
  narrate(context: NarrateContext): Promise<NarrationPlan>;
}
