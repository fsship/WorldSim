import { describe, expect, it, vi } from 'vitest';
import { isPrivateSpeech, readDialogueLine, readQuotedSpeech, type DialogueContext, type LlmCallAttempt, type ParseContext, type ProviderConfig } from '@worldsim/shared';
import { MockLLMProvider, OpenAICompatibleProvider, createProvider } from './index';

const config: ProviderConfig = {
  mode: 'openai', baseUrl: 'https://example.invalid/v1/', apiKey: 'test-only',
  model: 'fixture-model', temperature: 0.3, timeoutMs: 1000, maxTokens: 800, retries: 1,
};
const parseContext: ParseContext = { text: '看看议事厅', location: '议事厅', exits: [], people: [], items: [] };
function completion(content: string | null, finish_reason = 'stop') {
  return Response.json({ choices: [{ finish_reason, message: { content } }] });
}

describe('OpenAI 兼容协议', () => {
  it('uses separate, stateless messages for each role and keeps narration observation-only', async () => {
    const payloads: { messages: { role: string; content: string }[]; model: string; max_completion_tokens: number }[] = [];
    const replies = ['{"kind":"look"}', '{"optionId":"seen"}', '{"lines":[{"index":0,"style":"plain"}]}'];
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe('https://example.invalid/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-only');
      payloads.push(JSON.parse(init?.body as string));
      return completion(replies.shift()!);
    };
    const p = new OpenAICompatibleProvider(config, fetcher);
    await p.parse(parseContext);
    await p.resolve({ text: '练习朗诵', intent: { kind: 'attempt' }, location: '议事厅',
      actor: { name: '国王', role: '国王', abilities: [] }, options: [{ id: 'seen', summary: '晨光穿过高窗。' }],
    });
    const observation = { kind: 'world' as const, text: '晨光穿过高窗。' };
    await p.narrate({ observations: [observation] });
    expect(new Set(payloads.map(body => body.messages[0].content)).size).toBe(3);
    expect(payloads[2].messages).toHaveLength(2);
    expect(JSON.parse(payloads[2].messages[1].content)).toEqual({ observations: [observation] });
    expect(JSON.stringify(payloads[2])).not.toContain('练习朗诵');
    expect(payloads[0]).toMatchObject({ model: config.model, max_completion_tokens: config.maxTokens });
  });

  it.each([
    () => completion('not JSON'),
    () => completion('{"kind":"look","setRole":"emperor"}'),
    () => completion('{"kind":"look"}', 'length'),
    () => new Response('unavailable', { status: 503 }),
  ])('retries malformed, unexpected, truncated or transient responses once', async invalid => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(invalid()).mockResolvedValueOnce(completion('{"kind":"attempt"}'));
    expect(await new OpenAICompatibleProvider(config, fetcher).parse(parseContext)).toEqual({ kind: 'attempt' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([,init]) => !('reasoning_effort' in JSON.parse(String(init?.body))))).toBe(true);
  });
  it('stops after the retry limit and does not expose response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('private upstream detail', { status: 429 }));
    await expect(new OpenAICompatibleProvider(config, fetcher).parse(parseContext)).rejects.toThrow('模型服务暂时无法');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry an invalid API key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('wrong credential test-only', { status: 401 }));
    await expect(new OpenAICompatibleProvider(config, fetcher).parse(parseContext)).rejects.toThrow('模型服务暂时无法');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { param: 'temperature', code: 'unsupported_value' },
    { message: "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported." },
    { message: 'This model does not support the temperature parameter.' },
  ])('resends without an explicitly unsupported temperature and remembers the setting for narration', async error => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error }, { status: 400 }))
      .mockResolvedValueOnce(completion('{"kind":"look"}'))
      .mockResolvedValueOnce(completion('{"lines":[{"index":0,"style":"plain"}]}'));
    const provider = new OpenAICompatibleProvider({ ...config, retries: 0 }, fetcher);
    expect(await provider.parse(parseContext)).toEqual({ kind: 'look' });
    await provider.narrate({ observations: [{ kind: 'world', text: '晨光穿过高窗。' }] });
    const [first, second, third] = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(first.temperature).toBe(config.temperature);
    const { temperature: _, ...withoutTemperature } = first;
    expect(second).toEqual(withoutTemperature);
    expect(third).not.toHaveProperty('temperature');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('stops after one compatibility attempt if the 400 response repeats', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { param: 'temperature', code: 'unsupported_parameter' } }, { status: 400 }));
    await expect(new OpenAICompatibleProvider(config, fetcher).parse(parseContext)).rejects.toThrow('模型服务暂时无法');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { param: 'model', code: 'unsupported_parameter', message: 'Unsupported model.' },
    { message: 'The temperature is valid; response_format is unsupported.' },
    { message: 'temperature must be between 0 and 2' },
    { message: 'secret'.repeat(4000) + ' Unsupported parameter: temperature' },
  ])('keeps unrelated or oversized 400 errors terminal and private', async error => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error }, { status: 400 }));
    await expect(new OpenAICompatibleProvider(config, fetcher).parse(parseContext))
      .rejects.toThrow(/^模型服务暂时无法返回有效结果，请检查模型配置并重试。$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('aborts a stalled request and bounds repeated timeout attempts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true })));
    await expect(new OpenAICompatibleProvider({ ...config, retries: 0 }, fetcher).parse(parseContext))
      .rejects.toMatchObject({task:'parse', reason:'timeout'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects credentials embedded in URLs and remote cleartext endpoints', () => {
    for (const baseUrl of ['https://user:pass@example.invalid/v1', 'https://example.invalid/?key=secret', 'http://example.invalid']) {
      expect(() => new OpenAICompatibleProvider({ ...config, baseUrl })).toThrow();
    }
  });
});

