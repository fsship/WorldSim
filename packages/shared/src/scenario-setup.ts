export function defaultScenarioSetup(playerLocationId = 'start') {
  return {
    locations:[{id:'start', name:'开场地点', description:'故事从这里开始。'}],
    player:{name:'主角', role:'玩家角色', locationId:playerLocationId},
  };
}
