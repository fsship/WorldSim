import { useEffect, useState, type FormEvent } from 'react'
import { llmTaskLabels, type LlmCallList, type LlmCallSummary, type LlmCallDetail } from '@worldsim/shared/llm-calls'
import { api, errorText } from './api'
import { CompassMark, Icon } from './Icon'
import { Modal } from './Modal'
import { PageLink, type Navigate } from './PageLink'
import './llm-calls.css'

const pageSize = 20
type FilterStatus = '' | LlmCallSummary['status']
const stamp = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

function CallStatus({ status }: { status: LlmCallSummary['status'] }) {
  return <span className={'call-status ' + status}><i/>{status === 'success' ? '成功' : '失败'}</span>
}

function CallRow({ call, open }: { call: LlmCallSummary, open: () => void }) {
  const time = new Date(call.startedAt)
  return <li>
    <button className="call-row" onClick={open}>
      <span className="call-task"><strong>{llmTaskLabels[call.task] ?? call.task}</strong><small>{call.model}</small></span>
      <span className="call-row-status"><CallStatus status={call.status}/><small>第 {call.attempt} 次尝试</small></span>
      <time className="call-time" dateTime={call.startedAt}>{stamp.format(time)}</time>
      <span className="call-metrics">{call.durationMs.toLocaleString()} ms</span>
      <span className="call-metrics call-tokens">{call.totalTokens?.toLocaleString() ?? '—'}</span>
      <Icon name="chevron" size={15}/>
    </button>
  </li>
}

