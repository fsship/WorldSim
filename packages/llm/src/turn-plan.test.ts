import { describe, expect, it, vi } from 'vitest';
import { ParseContextSchema, spokenPlanWords, TurnPlanSchema, turnPlanSchemaFor, type ParseContext, type ProviderConfig, type TurnPlan } from '@worldsim/shared';
import { OpenAICompatibleProvider } from './openai';

const config: ProviderConfig = {
  mode:'openai', baseUrl:'https://example.invalid/v1', model:'fixture', timeoutMs:1000,
  temperature:0.3, maxTokens:800, retries:0,
};
const scene = (text: string): ParseContext => ({
  text, location:'议事厅', exits:['宫门'], people:['艾琳'], items:['王室印玺'], lastSpeakerId:'steward',
  referents:[
    {kind:'place', id:'gate', name:'宫门', aliases:['城门']},
    {kind:'npc', id:'steward', name:'艾琳', aliases:['侍从']},
    {kind:'item', id:'seal', name:'王室印玺', aliases:['王印']},
    {kind:'document', id:'agenda', name:'朝会议程', aliases:['议程']},
    {kind:'subject', id:'surface-page', name:'桌上的书册', aliases:['书册']},
  ],
});
const completion = (output: unknown) => Response.json({choices:[{finish_reason:'stop', message:{content:JSON.stringify(output)}}]});
const greeting = '"早，艾琳"——我回复道，顺手看了看长桌，想知道有哪些议程';
const mixed: TurnPlan = {kind:'speak', words:'早，艾琳', targetId:'steward', private:false, reading:{documentId:'agenda',source:'顺手看了看长桌'}};
const first = '如果他能现在自守，我可以既往不咎，否则，';
const last = '他的下场可不会好';
const gesture = '我审视着在场的诸多人物';
const interruptedLine = '“' + first + '”' + gesture + '“' + last + '”';

