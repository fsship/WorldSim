import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLLMProvider, type MockHandlers } from '@worldsim/llm';
import { createPalace } from '@worldsim/scenarios';
import { runTurn } from '@worldsim/engine';
import type { WorldState } from '@worldsim/shared';
import { buildApp } from '../src/app';
import { GameStore } from '../src/store';

const apps: ReturnType<typeof buildApp>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true});
});

async function failedSave(options: {physical?:boolean; interrupt?:boolean; whisper?:boolean} = {}) {
  const dir = mkdtempSync(join(tmpdir(),'worldsim-dialogue-'));
  dirs.push(dir);
  const path = join(dir,'play.sqlite');
  const store = new GameStore(path);
  try {
    const base = createPalace(randomUUID());
    base.time = options.interrupt ? 494 : 505;
    base.queue = base.queue.filter(event => event.at >= base.time);
    const input = options.whisper ? '我对艾琳耳语：“官员们怎么还没来？”' : '“官员们怎么还没来？”我说道';
    const cmd = {input,requestId:randomUUID(),version:0};
    store.create(base);
    const p = new MockLLMProvider({
      decideNpcAction:() => options.physical ? {kind:'gesture',gesture:'bow',thenSpeak:true} : {kind:'speak'},
      dialogue:() => ({text:'未经核实的答复。',factIds:[]}),
      reviewDialogue:() => ({grounded:false,playerAgency:true,citationsAccurate:true}),
    });
    const saved = store.world(base.id);
    const result = await runTurn(saved,input,p);
    const initial = store.commit(saved,cmd,result);
    return {path,id:base.id,initial,input};
  } finally {store.close();}
}
const approved = {grounded:true,playerAgency:true,citationsAccurate:true};
const answer = '陛下，我不知道他们为何尚未到场。';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {resolve,promise};
}
function server(path:string, hooks:MockHandlers = {}) {
  const app = buildApp({databasePath:path,env:{},providerFactory:() => new MockLLMProvider({
    dialogue:() => ({text:answer,factIds:[]}),reviewDialogue:() => approved,...hooks,
  })});
  apps.push(app);
  return app;
}
const retry = (app:ReturnType<typeof buildApp>,id:string) => app.inject({
  method:'POST',url:'/api/games/'+id+'/dialogue/retry',payload:{version:1},
});
const read = (path:string,id:string): WorldState => {
  const store = new GameStore(path);
  try {return store.world(id);} finally {store.close();}
};

describe('原地补答已提交的提问', () => {
  it.each([false,true])('补答只生成台词，不重复身体动作或发言；快照各自回放实际听到的答复（私语 %s）',async whisper => {
    const {path,id,initial} = await failedSave({physical:true,whisper});
    expect(initial.turns[0].replyRetry?.speaker).toBe('艾琳');
    const before = read(path,id);
    const decide = vi.fn();
    const dialogue = vi.fn(() => ({text:answer,factIds:[]}));
    const app = server(path,{decideNpcAction:decide,dialogue});
    const snap = await app.inject({method:'POST',url:'/api/games/'+id+'/snapshots',payload:{version:1}});
    expect(snap.statusCode).toBe(200);
    const first = await retry(app,id);
    expect(first.statusCode,first.body).toBe(200);
    const view = first.json();
    expect(view.state).toEqual(initial.state);
    expect(view.turns[0].replyRetry).toBeUndefined();
    expect(view.turns[0].observations.at(-1)).toMatchObject({kind:'dialogue',text:answer,speaker:'艾琳'});
    expect(view.turns[0].observations[0]).toEqual(initial.turns[0].observations[0]);
    expect(view.turns[0].hearing).toEqual(initial.turns[0].hearing);
    expect((await retry(app,id)).json()).toEqual(view);
    expect(dialogue).toHaveBeenCalledOnce();
    expect(decide).not.toHaveBeenCalled();
    const after = read(path,id);
    expect(after.history.slice(0,-1)).toEqual(before.history);
    expect(after.history.at(-1)?.utterance).toEqual({speakerId:'steward',listenerIds:whisper ? ['king'] : ['king','captain'],
      ...(whisper ? {private:true} : {groups:before.history.find(e=>e.source === 'speech')!.utterance!.groups})});
    expect({...after, history:[]}).toEqual({...before,history:[]});
    expect((await server(path).inject('/api/games/'+id)).json()).toEqual(view);
    const oldBranch = await app.inject({method:'POST',url:'/api/games/'+id+'/snapshots/'+snap.json().id+'/load',payload:{}});
    expect(oldBranch.json().turns).toEqual(initial.turns);
    const afterSnap = await app.inject({method:'POST',url:'/api/games/'+id+'/snapshots',payload:{version:1}});
    const newBranch = await app.inject({method:'POST',url:'/api/games/'+id+'/snapshots/'+afterSnap.json().id+'/load',payload:{}});
    expect(newBranch.json().turns).toEqual(view.turns);
  });

  it('事后出现新的通报时保留原话与现场，再次未获可用答复也不写入存档', async () => {
    const interrupted = await failedSave({interrupt:true});
    const blocked = server(interrupted.path);
    expect(interrupted.initial.turns[0].replyRetry).toBeUndefined();
    expect((await retry(blocked,interrupted.id)).statusCode).toBe(409);
    const {id,path,initial} = await failedSave();
    const failing = server(path,{reviewDialogue:() => ({...approved,grounded:false})});
    expect((await retry(failing,id)).statusCode).toBe(502);
    expect((await failing.inject('/api/games/'+id)).json()).toEqual(initial);
  });

  it('同时重试复用结果，另一进程已经开始的行动不能覆盖补答，下回合仍可正常继续', async () => {
    const {path,id} = await failedSave();
    const started = deferred(), finish = deferred();
    const slowTurn = server(path,{parse:async () => {started.resolve();await finish.promise;return {kind:'look'};}});
    const command = {version:1,requestId:randomUUID(),input:'观察周围'};
    const takingTurn = slowTurn.inject({method:'POST',url:'/api/games/'+id+'/turns',payload:command}).then(r=>r);
    await started.promise;
    const speaking = deferred(), approvedNow = deferred();
    const fn = vi.fn(async () => {speaking.resolve();await approvedNow.promise;return {text:answer,factIds:[]};});
    const responder = server(path,{dialogue:fn});
    const first = retry(responder,id).then(r=>r);
    await speaking.promise;
    const second = retry(responder,id).then(r=>r);
    approvedNow.resolve();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(fn).toHaveBeenCalledOnce();
    finish.resolve();
    expect((await takingTurn).statusCode).toBe(409);
    const next = await slowTurn.inject({method:'POST',url:'/api/games/'+id+'/turns',payload:command});
    expect(next.statusCode,next.body).toBe(200);
    expect(next.json().turns[0].narrative).toContain(answer);
    expect((await retry(responder,id)).json()).toEqual(next.json());
  });

  it('两个服务竞相补答时，只向原听众交付先成功的那一句',async () => {
    const {path,id} = await failedSave();
    const speaking = deferred(), finish = deferred();
    const slow = server(path,{dialogue:async () => {
      speaking.resolve(); await finish.promise;
      return {text:'较晚完成的台词。',factIds:[]};
    }});
    const pending = retry(slow,id).then(r=>r);
    await speaking.promise;
    const first = await retry(server(path),id);
    finish.resolve();
    expect(first.statusCode).toBe(200);
    expect((await pending).json()).toEqual(first.json());
    const stored = read(path,id);
    expect(stored.history.filter(e => e.replyToFailureId).map(e => e.text)).toEqual([answer]);
  });
});
