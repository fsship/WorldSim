import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ScenarioDefinition } from '@worldsim/shared'
import { Icon } from './Icon'
import { timeText } from './api'

type Location = ScenarioDefinition['locations'][number]
type Actor = ScenarioDefinition['npcs'][number]
type Event = NonNullable<ScenarioDefinition['events']>[number]

function emptyLocation(): Location {
  return { id: 'loc-' + crypto.randomUUID(), name: '', description: '' }
}
function emptyDefinition(): ScenarioDefinition {
  const location = emptyLocation()
  return { title: '', opening: '', locations: [location], player: { name: '', role: '', locationId: location.id }, npcs: [] }
}
function PlaceSelect({ locations, value, onChange, label = '起始地点' }: {
  locations: Location[], value: string, onChange: (id: string) => void, label?: string
}) {
  return <label className="field">{label}
    <select value={value} required onChange={e => onChange(e.target.value)}>
      <option value="" disabled>请选择地点</option>
      {locations.map((place, index) => <option key={place.id} value={place.id}>{place.name.trim() || '地点 ' + (index + 1)}</option>)}
    </select>
  </label>
}
function CharacterFields({ actor, locations, update, npc }: {
  actor: Actor, locations: Location[], update: (actor: Actor) => void, npc?: boolean
}) {
  return <>
    <div className="editor-grid">
      <label className="field">姓名<input required maxLength={60} value={actor.name} onChange={e => update({ ...actor, name: e.target.value })}/></label>
      <label className="field">身份<input required maxLength={60} value={actor.role} onChange={e => update({ ...actor, role: e.target.value })}/></label>
    </div>
    <PlaceSelect locations={locations} value={actor.locationId} onChange={locationId => update({ ...actor, locationId })}/>
    {npc && <label className="field">公开职责（可选）<input maxLength={200} value={actor.duty ?? ''} onChange={e => update({ ...actor, duty: e.target.value.trim() ? e.target.value : undefined })}/></label>}
    <label className="field">个人目标（可选）<input maxLength={200} value={actor.goal ?? ''} onChange={e => update({ ...actor, goal: e.target.value.trim() ? e.target.value : undefined })}/></label>
  </>
}
function replaceAt<T>(list: T[], index: number, value: T) {
  return list.map((item, i) => i === index ? value : item)
}

