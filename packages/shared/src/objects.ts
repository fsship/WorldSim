import { withoutQuietPrefix } from './speech';

type ObjectKind = 'use' | 'arrest' | 'investigate' | 'order';
export interface ObjectAction { kind: ObjectKind; object: string; inspection?: 'handle' | 'look' }

// A direct verb, or the same verb after a 把/将 object, confers authority only
// over that object. Never search the entire request for a name to bind.
const handle = /(?:拿出|取出|掏出|亮出|拿起|举起|取下|拾起|捧起)(?:来)?/u;
const pickUp = new RegExp('^' + handle.source + '(?:了|一下)?\\s*', 'u');
const putObjectFirst = new RegExp('^(?:把|将)\\s*(.+?)\\s*' + handle.source + '(?:了|一下)?$', 'u');
const inspect = /(?:(?:我|再|顺手|顺便)\s*)*(?:(?:仔细|认真|细细|好好|凑近)(?:地)?\s*)?(?:看一看|看一眼|看了看|看看|瞧一瞧|瞧一眼|瞧了瞧|端详|观察|打量|细看|查看|察看|检视|查验|审视|检查|看向|看|瞧)(?:了)?(?:一下|一眼|一番|片刻)?/u;
const inspectAtStart = new RegExp('^' + inspect.source + '\\s*', 'u');
const inspectAtEnd = new RegExp(inspect.source + '(?:它)?$', 'u');
const verbs = [
  {kind:'use', words:/出示|展示|使用|用/u},
  {kind:'arrest', words:/(?:当场|下令)?(?:逮捕|拘押|拘捕|拘留|抓捕|拿下|抓住|捉拿|缉拿|扣押)(?:起来)?/u},
  {kind:'investigate', words:/调查|搜查|搜寻|检查|翻查|翻阅|翻看|查阅|查找|查验|核查|核对|查看|阅读|研究|探索|搜索|侦查|寻找|看了看|看一看/u},
] as const;
const actions = verbs.map(({kind, words}) => ({
  kind, before:new RegExp('^(?:' + words.source + ')(?:了|一下|一遍)?\\s*', 'u'),
  after:new RegExp('^([^，,。；;！？?!]+?)(?:' + words.source + ')(?:了)?(?:一下|一遍)?$', 'u'),
}));
const orderStart = /^(?:下令|命令|吩咐|嘱咐|要求|指示|安排|派遣|传令|令|让|劝|说服)/u;
const inventory = /^(?:从(?:自己|我)?(?:的)?(?:背包|包|口袋|衣袋)(?:里面|里|中)?|从(?:自己)?身上)\s*/u;

function objectName(kind: Exclude<ObjectKind,'order'>, raw: string, knownNames: readonly string[] = []): string {
  let name = raw.trim();
  if (knownNames.includes(name)) return name;
  if (kind === 'use') name = name.replace(/^(?:我的|自己(?:的)?)(?=.+)/u, '')
    .replace(/^(?:(?:背包|包|口袋|衣袋)(?:里面|里|中)|身上|手边|手头|手中|手上|手里|眼前)(?:的|(?=[这那]))/u, '');
  if (kind === 'investigate') name = name.replace(/^(?:(?:长桌|桌子|书桌|桌|案|书架)(?:面上|上|头)|眼前|手边)(?:的|(?=那|这))/u, '');
  const classifier = kind === 'use' ? /^(?:(?:这|那)(?:一)?|一)(?:件|枚|本|份|个|册|张|把|块|面)的?/u :
    /^(?:这|那)(?:一)?(?:件|枚|本|份|位|个|册|张)的?/u;
  name = name.replace(classifier, '');
  return name.replace(/^《([^《》]+)》$/u, '$1').trim();
}

function handledObject(clause: string, itemNames: readonly string[]): string | undefined {
  const before = pickUp.exec(clause);
  if (before) return objectName('use', clause.slice(before[0].length), itemNames);
  const after = putObjectFirst.exec(clause);
  if (after) return objectName('use', after[1], itemNames);
}

