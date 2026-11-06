import type { ComponentProps } from 'react'

export type PagePath = '/' | '/llm-calls'
export type Navigate = (page: PagePath) => void

export function PageLink({ href, navigate, ...props }: Omit<ComponentProps<'a'>, 'href' | 'onClick'> & {
  href: PagePath, navigate: Navigate
}) {
  return <a {...props} href={href} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }}/>
}
