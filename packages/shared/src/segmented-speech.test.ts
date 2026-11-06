import { describe, expect, it } from 'vitest';
import { readPlayerInput } from './player-input';
import { isPrivateSpeech, quoteSpans, readQuotedSpeech, readSegmentedSpeech } from './speech';

const people = ['艾琳', '罗兰'];

describe('穿插叙述的多段发言', () => {
  it.each([
    ['“如果他能现在自守，我可以既往不咎，否则，”我审视着在场的诸多人物“他的下场可不会好”',
      '如果他能现在自守，我可以既往不咎，否则，\n他的下场可不会好'],
    ['“你们当中有部分人打算背叛我”我不紧不慢地说道。\n“我已经知道此人是谁，对此，我会采取一些适当的措施的”',
      '你们当中有部分人打算背叛我\n我已经知道此人是谁，对此，我会采取一些适当的措施的'],
    ['我说道：「先听我说。」我顿了顿，“当时有人说『站住』。”我环顾四周。“还有人听见吗？”',
      '先听我说。\n当时有人说『站住』。\n还有人听见吗？'],
  ])('保留玩家所有台词及内层引号，插语留在发言外', (input, expected) => {
    const dialogue = {text:expected};
    expect(readSegmentedSpeech(input, people)).toEqual(dialogue);
    expect(readPlayerInput(input, people, [])?.dialogue).toEqual(dialogue);
  });

  it('保留私语听者与音量，只从引语之外读取说话方式', () => {
    const quiet = '我悄悄对艾琳说：“等一下。”我看向罗兰。“有人来了。”';
    expect(readSegmentedSpeech(quiet, people)).toEqual({text:'等一下。\n有人来了。', addressee:'艾琳'});
    expect(isPrivateSpeech(quiet)).toBe(true);
    const loud = '“等一下。”我看向罗兰。“你为什么悄悄告诉艾琳？”';
    expect(isPrivateSpeech(loud)).toBe(false);
  });

  it.each([
    '“甲。”“乙。”', '“甲。”艾琳答道：“乙。”', '我模仿艾琳说道：“甲。”我说道，“乙。”',
    '假如我说：“甲。”我说：“乙。”', '“甲。”我审视着她复述的话：“乙。”',
    '“甲。”我没说：“乙。”', '“甲。”我走进花园：“乙。”', '“甲。”我停下来等五分钟。“乙。”',
    '我对艾琳说：“甲。”我对罗兰说：“乙。”', '“艾琳，甲。”我说。“罗兰，乙。”',
    '我低声对艾琳说：“甲。”我高声对艾琳说：“乙。”', '“甲。”我说“乙。', '“甲。”我说「乙。”',
  ])('发言归属或听众不清楚时不自动合并：%s', input => {
    expect(readSegmentedSpeech(input, people)).toBeUndefined();
    expect(readQuotedSpeech(input, people)).toBeUndefined();
  });

  it('按原文位置返回最外层引语，保留空白、嵌套引语和英语撇号', () => {
    const input = '📜“ 他说「别走」。”我问，\'Don\'t go.\'';
    const spans = quoteSpans(input);
    expect(spans.map(span => span.text)).toEqual([' 他说「别走」。', "Don't go."]);
    expect(spans.map(span => input.slice(span.start, span.end))).toEqual(['“ 他说「别走」。”', "'Don't go.'"]);
    expect(spans[0].start).toBe(2);
    expect(quoteSpans('“甲。”我说“乙。')).toEqual([]);
    expect(quoteSpans('“甲。」我说“乙。”')).toEqual([]);
  });
});
