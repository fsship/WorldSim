import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { and, asc, count, desc, eq, getColumns, inArray, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { displayReplyRecovery, projectTurn, projectWorld, replyRecovery } from '@worldsim/engine';
import { loadScenarioWorld, type ScenarioDefinition } from '@worldsim/scenarios';
import {
  GameTurnSchema, GameViewSchema, llmTaskLabels, PublicTurnSchema, PublicStateSchema, WorldStateSchema,
  type GameSummary, type GameTurn, type GameView, type LlmCallDetail, type LlmCallEntry,
  type LlmCallList, type ProviderConfig, type SnapshotSummary, type WorldState,
} from '@worldsim/shared';
import { ApiError, versionConflict } from './errors';
import { customScenarios, games, llmCalls, migration1, migration2, migration3, settings, snapshots, turns } from './schema';

const { requestBody, responseBody, responseTruncated, ...callSummaryColumns } = getColumns(llmCalls);
const callSearchColumns = [
  llmCalls.callId, llmCalls.gameId, llmCalls.task, llmCalls.model, llmCalls.errorReason,
  llmCalls.status, requestBody, responseBody,
];

export interface Command {
  requestId: string;
  version: number;
  input: string;
}

function checkSameCommand(saved: { baseVersion: number; input: string }, cmd: Command) {
  if (saved.baseVersion !== cmd.version || saved.input !== cmd.input) {
    throw new ApiError(409, '此请求编号已经用于另一项行动。');
  }
}

export class GameStore {
  private readonly connection: DatabaseSync;
  private readonly db;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(filename);
    try {
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      this.connection.exec('BEGIN IMMEDIATE');
      const version = this.connection.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error('当前服务无法读取此版本的存档数据库。');
      if (version === 0) this.connection.exec(migration1);
      if (version < 2) this.connection.exec(migration2);
      if (version < 3) this.connection.exec(migration3);
      this.connection.exec('COMMIT');
      this.db = drizzle({ client: this.connection });
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close() {
    this.connection.close();
  }

  config(): ProviderConfig | undefined {
    return this.db.select().from(settings).where(eq(settings.id, 1)).get()?.config;
  }

  setConfig(config: ProviderConfig) {
    this.db.insert(settings).values({ id: 1, config }).onConflictDoUpdate({
      target: settings.id, set: { config },
    }).run();
  }

  listCustomScenarios() {
    const title = sql<string>`json_extract(${customScenarios.definition}, '$.title')`;
    return this.db.select({
      id: customScenarios.id, title,
      description: sql<string>`json_extract(${customScenarios.definition}, '$.opening')`,
    }).from(customScenarios).orderBy(asc(title), asc(customScenarios.id)).all();
  }

  customScenario(id: string): ScenarioDefinition {
    const row = this.db.select().from(customScenarios).where(eq(customScenarios.id, id)).get();
    if (!row) throw new ApiError(404, '找不到这个剧本。');
    return row.definition;
  }

  saveCustomScenario(definition: ScenarioDefinition, existingId?: string) {
    const id = existingId ?? 'custom-' + randomUUID();
    if (existingId === undefined) {
      this.db.insert(customScenarios).values({ id, definition }).run();
    } else {
      const change = this.db.update(customScenarios).set({ definition }).where(eq(customScenarios.id, id)).run();
      if (!change.changes) throw new ApiError(404, '找不到这个剧本。');
    }
    return { id, title: definition.title, description: definition.opening, builtin: false };
  }

  recordLlmCall(entry: LlmCallEntry): void {
    this.db.insert(llmCalls).values(entry).run();
  }

  listLlmCalls(options: {
    q?: string; status?: LlmCallEntry['status']; offset: number; limit: number;
  }): LlmCallList {
    // Escape the wildcard and escape characters so a search matches the literal text.
    const query = options.q?.trim();
    const pattern = query ? '%' + query.replace(/[%_/]/g, '/$&') + '%' : undefined;
    const matchingTasks = query ? Object.keys(llmTaskLabels).filter(task => llmTaskLabels[task].includes(query)) : [];
    const filter = and(
      options.status ? eq(llmCalls.status, options.status) : undefined,
      pattern ? or(
        ...callSearchColumns.map(column => sql`${column} LIKE ${pattern} ESCAPE '/'`),
        matchingTasks.length ? inArray(llmCalls.task, matchingTasks) : undefined,
      ) : undefined,
    );
    return this.db.transaction(tx => {
      const total = tx.select({ n: count() }).from(llmCalls).where(filter).get()!.n;
      const items = tx.select(callSummaryColumns).from(llmCalls).where(filter)
        .orderBy(desc(llmCalls.id)).limit(options.limit).offset(options.offset).all();
      return { items, total };
    });
  }

  llmCall(id: number): LlmCallDetail {
    const call = this.db.select().from(llmCalls).where(eq(llmCalls.id, id)).get();
    if (!call) throw new ApiError(404, '找不到这条模型调用记录。');
    return call;
  }

  list(): GameSummary[] {
    return this.db.select({
      id: games.id, title: games.title, time: games.time,
      version: games.version, updatedAt: games.updatedAt,
    }).from(games).orderBy(desc(games.updatedAt), desc(games.id)).all();
  }

  create(initial: WorldState): GameView {
    const world = loadScenarioWorld(initial);
    this.db.insert(games).values({
      id: world.id, title: world.scenario, time: world.time, version: world.version,
      updatedAt: new Date().toISOString(), world,
    }).run();
    return this.view(world.id);
  }

  world(id: string): WorldState {
    const row = this.db.select().from(games).where(eq(games.id, id)).get();
    if (!row) throw new ApiError(404, '找不到这个游戏存档。');
    return loadScenarioWorld(row.world);
  }

  view(id: string): GameView {
    // One read transaction keeps state and visible history on the same revision,
    // even when another process commits an action between the two SELECTs.
    return this.db.transaction(() => {
      const world = this.world(id);
      const history = this.db.select({ turn: turns.turn }).from(turns)
        .where(eq(turns.gameId, id)).orderBy(asc(turns.version)).all()
        .map(row => {
          const turn = GameTurnSchema.parse(row.turn);
          return displayReplyRecovery(world, turn, projectTurn(turn));
        });
      return GameViewSchema.parse({state:projectWorld(world),turns:history});
    });
  }

  savedTurn(id: string, version: number): GameTurn {
    const row = this.db.select({turn:turns.turn}).from(turns)
      .where(and(eq(turns.gameId,id),eq(turns.version,version))).get();
    if (!row) throw new ApiError(409,'没有可补答的回合。');
    return GameTurnSchema.parse(row.turn);
  }

  saveDialogue(base: WorldState, turn: GameTurn, next: WorldState): GameView {
    this.db.transaction(() => {
      const current = this.world(base.id);
      if (replyRecovery(current,turn)?.replacement) return;
      if (!isDeepStrictEqual(current,base)) throw versionConflict();
      const candidate = WorldStateSchema.parse(next);
      if (candidate.id !== base.id || candidate.version !== base.version || candidate.time !== base.time ||
          candidate.history.length !== base.history.length + 1 || !replyRecovery(candidate,turn)?.replacement)
        throw new Error('补答未能对应原回合。');
      this.db.update(games).set({world:candidate,updatedAt:new Date().toISOString()})
        .where(and(eq(games.id,base.id),eq(games.version,base.version))).run();
    },{behavior:'immediate'});
    return this.view(base.id);
  }

  replayed(id: string, cmd: Command): boolean {
    const saved = this.db.select({ input: turns.input, baseVersion: turns.baseVersion })
      .from(turns).where(and(eq(turns.gameId, id), eq(turns.requestId, cmd.requestId))).get();
    if (saved) checkSameCommand(saved, cmd);
    return Boolean(saved);
  }

  commit(base: WorldState, cmd: Command, next: {world: WorldState; turn: GameTurn}): GameView {
    const id = base.id;
    const world = WorldStateSchema.parse(next.world);
    const turn = GameTurnSchema.parse(next.turn);
    if (world.id !== id || world.version !== cmd.version + 1 || turn.input !== cmd.input ||
        turn.version !== world.version || turn.endTime !== world.time) {
      throw new Error('回合结果与提交的行动不一致。');
    }
    this.db.transaction(() => {
      if (this.replayed(id, cmd)) return;
      const previous = this.world(id);
      // Dialogue and opening recovery can commit at the same turn version.
      if (previous.version !== cmd.version || !isDeepStrictEqual(previous, base)) throw versionConflict();
      if (turn.startTime !== previous.time || world.time < previous.time ||
          !isDeepStrictEqual(world.history, [...previous.history, ...turn.events]) ||
          !isDeepStrictEqual(turn.changes, turn.events.flatMap(event => event.changes))) {
        throw new Error('世界历史与回合日志不一致。');
      }
      PublicStateSchema.parse(projectWorld(world));
      PublicTurnSchema.parse(projectTurn(turn));
      const changed = this.db.update(games).set({
        world, version: world.version, time: world.time, updatedAt: new Date().toISOString(),
      }).where(and(eq(games.id, id), eq(games.version, cmd.version))).returning({ id: games.id }).get();
      if (!changed) throw versionConflict();
      this.db.insert(turns).values({
        gameId: id, version: world.version, requestId: cmd.requestId,
        baseVersion: cmd.version, input: cmd.input, turn,
      }).run();
    }, { behavior: 'immediate' });
    return this.view(id);
  }

  replaceOpening(base: WorldState, candidate: WorldState): GameView {
    const world = WorldStateSchema.parse(candidate);
    if (base.version !== 0 || world.version !== 0 || world.id !== base.id || world.time !== base.time) {
      throw new Error('开场重试必须保留原存档、时间和回合。');
    }
    this.db.transaction(() => {
      const previous = this.world(base.id);
      if (previous.version !== 0 || this.db.select({version:turns.version}).from(turns).where(eq(turns.gameId, base.id)).get()) {
        throw versionConflict();
      }
      const visible = projectWorld(previous);
      if (!visible.openingUsedFallback) return; // Another request already recovered this opening.
      if (!visible.openingRetryable || !isDeepStrictEqual(previous, base)) throw versionConflict();
      PublicStateSchema.parse(projectWorld(world));
      this.db.update(games).set({world, updatedAt:new Date().toISOString()})
        .where(and(eq(games.id, base.id), eq(games.version, 0))).run();
    }, {behavior:'immediate'});
    return this.view(base.id);
  }

  snapshots(id: string): SnapshotSummary[] {
    this.world(id);
    return this.db.select({
      id: snapshots.id, version: snapshots.version, time: snapshots.time,
      createdAt: snapshots.createdAt,
    }).from(snapshots).where(eq(snapshots.gameId, id)).orderBy(desc(snapshots.createdAt)).all();
  }

  snapshot(id: string, version: number): SnapshotSummary {
    return this.db.transaction(() => {
      const world = this.world(id);
      if (version !== world.version) throw versionConflict();
      const summary = { id: randomUUID(), version, time: world.time, createdAt: new Date().toISOString() };
      this.db.insert(snapshots).values({ ...summary, gameId: id, world }).run();
      return summary;
    }, { behavior: 'immediate' });
  }

  restore(gameId: string, snapshotId: string): GameView {
    const id = randomUUID();
    this.db.transaction(() => {
      const snapshot = this.db.select().from(snapshots)
        .where(and(eq(snapshots.id, snapshotId), eq(snapshots.gameId, gameId))).get();
      if (!snapshot) throw new ApiError(404, '找不到这个存档快照。');
      const world = loadScenarioWorld({ ...snapshot.world, id });
      this.db.insert(games).values({
        id, title: world.scenario + ' · 快照分支', version: world.version, time: world.time,
        updatedAt: new Date().toISOString(), world,
      }).run();
      const history = this.db.select().from(turns)
        .where(and(eq(turns.gameId, gameId), lte(turns.version, world.version))).all();
      for (const row of history) this.db.insert(turns).values({ ...row, gameId: id }).run();
    }, { behavior: 'immediate' });
    return this.view(id);
  }
}
