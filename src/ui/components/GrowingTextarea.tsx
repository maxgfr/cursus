import { type TextareaHTMLAttributes, useEffect, useLayoutEffect, useRef } from 'react'

/** Height that shows the whole text: its scroll height plus the borders (the box is `border-box`). */
function fit(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
}

/**
 * A text area as tall as its text, never shorter than its `rows`: a proposed question or answer reads in full
 * without scrolling inside a two-line box, on a phone too. It fits again when the text or its width changes.
 */
export function GrowingTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const { value } = props
  useLayoutEffect(() => {
    const el = ref.current
    // Once the box holds the new text.
    if (el && el.value === value) fit(el)
  }, [value])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fit(el)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return <textarea ref={ref} {...props} />
}
