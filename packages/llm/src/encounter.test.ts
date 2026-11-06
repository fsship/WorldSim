import { describe, expect, it, vi } from 'vitest';
import { llmTaskLabels, turnPlanSchemaFor, type EncounterContext, type LlmCallAttempt, type ProviderConfig } from '@worldsim/shared';
import { MockLLMProvider, OpenAICompatibleProvider } from './index';

const scene: EncounterContext = {
  trigger:'opening', worldInfo:'早班列车经过山里的小城。', situation:'我推门进入候车厅，向窗口张望。',
  player:{name:'林秋', role:'旅客'}, location:{name:'候车厅', description:'检票窗口前有几个人在排队。'},
  present:[], time:360,
};
const config: ProviderConfig = {
  mode:'openai', baseUrl:'https://example.invalid/v1', model:'fixture-model', temperature:0.3,
  timeoutMs:1000, maxTokens:800, retries:0,
};
const npc = {kind:'npc', name:'云安', role:'检票员', duty:'在站台入口检票。', goal:'做好第一次值班。'};
function answer(proposal: unknown) {
  return Response.json({choices:[{finish_reason:'stop', message:{content:JSON.stringify(proposal)}}]});
}

describe('即时相遇的模型边界', () => {
  it('单独请求并登记相遇任务，只传现场与世界资料', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(answer(npc)).mockResolvedValueOnce(answer({kind:'none'}));
    const entries: LlmCallAttempt[] = [];
    const provider = new OpenAICompatibleProvider(config, fetcher, entry => entries.push(entry));
    expect(await provider.encounter(scene)).toEqual(npc);
    expect(await provider.encounter({...scene, trigger:'arrival'})).toEqual({kind:'none'});
    const payload = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(JSON.parse(payload.messages[1].content)).toEqual(scene);
    expect(payload.messages[0].content).toContain('{"kind":"none"}');
    expect(entries.map(e => [e.task, e.status])).toEqual([['encounter','success'], ['encounter','success']]);
    expect(llmTaskLabels.encounter).toBeTruthy();
  });

  it.each([
    { ...npc, id:'player' }, { ...npc, goal:'假\n事实' },
    { ...npc, name:'云<span>安' }, { kind:'none', npc }, { ...npc, locationId:'remote' },
  ])('拒绝越权与格式错误的角色提案', async invalid => {
    const provider = new OpenAICompatibleProvider(config, async () => answer(invalid));
    await expect(provider.encounter(scene)).rejects.toMatchObject({task:'encounter', reason:'format'});
  });

  it('与玩家或在场者同名则复用当前阵容', async () => {
    for (const name of ['林秋', 'ＢＥＡ']) {
      const provider = new OpenAICompatibleProvider(config, async () => answer({...npc, name}));
      const result = await provider.encounter({...scene, present:[{name:'Bea', role:'检票员'}]});
      expect(result).toEqual({kind:'none'});
    }
  });

  it('事件依据当前实际到来的人判断，开局空无一人也可迎来邮差', async () => {
    const atDoor = {...scene, trigger:'event' as const, situation:'我独自来到空无一人的站厅。',
      location:{name:'站厅', description:'四周没有人。'}, present:[{name:'云安',role:'修理工'}]};
    const provider = new MockLLMProvider();
    expect(await provider.encounter({...atDoor, recent:['一名邮差推开门，将信递给修理工。']})).toMatchObject({kind:'npc', role:'邮差'});
    expect(await provider.encounter({...atDoor, recent:['一名邮差走进房间。', '墙上的钟敲响了。']})).toMatchObject({kind:'npc', role:'邮差'});
    expect(await provider.encounter({...atDoor, recent:['一名邮差走进房间。', '邮差随即离开。', '墙上的钟敲响了。']})).toEqual({kind:'none'});
    for (const text of ['外面风雨更大了。', '广播预计邮差明天抵达。', '云安敲门，向里面的人招手。'])
      expect(await provider.encounter({...atDoor, recent:[text]})).toEqual({kind:'none'});
  });

  it('离线寻人区分帮忙的人、已有对象和明确要找的另一位同行', async () => {
    const provider = new MockLLMProvider();
    const market = {...scene, trigger:'contact' as const, worldInfo:'集市中央有一间医馆。',
      situation:'客栈掌柜刚出来招呼我。', location:{name:'集市', description:'一排摊位沿街铺开。'},
      present:[{name:'阿春',role:'摊主'}, {name:'小桂', role:'掌柜'}]};
    const other = await provider.encounter({...market, input:'我想问问另一位摊主。'});
    expect(other).toMatchObject({kind:'npc', role:'摊主'});
    if (other.kind === 'npc') expect(other.name).not.toBe('阿春');
    expect(await provider.encounter({...market, input:'请掌柜帮我找医生。'})).toMatchObject({kind:'npc', role:'医生'});
    expect(await provider.encounter({...market, input:'我问掌柜医生的事。'})).toEqual({kind:'none'});
    expect(await provider.encounter({...market, input:'我想找龙骑士。'})).toEqual({kind:'none'});
  });

  it('离线模式按地点与在场者生成，也允许无人出现', async () => {
    const provider = new MockLLMProvider();
    const first = await provider.encounter(scene);
    expect(first).toMatchObject({kind:'npc', role:'站务员'});
    if (first.kind !== 'npc') throw new Error('缺少站务员');
    expect(await provider.encounter({...scene, trigger:'contact', input:'我向站务员问候', present:[{name:first.name, role:first.role}]}))
      .toEqual({kind:'none'});
    expect(await provider.encounter({...scene, trigger:'arrival',
      location:{name:'废弃的车站', description:'此地空无一人。'}})).toEqual({kind:'none'});
    expect(await provider.encounter({...scene, trigger:'contact', worldInfo:'山路上有个集市。',
      situation:'我在路边醒来。', location:{name:'开场地点', description:'故事从这里开始。'}, input:'我去找摊主。'}))
      .toMatchObject({kind:'npc', role:'摊主'});
  });

  it('开关、引语与动作原文约束找人意图', () => {
    const context = {text:'我向摊主问道：“请问几点开门？”', location:'市场', people:[], items:[], exits:[]};
    const plan = {kind:'seekContact', source:'我向摊主问道'};
    expect(turnPlanSchemaFor(context).safeParse(plan).success).toBe(false);
    const enabled = turnPlanSchemaFor({...context, allowEncounter:true});
    expect(enabled.parse(plan)).toEqual(plan);
    expect(enabled.safeParse({kind:'seekContact', source:'请问几点开门'}).success).toBe(false);
  });
});
