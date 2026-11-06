import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../apps/server/src/app';
import { createProvider } from '../packages/llm/src';
import { createPalace } from '../packages/scenarios/src';
import { ProviderConfigSchema, WorldStateSchema, type LLMProvider, type NpcActionContext } from '../packages/shared/src';

export function readLiveConfig() {
  const root = fileURLToPath(new URL('../',import.meta.url));
  if (existsSync(resolve(root,'.env'))) process.loadEnvFile(resolve(root,'.env'));
  const settings = new DatabaseSync(resolve(root,process.env.DATABASE_PATH || 'data/worldsim.sqlite'),{readOnly:true});
  try {
    const row = settings.prepare('SELECT config FROM provider_settings WHERE id=1').get();
    assert.ok(typeof row?.config === 'string','请先保存真实模型配置。');
    const config = ProviderConfigSchema.safeParse(JSON.parse(row.config));
    assert.ok(config.success && config.data.mode === 'openai','请先选择真实模型。');
    return config.data;
  } finally { settings.close(); }
}

export function liveFixture(until:number, instrument:(provider:LLMProvider)=>LLMProvider = p => p) {
  const provider = createProvider(readLiveConfig());
  const seed = createPalace('live-fixture');
  const publicFacts = seed.facts.filter(f => f.type === 'public');
  const compact = (s:string) => s.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{Cf}]/gu,'');
  const hidden = [...seed.characters.flatMap(c=>c.goals), ...seed.facts.filter(f=>f.type !== 'public').map(f=>f.content.text),
    ...seed.queue.filter(e=>e.at > until || e.type === 'plan' || e.perception === 'private').map(e=>e.text)]
    .flatMap(s=>[s,...s.split(/[，。；！？、,;.!?]/u)]).map(compact)
    .filter(s=>s.length>=4 && !publicFacts.some(f=>compact(f.content.text).includes(s)));
  let blocked = false;
  function guard(ok:boolean) {
    if (!ok) blocked = true;
    assert.ok(!blocked,'验收已拦截超出公开范围的内容。');
  }
  function check(value:unknown) {
    const data = JSON.stringify(value);
    const normalized = compact(data);
    guard(!/"(?:goals|plans|queue|variables|knownFactIds)"\s*:/u.test(data) && hidden.every(s=>!normalized.includes(s)));
  }
  const king = seed.characters.find(c => c.kind === 'player')!;
  function scene(c:Pick<NpcActionContext,'facts'|'currentTime'|'present'|'input'>) {
    guard(c.currentTime === undefined || c.currentTime <= until);
    guard(c.facts.every(f=>publicFacts.some(s=>s.id===f.id && s.content.text===f.text)));
    if (!c.present.some(person=>person.name === king.name)) guard(c.input === '');
  }
  function call<T,R>(c:T,send:(ctx:T)=>Promise<R>) { check(c); return send(c); }
  const interpret = provider.interpret?.bind(provider);
  assert.ok(interpret);
  const safe:LLMProvider = {
    parse:async ()=>{ throw Error('真实模式不能退回离线解析'); },
    interpret:c=>call(c,interpret), resolve:c=>call(c,v=>provider.resolve(v)), narrate:c=>call(c,v=>provider.narrate(v)),
    decideNpcAction:c=>{scene(c); return call(c,v=>provider.decideNpcAction(v));},
    reviewNpcAction:c=>{scene(c.context); return call(c,v=>provider.reviewNpcAction(v));},
    dialogue:c=>{scene(c); return call(c,v=>provider.dialogue(v));},
    reviewDialogue:c=>{scene(c.context); return call(c,v=>provider.reviewDialogue(v));},
  };
  const directory = mkdtempSync(join(tmpdir(),'worldsim-live-'));
  const filename = join(directory,'game.sqlite');
  const app = buildApp({databasePath:filename,providerFactory:()=>instrument(safe)});
  const db = new DatabaseSync(filename,{readOnly:true});
  return {app, check, read:(id:string) => {
    const row = db.prepare('SELECT world FROM games WHERE id=?').get(id);
    assert.ok(typeof row?.world==='string');
    return WorldStateSchema.parse(JSON.parse(row.world));
  }, close:async () => {
    db.close();
    try { await app.close(); } finally { rmSync(directory,{recursive:true,force:true}); }
  }};
}