export function ScenarioEditor({ initial, busy, error, onSave, onCancel }: {
  initial?: ScenarioDefinition, busy: boolean, error: string, onSave: (value: ScenarioDefinition) => void, onCancel: () => void
}) {
  const [draft, setDraft] = useState<ScenarioDefinition>(() => initial ?? emptyDefinition())
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const [validation, setValidation] = useState('')
  const events = draft.events ?? []
  const updatePlace = (i: number, update: Partial<Location>) =>
    setDraft({ ...draft, locations: replaceAt(draft.locations, i, { ...draft.locations[i], ...update }) })
  function removePlace(id: string) {
    // Require a new choice for characters/events that pointed to the removed place.
    const unplace = <T extends { locationId: string }>(row: T): T => row.locationId === id ? { ...row, locationId: '' } : row
    setDraft({ ...draft, locations: draft.locations.filter(place => place.id !== id), player: unplace(draft.player),
      npcs: draft.npcs.map(unplace), events: events.map(unplace) })
  }
  function updateEvent(i: number, update: Partial<Event>) {
    setDraft({ ...draft, events: replaceAt(events, i, { ...events[i], ...update }) })
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const unique = (names: string[]) => new Set(names.map(n => n.trim())).size === names.length
    if (!unique(draft.locations.map(r => r.name))) { setValidation('请为每个地点填写不同的名称。'); return }
    if (!unique([draft.player, ...draft.npcs].map(person => person.name))) { setValidation('请为每个角色填写不同的姓名。'); return }
    const startClock = String(new FormData(e.currentTarget).get('startClock'))
    const [hour, minute] = startClock.split(':').map(Number)
    setValidation(''); onSave({ ...draft, startTime: hour * 60 + minute })
  }
  return <form className="scenario-editor panel-form" onSubmit={submit}>
    <h3 ref={heading} tabIndex={-1}>{initial ? '编辑剧本' : '创建自定义剧本'}</h3>
    <fieldset className="editor-body" disabled={busy}>
      <label className="field">剧本名称<input required maxLength={80} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>
      <label className="field">开场叙述<textarea required rows={3} maxLength={1200} placeholder="故事从哪里开始？玩家此刻看到了什么？"
        value={draft.opening} onChange={e => setDraft({ ...draft, opening: e.target.value })}/></label>
      <label className="field">开场时间<input type="time" name="startClock" step={60} required defaultValue={timeText(initial?.startTime ?? 480)}/></label>
      <section className="editor-section">
        <h4>地点</h4><p className="form-note">按路线顺序填写地点，玩家可在相邻两处之间往返。</p>
        {draft.locations.map((place, i) => <fieldset key={place.id} className="editor-block" aria-label={'地点 ' + (i + 1)}>
          <div className="editor-row"><label className="field">地点名称<input required maxLength={60} value={place.name}
            onChange={e => updatePlace(i, { name: e.target.value })}/></label>
            {draft.locations.length > 1 && <button type="button" className="text-button" onClick={() => removePlace(place.id)}>移除地点</button>}</div>
          <label className="field">地点描述<textarea required rows={2} maxLength={400} value={place.description}
            onChange={e => updatePlace(i, { description: e.target.value })}/></label>
        </fieldset>)}
        <button type="button" className="secondary small" disabled={draft.locations.length >= 12}
          onClick={() => setDraft({ ...draft, locations: [...draft.locations, emptyLocation()] })}><Icon name="plus" size={14}/>添加地点</button>
      </section>
      <section className="editor-section"><h4>玩家角色</h4>
        <CharacterFields actor={draft.player} locations={draft.locations} update={player => setDraft({ ...draft, player })}/>
      </section>
      <section className="editor-section"><h4>非玩家角色</h4>
        {draft.npcs.map((actor, i) => <fieldset className="editor-block" key={i} aria-label={'非玩家角色 ' + (i + 1)}>
          <CharacterFields actor={actor} npc locations={draft.locations} update={value => setDraft({ ...draft, npcs: replaceAt(draft.npcs, i, value) })}/>
          <button type="button" className="text-button" onClick={() => setDraft({ ...draft, npcs: draft.npcs.filter((_, n) => n !== i) })}>移除角色</button>
        </fieldset>)}
        <button className="secondary small" type="button" disabled={draft.npcs.length >= 16}
          onClick={() => setDraft({ ...draft, npcs: [...draft.npcs, { name: '', role: '', locationId: draft.player.locationId }] })}><Icon name="plus" size={14}/>添加角色</button>
      </section>
      <section className="editor-section"><h4>定时剧情事件</h4>
        {events.map((event, i) => <fieldset className="editor-block" key={i} aria-label={'定时剧情事件 ' + (i + 1)}>
          <div className="editor-grid">
            <label className="field">开场后多少分钟<input type="number" min={1} max={1440} step={1} required value={event.afterMinutes || ''}
              onChange={e => updateEvent(i, { afterMinutes: Number(e.target.value) })}/></label>
            <PlaceSelect locations={draft.locations} value={event.locationId} label="发生地点" onChange={locationId => updateEvent(i, { locationId })}/>
          </div>
          <label className="field">事件内容<textarea required rows={2} maxLength={600} value={event.text} onChange={e => updateEvent(i, { text: e.target.value })}/></label>
          <button type="button" className="text-button" onClick={() => setDraft({ ...draft, events: events.filter((_, n) => n !== i) })}>移除事件</button>
        </fieldset>)}
        <button type="button" className="secondary small" disabled={events.length >= 24}
          onClick={() => setDraft({ ...draft, events: [...events, { afterMinutes: 15, locationId: draft.player.locationId, text: '' }] })}><Icon name="plus" size={14}/>添加事件</button>
      </section>
    </fieldset>
    {initial && <p className="form-note">保存后的修改会在下次用此剧本新建游戏时生效。</p>}
    {(validation || error) && <p className="error-text" role="alert">{validation || error}</p>}
    <div className="scenario-actions"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="primary" disabled={busy}><Icon name="save" size={15}/>{busy ? '正在保存…' : '保存剧本'}</button>
    </div>
  </form>
}
