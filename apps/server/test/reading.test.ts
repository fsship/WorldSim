import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MockLLMProvider } from '@worldsim/llm';
import { createPalace } from '@worldsim/scenarios';
import { GameViewSchema, SnapshotSummarySchema } from '@worldsim/shared';
import { buildApp } from '../src/app';

it('阅读中断后的公开纪事、读档与快照分支都保留未读位置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldsim-reading-'));
  const options = {
    databasePath:join(dir, 'test.sqlite'), env:{},
    providerFactory:() => new MockLLMProvider({decideNpcAction:() => ({kind:'stay'})}),
  };
  let app = buildApp(options);
  try {
    const post = async (url: string, payload: object) => {
      const r = await app.inject({method:'POST', url, payload});
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    const game = GameViewSchema.parse(await post('/api/games', {}));
    const path = '/api/games/' + game.state.id;
    const [first, second, third] = createPalace('fixture').readables.find(d => d.id === 'morning-agenda')!.entries;
    await post(path + '/turns', {requestId:'wait', input:'等待十四分钟', version:0});
    const read = {requestId:'read', input:'查看长桌上的朝会议程', version:1};
    const interrupted = GameViewSchema.parse(await post(path + '/turns', read));
    expect(interrupted.state.time).toBe(495);
    expect(interrupted.turns[1].narrative).toContain(first.text);
    expect(interrupted.turns[1].narrative).toContain('钟声');
    for (const entry of [second, third]) expect(JSON.stringify(interrupted)).not.toContain(entry.text);
    expect(await post(path + '/turns', read)).toEqual(interrupted);
    const snap = SnapshotSummarySchema.parse(await post(path + '/snapshots', {version:2}));
    await app.close();
    app = buildApp(options);
    expect((await app.inject(path)).json()).toEqual(interrupted);
    const branch = GameViewSchema.parse(await post(path + '/snapshots/' + snap.id + '/load', {}));
    expect(branch.turns).toEqual(interrupted.turns);
    const continued = GameViewSchema.parse(await post('/api/games/' + branch.state.id + '/turns',
      {requestId:'resume', input:'继续阅读朝会议程', version:2}));
    expect(continued.state.time).toBe(497);
    const narrative = continued.turns[2].narrative;
    expect(narrative).not.toContain(first.text);
    expect(narrative).toContain(second.text);
    expect(narrative).toContain(third.text);
    expect((await app.inject(path)).json()).toEqual(interrupted);
  } finally {
    await app.close();
    rmSync(dir, {recursive:true, force:true});
  }
});
