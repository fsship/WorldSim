import {
  ScenarioDefinitionSchema, WorldStateSchema, type Character, type ScenarioDefinition, type ScenarioInput, type WorldState,
} from '@worldsim/shared';

function character(person:ScenarioDefinition['player'] & {duty?:string}, id:string, kind:Character['kind']): Character {
  return {
    id, kind, name:person.name, role:person.role, aliases:[person.role], locationId:person.locationId,
    ...(person.duty ? {publicDuty:person.duty} : {}),
    goals:person.goal ? [person.goal] : [], condition:'healthy',
    attributes:kind === 'player' ? {observation:3, diplomacy:3} : {observation:2, diplomacy:2},
    abilities:[], inventory:[], knownFactIds:[], relations:{}, plans:[],
  };
}

export function createCustomScenario(scenarioId:string, gameId:string, definition:ScenarioInput): WorldState {
  const draft = ScenarioDefinitionSchema.parse(definition);
  const startTime = draft.startTime ?? 8 * 60;
  const player = character(draft.player, 'player', 'player');
  const characters = [player, ...draft.npcs.map((npc, i) => character(npc, 'npc-' + (i + 1), 'npc'))];
  const locations = draft.locations.map((place, index) => ({
    ...place, aliases:[], ambience:'暂时没有特别的声响。',
    exits:[draft.locations[index - 1], draft.locations[index + 1]].flatMap(neighbor => neighbor ? [neighbor.id] : []),
  }));
  const witnesses = characters.filter(person => person.locationId === player.locationId);
  const history:WorldState['history'] = [{
    id:'opening-1', source:'opening', time:startTime, kind:'world', text:draft.opening, perception:'local',
    locationId:player.locationId, recipients:[player.id], noticeWitnessIds:witnesses.map(person => person.id), changes:[],
  }];
  const speaker = witnesses.find(person => person.kind === 'npc');
  if (speaker) {
    // prepareOpening replaces the seed with this NPC's own decision, speech or silence.
    history.push({id:'opening-2', source:'opening', time:startTime, kind:'npc', text:'等待回应。',
      speaker:speaker.name, speakerId:speaker.id, perception:'local', locationId:player.locationId, recipients:[player.id], changes:[]});
  }
  const queue:WorldState['queue'] = (draft.events ?? []).map((event, index) => ({
    id:'event-' + String(index + 1).padStart(2, '0'), at:startTime + event.afterMinutes, text:event.text,
    type:'notice', perception:'local', important:true, status:'pending', locationId:event.locationId,
    entities:[], condition:{}, recipients:[], effects:[],
  }));
  return WorldStateSchema.parse({
    id:gameId, scenario:draft.title, scenarioId, version:0, time:startTime, locations, characters, history, queue,
    ...(draft.worldInfo ? {worldInfo:draft.worldInfo} : {}),
    rules:{maxWait:720, maxShort:10, discoveries:[], testimonies:[], orders:[], arrestAuthority:'拘押权限', arrestEvidence:[], useNpcGoals:true},
    items:[], facts:[], variables:{},
  });
}

export const lighthouse:ScenarioDefinition = {
  title:'雾港来信',
  opening:'早上八点，海雾一直漫到塔门口。值班室的无线电刚收到渡船的呼叫：他们看见了两束灯光，却无法分辨哪一束才指向进港航道。再过一刻钟，船就要抵达外湾。',
  locations:[
    {id:'lantern', name:'灯室', description:'透镜在铜座上缓缓转动，玻璃上贴着值班员写下的灯号：两短一长。'},
    {id:'station', name:'值班室', description:'无线电架在朝海的窗边，墙上的潮汐表圈出了今天上午的满潮时刻。楼梯通往灯室，另一扇门通向栈桥。'},
    {id:'pier', name:'栈桥', description:'潮水没过了最低的一层石阶。系船柱旁挂着信号旗，雾中只看得清近处的浮标。'},
  ],
  player:{name:'沈岚', role:'灯塔值班员', locationId:'station', goal:'确认正确的灯号，引导渡船安全进港。'},
  npcs:[
    {name:'林澍', role:'报务员', locationId:'station', duty:'守听无线电并核对渡船的呼号。', goal:'记录船长最后一次清楚报出的方位。'},
    {name:'许照', role:'守灯人', locationId:'lantern', duty:'检查灯室的透镜与灯号。', goal:'找出外湾第二束灯光的来处。'},
    {name:'阿芮', role:'引航员', locationId:'pier', duty:'观察栈桥外的水流和能见度。'},
  ],
  events:[
    {afterMinutes:8, locationId:'pier', text:'雾往西散开了一线，浮标背后露出一艘渔船。渔船桅顶的作业灯正对着航道。'},
    {afterMinutes:15, locationId:'station', text:'无线电响了三声。船长报告已经停船，正在外湾等待灯塔确认进港灯号。'},
    {afterMinutes:24, locationId:'lantern', text:'东面的雾被风推开，透过灯室的玻璃可以看见渡船在浮标外掉头。'},
  ],
};
