import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { GameTurn, ProviderConfig, WorldState } from '@worldsim/shared';

export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  version: integer('version').notNull(),
  time: integer('time').notNull(),
  updatedAt: text('updated_at').notNull(),
  world: text('world', { mode: 'json' }).$type<WorldState>().notNull(),
});

export const turns = sqliteTable('turns', {
  gameId: text('game_id').notNull().references(() => games.id),
  version: integer('version').notNull(),
  requestId: text('request_id').notNull(),
  baseVersion: integer('base_version').notNull(),
  input: text('input').notNull(),
  turn: text('turn', { mode: 'json' }).$type<GameTurn>().notNull(),
}, t => [
  primaryKey({ columns: [t.gameId, t.version] }),
  unique().on(t.gameId, t.requestId),
]);

export const snapshots = sqliteTable('snapshots', {
  id: text('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id),
  version: integer('version').notNull(),
  time: integer('time').notNull(),
  createdAt: text('created_at').notNull(),
  world: text('world', { mode: 'json' }).$type<WorldState>().notNull(),
});

export const settings = sqliteTable('provider_settings', {
  id: integer('id').primaryKey(),
  config: text('config', { mode: 'json' }).$type<ProviderConfig>().notNull(),
});

// Migration 1. Only the server creates these tables. World text and model proposals
// enter the database as bound values through Drizzle.
export const migration1 = `
CREATE TABLE games (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL,
  time INTEGER NOT NULL, updated_at TEXT NOT NULL, world TEXT NOT NULL
);
CREATE TABLE turns (
  game_id TEXT NOT NULL REFERENCES games(id), version INTEGER NOT NULL,
  request_id TEXT NOT NULL, base_version INTEGER NOT NULL, input TEXT NOT NULL,
  turn TEXT NOT NULL, PRIMARY KEY (game_id, version), UNIQUE (game_id, request_id)
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY NOT NULL, game_id TEXT NOT NULL REFERENCES games(id),
  version INTEGER NOT NULL, time INTEGER NOT NULL, created_at TEXT NOT NULL,
  world TEXT NOT NULL
);
CREATE INDEX snapshots_game ON snapshots(game_id, created_at);
CREATE TABLE provider_settings (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL);
PRAGMA user_version = 1;
`;
