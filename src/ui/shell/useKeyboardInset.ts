import { useEffect } from 'react'

/**
 * Publishes the on-screen keyboard height as `--kb-inset` on <html> (iOS shrinks only the visual
 * viewport), and `data-keyboard` while it is open so the tab bar can step aside.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      root.style.setProperty('--kb-inset', `${inset}px`)
      if (inset > 80) root.dataset.keyboard = 'open'
      else delete root.dataset.keyboard
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
}
