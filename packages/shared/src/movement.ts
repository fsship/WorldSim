export type MovementRequest =
  | { kind: 'destination'; target:string; origin?:string; followUp?:true }
  | { kind: 'missing' | 'ambiguous' | 'compound' };

// Chinese permits both 动词 + 地点 and 朝/往 + 地点 + 动词. Read the whole
// clause so a landmark inside a question, another person's order, or the name
// of an object does not give the player authority to change rooms.
const mover = /^(?:我(?:自己)?(?:现在|这就|决定|准备|打算|想要|要|想)?|请|试着|尝试|先)\s*/u;
const manner = /(?:(?:快步|大步|小步|迈步|缓步|疾步|步行|徒步|慢慢|缓缓|迅速|缓慢|匆匆|悄悄|径直|直接|赶紧|立刻|马上|起身|动身)(?:地)?|([\p{Script=Han}])\1([\p{Script=Han}])\2地?|[一二两三四五六七八九十]+步并作[一二两三四五六七八九十]+步|[\p{Script=Han}]{2}地)/u;
const leadingManner = new RegExp('^' + manner.source, 'u');
const trailingManner = new RegExp(manner.source + '$', 'u');
const posture = /^(?:站起身(?:来)?|起身|起步|动身)\s*[，,]\s*/u;
const route = /^(?:沿着?|顺着|循着)\s*([\p{L}·]{0,24}?(?:廊|道|路|径|阶|梯|墙边|脚印|路标))\s*(?:[，,]\s*)?/u;
const fromPlace = /^从\s*([\p{L}·]{1,40}?)\s*(?=向|朝|往|前往|去往|前去|去|到|走|跑|奔|赶|踱|移步|出发|返回|进入|沿|顺着)/u;
const toward = /^(?:向|朝|往)(?:着)?\s*(.*?)\s*(?:(?:走|跑|奔|赶|冲|踱|行)(?:了?(?:过去|过来|去|来)了?)?|前进|前行|出发|而去|去)$/u;
const direct = /^(前往|去往|前去|赶赴|赶往|奔赴|奔往|返回|回到|来到|到达|抵达|进入|移步(?:到|至)?|出发(?:去|到|前往)|(?:走|跑|奔|赶|冲|驶|迈|踱)(?:向|到|至|往|进|入|回|去)|回|去|到)\s*(.*)$/u;
const separateAction = /[，,；;。.!！]|然后|接着|随后|之后再|并且|同时|再(?=去|到|走|跑|前往|返回)|顺便/u;
const alternatives = /或者|还是|或是|或|[、/／]/u;
const localFollowUp = /^(?:我)?(?:再|然后|接着|顺便|仔细)?(?:看|查看|调查|搜查|检查|查阅|观察|翻阅|询问|打听|交谈|问|说|请|要求|吩咐|命令|出示|取出|使用)/u;
const reconsidered = /改主意|改变主意|反悔|作罢|算了|取消|留在原地|没有要去|不(?:再|打算|要|想)?(?:去|走|前往|移动)|条件是|除非|假如|如果|其实|而是|只是想/u;
const lookAround = /(?:看看|看一看)(?:情况|动静|四周|周围)?$/u;

function stripManners(text: string, edge: RegExp): string {
  let value = text.trim();
  let match;
  while ((match = edge.exec(value))) {
    // A manner must never swallow an operator that changes the subject or
    // the actuality of the action, even when it ends in 地.
    if (/不|没|未|若|他|她|我|你|假装|梦见|想象|目睹|目送|拒绝|强迫/u.test(match[0])) break;
    value = (value.slice(0, match.index) + value.slice(match.index + match[0].length)).trim();
  }
  return value;
}

export function readMovement(text: string): MovementRequest | undefined {
  const sentence = text.trim().replace(/[。.!！]+$/u, '').trim().replace(/(?:吧|啦|喽)$/u, '').trim();
  if (/[“”‘’「」『』"'?？]|^(?:如果|假如|若是|假设)/u.test(sentence) || /(?:吗|么|是否|要不要|能不能)$/u.test(sentence)) return;
  let verb = stripManners(sentence.replace(mover, '').trim().replace(/^(?:先|试着|尝试)\s*/u, '').replace(posture, ''), leadingManner);
  const origin = fromPlace.exec(verb);
  if (origin) verb = stripManners(verb.slice(origin[0].length), leadingManner);
  // A path is an adjunct to the player's motion. Stop at its noun boundary
  // rather than searching past an arbitrary action or someone else's walk.
  const path = route.exec(verb);
  if (path) {
    if (/看着|目送|望着|假设|如果|想象|没|不|命令|告诉|让|问/u.test(path[1])) return;
    verb = stripManners(verb.slice(path[0].length), leadingManner);
  }
  const separator = separateAction.exec(verb);
  const first = separator ? verb.slice(0, separator.index) : verb;
  const firstClause = first.replace(lookAround, '').trim();
  // 回答/回复 and 到处观察 are verbs in their own right. Likewise, 向 can
  // introduce the addressee of a statement about travel.
  if (/^(?:回(?:答|复|应|话|禀|忆|想|顾|头|绝|避|望)|到底|到处)/u.test(firstClause) ||
      /^(?:朝|向|往).+(?:看|望|瞧|指|招手)(?:过去|过来|去|来)?$/u.test(firstClause)) return;
  const movement = toward.exec(firstClause);
  const directMove = movement ? null : direct.exec(firstClause);
  let operand = movement ? stripManners(movement[1], trailingManner).replace(/的?方向$/u, '') : directMove?.[2];
  if (operand === undefined) return;
  if (movement && /告诉|告知|解释|转述|说|问|提醒|嘱咐|要求|命令/u.test(operand)) return;
  // 去/到 can also introduce a different action, e.g. 去询问 or 到处看看.
  if (/^(?:调查|查阅|搜查|检查|观察|打听|询问|通知|拿出|取出|等待|休息|找|问|看看|处看)/u.test(operand)) return;
  if (alternatives.test(firstClause)) return {kind:'ambiguous'};
  if (separator) {
    const later = verb.slice(separator.index + separator[0].length).trim();
    if (!localFollowUp.test(later) || separateAction.test(later) || alternatives.test(later) || reconsidered.test(later)) return {kind:'compound'};
  }
  if (directMove?.[1] === '到') operand = operand.replace(/去$/u, '');
  const target = operand.trim().replace(/^一趟\s*|\s*一趟$/gu, '');
  return target ? {kind:'destination', target, ...(origin ? {origin:stripManners(origin[1], trailingManner)} : {}),
    ...(separator || first.trim() !== firstClause ? {followUp:true} : {})} : {kind:'missing'};
}

/** Exact names take priority over locative suffixes such as 宫门口 and 档案室里. */
export function movementLocations<T extends {name:string; aliases:readonly string[]}>(locations: readonly T[], target: string): T[] {
  const matching = (name: string) => locations.filter(l => l.name === name || l.aliases.includes(name));
  const exact = matching(target);
  if (exact.length) return exact;
  const place = target.replace(/(?:那边|那里|这边|这里|里面|里边|里头|里|内)$|(?<=门)口$/u, '');
  return place === target ? [] : matching(place);
}
