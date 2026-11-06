import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { prepareOpening, projectWorld, replyRecovery, retryDialogue, retryOpening, runTurn } from '@worldsim/engine';
import { createProvider, ProviderFailure } from '@worldsim/llm';
import { llmTaskLabels, ProviderConfigSchema, TurnRequestSchema, type GameView, type ProviderConfig } from '@worldsim/shared';
import { assertPrivateDatabase, envConfig, publicConfig, updateConfig } from './config';
import { ApiError, versionConflict } from './errors';
import { GameStore, type Command } from './store';
import { createScenarioWorld, registerScenarioRoutes } from './scenarios';

const snapshotInput = TurnRequestSchema.pick({ version: true });
const emptyInput = z.object({}).strict();
const newGameInput = z.object({ scenarioId: z.string().min(1).max(160).default('palace') }).strict();
const openingInput = z.object({version:z.literal(0)}).strict();
const callListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['success', 'error']).optional(),
  offset: z.coerce.number().int().nonnegative().safe().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
const callIdParam = z.object({ id: z.coerce.number().int().positive().safe() });
type ActiveRequest = { kind:'turn'; command:Command; result:Promise<GameView> } |
  { kind:'opening'; result:Promise<GameView> } | {kind:'dialogue'; version:number; result:Promise<GameView>};

interface Options {
  databasePath: string;
  logger?: boolean;
  staticRoot?: string;
  env?: NodeJS.ProcessEnv;
  // Tests can inject a faulty provider without bypassing the real engine.
  providerFactory?: typeof createProvider;
}

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(host);
}

function providerFailureNotice(error: ProviderFailure): string {
  const stage = llmTaskLabels[error.task];
  switch (error.reason) {
    case 'speech_evidence': return '模型提取的发言与玩家原话不符。';
    case 'format': return stage + '时，模型返回的内容未通过格式校验。';
    case 'timeout': return stage + '时，模型请求超时。';
    case 'network': return stage + '时，未能连接模型服务。';
    case 'http': return stage + '时，模型服务返回 HTTP ' + error.httpStatus + '。' +
      (error.httpStatus === 401 || error.httpStatus === 403 ? '请检查模型服务的访问权限。' : '');
  }
}

