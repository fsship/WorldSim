const closingQuote: Record<string, string> = {
  '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'",
};

export interface QuoteSpan { start:number; end:number; text:string }

/** Complete outer quotations, with half-open offsets into the original input. */
export function quoteSpans(input: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if ((c === "'" || c === '’') && /[a-z]/iu.test(input[i - 1] ?? '') && /[a-z]/iu.test(input[i + 1] ?? '')) continue;
    if (stack.length && c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) spans.push({start, end:i + 1, text:input.slice(start + 1, i)});
    } else if (closingQuote[c]) {
      if (!stack.length) start = i;
      stack.push(closingQuote[c]);
    } else if (/[”’」』]/u.test(c)) return [];
  }
  return stack.length ? [] : spans;
}

export interface DialogueLine {
  text: string;
  addressee?: string;
}

const compound = /然后|随后|接着|同时|并且|之后/u;
function simpleAddressee(value: string) {
  return !compound.test(value) &&
    !/^我|如果|假如|假设|倘若|[并再]|不(?:敢|想|愿|会|能|打算|要|曾)?$|没(?:有)?$|未$|前往|走进|走向|走到|等候|等待|转身|离开|逮捕|(?:说|问|答)道?$/u.test(value);
}

// An attribution can specify a manner of speaking, but must not contain an
// additional decision or action. Parse the modifier separately from the name.
const quietManner = /(?:压低(?:声音|嗓音)|低声|轻声|小声|悄声|悄悄|偷偷|秘密|私底下|私下|单独|在耳(?:边|畔))地?/u;
const exclusive = /^(?:仅仅|仅|只)(?=对|向|跟|告诉|告知)/u;
const initialQuietManner = new RegExp("^" + quietManner.source + "\\s*", "u");
/** Use the same delivery markers when parsing spoken commands and ordinary dialogue. */
export const withoutQuietPrefix = (verb: string): string => verb.replace(initialQuietManner, "");
const speechManner = /(?:(?:很|有些|十分|非常|颇为|格外|略显)?(?:不满|不悦|不耐烦|愤怒|气愤|恼火|生气|严肃|认真|坚定|平静|冷静|温和|急切|焦急|迟疑|疑惑|困惑|疑虑|好奇|惊讶|无奈|激动|担忧|坦然|礼貌|冷冷|缓缓|慢慢|轻轻|急急|狠狠)地|(?:不禁|高声|大声|厉声|沉声|随口|开口|朗声))/u;
const reportingVerb = /(?:耳语|低语|追问|反问|发问|询问|问|回答|回复|回应|答复|应答|答|告诉|告知|说|道)(?:道)?$/u;
const tonePhrase = /(?:用|以|带着)[\p{Script=Han}]{1,10}?(?:语气|口吻|口气|语调|声音|嗓音)/u;
const deliveryVerb = /耳语|低语|回答|答复|回复|回应|询问|追问|反问|发问|告诉|告知|命令|吩咐|下令|嘱咐|指示|安排|派遣|传令|要求|劝|说服|令|让|说|问|答|道/u;

