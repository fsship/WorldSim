import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { runTurn } from '@worldsim/engine';
import { MockLLMProvider } from '@worldsim/llm';
import { createPalace, loadScenarioWorld } from '@worldsim/scenarios';
import { GameStore } from '../src/store';

it('旧游戏和旧快照都能读取当时议事厅的文书，既有回合保留原样', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-readables-'));
  const file = join(dir, 'games.sqlite');
  const store = new GameStore(file);
  const db = new DatabaseSync(file);
  try {
    const initial = createPalace('before-documents');
    store.create(initial);
    const base = store.world(initial.id);
    const next = await runTurn(base, '等待三分钟', new MockLLMProvider());
    const view = store.commit(base, {version:0, requestId:'first', input:next.turn.input}, next);
    const snapshot = store.snapshot(initial.id, 1);
    db.prepare("UPDATE games SET world=json_remove(world, '$.readables') WHERE id=?").run(initial.id);
    db.prepare("UPDATE snapshots SET world=json_remove(world, '$.readables') WHERE id=?").run(snapshot.id);

    expect(store.world(initial.id)).toEqual(next.world);
    expect(store.view(initial.id)).toEqual(view);
    const fork = store.restore(initial.id, snapshot.id);
    expect(fork.turns).toEqual(view.turns);
    expect(store.world(fork.state.id)).toEqual({...next.world, id:fork.state.id});
    // Legacy rows are only upgraded in memory. Restore writes a new game.
    expect(db.prepare("SELECT json_type(world,'$.readables') AS field FROM games WHERE id=?").get(initial.id)?.field).toBeNull();
    expect(db.prepare("SELECT json_type(world,'$.readables') AS field FROM snapshots WHERE id=?").get(snapshot.id)?.field).toBeNull();
  } finally {
    db.close();
    store.close();
    rmSync(dir, {recursive:true, force:true});
  }
});

it('只补本剧本缺失的文书，新版存档自己定义的正文或空清单优先', () => {
  const palace = createPalace('preserve');
  const {readables, ...legacy} = palace;
  expect(readables[0].entries.map(entry => entry.title)).toEqual(['官员点名', '宫门交班', '各部呈报']);
  expect(loadScenarioWorld({...legacy, scenario:'另一剧本'}).readables).toEqual([]);
  expect(loadScenarioWorld({...palace, readables:[]}).readables).toEqual([]);
  const edited = {...readables[0], entries:[{title:'增补议程', text:'先听取陈情。'}]};
  expect(loadScenarioWorld({...palace, readables:[edited]}).readables).toEqual([edited]);
  const {preparedBy, ...oldAgenda} = readables[0];
  expect(preparedBy).toBe('steward');
  expect(loadScenarioWorld({...palace, readables:[oldAgenda]}).readables[0].preparedBy).toBe('steward');
  expect(loadScenarioWorld({...palace, readables:[{...oldAgenda,entries:edited.entries}]}).readables[0].preparedBy).toBeUndefined();
  const originalAgenda = readables[0];
  const deliveries = readables.filter(doc => doc.availableAfterEvent);
  expect(deliveries.length).toBeGreaterThan(0);
  expect(loadScenarioWorld({...palace, readables:[originalAgenda]}).readables).toEqual(readables);
  for (const eventId of new Set(deliveries.map(doc => doc.availableAfterEvent))) {
    expect(palace.queue.filter(e => e.id === eventId)).toHaveLength(1);
    const changedNotice = palace.queue.map(e => e.id === eventId ? {...e, text:'侍卫进来行礼。'} : e);
    expect(loadScenarioWorld({...palace, queue:changedNotice, readables:[originalAgenda]}).readables)
      .toEqual(readables.filter(d => d.availableAfterEvent !== eventId));
  }
  const customLog = {...deliveries[0], entries:[{title:'替班记录', text:'雨天，两班人一起清点雨具。'}]};
  expect(loadScenarioWorld({...palace, readables:[readables[0], customLog]}).readables).toEqual([readables[0], customLog]);
});

it('只有原版议程的旧存档和快照，在侍卫呈簿后可接着阅读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-handover-'));
  const file = join(dir, 'games.sqlite');
  const store = new GameStore(file);
  const db = new DatabaseSync(file);
  try {
    const initial = createPalace('old-handover');
    store.create(initial);
    const provider = new MockLLMProvider({decideNpcAction:() => ({kind:'stay'})});
    for (const input of ['等待钟声', '等待二十分钟']) {
      const base = store.world(initial.id);
      const next = await runTurn(base, input, provider);
      store.commit(base, {version:base.version, requestId:'wait-' + base.version, input}, next);
    }
    const before = store.view(initial.id);
    expect(before.state.time).toBe(512);
    expect(before.turns.at(-1)?.narrative).toContain('呈上宫门的交接簿');
    const snapshot = store.snapshot(initial.id, before.state.version);
    const oldReadables = JSON.stringify(initial.readables.filter(doc => !doc.availableAfterEvent));
    db.prepare("UPDATE games SET world=json_set(world, '$.readables', json(?)) WHERE id=?").run(oldReadables, initial.id);
    db.prepare("UPDATE snapshots SET world=json_set(world, '$.readables', json(?)) WHERE id=?").run(oldReadables, snapshot.id);

    const fork = store.restore(initial.id, snapshot.id);
    expect(fork.turns).toEqual(before.turns);
    for (const id of [initial.id, fork.state.id]) {
      const world = store.world(id);
      expect(world.readables).toEqual(initial.readables);
      expect(loadScenarioWorld(world)).toEqual(world);
      expect(world.history.filter(e => e.source === 'dispatch')).toHaveLength(1);
      const next = await runTurn(world, '我看了下交接簿，看看上面写了什么', provider);
      expect(next.turn.resolution.status).toBe('resolved');
      const ledger = initial.readables.find(doc => doc.availableAfterEvent === 'dispatch')!;
      expect(next.turn.narrative).toContain(ledger.entries[0].text);
      expect(next.turn.events.some(e => e.source === 'dispatch')).toBe(false);
    }
    expect(db.prepare("SELECT json_array_length(world, '$.readables') AS n FROM games WHERE id=?").get(initial.id)?.n).toBe(1);
    expect(db.prepare("SELECT json_array_length(world, '$.readables') AS n FROM snapshots WHERE id=?").get(snapshot.id)?.n).toBe(1);
  } finally {
    db.close();
    store.close();
    rmSync(dir, {recursive:true, force:true});
  }
});
