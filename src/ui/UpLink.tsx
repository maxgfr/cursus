import type { ReactNode } from 'react'
import { leaveTo, useNavLocation } from '../app/nav.ts'

/**
 * A link that leaves this screen for a screen above it (e.g. « Open course » once cards are saved): back through the
 * history when that screen opened this one, else in this screen's place, so Back never returns here in a loop.
 */
export function UpLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={useNavLocation.hrefs(href)}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        leaveTo(href)
      }}
    >
      {children}
    </a>
  )
}
