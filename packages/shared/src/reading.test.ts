import { describe, expect, it } from 'vitest';
import { readPlayerInput } from './player-input';
import { isPrivateSpeech } from './speech';

const people = ['艾琳', '罗兰'];
const documents = ['朝会议程', '议程', '议程单', '长桌', '巡园清单', '石案', '交接簿'];
const parse = (text: string) => readPlayerInput(text, people, ['议事厅'], documents);

describe('亲自阅读场景中已有的文书', () => {
  it.each([
    '"早，艾琳"——我回复道，顺手看了看长桌，想知道有哪些议程',
    '“早，艾琳”——我回复道，顺手看了看长桌，想知道有哪些议程。',
    '我说：“早，艾琳”，随后看一眼长桌。',
    '「早，艾琳」，我回复道，低头看了看长桌。',
  ])('把 %s 里的原话和观察分开，问候只到引号为止', text => {
    const action = parse(text);
    expect(action?.intent).toEqual({kind:'speak', target:'艾琳'});
    expect(action?.dialogue).toEqual({text:'早，艾琳', addressee:'艾琳'});
    expect(action?.speechInput).not.toMatch(/顺手|看一眼|长桌/u);
    expect(action?.reading).toEqual({target:'长桌'});
  });

  it('耳语音量取自发言自己的归属，阅读意图不会加入发言', () => {
    const action = parse('“早，艾琳”——我只对艾琳说，顺手看了看长桌。');
    expect(action?.reading?.target).toBe('长桌');
    expect(action?.dialogue?.text).toBe('早，艾琳');
    expect(isPrivateSpeech(action!.speechInput!)).toBe(true);
  });
  it('阅读目的提及的行程仅是玩家想弄清楚的事情', () => {
    const action = parse('“早，艾琳”——我答道，顺手看长桌，想知道待会要去宫门吗？');
    expect(action?.dialogue?.text).toBe('早，艾琳');
    expect(action?.reading).toEqual({target:'长桌'});
    expect(action?.movement).toBeUndefined();
  });

  it.each([
    ['我看了看长桌', {target:'长桌'}],
    ['我看了下交接簿，看看上面写了什么', {target:'交接簿'}],
    ['我看了一下那本交接簿，看看里面写了什么？', {target:'交接簿'}],
    ['我正在检视长桌上的朝会议程', {target:'朝会议程'}],
    ['我看看长桌上的朝会议程', {target:'朝会议程'}],
    ['我看看长桌上有哪些议程', {target:'议程'}],
    ['我扫一眼长桌上的议程', {target:'议程'}],
    ['看一眼议程上写了什么', {target:'议程'}],
    ['看一眼议程上写了什么？', {target:'议程'}],
    ['顺手看长桌，想知道有哪些议程', {target:'长桌'}],
    ['我阅读桌上那份《朝会议程》', {target:'朝会议程'}],
    ['我细读朝会议程中的第二项', {target:'朝会议程', section:2}],
    ['查看第十二项议程', {target:'议程', section:12}],
    ['阅读议程中关于宫门交班的一项', {target:'议程', section:'宫门交班'}],
    ['阅读巡园清单中的《查验落锁》', {target:'巡园清单', section:'查验落锁'}],
    ['看查验落锁那一项', {target:'', section:'查验落锁'}],
    ['看下一项议程', {target:'议程',resume:true, nextOnly:true}],
    ['读议程的下一项', {target:'议程',resume:true, nextOnly:true}],
    ['我继续阅读巡园清单', {target:'巡园清单', resume:true}],
    ['继续阅读', {target:'', resume:true}],
    ['接着看下一项', {target:'', resume:true, nextOnly:true}],
  ])('读取玩家实际指称的文书或条目：%s', (text, reading) => {
    const action = parse(String(text));
    expect(action?.intent.kind).toBe('investigate');
    expect(action?.reading).toEqual(reading);
    expect(action?.dialogue).toBeUndefined();
  });

  it.each([
    '“早，艾琳，顺手看了看长桌，想知道有哪些议程。”我说',
    '我对艾琳说：“你去阅读朝会议程。”', '我对艾琳说，去看看朝会议程',
    '艾琳看了看长桌', '我让艾琳阅读朝会议程', '“早，艾琳”她说道，顺手阅读议程',
    '“早”——我回复道，让艾琳看看议程', '“早”——我回复道，我不看议程',
    '如果我阅读朝会议程会怎么样', '我昨天读过朝会议程', '我不想继续阅读',
    '我看朝会议程吗？', '我读朝会议程，然后前往宫门', '我看议程，算了',
    '我看长桌旁的鞋印，想知道有哪些议程', '我阅读值夜登记簿', '我看了看印玺',
    '去档案室读议程', '“早”我回复道，顺手阅读议程，然后去宫门',
    '我没看交接簿，看看上面写了什么', '侍卫看了下交接簿，看看上面写了什么',
    '我看了下交接簿，看看墙上写了什么', '我看了下交接簿的封皮，看看上面写了什么',
    '我对侍卫说：“看看交接簿上面写了什么。”',
  ])('不因提及文书而越权阅读：%s', text => {
    expect(parse(text)?.reading).toBeUndefined();
  });
});
