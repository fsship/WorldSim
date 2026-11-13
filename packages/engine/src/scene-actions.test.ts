import { expect, it } from 'vitest';
import { MockLLMProvider } from '@worldsim/llm';
import { createCustomScenario } from '@worldsim/scenarios';
import { WorldStateSchema, type TurnPlan } from '@worldsim/shared';
import { projectWorld, runTurn } from './index';

const world = () => createCustomScenario('studio','test',{worldInfo:'城市里的一间画室。',opening:'你来到画室。'});
const interpret = (plan:TurnPlan) => Object.assign(new MockLLMProvider(),{interpret:async () => plan});
const lamp = {scope:'scene' as const,name:'台灯',value:'已打开'};
const pen = {scope:'held' as const,name:'铅笔',value:'在手中'};
it('部分完成的步骤在读档后仍然生效，失败步骤和后续步骤不写入',async () => {
  const start = world();
  const result = await runTurn(start,'开灯，拿笔，写字',interpret({kind:'sequence',steps:[
    {source:'开灯',text:'台灯亮了。',sets:[lamp]},
    {source:'拿笔',text:'你拿起铅笔。',requires:[{...lamp,value:'已关闭'}],sets:[pen]},
    {source:'写字',text:'你写下了名字。'},
  ]}));
  expect(result.turn.resolution.status).toBe('uncertain');
  expect(result.world.time).toBe(start.time+1);
  expect(result.turn.narrative).not.toContain('写下');
  const loaded = WorldStateSchema.parse(JSON.parse(JSON.stringify(result.world)));
  expect(loaded.sceneState).toEqual([{...lamp,locationId:'start'}]);
  const used = await runTurn(loaded,'借着灯光拿起铅笔',interpret({kind:'sequence',steps:[
    {source:'拿起铅笔',text:'你拿起铅笔。',requires:[lamp],sets:[pen]},
  ]}));
  expect(projectWorld(used.world).player.items.map(i=>i.name)).toContain('铅笔');
  const next = await runTurn(used.world,'前往公园',interpret({kind:'explore',destination:'公园'}));
  expect(projectWorld(next.world).player.items.map(i=>i.name)).toContain('铅笔');
  expect(projectWorld(next.world).location.description).not.toContain('台灯');
  const put = await runTurn(next.world,'放下铅笔',interpret({kind:'sequence',steps:[
    {source:'放下铅笔',text:'你放下铅笔。',clears:[pen],sets:[{scope:'scene',name:'铅笔',value:'地面上'}]},
  ]}));
  expect(projectWorld(put.world).player.items).toHaveLength(0);
  expect(projectWorld(put.world).location.description).toContain('铅笔');
});