describe('真实适配器的回合计划协议', () => {
  it.each<[string, TurnPlan]>([
    ['朝宫门快步走去', {kind:'move',destination:'gate'}],
    ['拿起来，借窗边的光瞧瞧王印', {kind:'item',itemId:'seal',interaction:'handle_inspect'}],
    [greeting, mixed],
    ['“远方的使节，请稍候。”我说', {kind:'speak',words:'远方的使节，请稍候。',private:false,targetUnavailable:true}],
    ['“侍从，请在这里等我。”', {kind:'order',words:'侍从，请在这里等我。',targetId:'steward',private:false}],
    ['我走向“宫门”', {kind:'move',destination:'gate',source:'走向“宫门”'}],
    ['接着等官员们出现，最多一刻钟', {kind:'wait',event:'官员',minutes:15}],
    ['再翻下一项', {kind:'read',reading:{resume:true,nextOnly:true}}],
    ['环视四周', {kind:'look'}],
    ['案头那册子，我想翻一翻', {kind:'investigate',focus:'surface-page'}],
    ['目睹门外的人跑过去', {kind:'attempt',activity:'general'}],
  ])('一次请求解释原话 %s，不用句式或显式第一人称过滤模型结果', async (input, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(expected));
    const p = new OpenAICompatibleProvider(config, fetcher);
    const context = scene(input);
    expect(await p.interpret(context)).toEqual(expected);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(JSON.parse(request.messages[1].content)).toEqual(context);
  });

  it.each([
    {kind:'teleport',destination:'gate'},
    {kind:'item',itemId:'seal',interaction:'handle_inspect',op:'flag'},
    {...mixed, words:'我已经命令他们开门。'},
    {kind:'order',words:'加强戒备。', targetId:'steward',private:false},
    {kind:'wait',minutes:5,clock:'09:15'},
    {kind:'wait',event:'钟声',clock:'09:15'},
    {kind:'wait',minutes:1,day:'明天'},
    {...mixed, targetUnavailable:true},
    {kind:'read',reading:{documentId:'agenda',changes:[]}},
    {kind:'speak',words:'早，艾琳',private:false,reading:{section:0}},
    {kind:'attempt'},
  ])('不接纳虚构台词、未声明的状态字段或不完整的计划 %#', async output => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(output));
    const p = new OpenAICompatibleProvider(config, fetcher);
    await expect(p.interpret(scene(greeting))).rejects.toThrow('模型服务');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('只把公开引用字段交给模型；自定义动作时长、持有关系和内部材料不能混入', () => {
    const raw = scene('看一眼王印');
    expect(ParseContextSchema.safeParse({...raw, secrets:['机密']}).success).toBe(false);
    expect(ParseContextSchema.safeParse({...raw, referents:[{...raw.referents![2], hidden:true}]}).success).toBe(false);
    expect(ParseContextSchema.safeParse({...raw, referents:[{...raw.referents![2], actorId:'king'}]}).success).toBe(false);
    expect(TurnPlanSchema.safeParse({kind:'move',destination:'gate',minutes:100}).success).toBe(false);
    expect(TurnPlanSchema.safeParse({kind:'item',itemId:'seal',interaction:'inspect',owner:'king'}).success).toBe(false);
  });

  it('口头发言遗漏音量时让模型补全，不猜测私人话语的听众', async () => {
    const text = '“请你留下。”我对艾琳耳语';
    const draft = {kind:'speak',words:'请你留下。',targetId:'steward'};
    const plan = {...draft,private:true};
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(draft)).mockResolvedValueOnce(completion(plan));
    const p = new OpenAICompatibleProvider({...config,retries:1}, fetcher);
    expect(await p.interpret(scene(text))).toEqual(plan);
    const retry = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(retry.messages[0].content).toContain('private (invalid_type)');
  });

  it.each([{words:[first, last]}, {words:first + last}, {words:first}])(
    '两句玩家台词被动作隔开时，旧计划和分段计划都完整传达两句 %#', async ({words}) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion({kind:'speak', private:false, words}));
      const context = scene(interruptedLine);
      const plan = await new OpenAICompatibleProvider(config, fetcher).interpret(context);
      expect(plan).toEqual({kind:'speak', private:false, words:[first, last]});
      expect(turnPlanSchemaFor(context).parse(plan)).toEqual(plan);
      if (plan.kind !== 'speak') throw Error('expected speech');
      expect(spokenPlanWords(plan.words)).toBe(first + '\n' + last);
    });

  it('多说话人或夹有被引用的资料时，仅提交模型逐段指定的玩家台词', () => {
    const input = '我说：“开门。”卫兵答：“等着。”我接着说：“我就在门口。”';
    const schema = turnPlanSchemaFor(scene(input));
    const chosen = {kind:'speak', private:false, words:['开门。', '我就在门口。']};
    expect(schema.parse(chosen)).toEqual(chosen);
    expect(schema.safeParse({...chosen,words:'开门。我就在门口。'}).success).toBe(false);
    expect(schema.safeParse({...chosen,words:['开门。”卫兵答：“等着。']}).success).toBe(false);
    const reading = {kind:'speak', private:false, words:['早。'], reading:{documentId:'agenda',source:'查看“议程”'}};
    const combined = turnPlanSchemaFor(scene('“早。”我说，随后查看“议程”'));
    expect(combined.parse(reading)).toEqual(reading);
    expect(combined.parse({...reading,words:'早。'})).toEqual({...reading,words:'早。'});
    expect(schema.parse({...chosen,words:'开门。'})).toEqual({...chosen,words:'开门。'});
  });

  it('模型随第一段台词提供实际的动作描写时，保留出处，只把两句原话当发言', async () => {
    const observed = {kind:'speak', private:false, words:first, source:gesture};
    const context = scene(interruptedLine);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(observed));
    const plan = await new OpenAICompatibleProvider(config,fetcher).interpret(context);
    expect(plan).toEqual({...observed,words:[first,last]});
    expect(turnPlanSchemaFor(context).parse(plan)).toEqual(plan);
  });

  it.each([last, '我挥了挥手', first + '”' + gesture, '，'])('拒绝不属于引语外实际描写的发言 source：%s', source => {
    const result = turnPlanSchemaFor(scene(interruptedLine)).safeParse({kind:'speak', private:false, words:first, source});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({code:'custom',path:['source']}));
  });

  it.each([{words:[last,first]}, {words:[first,first]}, {words:[first,'他的下场很坏']},
    {words:[first,gesture,last]}, {words:first + '”' + gesture + '“' + last}])(
    '拒绝重排、重复、虚构或把动作说出口的计划 %#', ({words}) => {
      const result = turnPlanSchemaFor(scene(interruptedLine)).safeParse({kind:'speak', private:false, words});
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({code:'custom',path:['words']}));
    });
});
