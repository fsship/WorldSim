/** A player's reference to a document at the scene. An empty target refers to the
 * last reading. Section numbers follow the printed list, starting at one. */
export interface ReadingRequest {
  target: string;
  documentId?: string;
  section?: number | string;
  resume?: true;
  nextOnly?: true;
}

const readVerb = /^(?:低头|俯身)?(?:(?:仔细|认真|快速)地?)?(?:读一读|阅读|细读|翻阅|翻读|查阅|审阅|浏览|翻看|翻开|扫视|端详|打量|检查|检视|查验|调查|查看|细看|看一看|看一眼|看看|看了(?:看|一?下)|望了望|[扫瞥]了?一眼|看|读)\s*/u;
const readingPurpose = /^(?:我)?(?:(?:想知道|想看看|想了解|想弄清楚)[^，,；;。]+|看看(?:上面|里面)(?:写了|写着)什么)[？?]?$/u;
const digits = '零一二三四五六七八九';

function sectionNumber(text: string): number | undefined {
  if (/^\d{1,6}$/u.test(text)) return Number(text);
  const match = /^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/u.exec(text.replace('两', '二'));
  if (!match || (!match[2] && match[1] && match[3])) return;
  const first = match[1] ? digits.indexOf(match[1]) : 0;
  return match[2] ? (first || 1) * 10 + (match[3] ? digits.indexOf(match[3]) : 0) : first;
}

function documentName(raw: string, names: readonly string[]): string | undefined {
  // Only remove an actual supporting surface and the location words after it.
  // A mention elsewhere in the sentence is never enough to select a document.
  const exact = raw.trim().replace(/^《([^《》]+)》$/u, '$1');
  if (names.includes(exact)) return exact;
  const surface = [...names, '桌', '桌子'].find(name => raw.startsWith(name) &&
    /^(?:上面|面上|上)(?:摆着|放着|摊开|摊着|放置)?(?:的)?/u.test(raw.slice(name.length)));
  const placed = surface ? raw.slice(surface.length).replace(/^(?:上面|面上|上)(?:摆着|放着|摊开|摊着|放置)?的?/u, '') : raw;
  const name = placed.trim().replace(/^(?:都)?(?:列着|写着|写了|有)(?:哪些|什么)/u, '')
    .replace(/^(?:(?:这|那)(?:一)?(?:份|张|本|册)|(?:今日|今天)(?:的)?)+/u, '')
    .replace(/^《([^《》]+)》$/u, '$1').trim();
  if (surface && names.includes(surface) && (!name || name === '内容')) return surface;
  return names.includes(name) ? name : undefined;
}

function selectedSection(words: string, names: readonly string[]): ReadingRequest | undefined {
  // Both “议程的第二项” and “第二项议程” identify the same printed item.
  const part = /第([一二两三四五六七八九十\d]+)[条项段]/u.exec(words);
  if (part) {
    const before = words.slice(0, part.index).trim().replace(/(?:[中里上之]的?|的)$/u, '');
    const after = words.slice(part.index + part[0].length).trim();
    const section = sectionNumber(part[1]);
    if (section === undefined || (before && after)) return;
    const target = before || after ? documentName(before || after, names) : '';
    if (target !== undefined) return {target, section};
  }
  // A named section needs a clear boundary between it and the document.
  const named = words.match(/^(.+?)(?:中的?|里的?|的)(?:关于)?(?:《([^《》]+)》|(.+?)(?:的?那|这|的?一)?[项条])$/u);
  if (named) {
    const target = documentName(named[1], names);
    if (target) return {target, section:named[2] ?? named[3]};
  }
  const implicit = words.match(/^([^，。！？；]+?)(?:这|那)(?:一)?[条项]$/u);
  if (implicit) return {target:'', section:implicit[1]};
}

/** Recognize an explicit inspection of a named, authored readable. The engine
 * separately checks where the reader is and which entries they can see. */
export function readReadingAction(input: string, names: readonly string[]): ReadingRequest | undefined {
  const sentence = input.trim().replace(/[。.!！]+$/u, '').trim();
  const clauses = sentence.split(/[，,；;。]/u);
  if (clauses.length > 2) return;
  const [first, purpose] = clauses;
  const action = first.replace(/((?:有|写了|写着|列着)(?:哪些|什么)[\p{L}·]*)[？?]$/u, '$1');
  if (purpose !== undefined && !readingPurpose.test(purpose.trim())) return;
  if (/[“”‘’「」『』"']|假如|如果|设想|然后|随后|并且|取消|算了|不读|不看/u.test(sentence) || /[？?]/u.test(action)) return;
  let words = action.trim().replace(/^(?:我(?:想要|想|要|决定)?\s*)?/u, '')
    .replace(/^(?:正在|此刻|现在|正)\s*/u, '')
    .replace(/^(?:(?:再|先|顺手|顺便|随手|同时)\s*)+/u, '');
  const continuation = /^(?:继续|接着|往下)\s*/u.exec(words);
  if (continuation) words = words.slice(continuation[0].length);
  const verb = readVerb.exec(words);
  if (!verb) return;
  words = words.slice(verb[0].length).replace(/^(?:一下|一眼)\s*|\s*(?:上写的内容|上面的字)$/u, '').trim();
  if (/^下一[条项段]$/u.test(words)) return {target:'', resume:true, nextOnly:true};
  if (/^(?:往下|下去|剩下的)$/u.test(words) || (continuation && !words)) return {target:'', resume:true};
  const next = words.match(/^(.+?)(?:中的?|里的?|的)?下一[条项段]$/u) ?? words.match(/^下一[条项段](.+)$/u);
  if (next) {
    const target = documentName(next[1], names);
    if (target) return {target, resume:true, nextOnly:true};
  }
  const section = selectedSection(words, names);
  if (section) return section;
  const target = documentName(words, names);
  if (target) return {target, ...(continuation ? {resume:true} : {})};
}