function inspectItem(clause: string, following: string, itemNames: readonly string[]): ObjectAction | undefined {
  const whole = handledObject(clause, itemNames);
  // Match a whole item before interpreting the end of its name as another verb.
  if (whole === undefined || !itemNames.includes(whole)) {
    const suffix = inspectAtEnd.exec(clause);
    if (suffix && suffix.index > 0) {
      const object = handledObject(clause.slice(0, suffix.index).trim(), itemNames);
      if (object) return {kind:'use', object, inspection:'handle'};
    }
  }
  if (whole !== undefined) {
    const seeing = inspectAtStart.exec(following);
    if (seeing && ['', '它', whole].includes(following.slice(seeing[0].length).trim()))
      return {kind:'use', object:whole, inspection:'handle'};
    return {kind:'use', object:whole};
  }
  const seeing = inspectAtStart.exec(clause);
  const beforeObject = seeing ? clause.slice(seeing[0].length) : undefined;
  const afterObject = /^(?:把|将)/u.test(clause) ? inspectAtEnd.exec(clause) : undefined;
  const raw = beforeObject ?? (afterObject && clause.slice(1, afterObject.index));
  if (typeof raw !== 'string') return;
  const object = objectName('use', raw, itemNames);
  if (object && itemNames.includes(object)) return {kind:'use', object, inspection:'look'};
}

/** Extract an affirmative, player-authored action without trusting a model's target. */
export function readObjectAction(text: string, people: readonly string[] = [], itemNames: readonly string[] = []): ObjectAction | undefined {
  if (/[？?]|吗[。！!]?\s*$|(?:如果|假如|倘若|假设|要是|要不要|并非|是否|或者|还是)/u.test(text)) return;
  if (/[，,。；;！!]\s*(?:算了|别真的|不要执行|不必执行|(?:不[，,]\s*)?(?:我)?(?:收回|撤回)(?:这(?:个|道|条|项))?(?:命令|指令|决定)|(?:这|我)?只是(?:说说|举例|设想))/u.test(text)) return;
  let clause = text.trim().replace(/^(?:(?:我(?:现在|决定|准备|打算|想要|要|想)?|亲自|试着|尝试|先)\s*)+/u, '');
  // Directly naming the NPC after 请 means a request, not a player's polite prefix.
  const spoken = withoutQuietPrefix(clause);
  const request = spoken.match(orderStart) ?? (/^请/u.test(spoken) && people.some(name => spoken.slice(1).startsWith(name))
    ? spoken.match(/^请/u) : null);
  if (request && !/^下令(?:逮捕|拘押|拘捕|抓捕)/u.test(spoken))
    return {kind:'order', object:spoken.slice(request[0].length).trim()};

  const [first, ...rest] = clause.split(/[，,。；;！!]|然后|接着|随后/u);
  clause = first.trim();
  if (/[“”‘’「」『』"']/u.test(clause)) return;
  clause = clause.replace(/^请\s*/u,'').replace(/^(?:仔细|认真|当场|亲手|慢慢)(?:地)?\s*/u, '');
  // 用手拿起 selects the item after 拿起; 用手里的印玺 selects a held item.
  if (/^用手(?:里|中)的/u.test(clause)) clause = clause.replace(/^用手(?:里|中)的/u, '用');
  else clause = clause.replace(/^用(?:双手|左手|右手|手指|指尖|目光|眼睛|手|力|心)(?=.+)/u, '');
  const source = inventory.test(clause);
  if (source) clause = clause.replace(inventory, '');
  const showing = clause.match(/^(?:向|给)\s*(.+?)(?=出示|展示|亮出)/u);
  if (showing && people.includes(showing[1])) clause = clause.slice(showing[0].length);
  const following = rest.map(s => s.trim()).find(Boolean) ?? '';
  const itemAction = inspectItem(clause, following, itemNames);
  if (itemAction && rest.some(s => /^(?:我)?(?:还是|决定)?(?:不|别)(?:再|要)?(?:拿|取|看|端详|碰)(?:它)?了[吧。！!]?$/u.test(s.trim()))) return;
  if (itemAction) return itemAction;
  const disposal = /^(?:把|将)\s*/u;
  for (const action of actions) {
    if ((source || showing) && action.kind !== 'use') continue;
    if (action.before.test(clause)) {
      const object = objectName(action.kind, clause.replace(action.before, ''));
      return {kind:action.kind, object};
    }
    if (disposal.test(clause)) {
      const object = clause.replace(disposal, '').match(action.after)?.[1];
      if (object) return {kind:action.kind, object:objectName(action.kind, object)};
    }
  }
}