function prettyContent(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

// Expose the provider's original text separately. Nested JSON in message.content is easier
// to inspect with its own line breaks than as an escaped string in the outer envelope.
function CallBody({ call, side }: { call: LlmCallDetail, side: 'request' | 'response' }) {
  const raw = side === 'request' ? call.requestBody : call.responseBody
  if (raw === null) return <p className="call-note">未收到响应正文。</p>
  if (raw === '') return <p className="call-note">响应正文为空。</p>
  let messages: { role: string, content: string }[] = []
  try {
    const parsed = JSON.parse(raw)
    const entries = side === 'request' ? parsed?.messages : parsed?.choices?.map((choice: { message?: unknown }) => choice?.message)
    if (Array.isArray(entries)) messages = entries.filter(m => typeof m?.content === 'string' && typeof m?.role === 'string')
  } catch { /* Non-JSON and incomplete responses are still visible below. */ }
  return <>
    {side === 'response' && call.responseTruncated && <p className="call-note">响应正文已截断，仅显示已保存的部分。</p>}
    {messages.length === 0 ? <pre className="call-body">{raw}</pre> : <>
      {messages.map((message, index) => <section key={index} className="call-message">
        <h3>{message.role}</h3><pre className="call-body">{prettyContent(message.content)}</pre>
      </section>)}
      <details className="call-raw"><summary>{side === 'request' ? '原始请求正文' : '原始响应正文'}</summary>
        <pre className="call-body">{raw}</pre>
      </details>
    </>}
  </>
}

function CallDetails({ id, onClose, onRelated }: { id: number, onClose: () => void, onRelated: (id: string) => void }) {
  const [call, setCall] = useState<LlmCallDetail | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [side, setSide] = useState<'request' | 'response'>('request')
  useEffect(() => {
    let active = true
    setError('')
    void api.llmCall(id).then(value => {
      if (active) setCall(value)
    }, reason => { if (active) setError(errorText(reason)) })
    return () => { active = false }
  }, [id, refresh])
  return <Modal wide title={'调用详情 #' + id} icon="journal" onClose={onClose}>
    {error && <div role="alert" className="error-text">{error} <button className="text-button" onClick={() => setRefresh(refresh + 1)}>重试</button></div>}
    {!call && !error && <p role="status" className="call-note">正在读取调用详情…</p>}
    {call && <div className="call-detail">
      <div className="call-detail-title"><h3>{llmTaskLabels[call.task] ?? call.task}</h3><CallStatus status={call.status}/></div>
      <dl className="call-fields">
        <div><dt>开始时间</dt><dd>{stamp.format(new Date(call.startedAt))}</dd></div>
        <div><dt>模型</dt><dd>{call.model}</dd></div>
        <div><dt>任务</dt><dd>{call.task}</dd></div>
        <div><dt>尝试次数</dt><dd>第 {call.attempt} 次</dd></div>
        <div><dt>耗时</dt><dd>{call.durationMs.toLocaleString()} ms</dd></div>
        <div><dt>HTTP 状态</dt><dd>{call.httpStatus ?? '—'}</dd></div>
        <div><dt>游戏 ID</dt><dd>{call.gameId ?? '—'}</dd></div>
        <div><dt>回合</dt><dd>{call.turnVersion ?? '—'}</dd></div>
        <div className="call-full"><dt>调用 ID</dt><dd><code>{call.callId}</code><button className="text-button" onClick={() => onRelated(call.callId)}>查看各次尝试</button></dd></div>
        <div className="call-full"><dt>Token 用量</dt><dd>输入 {call.promptTokens ?? '—'} · 输出 {call.completionTokens ?? '—'} · 合计 {call.totalTokens ?? '—'}</dd></div>
        {call.errorReason && <div className="call-full"><dt>失败原因</dt><dd className="error-text">{call.errorReason}</dd></div>}
      </dl>
      <div className="segmented call-tabs" aria-label="查看调用内容">
        <button aria-pressed={side === 'request'} onClick={() => setSide('request')}>请求正文</button>
        <button aria-pressed={side === 'response'} onClick={() => setSide('response')}>响应正文</button>
      </div>
      <CallBody key={side} call={call} side={side}/>
    </div>}
  </Modal>
}

export function LlmCallsPage({ navigate }: { navigate: Navigate }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<FilterStatus>('')
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<LlmCallList | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => {
    let active = true
    setResult(null)
    setError('')
    void api.llmCalls(query, status, page * pageSize, pageSize).then(value => {
      if (!active) return
      setResult(value)
    }, reason => { if (active) setError(errorText(reason)) })
    return () => { active = false }
  }, [query, status, page, refresh])

  function search(event: FormEvent) {
    event.preventDefault()
    setPage(0)
    setQuery(draft.trim())
    setRefresh(value => value + 1)
  }
  function searchRelated(callId: string) {
    setSelected(null)
    setDraft(callId)
    setQuery(callId)
    setStatus('')
    setPage(0)
  }
  const pages = result ? Math.ceil(result.total / pageSize) : 0
  return <main className="call-page">
    <header className="call-header"><div className="call-header-inner">
      <span className="call-brand"><CompassMark/>WorldSim</span>
      <PageLink className="call-back" href="/" navigate={navigate}><Icon name="arrow" size={15}/>返回世界剧场</PageLink>
    </div></header>
    <div className="call-workspace">
      <div className="call-heading"><h1>模型调用记录</h1><button className="secondary" onClick={() => { setPage(0); setRefresh(value => value + 1) }}>
        <Icon name="history" size={15}/>刷新
      </button></div>
      <form className="call-filters" role="search" aria-label="搜索调用记录" onSubmit={search}>
        <label className="history-search call-search"><Icon name="search" size={16}/><input type="search" maxLength={200} aria-label="搜索调用记录" value={draft}
          onChange={e => setDraft(e.target.value)} placeholder="搜索请求、响应、模型或 ID"/></label>
        <select aria-label="调用状态" value={status} onChange={e => { setStatus(e.target.value as FilterStatus); setQuery(draft.trim()); setPage(0) }}>
          <option value="">全部状态</option><option value="success">成功</option><option value="error">失败</option>
        </select>
        <button type="submit" className="primary">搜索</button>
      </form>
      <section className="call-list" aria-label="调用列表" aria-busy={!result && !error}>
        <div className="call-list-heading call-grid"><span>任务 / 模型</span><span>状态</span><span>开始时间</span><span>耗时</span><span>Token</span><span/></div>
        {error ? <div className="call-empty" role="alert"><p className="error-text">{error}</p><button className="secondary small" onClick={() => setRefresh(value => value + 1)}>重试</button></div> :
          !result ? <p className="call-empty" role="status">正在读取调用记录…</p> :
          !result.items.length ? <div className="call-empty" role="status"><Icon name="journal" size={25}/>
            <strong>{query || status ? '没有匹配的调用记录' : '暂无模型调用记录'}</strong>
            <p>{query || status ? '试试其他关键词，或清除筛选条件。' : '使用真实模型进行游戏后，每次请求会显示在这里。'}</p>
            {(query || status) && <button className="secondary small" onClick={() => { setDraft(''); setQuery(''); setStatus(''); setPage(0) }}>清除筛选</button>}
          </div> : <ul>{result.items.map(call => <CallRow key={call.id} call={call} open={() => setSelected(call.id)}/>)}</ul>}
      </section>
      {result && <footer className="call-pagination"><span aria-live="polite">共 {result.total.toLocaleString()} 条记录</span>
        {pages > 1 && <div><button className="secondary small" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
          <span>{page + 1} / {pages}</span><button className="secondary small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>}
      </footer>}
    </div>
    {selected !== null && <CallDetails key={selected} id={selected} onClose={() => setSelected(null)} onRelated={searchRelated}/>}
  </main>
}