/** Examine the player's delivery, never a description of a whisper in the spoken words. */
export function isPrivateSpeech(input: string): boolean {
  const raw = input.trim();
  const spans = quoteSpans(raw);
  if (spans.length > 1) {
    return outsideClauses(raw, spans).some((clause, i) => {
      const speaker = attribution(clause, '', i === 0, []);
      return !!speaker && privateAttribution(clause, true, speaker.addressee);
    });
  }
  const opening = spans[0]?.start ?? raw.search(/[“‘「『"']/u);
  let delivery = raw.split(/[：:，,。！？?!]/u, 1)[0];
  if (opening >= 0) {
    delivery = opening > 0 ? raw.slice(0, opening) : spans[0] ? raw.slice(spans[0].end) : "";
  }
  let addressee: string | undefined;
  if (opening >= 0 || delivery.length < raw.length) {
    delivery = delivery.trim().replace(/^(?:[，,]\s*)?(?:—+|--+)?\s*|[：:，,。！？?!.]+$/gu, "").trim();
    // A title like 顾问 or 传令官 can itself contain a reporting verb.
    addressee = attribution(delivery, "", opening !== 0, [])?.addressee;
  }
  return privateAttribution(delivery, opening >= 0 || /[：:]/u.test(raw), addressee);
}

function privateAttribution(delivery: string, attributed: boolean, addressee?: string) {
  if (addressee) delivery = delivery.replace(addressee, '');
  // Stop at the first actual speech verb, even for unquoted "我说要私下告诉艾琳".
  const verb = deliveryVerb.exec(delivery);
  if (!verb) return false;
  const manner = delivery.slice(0, verb.index).trim().replace(/^[，,]?\s*我\s*/u, "");
  if (exclusive.test(manner + verb[0])) return true;
  if (!attributed && manner && !/^(?:向|对|跟|凑近|贴近|靠近|凑到|在)/u.test(manner) &&
      !initialQuietManner.test(manner) && !tonePhrase.test(manner)) return false;
  return verb[0] === "耳语" || verb[0] === "低语" || quietManner.test(manner) || /耳边|耳畔|(?:压低|极小|很小|微弱)的?(?:声音|嗓音)/u.test(manner);
}

function isSafeManner(modifier: string) {
  return !/^(?:向|对|跟)/u.test(modifier) && !compound.test(modifier) &&
    !/如果|假设|假如|或许|打算|不敢|不愿|不想|没(?:有|说|答)|并未|并非|[着了]|转身|前往|走|去|拿|离开|逮捕|开门/u.test(modifier);
}

function trimManner(input: string, firstPerson: boolean, people: readonly string[]): string {
  // In “用平静的语气问”, 用 introduces how the words are delivered.
  const tone = tonePhrase.exec(input);
  if (tone && (tone.index === 0 || tone.index + tone[0].length === input.length) &&
      isSafeManner(tone[0].replace(/^(?:用|以|带着)/u, ""))) {
    input = (input.slice(0, tone.index) + input.slice(tone.index + tone[0].length)).trim();
  }
  input = withoutQuietPrefix(input);
  if (/^(?:仅仅|仅|只)$/u.test(input)) return "";
  input = input.replace(exclusive, "").trim();
  // When the first-person subject is explicit, a short adverb before the verb
  // (or before 对/向/跟) has a clear boundary even if its tone is unfamiliar.
  const modifier = firstPerson && /^(?:很|十分|略显|有些|非常)?([\p{Script=Han}]{1,8})地\s*(?=$|对|向|跟)/u.exec(input);
  if (modifier && isSafeManner(modifier[1])) return input.slice(modifier[0].length).trim();

  // With an explicit addressee, its known name separates it from an unfamiliar
  // trailing manner (对艾琳半信半疑地说), without guessing a person from quoted text.
  const directed = input.match(/^(向|对|跟)\s*(.+)$/u);
  if (directed) {
    for (const name of people) {
      if (!directed[2].startsWith(name)) continue;
      const rest = directed[2].slice(name.length).trim();
      if (/^[\p{Script=Han}]{1,8}地$/u.test(rest) && isSafeManner(rest)) return directed[1] + name;
    }
  }
  const manner = quietManner.exec(input) ?? speechManner.exec(input);
  if (!manner || (manner.index !== 0 && manner.index + manner[0].length !== input.length)) return input.trim();
  return (input.slice(0, manner.index) + input.slice(manner.index + manner[0].length)).trim();
}

function attribution(input: string, text: string, beforeSpeech: boolean, people: readonly string[]): DialogueLine | undefined {
  const firstPerson = input.startsWith('我');
  if (!firstPerson && !beforeSpeech) return;
  const clause = firstPerson ? input.slice(1).trim() : input;
  const ending = clause.match(reportingVerb);
  if (ending) {
    const prefix = trimManner(clause.slice(0, ending.index).trim(), firstPerson, people);
    if (!prefix) return { text };
    const directed = prefix.match(/^(?:向|对|跟)\s*([\p{L}·]{1,30})$/u);
    if (directed && simpleAddressee(directed[1])) return { text, addressee: directed[1] };
    const whisper = prefix.match(/^(?:在|凑近|贴近|靠近|凑到)\s*([\p{L}·]{1,30}?)(?:的?耳(?:边|畔))$/u)
      ?? (/^(?:耳语|低语)/u.test(ending[0]) && prefix.match(/^(?:凑近|贴近|靠近|凑到)\s*([\p{L}·]{1,30})$/u));
    if (whisper && simpleAddressee(whisper[1])) return { text, addressee: whisper[1] };
  }
  // A reporting verb may instead take a direct object: 我不满地回答艾琳.
  const objectForm = clause.match(/^(.*?)(追问|反问|询问|问|回答|回复|回应|答复|告诉|告知)\s*([\p{L}·]{1,30}?)(?:问道|说道)?$/u);
  if (!objectForm || trimManner(objectForm[1].trim(), firstPerson, people) !== '' ||
      !simpleAddressee(objectForm[3])) return;
  return { text, addressee: objectForm[3] };
}

function unquotedWhisper(raw: string, people: readonly string[]): DialogueLine | undefined {
  if (!isPrivateSpeech(raw)) return;
  // An explicit boundary also preserves an unknown addressee in "我只告诉来人，……".
  // Never shorten an unfamiliar name to a present person's name when there is a boundary.
  const comma = raw.search(/[，,]/u);
  if (comma > 0 && raw.slice(comma + 1).trim()) {
    const directed = attribution(raw.slice(0, comma).trim(), raw.slice(comma + 1).trim(), true, people);
    if (directed) return directed;
  }
  const report = deliveryVerb.exec(raw);
  if (!report || !reportingVerb.test(report[0])) return;
  const end = report.index + report[0].length;
  const speaker = raw.slice(0, end);
  const words = raw.slice(end).trim();
  if (!words) return;

  // "我低声问艾琳还有什么消息" has no punctuation between the name and words.
  // A direct object needs an identifiable boundary. Ambiguous whispers fail closed.
  const directed = attribution(speaker, words, true, people);
  if (!directed) return;
  if (directed.addressee || !/^(?:问|询问|追问|告诉|告知|回复|回答|回应|答复)$/u.test(report[0])) return directed;
  const name = people.filter(person => words.startsWith(person) && !words.slice(person.length).startsWith("的"))
    .sort((a, b) => b.length - a.length)[0];
  if (!name) return;
  const text = words.slice(name.length).replace(/^[，,：:]\s*/u, "").trim();
  if (text) return { text, addressee:name };
}

function observationBeat(clause: string, people: readonly string[]): boolean {
  if (/^我(?:顿了顿|停顿了一下|点了点头|摇了摇头|抬起头|环顾四周)$/u.test(clause)) return true;
  const target = /^我(?:审视|扫视|环视|打量|看向|望向|环顾)(?:着|了)?(.+)$/u.exec(clause)?.[1];
  return !!target && (people.includes(target) ||
    /^(?:(?:在场|眼前|面前)的?)?(?:诸多|诸位|所有|每一位)?(?:人物|众人|人群|官员|大臣|宾客|四周|人)$/u.test(target));
}

function outsideClauses(raw: string, spans: QuoteSpan[]): string[] {
  const boundaries = [0, ...spans.map(span => span.end)];
  return boundaries.map((start, i) => raw.slice(start, spans[i]?.start ?? raw.length)
    .replace(/^[，,。.!！?？：:—\s-]+|[，,。.!！?？：:—\s-]+$/gu, ''));
}

function segmentedDialogue(raw: string, spans: QuoteSpan[], people: readonly string[]): DialogueLine | undefined {
  if (spans.length < 2 || spans.some(span => !span.text.trim())) return;
  let grounded = false, addressee: string | undefined, quiet: boolean | undefined;
  for (const [i, clause] of outsideClauses(raw, spans).entries()) {
    if (!clause) continue;
    if (i > 0 && i < spans.length && observationBeat(clause, people)) { grounded = true; continue; }
    if (/转述|复述|引述|假装|假设|如果|想象|模仿/u.test(clause)) return;
    const speaker = attribution(clause, '', i === 0, people);
    if (!speaker) return;
    if (speaker.addressee && addressee && speaker.addressee !== addressee) return;
    addressee ??= speaker.addressee;
    const delivery = privateAttribution(clause, true, speaker.addressee);
    if (quiet !== undefined && delivery !== quiet) return;
    quiet = delivery;
    grounded = true;
  }
  if (!grounded) return;
  // A vocative can redirect a later clause even without another attribution.
  const namedListeners = new Set(spans.flatMap(span => people.filter(person => {
    const words = span.text.trimStart();
    return words.startsWith(person) && /^[，,]/u.test(words.slice(person.length));
  })));
  if (addressee) namedListeners.add(addressee);
  if (namedListeners.size > 1) return;
  const text = spans.map(span => span.text.trim()).join('\n');
  return addressee ? {text, addressee} : {text};
}

/** Resolve one player's speech interrupted by attribution or an incidental gesture. */
export function readSegmentedSpeech(input: string, people: readonly string[] = []): DialogueLine | undefined {
  return segmentedDialogue(input, quoteSpans(input), people);
}

export function readQuotedSpeech(input: string, people: readonly string[] = []): DialogueLine | undefined {
  const raw = input.trim();
  const spans = quoteSpans(raw);
  if (spans.length > 1) return segmentedDialogue(raw, spans, people);
  const span = spans[0];
  if (!span) return;
  const text = span.text.trim();
  if (!text) return;

  const after = raw.slice(span.end).trim().replace(/[。.!！?？]+$/u, '').trim();
  if (span.start > 0) {
    if (after) return;
    const before = raw.slice(0, span.start).trim().replace(/[：:，,]$/u, '').trim();
    return attribution(before, text, true, people);
  }
  const speaker = after.replace(/^(?:[，,]\s*)?(?:—+|--+)?\s*/u, '');
  return speaker ? attribution(speaker, text, false, people) : { text };
}

/** Test only separators after the actual quotation. A comma in the spoken
 * words belongs to the speaker, not to a second player action. */
export function* quotedFollowUps(input: string, people: readonly string[]) {
  const raw = input.trim();
  const last = quoteSpans(raw).at(-1);
  if (!last) return;
  const remainder = raw.slice(last.end);
  for (const boundary of remainder.matchAll(/[，,；;。]|(?:随后|然后|同时|顺手|顺便)/gu)) {
    const split = last.end + boundary.index;
    const speechInput = raw.slice(0, split).trim();
    const dialogue = readQuotedSpeech(speechInput, people);
    if (!dialogue) continue;
    const followUp = raw.slice(split + boundary[0].length).trim().replace(/^(?:然后|随后)\s*/u, '');
    if (followUp) yield {dialogue, speechInput, followUp};
  }
}

// Bare dialogue is limited to a single question, optionally preceded by a vocative.
// E.g. “要去宫门吗？” without quotation marks can be an action request.
const directQuestion = /^(?:(?:还|又|都)?有(?:哪些|什么|谁)|(?:这|那)是(?:谁|什么)|哪些|什么|谁|哪里|何处|为什么|为何|怎么)[\p{L}\p{N}·\s]*[？?]$/u;
export function readDialogueLine(input: string, people: readonly string[] = []): DialogueLine | undefined {
  const quoted = readQuotedSpeech(input, people);
  if (quoted) return quoted;
  const raw = input.trim();
  // A colon can introduce the same spoken line without quotation marks.
  // Unmatched quotation marks must not silently become a valid attribution.
  if (!/[“”‘’「」『』"']/u.test(raw)) {
    const colon = raw.search(/[：:]/u);
    if (colon > 0 && raw.slice(colon + 1).trim()) {
      const speech = attribution(raw.slice(0, colon).trim(), raw.slice(colon + 1).trim(), true, people);
      if (speech) return speech;
    }
    const whisper = unquotedWhisper(raw, people);
    if (whisper) return whisper;
    const comma = raw.search(/[，,]/u);
    if (comma > 0) {
      const words = raw.slice(comma + 1).trim();
      if (words && !/^(?:然后|随后|接着|并且)/u.test(words)) {
        const speech = attribution(raw.slice(0, comma).trim(), words, true, people);
        if (speech) return speech;
      }
    }
  }
  const addressed = raw.match(/^([\p{L}·]{1,30})\s*[，,]\s*(.+)$/u);
  const addressee = addressed?.[1];
  if (addressee && !simpleAddressee(addressee)) return;
  const text = addressed?.[2] ?? raw;
  if (!directQuestion.test(text) || compound.test(text)) return;
  return addressee ? { text, addressee } : { text };
}
