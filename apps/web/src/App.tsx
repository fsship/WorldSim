import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { GameView, PublicConfig } from '@worldsim/shared'
import { api, dayText, errorText, isConflict, loadCurrent, rememberGame, timeText } from './api'
import { CompassMark, Icon, type IconName } from './Icon'
import { Journal } from './Journal'
import { Status } from './Status'
import { Modal } from './Modal'
import { ConfigPanel, HistoryPanel, SavesPanel, WaitPanel } from './Panels'

type Panel = 'history' | 'wait' | 'saves' | 'settings' | 'new' | 'status' | 'nav'
const panels: Record<Panel, [string, IconName]> = {
  history: ['历史记录', 'history'], wait: ['时间控制', 'hourglass'], saves: ['存档管理', 'archive'],
  settings: ['模型设置', 'sliders'], new: ['新建游戏', 'plus'], status: ['世界状态', 'panel'], nav: ['世界导航', 'compass']
}
function SideNav({ panel, config, open, disabled }: { panel: Panel | null, config: PublicConfig | null, open: (id: Panel | null) => void, disabled: boolean }) {
  function link(id: Panel | null, label: string, icon: IconName) {
    return <button type="button" key={label} className={'nav-link' + ((panel === id || (id === null && panel === 'nav')) ? ' selected' : '')} onClick={() => open(id)} disabled={disabled} aria-current={panel === id ? 'page' : undefined}>
      <Icon name={icon} size={18}/><span>{label}</span>
    </button>
  }
  return <nav className="side-nav" aria-label="主导航">
    <div className="brand"><CompassMark/><div className="brand-name">WorldSim<span>交互式世界模拟</span></div></div>
    <div className="side-rule"/><div className="nav-group">
      <div className="nav-caption">游戏空间</div>
      {link(null, '世界剧场', 'compass')}{link('history', '历史记录', 'history')}{link('wait', '时间控制', 'hourglass')}
    </div>
    <div className="nav-group"><div className="nav-caption">管理</div>{link('saves', '存档管理', 'archive')}{link('settings', '模型设置', 'sliders')}</div>
    <button className="engine-indicator" disabled={disabled} onClick={() => open('settings')}><span className="engine-mark"><Icon name="sparkle" size={17}/></span><span><b>模拟引擎</b><small><i/>{config ? config.mode === 'mock' ? '本地 Mock' : config.model : '连接中…'}</small></span><Icon name="chevron" size={13}/></button>
  </nav>
}
function Hero({ game }: { game: GameView | null }) {
  return <section className="hero" aria-label="当前剧本">
    <img className="hero-art" src="/palace.webp" alt="阳光斜照进王宫高耸的拱窗与议事厅" fetchPriority="high"/>
    <div className="hero-shade"/>
    <div className="hero-content"><div className="hero-kicker"><span/>当前剧本</div>
      <h1>{game?.state.title ?? '王宫疑云'}</h1>
      {game && <div className="hero-meta"><span><Icon name="pin" size={14}/>{game.state.location.name}</span><i/><span><Icon name="clock" size={14}/>{dayText(game.state.time)} · {timeText(game.state.time)}</span></div>}
    </div>
    <i className="hero-corner tl"/><i className="hero-corner br"/>
  </section>
}
export function App() {
  const [game, setGame] = useState<GameView | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [bootError, setBootError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [boot, setBoot] = useState(0)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const pending = useRef<{ game: string, version: number, input: string, requestId: string } | null>(null)
  const locked = useRef(false)
  const reading = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const accept = useCallback((view: GameView) => {
    setGame(view); rememberGame(view.state.id)
  }, [])
  const lock = (value: boolean) => { locked.current = value; setBusy(value) }
  useEffect(() => {
    let active = true
    setBootError('')
    void loadCurrent().then(view => { if (active) accept(view) }, e => { if (active) setBootError(errorText(e)) })
    void api.settings().then(value => { if (active) setConfig(value) }, () => undefined)
    return () => { active = false }
  }, [boot, accept])
  useEffect(() => {
    if (!game) return
    const el = reading.current
    if (el) el.scrollTop = game.turns.length ? el.scrollHeight : 0
  }, [game])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])
  const open = (id: Panel | null) => {
    if (locked.current) return
    setPanel(id); setError('')
    if (!id) requestAnimationFrame(() => inputRef.current?.focus())
  }
  function switchGame(view: GameView) {
    accept(view); setDraft(''); pending.current = null; setPanel(null); setError('')
  }
  async function newGame() {
    if (locked.current) return
    lock(true); setError('')
    try { switchGame(await api.create()); setNotice('新游戏已建立') }
    catch (e) { setError(errorText(e)) }
    finally { lock(false) }
  }
  async function retryOpening() {
    if (locked.current || !game || game.state.version !== 0 || !game.state.openingRetryable) return
    lock(true); setError('')
    try {
      const view = await api.retryOpening(game.state.id)
      accept(view)
      if (!view.state.openingUsedFallback) setNotice('开场已更新')
      else setNotice('本次重试仍使用了备用开场')
    } catch (e) {
      setError(errorText(e))
      if (isConflict(e)) {
        try { accept(await api.game(game.state.id)) } catch { /* Keep the visible save for retry. */ }
      }
    } finally { lock(false) }
  }
  async function retryDialogue(version: number) {
    if (!game || locked.current || game.state.version !== version) return
    lock(true); setError('')
    try { accept(await api.retryDialogue(game.state.id,version)) }
    catch (e) {
      setError(errorText(e))
      if (isConflict(e)) {
        try { accept(await api.game(game.state.id)) } catch { /* Keep the visible save for retry. */ }
      }
    } finally { lock(false) }
  }
  async function act(text: string, fromWait = false) {
    const input = text.trim()
    if (!input || !game || locked.current) return
    let action = pending.current
    if (!action || action.game !== game.state.id || action.version !== game.state.version || action.input !== input) {
      action = { game: game.state.id, version: game.state.version, input, requestId: crypto.randomUUID() }
    }
    pending.current = action; lock(true); setError('')
    if (fromWait) setPanel(null)
    try {
      accept(await api.turn(action.game, action.version, input, action.requestId))
      if (!fromWait) setDraft('')
      pending.current = null
    } catch (e) {
      setError(errorText(e))
      if (fromWait) setDraft(input)
      if (isConflict(e)) {
        try { accept(await api.game(game.state.id)); pending.current = null } catch { /* Preserve the request for a safe retry. */ }
      }
    } finally {
      lock(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }
  const send = (event: FormEvent) => { event.preventDefault(); void act(draft) }
  function keydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault(); void act(draft)
  }
  const disabled = busy || !game
  return <div className="app-shell">
    <aside className="desktop-nav"><SideNav panel={panel} open={open} config={config} disabled={disabled}/></aside>
    <main className="workbench">
      <header className="topbar">
        <div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => open('nav')} disabled={disabled}><Icon name="menu"/></button><Icon name="book" size={16}/><span>世界剧场</span><span className="crumb-separator">/</span><b>{game?.state.title ?? '王宫疑云'}</b></div>
        <div className="toolbar"><span className="autosave"><Icon name="cloud" size={16}/>{busy ? '正在处理' : game ? '已自动保存' : '正在连接'}</span><button className="secondary new-button" disabled={disabled} onClick={() => open('new')}><Icon name="plus" size={15}/><span>新建游戏</span></button>
          <button className="icon-button mobile-status" aria-label="查看世界状态" onClick={() => open('status')} disabled={disabled}><Icon name="panel"/></button>
        </div>
      </header>
      <div className="work-area">
        <div className="story-column">
          <div className="reading-scroll" ref={reading} tabIndex={0} role="region" aria-label="游戏叙事"><Hero game={game}/>
            {game ? <Journal game={game} busy={busy} onRetryOpening={() => void retryOpening()} onRetryDialogue={retryDialogue}/> : <div className="boot-message" role={bootError ? 'alert' : 'status'}>{bootError || '正在打开世界纪事…'}{bootError && <button className="secondary small" onClick={() => setBoot(boot + 1)}>重新连接</button>}</div>}
          </div>
          <div className="composer-wrap">
            {error && !panel && <p role="alert" className="action-error">{error}</p>}
            <form className="composer" onSubmit={send} aria-busy={busy}>
              <label htmlFor="action"><Icon name="feather" size={17}/>你的行动</label>
              <textarea ref={inputRef} id="action" rows={2} maxLength={2000} placeholder="此刻，你想做什么？" value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} onKeyDown={keydown}/>
              <div className="composer-tools">
                <button className="wait-shortcut" type="button" disabled={disabled} onClick={() => open('wait')}><Icon name="hourglass" size={14}/>等待</button>
                <span className="keyboard-hint">Enter 发送 · Shift + Enter 换行</span>
                <button className="primary send-btn" type="submit" aria-label="执行行动" disabled={disabled || !draft.trim()}>{busy ? '处理中…' : '执行行动'}<Icon name="send" size={15}/></button>
              </div>
            </form>
          </div>
        </div>
        {game && <div className="desktop-status"><Status state={game.state}/></div>}
      </div>
    </main>
    {notice && <div className="toast" role="status"><Icon name="check" size={16}/>{notice}</div>}
    {panel && <Modal key={panel} title={panels[panel][0]} icon={panels[panel][1]} wide={panel === 'history' || panel === 'saves'} onClose={() => { if (!locked.current) setPanel(null) }}>
      {panel === 'nav' && <SideNav panel={panel} open={open} config={config} disabled={disabled}/>}
      {panel === 'status' && game && <Status state={game.state}/>}
      {panel === 'history' && game && <HistoryPanel game={game}/>}
      {panel === 'wait' && game && <WaitPanel busy={busy} time={game.state.time} onWait={input => void act(input, true)}/>}
      {panel === 'saves' && game && <SavesPanel game={game} setBusy={lock} onLoad={view => { switchGame(view); setNotice('游戏进度已载入') }}/>}
      {panel === 'settings' && <ConfigPanel initial={config} setBusy={lock} onSaved={c => { setConfig(c); setPanel(null); setNotice('模型设置已保存') }}/>}
      {panel === 'new' && <div className="panel-form"><p>从议事厅的清晨重新开启「王宫疑云」。当前游戏已自动保存，可随时从存档管理中载入。</p><button className="primary" disabled={busy} onClick={() => void newGame()}><Icon name="plus" size={16}/>{busy ? '正在创建…' : '开始新游戏'}</button></div>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </Modal>}
  </div>
}
