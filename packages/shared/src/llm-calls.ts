export type LlmCallStatus = 'success' | 'error';

export const llmTaskLabels: Readonly<Record<string, string>> = {
  interpret: '理解玩家行动', parse: '解析玩家行动', resolve: '裁决行动', matchWait: '判断等待结果',
  openingAssets:'登记开场物品', encounter: '生成相遇人物',
  regionalDuty: '处理地区公务', decideNpcAction: '生成角色行动', reviewNpcAction: '校验角色行动',
  dialogue: '生成角色台词', reviewDialogue: '校验角色台词', narrate: '整理回合叙事',
};

/** One HTTP attempt. Retries share a call ID and have increasing attempt numbers. */
export interface LlmCallAttempt {
  callId: string;
  attempt: number;
  startedAt: string;
  durationMs: number;
  task: string;
  model: string;
  status: LlmCallStatus;
  httpStatus: number | null;
  errorReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  requestBody: string;
  responseBody: string | null;
  responseTruncated: boolean;
}

export interface LlmCallEntry extends LlmCallAttempt {
  gameId: string | null;
  turnVersion: number | null;
}

export interface LlmCallDetail extends LlmCallEntry {
  id: number;
}

export type LlmCallSummary = Omit<LlmCallDetail, 'requestBody' | 'responseBody' | 'responseTruncated'>;

export interface LlmCallList {
  items: LlmCallSummary[];
  total: number;
}
