import { Fragment } from 'react'
import type { GameView, Observation, PublicTurn } from '@worldsim/shared'
import { Icon, type IconName } from './Icon'
import { timeText } from './api'

// React escapes every segment. The reading view implements only emphasis,
// strong emphasis and inline code; HTML, links and images are ordinary text.
function RichText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    return <Fragment key={i}>{part}</Fragment>
  })}</>
}

type EntryKind = Observation['kind'] | 'action'
const entryStyle: Record<EntryKind, { label: string, icon: IconName }> = {
  world: { label: '世界叙事', icon: 'feather' },
  dialogue: { label: '人物对话', icon: 'dialog' },
  system: { label: '系统提示', icon: 'compass' },
  action: { label: '你的行动', icon: 'crown' }
}
function Entry({ kind, text, speaker, time, hearing, children }: { kind: EntryKind, text: string, speaker?: string, time?: number, hearing?: PublicTurn['hearing'], children?: React.ReactNode }) {
  const { label, icon } = entryStyle[kind]
  const listeners = hearing ? [...hearing.listeners, ...(hearing.groups ?? []).map(g => g.name + "（" + g.count + "人）")] : []
  return <article className={'entry entry-' + kind}>
    <span className="entry-bullet"><Icon name={icon} size={15}/></span>
    <div className="entry-content">
      <div className="entry-label"><span>{speaker || label}</span>{time !== undefined && <time>{timeText(time)}</time>}
        {hearing && <small>{listeners.length ?
          (hearing.volume === 'private' ? '私语 · ' : '听见 · ') + listeners.join('、') : '无人听见'}</small>}
      </div>
      <div className="entry-text"><RichText text={text}/></div>
      {children}
    </div>
  </article>
}
function Opening({ opening, time }: { opening: string, time: number }) {
  return opening.split(/\n\s*\n/).filter(Boolean).map((text, i) => {
    const speech = text.match(/^([^\n：「]{1,32})[：:]\s*[「“](.+)[」”]$/su)
    if (speech) return <Entry key={i} kind="dialogue" speaker={speech[1]} text={'「' + speech[2] + '」'} time={time}/>
    return <Entry key={i} kind="world" text={text} time={time}/>
  })
}

export function TurnEntry({ turn, busy, onRetry }: { turn: PublicTurn, busy?: boolean, onRetry?: (version:number) => void }) {
  const lines = turn.narrative.split('\n')
  // The engine composes one narrative line for each observation in order.
  // Keeping that index preserves the speaker even if two NPCs say the same words.
  return <>
    <Entry kind="action" text={turn.input} time={turn.startTime} hearing={turn.hearing}/>
    {turn.observations.length ? turn.observations.map((observation, index) =>
      <Entry key={index} kind={observation.kind} speaker={observation.speaker}
        text={lines.length === turn.observations.length ? lines[index] : observation.text}
        time={observation.time ?? turn.endTime}>
        {turn.replyRetry?.observation === index && onRetry &&
          <button className="secondary small opening-retry" type="button" disabled={busy} onClick={() => onRetry(turn.version)}>
            重试{turn.replyRetry.speaker}的答复
          </button>}
      </Entry>) : <Entry kind="world" text={turn.narrative} time={turn.endTime}/>}
  </>
}

export function Journal({ game, busy, onRetryOpening, onRetryDialogue }: {
  game: GameView, busy: boolean, onRetryOpening: () => void, onRetryDialogue: (version:number) => void
}) {
  return <section aria-label="世界纪事" className="journal">
    <div className="journal-heading"><div className="flex items-center gap-2.5"><Icon name="journal" size={21}/><h2>世界纪事</h2></div><span className="journal-line"/><span className="turn-count">回合 {String(game.state.version).padStart(2, '0')}</span></div>
    <div className="journal-entries" role="log" aria-label="行动与世界反馈" aria-live="polite" aria-relevant="additions">
      <Opening opening={game.state.opening} time={game.turns[0]?.startTime ?? game.state.time}/>
      {game.state.openingUsedFallback && <Entry kind="system" text={game.state.openingNotice || '开场未完成，已保留当前存档。'}>
        {game.state.openingRetryable && game.state.version === 0 &&
          <button className="secondary small opening-retry" type="button" disabled={busy} onClick={onRetryOpening}>重试开场</button>}
      </Entry>}
      {game.turns.map(turn => <TurnEntry key={turn.version} turn={turn} busy={busy} onRetry={onRetryDialogue}/>)}
    </div>
  </section>
}
