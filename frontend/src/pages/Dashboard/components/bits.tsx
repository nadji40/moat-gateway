import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { L } from '../../../i18n'

/** The down and up chevrons of a dropdown trigger; CSS shows the right one. */
export function Chevrons() {
  return (
    <>
      <svg className="chev-down" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M1 4.5l5 5 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="chev-up" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M1 7.5l5-5 5 5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </>
  )
}

/** The tick beside the selected item in a dropdown menu. */
export function MenuCheck() {
  return (
    <span className="check">
      <svg viewBox="0 0 11.5 9" fill="none" aria-hidden="true">
        <path d="M11.5 0l-7.75 9.00513-3.75-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

/** Copies `text`, and says so for a moment. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* no clipboard here: the text is still there to select */ }
  }
  return (
    <button className="code-copy" type="button" aria-label={copied ? L('Copied', 'تم النسخ') : L('Copy code', 'انسخ الشيفرة')} onClick={copy}>
      {copied ? (
        <svg className="ico-check" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 10L12.2581 12.4436C12.6766 12.7574 13.2662 12.6957 13.6107 12.3021L20 5" strokeWidth="2" strokeLinecap="round" stroke="white" />
          <path d="M21 12a9 9 0 1 1-6.67-8.69" strokeWidth="2" strokeLinecap="round" stroke="white" />
        </svg>
      ) : (
        <img src="/console-assets/Copy.svg" width="24" height="24" alt="" />
      )}
    </button>
  )
}

/** Where the sliding thumb behind the selected tab goes: over the tab, at its
 *  width, measured rather than assumed, so tabs of different lengths, either
 *  direction and a font arriving late all come out right. The thumb is placed
 *  from the tablist's 4px padding, which offsetLeft already counts. */
export function useThumb(tablist: RefObject<HTMLElement | null>, active: number): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({})
  useLayoutEffect(() => {
    const list = tablist.current
    if (!list) return
    const measure = () => {
      const tab = list.querySelectorAll<HTMLElement>('[role=tab]')[active]
      if (tab) setStyle({ width: tab.offsetWidth, left: 0, transform: `translateX(${tab.offsetLeft}px)` })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    void document.fonts?.ready.then(measure)
    return () => observer.disconnect()
  }, [tablist, active])
  return style
}
