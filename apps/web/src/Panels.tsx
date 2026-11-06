import { useEffect, useState, type FormEvent } from 'react'
import type { GameSummary, GameView, PublicConfig, ProviderConfig, SnapshotSummary } from '@worldsim/shared'
import { api, dayText, errorText, fullTime, timeText } from './api'
import { Icon } from './Icon'
import { TurnEntry } from './Journal'

export function WaitPanel({ time, onWait, busy }: { time: number, onWait: (input: string) => void, busy: boolean }) {
  const [mode, setMode] = useState<'duration' | 'rest' | 'event'>('duration')
  const [minutes, setMinutes] = useState('30')
  const [clock, setClock] = useState(timeText(time + 60))
  const [event, setEvent] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const input = mode === 'duration' ? '等待 ' + minutes + ' 分钟' : mode === 'rest' ? '休息至 ' + clock : event.trim() ? '等待' + event.trim() + '发生' : '等待下一件重要事件'
    onWait(input)
  }
  return <form className="panel-form" onSubmit={submit}>
    <p className="time-banner"><Icon name="clock"/>当前时间 <strong>{fullTime(time)}</strong></p>
    <div className="segmented" aria-label="等待方式">{([['duration', '等待时长'], ['rest', '休息至'], ['event', '等待事件']] as const).map(([key, label]) =>
      <button type="button" key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}</div>
    {mode === 'duration' && <label className="field">等待时长（分钟）<input type="number" min="1" max="720" step="1" required value={minutes} onChange={e => setMinutes(e.target.value)}/></label>}
    {mode === 'rest' && <label className="field">休息至游戏时间<input type="time" required value={clock} onChange={e => setClock(e.target.value)}/></label>}
    {mode === 'event' && <label className="field">事件名称（可选）<input maxLength={160} placeholder="留空以等待下一件重要事件" value={event} onChange={e => setEvent(e.target.value)}/></label>}
    <p className="form-note">单次最多等待 12 游戏小时。遇到需要你决定的事件，等待会提前结束。</p>
    <button className="primary" disabled={busy}><Icon name="hourglass" size={16}/>开始等待</button>
  </form>
}

export function ConfigPanel({ initial, onSaved, setBusy }: { initial: PublicConfig | null, onSaved: (config: PublicConfig) => void, setBusy: (busy: boolean) => void }) {
  const [config, setConfig] = useState(initial)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (initial) { setConfig(initial); return }
    let active = true
    void api.settings().then(c => { if (active) setConfig(c) }, e => { if (active) setError(errorText(e)) })
    return () => { active = false }
  }, [initial, retry])
  if (!config) return <p>{error || '正在读取模型设置…'}{error && <button className="text-button" onClick={() => { setError(''); setRetry(retry + 1) }}>重试</button>}</p>
  const update = <K extends keyof ProviderConfig>(k: K, v: ProviderConfig[K]) => setConfig({ ...config, [k]: v })
  async function save(e: FormEvent) {
    e.preventDefault()
    if (submitting || !config) return
    setSubmitting(true); setBusy(true); setError('')
    const { hasApiKey: _hasApiKey, ...fields } = config
    try {
      const saved = await api.configure({ ...fields, ...(key.trim() ? { apiKey: key.trim() } : {}) })
      setKey(''); onSaved(saved)
    } catch (e) { setError(errorText(e)) }
    finally { setSubmitting(false); setBusy(false) }
  }
  return <form className="panel-form" onSubmit={save}>
    <label className="field">模拟引擎<select value={config.mode} onChange={e => update('mode', e.target.value as ProviderConfig['mode'])}><option value="mock">本地模拟（Mock）</option><option value="openai">OpenAI 兼容接口</option></select></label>
    {config.mode === 'mock' ? <p className="form-note">本地模拟无需 API Key，适合体验「王宫疑云」和重复测试。</p> : <>
      <label className="field">接口地址（Base URL）<input required type="url" value={config.baseUrl} onChange={e => update('baseUrl', e.target.value)}/></label>
      <label className="field">模型名称<input required value={config.model} onChange={e => update('model', e.target.value)}/></label>
      <label className="field">API Key<input autoComplete="new-password" type="password" placeholder={config.hasApiKey ? '已配置，留空保留原密钥' : '输入服务端密钥（可选）'} value={key} onChange={e => setKey(e.target.value)}/></label>
      <details className="advanced"><summary>高级参数</summary><div className="field-grid">
        <label className="field">Temperature<input type="number" required min="0" max="2" step=".1" value={config.temperature} onChange={e => update('temperature', Number(e.target.value))}/></label>
        <label className="field">最大输出 Token<input type="number" required min="32" max="8192" value={config.maxTokens} onChange={e => update('maxTokens', Number(e.target.value))}/></label>
        <label className="field">超时（毫秒）<input type="number" required min="1000" max="120000" value={config.timeoutMs} onChange={e => update('timeoutMs', Number(e.target.value))}/></label>
        <label className="field">重试次数<input type="number" required min="0" max="3" value={config.retries} onChange={e => update('retries', Number(e.target.value))}/></label>
      </div></details>
    </>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <button className="primary" disabled={submitting}><Icon name="check" size={16}/>{submitting ? '保存中…' : '保存设置'}</button>
  </form>
}

