import type { ActionIntent } from './contracts';

interface WaitAction {
  intent: ActionIntent;
  eventNeedle?: string;
  invalidTime?: true;
  resume?: true;
  day?: '今天' | '明天';
}

const subject = /^(?:我(?:想要|打算|决定|准备|想|要)?\s*)?/u;
const modifiers = /^(?:(?:暂且|暂时|耐心地?|静静地?|安静地?|先|再|继续|接着|就|请|试着|尝试)\s*)+/u;
const waitVerb = /^(等候|等待|等到|静候|等一等|等等(?:看)?|等着|等|休息|歇息|小憩|休整|睡到|睡觉|歇一歇)/u;
const numbers = '[0-9]+(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百]+';
const digits = '零一二三四五六七八九';

function numberValue(text: string): number {
  if (/^\d/u.test(text)) return Number(text);
  const input = text.replace(/两/gu, '二').replace(/〇/gu, '零');
  if (!/[十百]/u.test(input)) return Number([...input].map(d => digits.indexOf(d)).join(''));
  const parts = /^(?:([一二三四五六七八九])百零?)?(?:([一二三四五六七八九])?十)?([一二三四五六七八九])?$/u.exec(input);
  if (!parts) return NaN;
  return Math.max(0, digits.indexOf(parts[1])) * 100 +
    (input.includes('十') ? (parts[2] ? digits.indexOf(parts[2]) : 1) * 10 : 0) +
    Math.max(0, digits.indexOf(parts[3]));
}

const durationTerm = new RegExp('^(半|' + numbers + ')\\s*个?(半)?\\s*(小时|钟头|分钟|分|刻钟|天)(半)?', 'u');
const scales: Record<string, number> = {小时:60, 钟头:60, 分钟:1, 分:1, 刻钟:15, 天:1440};

