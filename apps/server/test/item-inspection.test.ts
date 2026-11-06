import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createPalace } from '@worldsim/scenarios';
import { MockLLMProvider } from '@worldsim/llm';
import { GameViewSchema } from '@worldsim/shared';
import { buildApp } from '../src/app';
import { GameStore } from '../src/store';

it('旧版印玺和玩家定制过的印玺都按自己的存档内容呈现，重复提交不重复拿取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-held-items-'));
  const databasePath = join(dir, 'games.sqlite');
  const oldDescription = '一枚可用于核验王命的黄铜印玺。';
  const custom = '印底嵌着一片绿色的玉。';
  const store = new GameStore(databasePath);
  const db = new DatabaseSync(databasePath);
  try {
    for (const [id, description] of [['old-seal', oldDescription], ['custom-seal', custom]]) {
      const initial = createPalace(id);
      store.create(initial);
      // Recreate the four-field item exactly as serialized before close inspection.
      const legacyItem = {id:'seal', name:'王室印玺', aliases:['印玺', '王印'], description};
      db.prepare('UPDATE games SET world=? WHERE id=?').run(JSON.stringify({...initial, items:[legacyItem]}), id);
    }
  } finally {
    db.close();
    store.close();
  }
  const app = buildApp({databasePath, env:{}, providerFactory:() => new MockLLMProvider()});
  try {
    for (const [id, expected] of [['old-seal', '印面'], ['custom-seal', custom]]) {
      const path = '/api/games/' + id;
      const request = {method:'POST' as const, url:path + '/turns', payload:{
        input:'我拿起王室印玺仔细看', requestId:'inspection', version:0,
      }};
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(200);
      const view = GameViewSchema.parse(response.json());
      expect(view.turns[0].narrative).toContain(expected);
      if (id === 'custom-seal') expect(view.turns[0].narrative).not.toContain('黄铜');
      expect(view.state.player.items.map(i => i.id)).toEqual(['seal']);
      expect(view.state.time).toBe(481);
      expect((await app.inject(request)).json()).toEqual(view);
      expect((await app.inject(path)).json()).toEqual(view);
    }
  } finally {
    await app.close();
    rmSync(dir, {recursive:true, force:true});
  }
});