function dateText(text: string) {
  return new Date(text).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}
export function SavesPanel({ game, onLoad, setBusy }: { game: GameView, onLoad: (view: GameView) => void, setBusy: (busy: boolean) => void }) {
  const [tab, setTab] = useState<'snapshots' | 'games'>('snapshots')
  const [games, setGames] = useState<GameSummary[]>([])
  const [snaps, setSnaps] = useState<SnapshotSummary[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, busyHere] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [retry, retryList] = useState(0)
  useEffect(() => {
    let active = true
    setFetching(true); setError('')
    void Promise.all([api.games(), api.snapshots(game.state.id)]).then(([all, saved]) => {
      if (active) { setGames(all); setSnaps(saved) }
    }, e => { if (active) setError(errorText(e)) }).finally(() => { if (active) setFetching(false) })
    return () => { active = false }
  }, [game.state.id, retry])
  async function operate(action: () => Promise<void>) {
    if (busy) return
    busyHere(true); setBusy(true); setError(''); setMessage('')
    try { await action() } catch (e) { setError(errorText(e)) } finally { busyHere(false); setBusy(false) }
  }
  function create() {
    void operate(async () => {
      const snap = await api.snapshot(game.state.id, game.state.version)
      setSnaps(prior => [snap, ...prior.filter(x => x.id !== snap.id)]); setMessage('当前进度已保存为快照。')
    })
  }
  return <div className="panel-form">
    <div className="segmented"><button aria-pressed={tab === 'snapshots'} onClick={() => setTab('snapshots')}>当前游戏快照</button><button aria-pressed={tab === 'games'} onClick={() => setTab('games')}>所有游戏</button></div>
    {tab === 'snapshots' && <><div className="row-between"><p className="form-note">载入快照会创建独立的游戏分支。</p><button className="secondary small" onClick={create} disabled={busy || fetching}><Icon name="save" size={15}/>保存快照</button></div>
      {snaps.map(s => <div key={s.id} className="save-row"><div><strong>{fullTime(s.time)}</strong><small>回合 {s.version} · {dateText(s.createdAt)}</small></div><button className="secondary small" disabled={busy} onClick={() => void operate(async () => onLoad(await api.restore(game.state.id, s.id)))}>载入快照</button></div>)}
      {!fetching && !snaps.length && !error && <p className="empty-state"><Icon name="archive" size={25}/>还没有手动快照</p>}</>}
    {tab === 'games' && games.map(g => <div className="save-row" key={g.id}><div><strong>{g.title} · {fullTime(g.time)}</strong><small>回合 {g.version} · {dateText(g.updatedAt)}</small></div>
      {g.id === game.state.id ? <span className="current-label">正在游玩</span> : <button className="secondary small" disabled={busy} onClick={() => void operate(async () => onLoad(await api.game(g.id)))}>载入游戏</button>}</div>)}
    {fetching && <p className="form-note" role="status">正在读取存档…</p>}
    {message && <p className="success-text" role="status">{message}</p>}
    {error && <div className="error-text" role="alert">{error} <button className="text-button" disabled={busy || fetching} onClick={() => retryList(retry + 1)}>刷新列表</button></div>}
  </div>
}

export function HistoryPanel({ game }: { game: GameView }) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLocaleLowerCase()
  const turns = [...game.turns].reverse().filter(t => [t.input, t.narrative, ...t.observations.map(o => o.text)].join('\n').toLocaleLowerCase().includes(q))
  return <div className="panel-form">
    <label className="history-search"><Icon name="search" size={17}/><input aria-label="搜索历史" placeholder="搜索行动或世界反馈…" value={search} onChange={event => setSearch(event.target.value)}/></label>
    {turns.map(t => <section key={t.version} className="history-turn"><h3>回合 {t.version}<span>{dayText(t.startTime)} · {timeText(t.startTime)}</span></h3><TurnEntry turn={t}/></section>)}
    {!turns.length && <p className="empty-state"><Icon name="journal" size={25}/>{q ? '没有匹配的回合' : '你的第一步行动将记录在这里。'}</p>}
  </div>
}
