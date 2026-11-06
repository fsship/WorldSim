import { offlineEncounter } from './offline-encounter';
import {
  ActionIntentSchema, NarrationPlanSchema, ResolutionProposalSchema, readPlayerInput, isPrivateSpeech,
  EncounterContextSchema, encounterProposalSchemaFor, type EncounterContext,
  DialogueContextSchema, DialogueDraftSchema, DialogueReviewContextSchema, DialogueReviewSchema,
  NpcActionContextSchema, npcActionProposalSchemaFor, type NpcActionContext,
  NpcActionReviewContextSchema, NpcActionReviewSchema, type NpcActionReviewContext,
  type DialogueContext, type DialogueDraft, type DialogueReviewContext,
  type ActionIntent, type LLMProvider, type NarrateContext, type ParseContext, type ResolveContext,
} from '@worldsim/shared';

function mentioned(text: string, names: string[]): string | undefined {
  return [...names].sort((a, b) => b.length - a.length).find(name => text.includes(name));
}

function parseMock({ text, people, location, items }: ParseContext): ActionIntent {
  const raw = text.trim();
  const explicit = readPlayerInput(raw, people, [location], [], items);
  if (explicit) return explicit.intent;
  const verb = raw.replace(/^(?:(?:我(?:想要|打算|决定|准备|想|要|先)?|请|试着|尝试)\s*)+/, '');
  const person = mentioned(raw, people);
  const privateSpeech = isPrivateSpeech(raw);
  if (/^(?:告诉|告知|询问|问|打听|声称|自称|说|安抚|感谢|劝说|拜访|交谈)|^(?:向|对|跟|和).+?(?:说|问|聊|谈|致意|打听|道谢)/.test(verb)) {
    return privateSpeech ? {kind:'speak'} : { kind: 'speak', target: person };
  }
  if (privateSpeech) return { kind: 'speak' };
  if (/^(?:环顾|观察|查看|四处看看|看看|打量|看向)/.test(verb)) return { kind: 'look', target: person };
  if (/觉醒|无敌|刀枪不入|修改数据库|忽略.*规则|已经成为|^(?:成为|是|获得|拥有)/.test(verb)) return { kind: 'assert' };
  return { kind: 'attempt' };
}

export type MockHandlers = {
  parse?: (context: ParseContext) => unknown | Promise<unknown>;
  resolve?: (context: ResolveContext) => unknown | Promise<unknown>;
  encounter?: (context: EncounterContext) => unknown | Promise<unknown>;
  decideNpcAction?: (context: NpcActionContext) => unknown | Promise<unknown>;
  reviewNpcAction?: (context: NpcActionReviewContext) => unknown | Promise<unknown>;
  dialogue?: (context: DialogueContext) => unknown | Promise<unknown>;
  reviewDialogue?: (context: DialogueReviewContext) => unknown | Promise<unknown>;
  narrate?: (context: NarrateContext) => unknown | Promise<unknown>;
};

// Offline demonstration only. The HTTP adapter always asks the configured model to write the line.
function offlineDialogue(context: DialogueContext): DialogueDraft {
  if (!context.input) return { text: '您想先听些什么？', factIds: [] };
  const fact = context.facts.find(f =>
    f.text.length <= 300 && !/[\r\n]/u.test(f.text) &&
    !context.history.some(line => line.role === 'npc' && line.text.includes(f.text)));
  if (fact) return { text: fact.text, factIds: [fact.id] };
  return { text: '我们现在在' + context.location + '。关于这一点，我手上没有别的确报。', factIds: [] };
}

/** Injectable responses follow the same schema checks as the network adapter. */
export class MockLLMProvider implements LLMProvider {
  constructor(private readonly handlers: MockHandlers = {}) {}
  async parse(context: ParseContext) {
    return ActionIntentSchema.parse(this.handlers.parse ? await this.handlers.parse(context) : parseMock(context));
  }
  async resolve(context: ResolveContext) {
    const value = this.handlers.resolve ? await this.handlers.resolve(context) : { optionId: context.options[0]?.id };
    return ResolutionProposalSchema.parse(value);
  }
  async encounter(data: EncounterContext) {
    const context = EncounterContextSchema.parse(data);
    const proposal = this.handlers.encounter ? await this.handlers.encounter(context) : offlineEncounter(context);
    return encounterProposalSchemaFor(context).parse(proposal);
  }
  async decideNpcAction(data: NpcActionContext) {
    const context = NpcActionContextSchema.parse(data);
    const defaultAction = context.order ? {kind:'carryOutOrder', thenSpeak:true} :
      {kind:context.trigger === 'ambient' ? 'stay' : 'speak'};
    const proposal = this.handlers.decideNpcAction ? await this.handlers.decideNpcAction(context) : defaultAction;
    return npcActionProposalSchemaFor(context).parse(proposal);
  }
  async reviewNpcAction(data: NpcActionReviewContext) {
    const context = NpcActionReviewContextSchema.parse(data);
    return this.handlers.reviewNpcAction ? NpcActionReviewSchema.parse(await this.handlers.reviewNpcAction(context)) :
      {grounded:false, selfOnly:false};
  }
  async dialogue(data: DialogueContext) {
    const context = DialogueContextSchema.parse(data);
    const draft = DialogueDraftSchema.parse(this.handlers.dialogue ? await this.handlers.dialogue(context) : offlineDialogue(context));
    if (draft.factIds.some(id => !context.facts.some(f => f.id === id))) throw new Error('引用了不可披露的事实。');
    return draft;
  }
  async reviewDialogue(data: DialogueReviewContext) {
    const input = DialogueReviewContextSchema.parse(data);
    if (this.handlers.reviewDialogue) return DialogueReviewSchema.parse(await this.handlers.reviewDialogue(input));
    const expected = offlineDialogue(input.context);
    // Without a model, only approve the verifiable output of our offline writer.
    const accepted = input.draft.text === expected.text;
    return { grounded: accepted, playerAgency: accepted, citationsAccurate:
      accepted && input.draft.factIds.length === expected.factIds.length && expected.factIds.every(id => input.draft.factIds.includes(id)) };
  }
  async narrate(context: NarrateContext) {
    const value = this.handlers.narrate ? await this.handlers.narrate(context) :
      { lines: context.observations.map((_, index) => ({ index, style: 'plain' })) };
    return NarrationPlanSchema.parse(value);
  }
}
