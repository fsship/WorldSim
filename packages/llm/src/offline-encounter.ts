import { createHash } from 'node:crypto';
import type { EncounterContext, EncounterProposal } from '@worldsim/shared';

// The local demonstration uses a small vocabulary of public places and occupations.
const roles = [
  {scene:/集市|市场|摊位|摊主|摊贩/, role:'摊主', duty:'照看摊位，招呼来客。'},
  {scene:/旅店|客栈|柜台|掌柜/, role:'掌柜', duty:'接待来访的人。'},
  {scene:/车站|站台|候车厅|站务员/, role:'站务员', duty:'为旅客指路。'},
  {scene:/港口|码头|渡口|栈桥|船夫/, role:'船夫', duty:'在岸边接应来往的人。'},
  {scene:/飞船|空间站|轨道站|技术员/, role:'技术员', duty:'检查站点的设施。'},
  {scene:/岗哨|关卡|守卫|守门人/, role:'守卫', duty:'在入口值守。'},
  {scene:/邮差|邮递员/, role:'邮差', duty:'将邮件递交给收件人。'},
  {scene:/旅客|乘客/, role:'旅客', duty:'在途中留意路线和周围的动静。'},
  {scene:/医生|大夫|诊所|医院|医馆/, role:'医生', duty:'照料前来就诊的人。'},
];
const passerby = {role:'过路人', duty:'经过此地，可以与身边的人交谈。'};
type Profile = typeof passerby;
const deserted = /空无一人|空荡荡|荒无人烟|渺无人烟|人迹罕至|四下无人|无人居住|无人值守|荒岛|无人岛|没有其他人|(?:周围|这里|附近|四周)没有人|不见人影|一个人也没有|只有你一个人/u;
const differentPerson = /另(?:外)?(?:一?[位名个])|其他|别的/u;

function roleAt(place:string) {
  return roles.find(person => place.includes(person.role)) ?? roles.find(person => person.scene.test(place));
}

function contactRole(context:EncounterContext, scene:string):Profile | undefined {
  // In “请掌柜帮我找医生”, 医生 is the person being sought. The shopkeeper is a helper.
  const focus = (context.input ?? '').split(/帮我|替我|帮忙/u).at(-1) ?? '';
  const target = focus.match(/(?:寻找|寻访|找|询问|问问?|叫|向|对)(?:一下)?([^，,。！？!?：“「”」]+)/u)?.[1]?.trim() ?? '';
  const object = target.replace(/^(?:另(?:外)?一?[位名个]|其他|别的|一?[位名个])\s*/u, '');
  const role = roles.find(candidate => object.startsWith(candidate.role));
  if (!role) {
    if (context.present.length || (object && !/^(?:人|陌生人|过路人|路人|行人|当地人|有人)/u.test(object))) return;
    return roleAt(scene) ?? passerby;
  }
  const alreadyHere = context.present.some(person => person.role === role.role);
  if (alreadyHere) return differentPerson.test(target) ? role : undefined;
  return role.scene.test(scene + ' ' + context.worldInfo + ' ' + context.situation) ? role : undefined;
}

function eventRole(context:EncounterContext):Profile | undefined {
  const arrivals:Profile[] = [];
  for (const notice of context.recent ?? []) {
    if (/预计|即将|届时|明天|将会|尚未到|据说|远方|广播里|没有.{0,8}(?:来到|抵达|出现)/u.test(notice)) continue;
    for (const clause of notice.split(/[。，；]/u)) {
      if (/空无一人|四下无人|不见人影/u.test(clause)) { arrivals.length = 0; continue; }
      const departure = /离开|离去|走了|走出|走远|转身离去/u.exec(clause);
      if (departure) {
        const subject = clause.slice(0, departure.index);
        const index = arrivals.findIndex(person => subject.includes(person.role));
        if (index >= 0) arrivals.splice(index, 1);
        else if (/^(?:[他她]|随后|随即|又|转身|便|就)*$/u.test(subject.trim())) arrivals.pop();
        continue;
      }
      const arrival = /进门|走进|推开.{0,4}门|来到|走来|赶到|抵达|走近|上前|敲门|现身|进来|递来|招手|开口/u.exec(clause);
      if (!arrival) continue;
      const subject = clause.slice(0, arrival.index).trim() || clause.slice(arrival.index);
      const role = roles.find(person => subject.includes(person.role));
      if (!role && !/一名|一位|有人|人影|旅客|乘客|陌生人/u.test(subject)) continue;
      const known = context.present.some(person => subject.includes(person.name) || subject.includes(person.role));
      if (!known || differentPerson.test(subject)) arrivals.push(role ?? passerby);
    }
  }
  return arrivals.at(-1);
}

export function offlineEncounter(context: EncounterContext): EncounterProposal {
  const location = context.location.name + ' ' + context.location.description;
  const scene = context.trigger === 'opening' ? location + ' ' + context.situation : location;
  let role:Profile | undefined;
  if (context.trigger === 'event') {
    role = eventRole(context);
  } else if (!deserted.test(scene)) {
    if (context.trigger === 'contact') role = contactRole(context, scene);
    else if (!context.present.length) {
      role = roleAt(scene);
      if (!role && /有人|人群|来客|行人|一名|一位|一群|来来往往|人声/u.test(scene)) role = passerby;
    }
  }
  if (!role) return {kind:'none'};
  const seed = [context.worldInfo, location, context.time, context.input ?? context.recent?.join('\n') ?? ''].join('\n');
  const bytes = createHash('sha256').update(seed).digest();
  const surnames = '沈唐许钟陆陈乔黎季苏方江';
  const givenNames = ['青禾', '川', '遥', '安', '景', '言', '澜', '初', '宁', '枫', '文', '明'];
  const occupied = new Set([context.player, ...context.present].map(person => person.name));
  // Stable for retries, including the unlikely case where the first name is already taken.
  for (let i = 0; i < surnames.length * givenNames.length; i++) {
    const index = (bytes.readUInt16BE(0) + i) % (surnames.length * givenNames.length);
    const name = surnames[Math.floor(index / givenNames.length)] + givenNames[index % givenNames.length];
    if (!occupied.has(name)) return {kind:'npc', name, role:role.role, duty:role.duty};
  }
  return {kind:'none'};
}
