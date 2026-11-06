import { describe, expect, it } from 'vitest';
import { BUILTIN_SCENARIOS, createBuiltinScenario, createCustomScenario, createPalace, loadScenarioWorld,
  ScenarioDefinitionSchema, type ScenarioDefinition } from './index';

const draft:ScenarioDefinition = {
  title:'王宫疑云', opening:'玻璃温室里响起了一声铃。',
  locations:[
    {id:'hall', name:'温室', description:'长案上放着两只花盆。'},
    {id:'yard', name:'前院', description:'石板缝里冒出了新草。'},
    {id:'shed', name:'木棚', description:'屋檐下码着木料。'},
  ],
  player:{name:'谢雨', role:'园艺师', locationId:'hall', goal:'找到新种子的花盆。'},
  npcs:[
    {name:'乔安', role:'花匠', locationId:'hall', duty:'照料新发芽的花苗。', goal:'修好育苗箱。'},
    {name:'韩峰', role:'木工', locationId:'shed'},
  ],
  events:[{afterMinutes:3, locationId:'yard', text:'花架旁的水阀滴下第一滴水。'}],
};

describe('剧本编译与开局', () => {
  it('所有内置剧本可独立开局，目录标题来自相应世界', () => {
    expect(new Set(BUILTIN_SCENARIOS.map(s => s.id)).size).toBe(BUILTIN_SCENARIOS.length);
    for (const scenario of BUILTIN_SCENARIOS) {
      const world = createBuiltinScenario(scenario.id, 'game');
      expect([world.scenarioId, world.scenario]).toEqual([scenario.id, scenario.title]);
      expect(loadScenarioWorld(world)).toEqual(world);
    }
    expect(createBuiltinScenario('palace', 'game')).toEqual(createPalace('game'));
    expect(createBuiltinScenario('lighthouse', 'game').characters.map(c => c.role)).toContain('灯塔值班员');
  });

  it('地点依序连通，开场按当时的位置记录见证人，事件采用游戏时钟', () => {
    const world = createCustomScenario('garden', 'first', draft);
    expect(world.time).toBe(480);
    expect(world.scenarioId).toBe('garden');
    expect(world.locations.map(l => l.exits)).toEqual([['yard'], ['hall','shed'], ['yard']]);
    expect(world.characters.map(c => [c.kind, c.name, c.locationId])).toEqual([
      ['player', '谢雨', 'hall'], ['npc', '乔安', 'hall'], ['npc', '韩峰', 'shed'],
    ]);
    expect(world.characters[1]).toMatchObject({publicDuty:draft.npcs[0].duty, goals:[draft.npcs[0].goal]});
    expect(world.history[0]).toMatchObject({text:draft.opening, noticeWitnessIds:world.characters.slice(0,2).map(c => c.id)});
    expect(world.history[1].speakerId).toBe(world.characters[1].id);
    expect(world.queue[0]).toMatchObject({at:world.time + 3, locationId:'yard', perception:'local', status:'pending'});
    expect(world.rules.useNpcGoals).toBe(true);
  });

  it.each([[0,3], [1439,1442]])('在首日第 %i 分钟开场，允许事件在次日发生', (startTime, at) => {
    const world = createCustomScenario('garden', 'game', {...draft, startTime});
    expect(world.time).toBe(startTime);
    expect(world.history.map(line => line.time)).toEqual([startTime, startTime]);
    expect(world.queue[0].at).toBe(at);
    expect(loadScenarioWorld(world)).toEqual(world);
  });

  it('同名自定义剧本加载时跳过王宫补全，原版老存档可还原剧本标识', () => {
    const world = createCustomScenario('custom-garden', 'game', draft);
    const {readables:_, ...stored} = world;
    expect(loadScenarioWorld(stored)).toEqual(world);
    const palace = createPalace('legacy');
    const {scenarioId:__, ...legacy} = palace;
    expect(loadScenarioWorld(legacy)).toEqual(palace);
  });

  it('独处或没有配角时，保留作者开场，不为玩家虚构说话人', () => {
    for (const npcs of [[], [draft.npcs[1]]]) {
      const world = createCustomScenario('solo', 'game', {...draft, npcs});
      expect(world.history).toHaveLength(1);
      expect(world.history[0].noticeWitnessIds).toEqual([world.characters[0].id]);
      expect(world.worldInfo).toBeUndefined();
    }
  });

  it('只写世界与当下处境即可开局，初始演员只有玩家，设定随世界存档', () => {
    const worldInfo = '群岛之间的邮船靠烟火辨认航路。每座岛都有哨塔。';
    const opening = '你站在海堤上，看着雾中的灯光。';
    const minimal = {worldInfo, opening};
    const definition = ScenarioDefinitionSchema.parse(minimal);
    expect(definition.title).toBe('群岛之间的邮船靠烟火辨认航路');
    expect(definition.npcs).toEqual([]);
    const world = createCustomScenario('sea', 'game', minimal);
    expect(world.worldInfo).toBe(worldInfo);
    expect(world.characters).toHaveLength(1);
    expect(world.characters[0]).toMatchObject({kind:'player', locationId:world.locations[0].id});
    expect(world.history.map(event => event.text)).toEqual([opening]);
    expect(loadScenarioWorld(world)).toEqual(world);
    expect(createCustomScenario('sea', 'game', definition)).toEqual(world);
  });

  it('世界模式可以补充起始地点与预设角色；旧剧本仍需完整定义', () => {
    const locations = [draft.locations[1]];
    const world = createCustomScenario('garden', 'game', {
      worldInfo:'潮间带上的温室。', opening:draft.opening, locations,
      npcs:[{name:'阿颂', role:'船客', locationId:locations[0].id}],
    });
    expect(world.characters.map(person => person.name)).toEqual(['主角', '阿颂']);
    expect(world.characters[0].locationId).toBe(locations[0].id);
    expect(ScenarioDefinitionSchema.safeParse({opening:draft.opening}).success).toBe(false);
    expect(ScenarioDefinitionSchema.safeParse({opening:draft.opening, worldInfo:'   '}).success).toBe(false);
  });

  it('拒绝重名、断开的地点引用和越界事件，保存前统一处理空白', () => {
    expect(ScenarioDefinitionSchema.parse({...draft, title:'  温室来客  '}).title).toBe('温室来客');
    for (const invalid of [
      {...draft, locations:[]},
      {...draft, locations:[draft.locations[0], {...draft.locations[1], id:'hall'}]},
      {...draft, locations:[draft.locations[0], {...draft.locations[1], name:'温室'}]},
      {...draft, player:{...draft.player, locationId:'nowhere'}},
      {...draft, npcs:[{...draft.npcs[0], name:draft.player.name}]},
      {...draft, npcs:[{...draft.npcs[0], locationId:'relocated'}]},
      {...draft, events:[{...draft.events![0], locationId:'gone'}]},
      {...draft, events:[{...draft.events![0], afterMinutes:0}]},
      {...draft, opening:'  '},
      {...draft, startTime:-1},
      {...draft, startTime:1440},
      {...draft, startTime:0.5},
    ]) expect(ScenarioDefinitionSchema.safeParse(invalid).success).toBe(false);
  });
});
