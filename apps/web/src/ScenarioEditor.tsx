import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ScenarioDefinition, ScenarioInput } from '@worldsim/shared'
import { defaultScenarioSetup } from '@worldsim/shared/scenario-setup'
import { Icon } from './Icon'
import { timeText } from './api'

type Location = ScenarioDefinition['locations'][number]
type Actor = ScenarioDefinition['npcs'][number]
type Event = NonNullable<ScenarioDefinition['events']>[number]

function emptyLocation(): Location {
  return { id: 'loc-' + crypto.randomUUID(), name: '', description: '' }
}
function emptyDefinition(): ScenarioDefinition {
  return { title: '', worldInfo: '', opening: '', ...defaultScenarioSetup(), npcs: [] }
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

function EventImpactFields({ event, locations, names, update }: {
  event: Event, locations: Location[], names: string[], update: (change: Partial<Event>) => void
}) {
  const situation = event.situation
  const namesId = useId()
  return <details className="scenario-details">
    <summary>事件影响</summary>
    <div className="editor-body">
      <label className="editor-check"><input type="checkbox" checked={event.public ?? false}
        onChange={e => update({ public: e.target.checked || undefined })}/>全局通告（各地都能收到）</label>
      {situation ? <>
        <label className="field">局势名称<input required maxLength={80} list={namesId} value={situation.id}
          onChange={e => update({ situation: { ...situation, id: e.target.value } })}/></label>
        <datalist id={namesId}>{names.map(name => <option key={name} value={name}/>)}</datalist>
        <p className="form-note">后续事件填写相同名称，就会更新这条局势。</p>
        <label className="field">局势摘要<textarea required rows={2} maxLength={600} value={situation.summary}
          onChange={e => update({ situation: { ...situation, summary: e.target.value } })}/></label>
        {locations.length > 1 && <details className="scenario-details">
          <summary>双向路段限制（{situation.blockedRoutes.length}）</summary>
          <div className="editor-body">
            <p className="form-note">设置本次事件生效后，这条局势对各路段的影响。</p>
            {locations.slice(1).map((to, i) => {
              const from = locations[i]
              const sameRoute = (route: typeof situation.blockedRoutes[number]) =>
                (route.from === from.id && route.to === to.id) || (route.from === to.id && route.to === from.id)
              const restrictions = situation.blockedRoutes.filter(sameRoute)
              const mode = restrictions.some(route => route.mode === 'all') ? 'all' : restrictions[0]?.mode ?? ''
              return <label key={from.id + ':' + to.id} className="field">
                {(from.name || '地点 ' + (i + 1)) + ' ↔ ' + (to.name || '地点 ' + (i + 2))}
                <select value={mode} onChange={e => {
                  const nextMode = e.target.value
                  const blockedRoutes = situation.blockedRoutes.filter(route => !sameRoute(route))
                  if (nextMode === 'vehicle' || nextMode === 'all') blockedRoutes.push({ from: from.id, to: to.id, mode: nextMode })
                  update({ situation: { ...situation, blockedRoutes } })
                }}>
                  <option value="">正常通行（解除限制）</option>
                  <option value="vehicle">仅禁止机动车通行</option>
                  <option value="all">禁止所有通行</option>
                </select>
              </label>
            })}
          </div>
        </details>}
        <button type="button" className="text-button" onClick={() => update({ situation: undefined })}>
          {situation.actions.length ? '移除局势及其行动分支' : '移除局势'}
        </button>
      </> : <button type="button" className="secondary small"
        onClick={() => update({ situation: { id: '', summary: '', blockedRoutes: [], actions: [] } })}>
        <Icon name="plus" size={14}/>添加持续局势
      </button>}
    </div>
  </details>
}

export function ScenarioEditor({ initial, busy, error, onSave, onCancel }: {
  initial?: ScenarioDefinition, busy: boolean, error: string, onSave: (value: ScenarioInput) => void, onCancel: () => void
}) {
  const [draft, setDraft] = useState<ScenarioDefinition>(() => initial ?? emptyDefinition())
  const [dynamic, setDynamic] = useState(() => !initial || initial.worldInfo !== undefined)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const [validation, setValidation] = useState('')
  const events = draft.events ?? []
  const situationNames = [...new Set(events.map(e => e.situation?.id.trim()).filter((name): name is string => !!name))]
  const updatePlace = (i: number, update: Partial<Location>) =>
    setDraft({ ...draft, locations: replaceAt(draft.locations, i, { ...draft.locations[i], ...update }) })
  function removePlace(id: string) {
    const usesRoute = (route: { from: string, to: string }) => route.from === id || route.to === id
    if (events.some(event => event.situation?.actions.some(action =>
      action.locationId === id || action.next.blockedRoutes.some(usesRoute)))) {
      setValidation('此地点仍被局势的行动分支使用。要保留这些分支，请保留此地点。')
      return
    }
    // Require a new choice for characters/events that pointed to the removed place.
    const unplace = <T extends { locationId: string }>(row: T): T => row.locationId === id ? { ...row, locationId: '' } : row
    setDraft({ ...draft, locations: draft.locations.filter(place => place.id !== id), player: unplace(draft.player),
      npcs: draft.npcs.map(unplace), events: events.map(event => {
        const row = unplace(event)
        if (!row.situation?.blockedRoutes.some(usesRoute)) return row
        return { ...row, situation: { ...row.situation, blockedRoutes: row.situation.blockedRoutes.filter(r => !usesRoute(r)) } }
      }) })
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
    setValidation('')
    onSave({ ...draft, worldInfo:dynamic ? draft.worldInfo : undefined,
      title:dynamic && !draft.title.trim() ? undefined : draft.title, startTime: hour * 60 + minute })
  }
  return <form className="scenario-editor panel-form" onSubmit={submit}>
    <h3 ref={heading} tabIndex={-1}>{initial ? '编辑剧本' : '创建自定义剧本'}</h3>
    <fieldset className="editor-body" disabled={busy}>
      <label className="field">人物出场方式<select value={dynamic ? 'encounter' : 'fixed'} onChange={e => setDynamic(e.target.value === 'encounter')}>
        <option value="encounter">相遇时由模型生成人物</option>
        <option value="fixed">仅使用预设角色</option>
      </select></label>
      {dynamic && <label className="field">世界信息<textarea required rows={3} maxLength={2000}
        placeholder="这个世界是什么样的？这里有哪些地方、势力或习惯？" value={draft.worldInfo ?? ''}
        onChange={e => setDraft({ ...draft, worldInfo:e.target.value })}/></label>}
      <label className="field">{dynamic ? '当下处境' : '开场叙述'}<textarea required rows={3} maxLength={1200} placeholder="故事从哪里开始？玩家此刻看到了什么？"
        value={draft.opening} onChange={e => setDraft({ ...draft, opening: e.target.value })}/></label>
      <details className="scenario-details" open={!dynamic}>
      <summary>{dynamic ? '更多设定（可选）' : '剧本设定'}</summary>
      <div className="editor-body">
      <label className="field">{dynamic ? '剧本名称（可选）' : '剧本名称'}<input required={!dynamic} maxLength={80}
        placeholder={dynamic ? '留空将采用世界信息的开头命名' : undefined} value={draft.title}
        onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>
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
      <section className="editor-section"><h4>{dynamic ? '预设角色（可选）' : '非玩家角色'}</h4>
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
            <label className="field">开场后多少分钟<input type="number" min={1} max={10080} step={1} required value={event.afterMinutes || ''}
              onChange={e => updateEvent(i, { afterMinutes: Number(e.target.value) })}/></label>
            <PlaceSelect locations={draft.locations} value={event.locationId} label="发生地点" onChange={locationId => updateEvent(i, { locationId })}/>
          </div>
          <label className="field">事件内容<textarea required rows={2} maxLength={600} value={event.text} onChange={e => updateEvent(i, { text: e.target.value })}/></label>
          <EventImpactFields event={event} locations={draft.locations} names={situationNames} update={change => updateEvent(i, change)}/>
          <button type="button" className="text-button" onClick={() => setDraft({ ...draft, events: events.filter((_, n) => n !== i) })}>移除事件</button>
        </fieldset>)}
        <button type="button" className="secondary small" disabled={events.length >= 24}
          onClick={() => setDraft({ ...draft, events: [...events, { afterMinutes: 15, locationId: draft.player.locationId, text: '' }] })}><Icon name="plus" size={14}/>添加事件</button>
      </section>
      </div>
      </details>
    </fieldset>
    {initial && <p className="form-note">保存后的修改会在下次用此剧本新建游戏时生效。</p>}
    {(validation || error) && <p className="error-text" role="alert">{validation || error}</p>}
    <div className="scenario-actions"><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="primary" disabled={busy}><Icon name="save" size={15}/>{busy ? '正在保存…' : '保存剧本'}</button>
    </div>
  </form>
}