export function buildApp(options: Options) {
  assertPrivateDatabase(options.databasePath, options.staticRoot);
  const defaultConfig = envConfig(options.env ?? process.env);
  const store = new GameStore(options.databasePath);
  const app = Fastify({
    logger: options.logger ?? false, bodyLimit: 32_768,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const makeProvider = options.providerFactory ?? createProvider;
  const getConfig = (): ProviderConfig => ProviderConfigSchema.parse(store.config() ?? defaultConfig);
  const inFlight = new Map<string, ActiveRequest>();

  function providerFor(gameId: string, turnVersion: number) {
    return makeProvider(getConfig(), attempt => store.recordLlmCall({ ...attempt, gameId, turnVersion }));
  }

  app.addHook('onClose', async () => store.close());
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    const host = req.headers.host;
    if (!isLocalHost(host)) throw new ApiError(403, '此服务仅供本机访问。');
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
      throw new ApiError(403, '此操作仅允许由游戏页面发起。');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, '此操作仅允许由游戏页面发起。');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new ApiError(415, '请使用 JSON 提交操作。');
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) return reply.status(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.status(400).send({ error: '提交的数据不符合要求。' });
    const status = typeof error === 'object' && error && 'statusCode' in error ? error.statusCode : 500;
    const code = typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
    req.log.warn({ requestId: req.id, status: code }, 'request failed');
    return reply.status(code).send({ error: code === 500 ? '操作未完成，请稍后重试。' : '请求格式无效。' });
  });

  app.get('/api/llm-calls', async req => store.listLlmCalls(callListQuery.parse(req.query)));
  app.get('/api/llm-calls/:id', async req => store.llmCall(callIdParam.parse(req.params).id));

  registerScenarioRoutes(app, store);
  app.get('/api/games', async () => store.list());
  app.post('/api/games', async req => {
    const { scenarioId } = newGameInput.parse(req.body);
    const world = createScenarioWorld(store, scenarioId, randomUUID());
    return store.create(await prepareOpening(world, providerFor(world.id, world.version)));
  });
  app.get<{ Params: { id: string } }>('/api/games/:id', async req => store.view(req.params.id));
  app.post<{ Params: { id: string } }>('/api/games/:id/opening/retry', async req => {
    openingInput.parse(req.body);
    const id = req.params.id;
    const active = inFlight.get(id);
    if (active?.kind === 'opening') return active.result;
    if (active) throw new ApiError(409, '当前回合正在处理中，请稍候。');
    const base = store.world(id);
    if (base.version !== 0) throw versionConflict();
    const state = projectWorld(base);
    if (!state.openingUsedFallback) return store.view(id);
    if (!state.openingRetryable) throw new ApiError(409, '开场已经发生了不可重复的行动。');
    async function recover() {
      let next;
      try { next = await retryOpening(base, providerFor(id, base.version)); }
      catch {
        req.log.warn({ gameId:id }, 'opening recovery failed');
        throw new ApiError(502, '开场重试失败，原存档已保留。');
      }
      return store.replaceOpening(base, next);
    }
    const result = recover();
    inFlight.set(id, {kind:'opening', result});
    try { return await result; } finally { inFlight.delete(id); }
  });
  app.get('/api/settings', async () => publicConfig(getConfig()));
  app.post<{Params:{id:string}}>('/api/games/:id/dialogue/retry', async req => {
    const {id} = req.params;
    const {version} = snapshotInput.parse(req.body);
    const active = inFlight.get(id);
    if (active?.kind === 'dialogue' && active.version === version) return active.result;
    if (active) throw new ApiError(409,'当前回合正在处理中，请稍候。');
    const base = store.world(id);
    const turn = store.savedTurn(id,version);
    const eligibility = replyRecovery(base,turn);
    if (eligibility?.replacement) return store.view(id);
    if (!eligibility) throw new ApiError(409,'提问后的现场已变化，或本回合没有可补答的台词。');
    async function recover() {
      const next = await retryDialogue(base,turn,providerFor(id, version));
      if ('notice' in next) {
        if (replyRecovery(store.world(id),turn)?.replacement) return store.view(id);
        throw new ApiError(502,next.notice + '时间和原回合已保留，可以再试。');
      }
      return store.saveDialogue(base,turn,next.world);
    }
    const result = recover();
    inFlight.set(id,{kind:'dialogue',version,result});
    try {return await result;} finally {inFlight.delete(id);}
  });
  app.put('/api/settings', async req => {
    const config = updateConfig(getConfig(), ProviderConfigSchema.parse(req.body));
    store.setConfig(config);
    return publicConfig(config);
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/turns', async req => {
    const id = req.params.id;
    const command = TurnRequestSchema.parse(req.body);
    if (store.replayed(id, command)) return store.view(id);
    const active = inFlight.get(id);
    if (active) {
      if (active.kind === 'turn' && active.command.requestId === command.requestId &&
          active.command.version === command.version && active.command.input === command.input) {
        return active.result;
      }
      throw new ApiError(409, '当前回合正在处理中，请稍候。');
    }
    const world = store.world(id);
    if (world.version !== command.version) throw versionConflict();
    const play = async (): Promise<GameView> => {
      let next: Awaited<ReturnType<typeof runTurn>>;
      try {
        next = await runTurn(world, command.input, providerFor(id, command.version + 1));
      } catch (error) {
        const diagnostic = error instanceof ProviderFailure
          ? {stage:error.task, reason:error.reason, httpStatus:error.httpStatus}
          : {stage:'turn', reason:'unexpected'};
        req.log.warn({gameId:id, version:command.version, ...diagnostic}, 'turn generation failed');
        const notice = error instanceof ProviderFailure ? providerFailureNotice(error) : '处理本回合时出现异常。';
        throw new ApiError(502, notice + '存档已保留，可以重试。');
      }
      const view = store.commit(world, command, next);
      req.log.info({ gameId: id, version: view.state.version }, 'turn committed');
      return view;
    };
    const result = play();
    inFlight.set(id, { kind:'turn', command, result });
    try { return await result; }
    finally { inFlight.delete(id); }
  });

  app.get<{ Params: { id: string } }>('/api/games/:id/snapshots', async req => store.snapshots(req.params.id));
  app.post<{ Params: { id: string } }>('/api/games/:id/snapshots', async req => {
    const { version } = snapshotInput.parse(req.body);
    return store.snapshot(req.params.id, version);
  });
  app.post<{ Params: { id: string; snapshotId: string } }>('/api/games/:id/snapshots/:snapshotId/load', async req => {
    emptyInput.parse(req.body);
    return store.restore(req.params.id, req.params.snapshotId);
  });

  if (options.staticRoot && existsSync(resolve(options.staticRoot, 'index.html'))) {
    app.register(staticFiles, { root: options.staticRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && req.headers.accept?.includes('text/html')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: '找不到这个资源。' });
    });
  }
  return app;
}