describe('NPC 台词编写和独立审查', () => {
  const context: DialogueContext = {
    speaker: { name: '艾琳', role: '侍从' }, player: { name: '国王', role: '国王' },
    location: '议事厅', present: [{ name: '罗兰', role: '卫队长' }],
    listeners:['国王','罗兰'], recentNotices:[{ time:495, text:'钟声响过。' }],
    input: '除了晨会，还有其他消息吗？', decision: '双方在场，可以交谈。',
    history: [{ role:'player', text:'晨报讲了什么？' }, { role:'npc', text:'今日会在这里开晨会。' },
      { role:'overheard', speaker:'罗兰', text:'您刚才问的是晨报。' }],
    facts: [{ id:'meeting', text:'今日的晨会将在议事厅举行。' }],
  };
  const draft = { text:'您问的是晨报以外的进展。那我眼下还说不准。', factIds:[] };
  const accepted = { grounded:true, playerAgency:true, citationsAccurate:true };
  const commission = {...context,input:'请你去市集，当着路人和林岚的面，公开宣布我的决定：下午照常开门。我等你回来。'};
  const promise = {text:'我这就去市集，当面向林岚和路人转达你的原话。',factIds:[]};
  const relay = {acceptsEntireReply:true,destination:'市集',audience:{kind:'room',name:'林岚'},message:'下午照常开门'};
  it.each([
    accepted,
    {...accepted,relay:null},
    {...accepted,relay:{acceptsEntireReply:true}},
    {...accepted,relay:{...relay,message:'今天不营业'}},
  ])('requires an explicit complete relay decision and corrects the review within its existing retry budget', async invalid => {
    const entries: LlmCallAttempt[] = [];
    const valid = {...accepted,relay};
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(JSON.stringify(invalid)))
      .mockResolvedValueOnce(completion(JSON.stringify(valid)));
    const provider = new OpenAICompatibleProvider(config,fetcher,entry=>entries.push(entry));
    expect(await provider.reviewDialogue({context:commission,draft:promise})).toEqual(valid);
    const [first,second] = entries.map(entry=>JSON.parse(entry.requestBody));
    expect(first.messages[0].content).toContain('必填字段 relay');
    expect(second.messages[0].content).toContain('上次 relay');
    expect(second.messages[1]).toEqual(first.messages[1]);
    expect(first.max_completion_tokens).toBe(second.max_completion_tokens);
    expect(entries.map(entry=>entry.errorReason)).toEqual(['relay_verdict',null]);
  });
  it('fails closed when the reviewed promise still lacks a usable decision after the retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async()=>completion(JSON.stringify(accepted)));
    const provider = new OpenAICompatibleProvider(config,fetcher);
    await expect(provider.reviewDialogue({context:commission,draft:promise})).rejects.toMatchObject({reason:'format'});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['这事我不能去办。','如果能找人替我，我会去说。','请问要我转告谁？','我已经把这句话听清楚了。'])('keeps a reply with no new commitment when the review explicitly returns null: %s', async text => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(JSON.stringify({...accepted,relay:null})));
    const provider = new OpenAICompatibleProvider(config,fetcher);
    expect(await provider.reviewDialogue({context:commission,draft:{text,factIds:[]}})).toEqual(accepted);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts an explicit negative appraisal without turning the rejected draft into a promise', async () => {
    const refused = {...accepted,grounded:false};
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(JSON.stringify({...refused,relay:null})));
    expect(await new OpenAICompatibleProvider(config,fetcher).reviewDialogue({context:commission,draft:promise})).toEqual(refused);
  });
  it('keeps a request to tell the player what happened on the ordinary review protocol', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(JSON.stringify(accepted)));
    const provider = new OpenAICompatibleProvider(config,fetcher);
    expect(await provider.reviewDialogue({context:{...context,input:'请告诉我罗兰去了哪里？'},draft})).toEqual(accepted);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).messages[0].content).not.toContain('必填字段 relay');
  });
  it.each(['', null])('retries a truncated review with lower effort and the same budget, evidence and review standard', async content => {
    const refused = { ...accepted, grounded:false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion(content,'length'))
      .mockResolvedValueOnce(completion(JSON.stringify(refused)))
      .mockResolvedValueOnce(completion(JSON.stringify(accepted)));
    const entries: LlmCallAttempt[] = [];
    const provider = new OpenAICompatibleProvider(config,fetcher,entry => entries.push(entry));
    expect(await provider.reviewDialogue({context,draft})).toEqual(refused);
    await provider.reviewDialogue({context,draft});
    const [first,retry,next] = entries.map(entry => JSON.parse(entry.requestBody));
    expect(first).not.toHaveProperty('reasoning_effort');
    expect(first.max_completion_tokens).toBe(config.maxTokens);
    expect(retry).toEqual({...first,reasoning_effort:'low'});
    expect(next).toEqual(first);
    expect(entries.map(entry => entry.errorReason)).toEqual(['review_length',null,null]);
  });
  it('does not negotiate reasoning effort for a malformed but untruncated review', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion('{'))
      .mockResolvedValueOnce(completion(JSON.stringify(accepted)));
    await new OpenAICompatibleProvider(config,fetcher).reviewDialogue({context,draft});
    const bodies = fetcher.mock.calls.map(([,init]) => JSON.parse(String(init?.body)));
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(bodies[1]).toEqual(bodies[0]);
  });
  it('honors zero configured retries after an empty length response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion('','length'));
    await expect(new OpenAICompatibleProvider({...config,retries:0},fetcher).reviewDialogue({context,draft}))
      .rejects.toMatchObject({reason:'format'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns to the normal parameters if the low-effort generation fails for a different reason', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(completion('','length'))
      .mockResolvedValueOnce(completion('{')).mockResolvedValueOnce(completion(JSON.stringify(accepted)));
    await new OpenAICompatibleProvider({...config,retries:2},fetcher).reviewDialogue({context,draft});
    expect(fetcher.mock.calls.map(([,init]) => JSON.parse(String(init?.body)).reasoning_effort))
      .toEqual([undefined,'low',undefined]);
  });
  it('records an explicit low-effort parameter rejection and retries with the endpoint default', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion('','length'))
      .mockResolvedValueOnce(Response.json({error:{param:'reasoning_effort',code:'unsupported_value'}},{status:400}))
      .mockResolvedValueOnce(completion(JSON.stringify(accepted)))
      .mockResolvedValueOnce(completion('','length'))
      .mockResolvedValueOnce(completion(JSON.stringify(accepted)));
    const entries: LlmCallAttempt[] = [];
    const provider = new OpenAICompatibleProvider(config,fetcher,entry => entries.push(entry));
    await provider.reviewDialogue({context,draft});
    await provider.reviewDialogue({context,draft});
    expect(entries.map(entry => JSON.parse(entry.requestBody).reasoning_effort))
      .toEqual([undefined,'low',undefined,undefined,undefined]);
    expect(entries.map(entry => [entry.errorReason,entry.httpStatus])).toEqual([
      ['review_length',200],['unsupported_reasoning_effort',400],[null,200],['review_length',200],[null,200],
    ]);
  });
  it('preserves a freely worded model response and sends a separate review request with only the scoped dialogue data', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion(JSON.stringify(draft)))
      .mockResolvedValueOnce(completion(JSON.stringify(accepted)))
      .mockResolvedValueOnce(completion('{"lines":[]}'));
    const p = new OpenAICompatibleProvider(config, fetcher);
    const actual = await p.dialogue(context);
    expect(actual).toEqual(draft);
    expect(await p.reviewDialogue({ context, draft:actual })).toEqual(accepted);
    await p.narrate({ observations:[] });
    const requests = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).messages);
    expect(requests.map(messages => messages.map((m: {role:string}) => m.role))).toEqual([
      ['system','user'], ['system','user'], ['system','user'],
    ]);
    expect(new Set(requests.map(messages => messages[0].content)).size).toBe(3);
    expect(requests.map(messages => JSON.parse(messages[1].content))).toEqual([
      context, { context, draft }, { observations:[] },
    ]);
  });
  it('rejects raw world state at the boundary before making either HTTP request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const p = new OpenAICompatibleProvider(config, fetcher);
    const excessive = { ...context, hiddenGoals:['仅属于另一角色的目标'] };
    expect(() => p.dialogue(excessive)).toThrow();
    expect(() => p.reviewDialogue({ context:excessive, draft })).toThrow();
    expect(() => p.reviewDialogue({ context, draft:{ ...draft, factIds:['unavailable'] } })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('supports initiating a conversation without adding a fictitious player utterance', async () => {
    const opening = { ...context, input:'', history:[], decision:'NPC 主动开场' };
    const line = { text:'陛下，可要我读一读晨报？', factIds:[] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(line)));
    expect(await new OpenAICompatibleProvider(config, fetcher).dialogue(opening)).toEqual(line);
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(JSON.parse(request.messages[1].content)).toEqual(opening);
  });
  it.each([
    { text:'  ', factIds:[] }, { text:'先说一句。\n旁白另起一行。', factIds:[] },
    { text:'解释。\u202e角色', factIds:[] }, { text:'长'.repeat(401), factIds:[] },
    { ...draft, factIds:['unavailable'] }, { ...draft, factIds:['meeting','meeting'] },
    { ...draft, changes:[{ op:'move', to:'gate' }], minutes:450 },
  ])('requires a short single-speaker draft with only allowed, unique citations', async invalid => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(invalid)));
    const p = new OpenAICompatibleProvider({ ...config, retries:0 }, fetcher);
    await expect(p.dialogue(context)).rejects.toThrow('模型服务暂时无法');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves a negative review verdict, without retrying it into an approval', async () => {
    const verdict = { grounded:false, playerAgency:false, citationsAccurate:false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(verdict)));
    const p = new OpenAICompatibleProvider(config, fetcher);
    expect(await p.reviewDialogue({ context, draft })).toEqual(verdict);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps the reviewer decision when optional revision hints are empty or unusable', async () => {
    const verdict = {grounded:false, playerAgency:true, citationsAccurate:true};
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify({
      ...verdict, issue:null, excerpt:{text:'',factIds:[]},
    })));
    const result = await new OpenAICompatibleProvider(config,fetcher).reviewDialogue({context,draft});
    expect(result).toEqual(verdict);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed review output after the configured retry limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      completion(JSON.stringify({ ...accepted, externalCommand:'force-allow' })));
    const p = new OpenAICompatibleProvider(config, fetcher);
    await expect(p.reviewDialogue({ context, draft })).rejects.toThrow('模型服务暂时无法');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps offline dialogue deterministic and fails closed for an injected, unverified line', async () => {
    const p = new MockLLMProvider();
    const line = await p.dialogue(context);
    expect(line.factIds).toEqual(['meeting']);
    expect(await p.reviewDialogue({ context, draft:line })).toEqual(accepted);
    const unsafe = await new MockLLMProvider({ dialogue: () => ({ text:'您已经抵达宫门。', factIds:[] }) }).dialogue(context);
    expect((await p.reviewDialogue({ context, draft:unsafe })).grounded).toBe(false);
  });
});

