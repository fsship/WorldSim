import { useEffect, useRef, useState } from 'react'
import type { GameView, ScenarioDefinition, ScenarioInput, ScenarioSummary } from '@worldsim/shared'
import { api, errorText } from './api'
import { Icon } from './Icon'
import { ScenarioEditor } from './ScenarioEditor'
import './scenarios.css'

interface Props {
  busy: boolean
  setBusy: (value: boolean) => void
  onStart: (view: GameView) => void
}

function ScenarioGroup({ title, stories, selected, onSelect }: {
  title: string, stories: ScenarioSummary[], selected: string | undefined, onSelect: (id: string) => void
}) {
  if (!stories.length) return null
  return <fieldset className="scenario-group">
    <legend>{title}</legend>
    {stories.map(story => <label key={story.id} className={'story-option' + (selected === story.id ? ' chosen' : '')}>
      <input type="radio" name="scenario" value={story.id} checked={selected === story.id} onChange={() => onSelect(story.id)}/>
      <span><strong>{story.title}</strong><span className="story-description">{story.description}</span></span>
    </label>)}
  </fieldset>
}

export function ScenarioLibrary({ busy, setBusy, onStart }: Props) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null)
  const [selected, setSelected] = useState<string>()
  const [editor, setEditor] = useState<{ id?: string, definition?: ScenarioDefinition } | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [retry, setRetry] = useState(0)
  const running = useRef(false)
  useEffect(() => {
    let active = true
    setError('')
    void api.scenarios().then(rows => {
      if (active) { setScenarios(rows); setSelected(rows[0]?.id) }
    }, e => { if (active) setError(errorText(e)) })
    return () => { active = false }
  }, [retry])
  async function perform(operation: () => Promise<void>) {
    if (running.current || busy) return
    running.current = true; setBusy(true); setError(''); setMessage('')
    try { await operation() }
    catch (e) { setError(errorText(e)) }
    finally { running.current = false; setBusy(false) }
  }
  function edit() {
    if (!selected) return
    void perform(async () => {
      const definition = await api.scenario(selected)
      setEditor({ id: selected, definition })
    })
  }
  function save(definition: ScenarioInput) {
    void perform(async () => {
      const saved = await api.saveScenario(definition, editor?.id)
      setScenarios(prior => [...(prior ?? []).filter(s => s.id !== saved.id), saved])
      setSelected(saved.id); setEditor(null); setMessage('剧本已保存，可以开始新游戏。')
    })
  }
  if (editor) return <ScenarioEditor initial={editor.definition} busy={busy} error={error}
    onSave={save} onCancel={() => { setEditor(null); setError('') }}/>
  if (!scenarios) return <div className="panel-form">{error
    ? <><p className="error-text" role="alert">{error}</p><button className="secondary" onClick={() => setRetry(retry + 1)}>重新读取剧本</button></>
    : <p role="status">正在读取剧本…</p>}</div>
  const active = scenarios.find(s => s.id === selected)
  return <div className="panel-form scenario-library">
    <fieldset className="story-picker" disabled={busy}>
      <ScenarioGroup title="内置剧本" stories={scenarios.filter(s => s.builtin)} selected={selected} onSelect={setSelected}/>
      <ScenarioGroup title="我的剧本" stories={scenarios.filter(s => !s.builtin)} selected={selected} onSelect={setSelected}/>
    </fieldset>
    {message && <p className="success-text" role="status">{message}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="scenario-actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => { setEditor({}); setError(''); setMessage('') }}>
        <Icon name="plus" size={15}/>自定义剧本
      </button>
      {active && !active.builtin && <button type="button" className="secondary" disabled={busy} onClick={edit}>编辑剧本</button>}
      <button type="button" className="primary" disabled={busy || !active} onClick={() => {
        if (active) void perform(async () => onStart(await api.create(active.id)))
      }}>{busy ? '正在处理…' : '开始新游戏'}<Icon name="arrow" size={15}/></button>
    </div>
  </div>
}
