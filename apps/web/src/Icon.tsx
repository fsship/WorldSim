import type { CSSProperties } from 'react'

const paths = {
  compass: <><circle cx="12" cy="12" r="9"/><path d="m16 8-2.4 5.6L8 16l2.4-5.6Z"/></>,
  book: <><path d="M12 6c-3-2-6-2-9-1v14c3-1.5 6-1.5 9 .5 3-2 6-2 9-.5V5c-3-1-6-1-9 1Z"/><path d="M12 6v13"/></>,
  journal: <><path d="M5 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V6a2 2 0 0 1 1-2Z"/><path d="M5 17h14M8 4v12m3-8h5m-5 3h4"/></>,
  history: <><path d="M3 11a9 9 0 1 1 2.2 7.2M3 5v6h6"/><path d="M12 7v5l3 2"/></>,
  hourglass: <><path d="M6 3h12M6 21h12M7 3c0 4 1 6 5 9-4 3-5 5-5 9m10-18c0 4-1 6-5 9 4 3 5 5 5 9M9 18h6"/></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8m-9 4h4"/></>,
  sliders: <><path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>, down: <path d="m6 9 6 6 6-6"/>,
  plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  save: <><path d="M4 4h13l3 3v13H4Z"/><path d="M7 4v6h9V4m-8 16v-6h8v6"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  cloud: <><path d="M7 17H6a4 4 0 0 1-1-7.8A6.5 6.5 0 0 1 17.5 8a4.5 4.5 0 0 1 1.8 8.8"/><path d="m8.5 15 2.5 2.5 4.5-5"/></>,
  pin: <><path d="M19 10c0 5.5-7 11-7 11S5 15.5 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.4"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  feather: <><path d="M3 21 15 9m-8 8c-1-3 0-7 6-12 3-2 6-2 8-2 0 6-2 12-8 14-2 1-4 1-6 0Z"/><path d="M11 12h4"/></>,
  user: <><circle cx="12" cy="8" r="3.1"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/></>,
  crown: <><path d="m3 7 4 4 5-7 5 7 4-4-2 10H5Z"/><path d="M6 20h12"/></>,
  heart: <path d="M12 20s-8.5-5.6-8.5-11a4.5 4.5 0 0 1 8.5-2 4.5 4.5 0 0 1 8.5 2c0 5.4-8.5 11-8.5 11Z"/>,
  bag: <><rect x="4" y="8" width="16" height="13" rx="2"/><path d="M8 8V6a4 4 0 0 1 8 0v2M4 12c5 3 11 3 16 0M11 14h2"/></>,
  scroll: <><path d="M6 4h12a2 2 0 0 1 2 2v2h-4V6a2 2 0 0 1 2-2M6 4a2 2 0 0 0-2 2v2h3m0-4v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2h-8v2a2 2 0 0 1-2 2"/></>,
  sparkle: <><path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z"/></>,
  send: <><path d="m21 3-6.8 18-3.5-7.7L3 9.8 21 3Z"/><path d="m10.7 13.3 5.7-5.7"/></>,
  dialog: <><path d="M20 12a7 7 0 0 1-7 7H9l-5 2 1.4-5A8 8 0 1 1 20 12Z"/><path d="M8 10h8m-8 4h5"/></>,
  menu: <path d="M3 6h18M3 12h18M3 18h18"/>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
  flame: <path d="M12 2c1 5-4 6-3 11-2-1-2-3-2-4-5 8 0 13 5 13 6 0 10-7 5-13 0 2-2 3-2 3 1-5-2-6-3-10Z"/>,
  people: <><circle cx="10" cy="8" r="3"/><path d="M3 20v-1a7 7 0 0 1 14 0v1m-1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5"/></>,
  search: <><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4m11.2-11.2L19 5"/></>,
  doors: <><path d="M4 21h16M6 21V4h11v17m-5-9h2"/></>,
  gear: <><path d="m10 3-.8 2.5-2 .9-2.4-.5-2 3.4 1.7 1.9v2L2.8 15l2 3.4 2.4-.5 2 .9.8 2.2h4l.8-2.2 2-.9 2.4.5 2-3.4-1.7-1.8v-2l1.7-1.9-2-3.4-2.4.5-2-.9L14 3Z"/><circle cx="12" cy="12" r="3"/></>
}
export type IconName = keyof typeof paths
export function Icon({ name, size = 18, style, className }: { name: IconName, size?: number, style?: CSSProperties, className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style} className={className}>{paths[name]}</svg>
}

export function CompassMark() {
  return <svg className="brand-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="16" stroke="currentColor" strokeWidth="1"/>
    <circle cx="24" cy="24" r="12.7" stroke="currentColor" strokeWidth=".5"/>
    <path d="m10 10 12 9 12-9-9 12 9 12-12-9-12 9 9-12Z" stroke="currentColor" strokeWidth=".6" transform="translate(2 2)"/>
    <path d="m24 2 4.1 17.9L46 24l-17.9 4.1L24 46l-4.1-17.9L2 24l17.9-4.1Z" stroke="currentColor"/>
    <path d="M24 2v22l-4.1-4.1ZM46 24H24l4.1-4.1ZM24 46V24l4.1 4.1ZM2 24h22l-4.1 4.1Z" fill="currentColor"/>
  </svg>
}
