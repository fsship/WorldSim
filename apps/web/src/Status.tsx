import type { PublicState } from '@worldsim/shared'
import { Icon, type IconName } from './Icon'
import { dayText, timeText } from './api'

function Heading({ name, label }: { name: IconName, label: string }) {
  return <h3 className="status-heading"><Icon name={name} size={15}/>{label}</h3>
}
export function Status({ state }: { state: PublicState }) {
  const conditionText: Record<string, string> = { healthy: '健康', dead: '死亡', detained: '受拘押' }
  return <aside className="status-panel" aria-label="世界状态">
    <div className="status-panel-title"><Icon name="panel" size={18}/><h2>世界状态</h2></div>
    <section className="clock-card">
      <div className="clock-engraving" aria-hidden="true"><Icon name="sun" size={56}/></div>
      <Heading name="clock" label="游戏时间"/>
      <div className="clock-reading"><strong>{timeText(state.time)}</strong><span>{dayText(state.time)}</span></div>
    </section>
    {state.worldInfo && <details className="status-section world-info"><summary>世界信息</summary><p>{state.worldInfo}</p></details>}
    <section className="status-section">
      <Heading name="user" label="玩家角色"/>
      <div className="identity"><div className="identity-icon"><Icon name={state.scenarioId === 'palace' ? 'crown' : 'user'} size={24}/></div>
        <div><p className="identity-name">{state.player.name}</p>{state.player.role !== state.player.name && <span className="identity-role">{state.player.role}</span>}</div>
        <span className="condition"><i/>{conditionText[state.player.condition] ?? state.player.condition}</span>
      </div>
      {state.player.goal && <p className="player-goal">目标 · {state.player.goal}</p>}
    </section>
    <section className="status-section">
      <Heading name="pin" label="当前位置"/>
      <p className="location-name">{state.location.name}</p>
      <p className="location-description">{state.location.description}</p>
      {state.exits.length > 0 && <p className="nearby"><b>通往</b>{state.exits.map(x => x.name).join('、')}</p>}
      {state.present.length > 0 && <p className="nearby"><b>在场</b>{state.present.map(x => x.name).join('、')}</p>}
    </section>
    <section className="status-section">
      <Heading name="bag" label="随身物品"/>
      <div className="item-list">{state.player.items.length ? state.player.items.map(item => <details key={item.id} className="item-detail">
        <summary><span className="item-stamp"><Icon name="bag" size={15}/></span><span>{item.name}</span><Icon name="down" size={13}/></summary>
        <p>{item.description}</p>
      </details>) : <p className="muted">暂无随身物品</p>}</div>
    </section>
    <section className="status-section facts">
      <Heading name="scroll" label="已知事实"/>
      {state.facts.length ? <ul>{state.facts.map(fact => <li key={fact.id}>{fact.text}</li>)}</ul> : <p className="muted">尚未记录重要事实</p>}
    </section>
  </aside>
}
