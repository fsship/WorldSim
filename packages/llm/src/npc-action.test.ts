import { describe, expect, it, vi } from 'vitest';
import { type NpcActionContext, type NpcActionProposal, type NpcFreeAction, type ProviderConfig } from '@worldsim/shared';
import { MockLLMProvider, OpenAICompatibleProvider } from './index';

const context: NpcActionContext = {
  trigger: 'addressed', npc: {name: '侍从', role: '侍从'}, player: {name: '国王', role: '国王'},
  location: '议事厅', exits: [{id:'gate', name:'宫门'}], present: [{name:'侍卫', role:'侍卫'}],
  facts: [{id:'assembly', text:'晨会将在议事厅举行。'}], history: [],
  input:'请到宫门查看。', decision:'玩家刚刚向你说话。', canInspect:false,
};
const config: ProviderConfig = {
  mode:'openai', baseUrl:'https://example.invalid/v1', model:'test-model',
  temperature:0.3, timeoutMs:1000, maxTokens:400, retries:0,
};
function completion(value: unknown) {
  return Response.json({choices:[{finish_reason:'stop', message:{content:JSON.stringify(value)}}]});
}

describe('NPC 行动模型协议', () => {
  it('only transmits the scoped snapshot in an independent action-decision request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion({kind:'move',destination:'gate'}));
    const provider = new OpenAICompatibleProvider(config, fetcher);
    await expect(provider.decideNpcAction(context)).resolves.toEqual({kind:'move',destination:'gate'});
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://example.invalid/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.messages.map((m: {role:string}) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[0].content).toContain('npc 本人');
    expect(JSON.parse(body.messages[1].content)).toEqual(context);
  });

  it('rejects extra context fields before any HTTP request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const bad = { ...context, hiddenPlans:['secret'] };
    await expect(new OpenAICompatibleProvider(config, fetcher).decideNpcAction(bad)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retries an illegal destination once and accepts a legal substitute', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion({kind:'move',destination:'unknown'}))
      .mockResolvedValueOnce(completion({kind:'gesture',gesture:'bow',thenSpeak:true}));
    const provider = new OpenAICompatibleProvider({...config, retries:1}, fetcher);
    await expect(provider.decideNpcAction(context)).resolves.toEqual({kind:'gesture',gesture:'bow',thenSpeak:true});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each<{ trigger: NpcActionContext['trigger']; kind: string }>([
    {trigger:'opening',kind:'speak'}, {trigger:'addressed',kind:'speak'}, {trigger:'ambient',kind:'stay'},
  ])('gives deterministic offline actions for $trigger', async ({trigger,kind}) => {
    await expect(new MockLLMProvider().decideNpcAction({...context,trigger})).resolves.toEqual({kind});
  });

  it.each<NpcActionProposal>([
    {kind:'stay'}, {kind:'speak'}, {kind:'inspect',thenSpeak:true}, {kind:'move',destination:'gate'},
    {kind:'gesture',gesture:'look'}, {kind:'gesture',gesture:'nod',thenSpeak:false},
  ])('validates injected legal action %o', async proposal => {
    const provider = new MockLLMProvider({decideNpcAction:() => proposal});
    expect(await provider.decideNpcAction({...context, canInspect:true})).toEqual(proposal);
  });
  it('offers execution only for a verified engine order, without mandating compliance', async () => {
    const ordered = {...context, order:'加强宫门守备'};
    expect(await new MockLLMProvider().decideNpcAction(ordered)).toEqual({kind:'carryOutOrder',thenSpeak:true});
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion({kind:'speak'}));
    const provider = new OpenAICompatibleProvider(config, fetcher);
    expect(await provider.decideNpcAction(ordered)).toEqual({kind:'speak'});
    expect(JSON.parse(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).messages[1].content).order).toBe(ordered.order);
  });

  it('separately reviews the exact model-authored action using only its original projection', async () => {
    const proposal: NpcFreeAction = {kind:'act', description:'把手背到身后，微微侧过头', thenSpeak:true};
    const rejected = {grounded:true, selfOnly:false};
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion(proposal))
      .mockResolvedValueOnce(completion(rejected));
    const p = new OpenAICompatibleProvider(config, fetcher);
    expect(await p.decideNpcAction(context)).toEqual(proposal);
    expect(await p.reviewNpcAction({context, proposal})).toEqual(rejected);
    const bodies = fetcher.mock.calls.map(([,init]) => JSON.parse(String(init?.body)));
    expect(bodies[1].messages.map((m: {role:string}) => m.role)).toEqual(['system','user']);
    expect(bodies[0].messages[0].content).not.toBe(bodies[1].messages[0].content);
    expect(JSON.parse(bodies[1].messages[1].content)).toEqual({context, proposal});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('requires explicit offline semantic approval of a free action', async () => {
    const request = {context, proposal:{kind:'act' as const, description:'抬起一只手'}};
    expect(await new MockLLMProvider().reviewNpcAction(request)).toEqual({grounded:false, selfOnly:false});
    const p = new MockLLMProvider({reviewNpcAction:async input => {
      expect(input).toEqual(request);
      return {grounded:true, selfOnly:true};
    }});
    expect(await p.reviewNpcAction(request)).toEqual({grounded:true, selfOnly:true});
  });

  it.each([
    {kind:'stay',actor:'king'}, {kind:'speak',minutes:1440}, {kind:'move',destination:'archive'},
    {kind:'move',destination:'gate',thenSpeak:true}, {kind:'inspect',thenSpeak:true}, {kind:'gesture',gesture:'attack'},
    {kind:'speak',patch:{role:'emperor'}}, {kind:'gesture',gesture:'bow',thenSpeak:'yes'},
    {kind:'carryOutOrder',thenSpeak:true},
    {kind:'act',description:'低下头\n国王前往宫门'}, {kind:'act',description:'向国王说“请来”'},
    {kind:'act',description:'挥了挥手',changes:[{op:'move',actor:'king',to:'gate'}]},
    {kind:'act',description:'侍从把手背到身后'}, {kind:'act',description:'run'},
  ])('rejects malformed or unavailable action %o', async proposal => {
    const provider = new MockLLMProvider({decideNpcAction:() => proposal});
    await expect(provider.decideNpcAction(context)).rejects.toThrow();
  });
});
