import { z } from 'zod';

const name = z.string().trim().min(1, '请输入名称').max(60, '名称不能超过 60 字');
const placeId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/, '地点标识必须为 1–60 位字母、数字、横线或下划线');
const note = z.string().trim().max(200, '不能超过 200 字').optional();
const person = z.object({ name, role:name, locationId:placeId, goal:note }).strict();

export const ScenarioDefinitionSchema = z.object({
  title:z.string().trim().min(1, '请填写剧本名称').max(80, '剧本名称不能超过 80 字'),
  opening:z.string().trim().min(1, '请填写开场').max(1200, '开场不能超过 1200 字'),
  startTime:z.number().int().min(0).max(1439).optional(),
  locations:z.array(z.object({
    id:placeId, name,
    description:z.string().trim().min(1, '请描述地点').max(400, '地点描述不能超过 400 字'),
  }).strict()).min(1, '至少需要一个地点').max(12, '最多支持 12 个地点'),
  player:person,
  npcs:z.array(person.extend({duty:note})).max(16, '最多支持 16 个配角'),
  events:z.array(z.object({
    afterMinutes:z.number().int().min(1).max(1440), locationId:placeId,
    text:z.string().trim().min(1, '请填写事件内容').max(600, '事件文字不能超过 600 字'),
  }).strict()).max(24, '最多支持 24 个剧情事件').optional(),
}).strict().superRefine((definition, ctx) => {
  const placeIds = new Set<string>();
  const placeNames = new Set<string>();
  for (const [i, place] of definition.locations.entries()) {
    if (placeIds.has(place.id)) ctx.addIssue({code:'custom', path:['locations', i, 'id'], message:'地点标识重复'});
    if (placeNames.has(place.name)) ctx.addIssue({code:'custom', path:['locations', i, 'name'], message:'地点名称重复'});
    placeIds.add(place.id);
    placeNames.add(place.name);
  }
  function checkPlace(id:string, path:(string | number)[]) {
    if (!placeIds.has(id)) ctx.addIssue({code:'custom', path:[...path, 'locationId'], message:'请选择剧本内的地点'});
  }
  checkPlace(definition.player.locationId, ['player']);
  const people = new Set([definition.player.name]);
  for (const [i, npc] of definition.npcs.entries()) {
    checkPlace(npc.locationId, ['npcs', i]);
    if (people.has(npc.name)) ctx.addIssue({code:'custom', path:['npcs', i, 'name'], message:'人物姓名重复'});
    people.add(npc.name);
  }
  definition.events?.forEach((event, i) => checkPlace(event.locationId, ['events', i]));
});

export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;

export interface ScenarioSummary {
  id: string;
  title: string;
  description: string;
  builtin: boolean;
}
