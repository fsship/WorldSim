import { expect, it } from 'vitest';
import { createCustomScenario } from '@worldsim/scenarios';
import { WorldStateSchema, type ScenarioInput } from '@worldsim/shared';
import { applyChanges, blockedRoute, projectWorld } from './state';
import { advance } from './scheduler';

const story:ScenarioInput = {
  title:'渡口停航',worldInfo:'两岸之间有一条船运线。',opening:'你正在北岸的等候室。',
  locations:[{id:'north',name:'北岸',description:'有一间等候室。'},{id:'south',name:'南岸',description:'有一个码头。'}],
  events:[
    {afterMinutes:1,locationId:'north',public:true,text:'广播通知暂时不准车辆过河。',
      situation:{id:'crossing',summary:'车辆暂时停渡。',blockedRoutes:[{from:'north',to:'south',mode:'vehicle'}],actions:[]}},
    {afterMinutes:6,locationId:'north',text:'北岸工作人员试航后重新开放车渡。',
      situation:{id:'crossing',summary:'已确认可以通车。',blockedRoutes:[],actions:[]}},
  ],
};

it('未到时不揭露局势；异地本地更新只保留上次见证；走到现场重新得知实际情况',() => {
  const world=createCustomScenario('river','test',story);
  expect(projectWorld(world).situations).toBeUndefined();
  advance(world,1,true,[]);
  expect(blockedRoute(world,'south','north',true)?.id).toBe('crossing');
  expect(blockedRoute(world,'south','north',false)).toBeUndefined();
  applyChanges(world,[{op:'move',actor:'player',to:'south'}]);
  advance(world,5,true,[]);
  expect(blockedRoute(world,'south','north',true)).toBeUndefined();
  const loaded=WorldStateSchema.parse(JSON.parse(JSON.stringify(world)));
  expect(projectWorld(loaded).situations?.[0]).toMatchObject({summary:'车辆暂时停渡。',updatedAt:481});
  applyChanges(loaded,[{op:'move',actor:'player',to:'north'}]);
  expect(projectWorld(loaded).situations?.[0]).toMatchObject({summary:'已确认可以通车。',updatedAt:486});
  // A local observation can also come from being present between updates (e.g. after actor creation).
  loaded.situations[0].witnesses=[];
  expect(projectWorld(loaded).situations?.[0].summary).toBe('已确认可以通车。');
  applyChanges(loaded,[{op:'depart',actor:'player',to:'south',arrivesAt:487},{op:'clock',to:487},{op:'move',actor:'player',to:'south'}]);
  expect(projectWorld(loaded).situations?.[0]).toMatchObject({summary:'已确认可以通车。',updatedAt:486});
});

it('选择可以改变当前目标、保留已有目标或在任务完成后清除',() => {
  const initial = createCustomScenario('river','decisions',{...story,
    player:{name:'青',role:'行人',locationId:'north',goal:'回家'},
    events:[{afterMinutes:1,locationId:'north',text:'摆渡员问你能否接班。',situation:{
      id:'duty',summary:'渡口缺人。',blockedRoutes:[],initialActions:['promise'],actions:[
        {id:'promise',summary:'答应接班',minutes:1,outcome:'你答应接班。',next:{summary:'已接班',blockedRoutes:[],actions:['count'],playerGoal:'等人到齐后交班'}},
        {id:'count',summary:'清点乘客',minutes:1,outcome:'乘客均已到齐。',next:{summary:'已清点',blockedRoutes:[],actions:['finish']}},
        {id:'finish',summary:'交班',minutes:1,outcome:'交班完成。',next:{summary:'已交班',blockedRoutes:[],playerGoal:null}},
      ],
    }}],
  });
  advance(initial,1,true,[]);
  expect(projectWorld(initial).player.goal).toBe('回家');
  applyChanges(initial,[{op:'respondSituation',situationId:'duty',actionId:'promise'}]);
  const loaded=WorldStateSchema.parse(JSON.parse(JSON.stringify(initial)));
  expect(projectWorld(loaded).player.goal).toBe('等人到齐后交班');
  applyChanges(loaded,[{op:'respondSituation',situationId:'duty',actionId:'count'}]);
  expect(projectWorld(loaded).player.goal).toBe('等人到齐后交班');
  applyChanges(loaded,[{op:'respondSituation',situationId:'duty',actionId:'finish'}]);
  expect(projectWorld(loaded).player.goal).toBeUndefined();
});
