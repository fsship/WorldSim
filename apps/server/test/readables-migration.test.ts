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
});