function duration(text: string): number | undefined {
  let rest = text.trim(), total = 0;
  if (!rest) return;
  while (rest) {
    const match = durationTerm.exec(rest);
    if (!match) return;
    const n = match[1] === '半' ? 0.5 : numberValue(match[1]);
    total += (n + (match[2] || match[4] ? 0.5 : 0)) * scales[match[3]];
    rest = rest.slice(match[0].length).trim();
  }
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

const clockPattern = new RegExp('^(今天|明天)?(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?(' + numbers +
  ')(?:[:：](\\d{1,2})|[点时](半|一刻|三刻|(?:' + numbers + ')分?)?(?:整)?)$', 'u');

function clockTime(text: string, kind: 'wait' | 'rest'): WaitAction | undefined {
  const parts = clockPattern.exec(text.replace(/\s+/gu, ''));
  if (!parts) return;
  let hour = numberValue(parts[3]);
  const suffix = parts[5];
  const minutes = parts[4] ? Number(parts[4]) : !suffix ? 0 : suffix === '半' ? 30 :
    suffix === '一刻' ? 15 : suffix === '三刻' ? 45 : numberValue(suffix.replace(/分$/u, ''));
  if (!Number.isInteger(hour) || !Number.isInteger(minutes) || hour > 23 || minutes > 59) return;
  const period = parts[2];
  if (/^(?:凌晨|晚上|夜里)$/u.test(period) && hour === 12) hour = 0;
  else if ((/^(?:下午|傍晚|晚上|夜里)$/u.test(period) && hour < 12) ||
    (period === '中午' && hour >= 1 && hour <= 3)) hour += 12;
  const clock = String(hour).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
  return {intent:{kind, clock}, day:parts[1] as WaitAction['day']};
}

/** Parse the current player's first waiting clause. Amounts come from that clause alone. */
export function readWaitAction(input: string, locationNames: readonly string[] = []): WaitAction | undefined {
  let body = input.trim().replace(subject, '').replace(modifiers, '');
  const preposition = /^(?:站在|坐在|留在|待在|停在|在)?/u.exec(body)![0];
  const here = ['这里', '这儿', '此处', '原地', ...locationNames].sort((a,b) => b.length - a.length)
    .find(place => body.startsWith(preposition + place));
  if (here) {
    body = body.slice(preposition.length + here.length).trim().replace(modifiers, '');
  }
  const verb = waitVerb.exec(body)?.[0];
  if (!verb) return;
  const kind = /休|憩|歇|睡/u.test(verb) ? 'rest' : 'wait';
  const object = body.slice(verb.length).trim();
  const [first, ...remaining] = object.split(/[，,。；;！!]|然后|随后|接着|再(?=说|问|走|去|决定|考虑)/u);
  if (/[?？]/u.test(first) || /^(?:了|过|不|没|于|同|的[人事]|是否)/u.test(first) ||
      /(?:吗|么|行不行|好不好|可以吗|只是.{0,8}(?:想法|设想|打算))$/u.test(first) ||
      remaining.some(part => /^(?:算了|(?:我)?不等了|别真的等)$/u.test(part.trim()))) return;
  let argument = first.replace(/[。.]+$/u, '').replace(/^(?:一直)?(?:到|至|直到)\s*/u, '').trim();
  if (remaining.length) argument = argument.replace(/(?:之|以)?后$/u, '').trim();
  const clock = clockTime(argument, kind);
  if (clock) return clock;
  const minutes = duration(argument);
  if (minutes !== undefined) return {intent:{kind, minutes}};
  if (!argument || /^(?:一?会[儿子]?|一?阵[子儿]?|片刻|一?下|一会儿工夫)$/u.test(argument)) {
    const resume = !argument && /^(?:我)?(?:继续|接着)/u.test(input.trim());
    return {intent:{kind, minutes:5}, ...(resume ? {resume:true} : {})};
  }
  // A malformed amount or clock must never turn into an open-ended event wait.
  if (/^(?:负|[-+.]|半|[零〇一二两三四五六七八九十百\d]|今天|明天|上午|下午|晚上|凌晨)/u.test(argument) ||
      /(?:分钟|小时|刻钟|[:：]\d)/u.test(argument)) return {intent:{kind}, invalidTime:true};
  const isEvent = /(?:事件|钟声|晨会|发生|到来|出现|到场|到齐|赶到|送到|抵达|回来|开始|开场|结束|响起)$/u.test(argument);
  // 等候信使的回话 is a wait-for request even without an arrival keyword.
  const namedWait = /^(?:等待|等候|静候)$/u.test(verb) && /^[\p{L}\p{N}·]+$/u.test(argument) &&
    !/^(?:是|只是|并非|的人|的时候)|如果|假如|是否/u.test(argument);
  if (kind === 'wait' && (verb === '等到' || isEvent || namedWait)) {
    const needle = argument.replace(/^(?:某个|某件|下一个|下一件)/u, '').replace(/的?(?:发生|到来|出现)$/u, '').replace(/[「」“”]/gu, '');
    const limit = remaining.find(part => /^(?:最多|至多)/u.test(part.trim()));
    const bound = limit === undefined ? undefined : duration(limit.trim().replace(/^(?:最多|至多)(?:等待|等)?\s*/u, ''));
    if (limit && bound === undefined) return {intent:{kind}, invalidTime:true};
    return {intent:bound === undefined ? {kind:'wait_event'} : {kind:'wait_event', minutes:bound},
      eventNeedle:/^(?:新的?|重要)?事件$/u.test(needle) ? '' : needle};
  }
}

/** A directional gaze is a local observation, even when a named exit is its subject. */
export function isDirectedLook(text: string): boolean {
  const body = text.trim().replace(subject, '').replace(modifiers, '').replace(/[。.!！]+$/u, '').trim();
  const clause = body.split(/[，,；;]|然后|随后/u, 1)[0];
  if (/[“”「」『』"'?？]/u.test(clause) || /(?:吗|么)$/u.test(clause)) return false;
  return /^(?:环顾|四下张望|四处张望|观察(?:四周|周围|这里)|(?:抬头|转头|扭头|抬眼)?(?:看向|望向|望着|注视).+|把(?:目光|视线)(?:转向|投向).+)/u.test(clause) ||
    /^(?:抬头|转头|扭头|抬眼)?(?:朝|向|往)(?:着)?[\p{L}·]{1,32}?(?:[看望瞧](?:了?过去|去|了?一眼)|望了望|看了看|张望)$/u.test(clause);
}
