import { useEffect, useRef, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function Modal({ title, icon, children, onClose, wide = false }: { title: string, icon: IconName, children: ReactNode, onClose: () => void, wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = ref.current
    node?.showModal()
    return () => node?.close()
  }, [])
  return <dialog ref={ref} aria-label={title} className={'modal' + (wide ? ' modal-wide' : '')} onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === ref.current) onClose() }}>
    <div className="modal-frame"><header className="modal-header"><h2><Icon name={icon} size={21}/>{title}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close"/></button></header>
      <div className="modal-body">{children}</div>
    </div>
  </dialog>
}