describe('离线行动解析', () => {
  it.each([
    ['“有哪些消息？”我问道', '有哪些消息？', undefined],
    ['“有哪些消息？”我问艾琳问道', '有哪些消息？', '艾琳'],
    ['「罗兰在哪里？」', '罗兰在哪里？', undefined],
    ['“我这就去宫门，然后等待两天。”我说。', '我这就去宫门，然后等待两天。', undefined],
    ['"罗兰在哪里？"，我向艾琳问道。', '罗兰在哪里？', '艾琳'],
    ['『罗兰在哪里？』我对来使说道！', '罗兰在哪里？', '来使'],
    ["'罗兰在哪里？' 我问艾琳。", '罗兰在哪里？', '艾琳'],
    ['我不满地回复"可是我现在就在议事厅啊？回答我的问题！"', '可是我现在就在议事厅啊？回答我的问题！', undefined],
    ['我对艾琳不满地说：“罗兰知道吗？”', '罗兰知道吗？', '艾琳'],
    ['我不满地向艾琳反问「罗兰在哪里？」', '罗兰在哪里？', '艾琳'],
    ["我不满地回答艾琳：'去宫门等两天。'", '去宫门等两天。', '艾琳'],
    ['我追问道：『罗兰呢？』', '罗兰呢？', undefined],
    ['我没好气地回应：“我就在议事厅！”', '我就在议事厅！', undefined],
    ['告诉艾琳：“还有消息吗？”', '还有消息吗？', '艾琳'],
    ['回复：“罗兰在哪里？”', '罗兰在哪里？', undefined],
    ['我告诉卫队长：“我打算前往宫门，然后等待两天。”', '我打算前往宫门，然后等待两天。', '卫队长'],
  ] as const)('keeps attribution separate from the utterance: %s', async (input, text, addressee) => {
    expect(readQuotedSpeech(input)).toEqual(addressee ? {text, addressee} : {text});
    const action = await createProvider().parse({ ...parseContext, text: input, people: ['艾琳', '罗兰'] });
    expect(action).toEqual(addressee ? {kind: 'speak', target: addressee} : {kind: 'speak'});
  });
  it('separates a present name from an unfamiliar trailing manner, with or without quotes', () => {
    const line = {text:'还有消息吗？', addressee:'艾琳'};
    expect(readDialogueLine('我对艾琳半信半疑地回复：“还有消息吗？”', ['艾琳'])).toEqual(line);
    expect(readDialogueLine('我对艾琳半信半疑地回复：还有消息吗？', ['艾琳'])).toEqual(line);
    expect(readDialogueLine('我没有明确地回复：还有消息吗？')).toBeUndefined();
  });
  it.each([
    ['我低声对艾琳说：“晨报到了吗？”', '艾琳'],
    ['“晨报到了吗？”我压低声音问艾琳。', '艾琳'],
    ['我凑近艾琳耳语：“晨报到了吗？”', '艾琳'],
    ['“晨报到了吗？”我在艾琳耳边问。', '艾琳'],
    ['我对艾琳悄悄地说：晨报到了吗？', '艾琳'],
    ['我小声问艾琳晨报到了吗？', '艾琳'],
    ['我私下告诉艾琳晨报到了吗？', '艾琳'],
    ['我偷偷地对艾琳说：“晨报到了吗？”', '艾琳'],
    ['我对艾琳秘密地说：“晨报到了吗？”', '艾琳'],
    ['我只告诉艾琳，晨报到了吗？', '艾琳'],
    ['我只对艾琳说：“晨报到了吗？”', '艾琳'],
    ['我仅对艾琳说：“晨报到了吗？”', '艾琳'],
    ['我单独向艾琳说：“晨报到了吗？”', '艾琳'],
    ['“晨报到了吗？”我私底下问艾琳。', '艾琳'],
    ['我在耳边对艾琳说：“晨报到了吗？”', '艾琳'],
    ['我凑到艾琳的耳边问：“晨报到了吗？”', '艾琳'],
    ['我小声说：“晨报到了吗？”', undefined],
  ] as const)('recognizes a private delivery separately from its words: %s', (input, addressee) => {
    expect(isPrivateSpeech(input)).toBe(true);
    expect(readDialogueLine(input, ['艾琳'])).toEqual(addressee ? {text:'晨报到了吗？', addressee} : {text:'晨报到了吗？'});
  });
  it.each(['“你刚才在跟谁耳语？”我问道', '“这个秘密是谁悄悄告诉你的？”', '我说：低声点，大家。', '我说要私下告诉艾琳',
    '为什么他要悄悄说话？', '“我只告诉艾琳，口令是青鸢。”我随口问道', '我对艾琳说：“为什么要偷偷地说？”',
    '我说：你能秘密地去办吗？', '我只说一句：“我明白了。”'])('keeps a public line about a whisper public: %s', input => {
    expect(isPrivateSpeech(input)).toBe(false);
  });
  it.each(['随口', '朗声', '开口'])('recognizes an ordinary %s attribution without converting it to a whisper', async manner => {
    const text = '“怎么官员们还没来？”我' + manner + '问道';
    expect(readDialogueLine(text)).toEqual({text:'怎么官员们还没来？'});
    expect(isPrivateSpeech(text)).toBe(false);
    expect(await createProvider().parse({...parseContext, text, people:['艾琳', '罗兰']})).toEqual({kind:'speak'});
  });
  it('an absent addressee can have a reporting verb in their title, and a private-sounding name can be addressed publicly', () => {
    expect(isPrivateSpeech('我对传令官秘密地说：“晨报到了吗？”')).toBe(true);
    expect(isPrivateSpeech('我只向顾问低声说：“晨报到了吗？”')).toBe(true);
    expect(isPrivateSpeech('我对秘密使者说：“晨报到了吗？”')).toBe(false);
  });
  it('recognizes a private command and keeps its explicit recipient', async () => {
    const text = '我私下命令罗兰加强宫门守备';
    expect(isPrivateSpeech(text)).toBe(true);
    expect(await createProvider().parse({...parseContext, text, people:['艾琳', '罗兰']})).toEqual({kind:'order', target:'罗兰'});
  });
  it.each([
    '“我想去宫门。”艾琳说', '假如我说“去宫门”', '“晨报送达了吗？', '“消息呢？」我问道',
    '“消息呢？”我问道，然后前往宫门', '“消息呢？”我问艾琳然后前往宫门', '“消息呢？”“我马上就到。”',
    '艾琳不满地回复“有哪些消息？”', '如果我不满地回复“有哪些消息？”', '我想象自己回答“有哪些消息？”',
    '我没有回复艾琳“有哪些消息？”', '我对艾琳没说“去宫门”', '我不敢回答“去哪儿？”',
    '我走到宫门不满地说“去宫门”', '艾琳生气地回复“去宫门”', '我转身离开并回复“去宫门”', '我不满地回复“去哪儿？”然后返回议事厅',
    '我回复艾琳后逮捕国王：“去宫门”', '我不满地回复“晨报到了吗？', '我低声说「去哪儿？”',
  ])('does not grant a quoted-speech intent to incomplete or compound input: %s', input => {
    expect(readQuotedSpeech(input)).toBeUndefined();
  });
  it('recognizes standalone questions and uses vocatives rather than the subject of the question', async () => {
    for (const [input, text, addressee] of [
      ['有哪些消息？', '有哪些消息？', undefined],
      ['还有什么消息？', '还有什么消息？', undefined],
      ['艾琳，有哪些消息？', '有哪些消息？', '艾琳'],
      ['陌生人, 谁见过罗兰？', '谁见过罗兰？', '陌生人'],
    ] as const) {
      expect(readDialogueLine(input)).toEqual(addressee ? {text, addressee} : {text});
      const intent = await createProvider().parse({ ...parseContext, text: input, people: ['艾琳', '罗兰'] });
      expect(intent).toEqual(addressee ? {kind: 'speak', target: addressee} : {kind: 'speak'});
    }
    for (const input of ['前往档案室？', '有哪些消息？随后逮捕卫兵', '艾琳问道，有哪些消息？', '如果有消息，是什么？']) {
      expect(readDialogueLine(input)).toBeUndefined();
    }
  });
  it.each([
    ['等待 30 分钟', { kind: 'wait', minutes: 30 }],
    ['等待半小时', { kind: 'wait', minutes: 30 }],
    ['等待下一件重要事件', { kind: 'wait_event' }],
    ['休息至 09:00', { kind: 'rest', clock: '09:00' }],
    ['我告诉卫兵自己是皇帝', { kind: 'speak', target: '卫兵' }],
    ['我取出背包里的核弹', { kind: 'use', item: '核弹' }],
  ])('parses %s', async (text, intent) => {
    expect(await createProvider().parse({ ...parseContext, text: String(text), people: ['卫兵'] })).toMatchObject(intent as object);
  });
  it('validates injected results with the production schema', async () => {
    const p = new MockLLMProvider({ parse: () => ({ kind: 'look', op: 'create_item' }) });
    await expect(p.parse(parseContext)).rejects.toThrow();
  });
});
