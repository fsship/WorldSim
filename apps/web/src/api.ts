import type { GameView, GameSummary, SnapshotSummary, PublicConfig, ProviderConfig } from '@worldsim/shared'

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api' + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new ApiError('无法连接游戏服务，请检查服务是否已启动。', 0)
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new ApiError(detail?.error ?? '游戏服务暂时不可用，请重试。', response.status)
  }
  return response.json() as Promise<T>
}

const gamePath = (id: string) => '/games/' + encodeURIComponent(id)
export const api = {
  games: () => request<GameSummary[]>('/games'),
  create: () => request<GameView>('/games', 'POST', {}),
  game: (id: string) => request<GameView>(gamePath(id)),
  retryOpening: (id: string) => request<GameView>(gamePath(id) + '/opening/retry', 'POST', { version: 0 }),
  retryDialogue: (id: string, version: number) => request<GameView>(gamePath(id) + '/dialogue/retry','POST',{version}),
  turn: (id: string, version: number, input: string, requestId: string) => request<GameView>(gamePath(id) + '/turns', 'POST', { version, input, requestId }),
  snapshot: (id: string, version: number) => request<SnapshotSummary>(gamePath(id) + '/snapshots', 'POST', { version }),
  snapshots: (id: string) => request<SnapshotSummary[]>(gamePath(id) + '/snapshots'),
  restore: (id: string, snap: string) => request<GameView>(gamePath(id) + '/snapshots/' + encodeURIComponent(snap) + '/load', 'POST', {}),
  settings: () => request<PublicConfig>('/settings'),
  configure: (config: ProviderConfig) => request<PublicConfig>('/settings', 'PUT', config)
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。'
}
export function isConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409
}
export function timeText(minutes: number) {
  const t = Math.floor(minutes) % 1440
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0')
}
export function dayText(minutes: number) { return '第 ' + (1 + Math.floor(minutes / 1440)) + ' 天' }
export function fullTime(minutes: number) { return dayText(minutes) + ' · ' + timeText(minutes) }

const currentKey = 'worldsim.activeGame'
export function rememberGame(id: string) {
  try { localStorage.setItem(currentKey, id) } catch { /* Play continues with browser storage disabled. */ }
}
export async function loadCurrent(): Promise<GameView> {
  const games = await api.games()
  let id: string | null = null
  try { id = localStorage.getItem(currentKey) } catch { /* SQLite holds the authoritative list. */ }
  const last = games.find(g => g.id === id) ?? games[0]
  return last ? api.game(last.id) : api.create()
}
