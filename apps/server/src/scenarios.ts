import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BUILTIN_SCENARIOS, createBuiltinScenario, createCustomScenario, ScenarioDefinitionSchema } from '@worldsim/scenarios';
import type { ScenarioSummary } from '@worldsim/shared';
import { ApiError } from './errors';
import type { GameStore } from './store';

const fieldNames: Record<string, string> = {
  title: '剧本名称', opening: '开场', startTime: '开场时间', locations: '地点', player: '玩家', npcs: 'NPC',
  id: '标识', name: '名称', description: '描述', role: '身份', locationId: '所在地点',
  goal: '目标', duty: '职责', events: '事件', afterMinutes: '发生时间', text: '事件内容',
};

function issueText(issue: z.ZodIssue): string {
  const field = issue.path.map(key => typeof key === 'number' ? '第' + (key + 1) + '项' : fieldNames[key] ?? key).join(' / ') || '剧本';
  let reason = issue.message;
  if (!/^[\u3400-\u9fff]/u.test(reason)) {
    switch (issue.code) {
      case 'too_small':
        reason = issue.type === 'array' ? '至少需要 ' + issue.minimum + ' 项' :
          issue.type === 'string' ? '至少需要 ' + issue.minimum + ' 个字符' : '数值过小';
        break;
      case 'too_big':
        reason = issue.type === 'array' ? '最多允许 ' + issue.maximum + ' 项' :
          issue.type === 'string' ? '最多允许 ' + issue.maximum + ' 个字符' : '数值过大';
        break;
      case 'unrecognized_keys': reason = '包含不支持的字段'; break;
      case 'invalid_type': reason = issue.received === 'undefined' ? '缺少必填内容' : '内容类型不正确'; break;
      default: reason = '格式无效';
    }
  }
  return field + '：' + reason;
}

function parseDefinition(input: unknown) {
  const parsed = ScenarioDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, issueText(parsed.error.issues[0]));
  return parsed.data;
}

const isBuiltin = (id: string) => BUILTIN_SCENARIOS.some(scenario => scenario.id === id);

export function createScenarioWorld(store: GameStore, scenarioId: string, gameId: string) {
  return isBuiltin(scenarioId) ? createBuiltinScenario(scenarioId, gameId)
    : createCustomScenario(scenarioId, gameId, store.customScenario(scenarioId));
}

export function registerScenarioRoutes(app: FastifyInstance, store: GameStore) {
  app.get<{ Reply:ScenarioSummary[] }>('/api/scenarios', async () => [
    ...BUILTIN_SCENARIOS.map(scenario => ({ ...scenario, builtin: true })),
    ...store.listCustomScenarios().map(scenario => ({ ...scenario, builtin: false })),
  ]);
  app.get<{ Params: { id: string } }>('/api/scenarios/:id', async req => store.customScenario(req.params.id));
  // Definitions include all locations, characters and events. Turns retain their smaller request limit.
  const formOptions = { bodyLimit: 256 * 1024 };
  app.post<{ Reply:ScenarioSummary }>('/api/scenarios', formOptions, async req => store.saveCustomScenario(parseDefinition(req.body)));
  app.put<{ Params: { id: string }; Reply:ScenarioSummary }>('/api/scenarios/:id', formOptions, async req => {
    if (isBuiltin(req.params.id)) throw new ApiError(403, '内置剧本只读。');
    return store.saveCustomScenario(parseDefinition(req.body), req.params.id);
  });
}
