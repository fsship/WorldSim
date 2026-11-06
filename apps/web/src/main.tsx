import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LlmCallsPage } from './LlmCallsPage'
import type { PagePath } from './PageLink'
import './style.css'

function currentPage(): PagePath {
  return window.location.pathname.replace(/\/$/, '') === '/llm-calls' ? '/llm-calls' : '/'
}

function WorldSim() {
  const [page, setPage] = useState(currentPage)
  // Keep the game (including unsent input or an in-flight turn) when visiting the log,
  // but don't start a game on a direct visit to the log.
  const [gameOpened, setGameOpened] = useState(() => currentPage() === '/')
  function show(next: PagePath) {
    if (next === '/') setGameOpened(true)
    setPage(next)
  }
  useEffect(() => {
    const onPop = () => show(currentPage())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    document.title = page === '/llm-calls' ? '模型调用记录 · WorldSim' : 'WorldSim · 王宫疑云'
  }, [page])
  function navigate(next: PagePath) {
    if (page !== next) window.history.pushState(null, '', next)
    show(next)
  }
  return <>
    {gameOpened && <div hidden={page !== '/'}><App navigate={navigate} active={page === '/'}/></div>}
    {page === '/llm-calls' && <LlmCallsPage navigate={navigate}/>}
  </>
}

createRoot(document.getElementById('root')!).render(<WorldSim/>)
