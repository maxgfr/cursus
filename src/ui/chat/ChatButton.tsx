import { MessageCircle } from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { lazyChunk, nothing } from '../../app/lazyChunk.tsx'
import { useT } from '../../i18n/react.tsx'
import { useAiReady } from '../ai/ready.ts'
import { IconButton } from '../components/IconButton.tsx'
import { useChat } from './context.tsx'

/** Mac and iPad keyboards show ⌘; everything else Ctrl. */
export function isApple(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/**
 * The small "Ask about this" icon of screen headers and the focus views; nothing outside the app shell, nor
 * without a model ready.
 */
export function ChatButton({ className }: { className?: string }) {
  const t = useT()
  const chat = useChat()
  const ready = useAiReady()
  if (!chat || !ready) return null
  return (
    <IconButton
      icon={MessageCircle}
      label={t('chat.open')}
      aria-pressed={chat.open}
      aria-keyshortcuts={isApple() ? 'Meta+J' : 'Control+J'}
      className={className}
      onClick={chat.toggle}
    />
  )
}

// Loaded the first time the chat opens: nothing of it weighs on the first paint.
const LazyChatPanel = lazyChunk<object>('chat', () => import('./ChatPanel.tsx'), nothing)

/**
 * Where the chat panel mounts, from its first opening on (it keeps its conversation when closed); never without a
 * model ready.
 */
export function ChatSlot() {
  const chat = useChat()
  const ready = useAiReady()
  const [used, setUsed] = useState(false)
  useEffect(() => {
    if (chat?.open) setUsed(true)
  }, [chat?.open])
  if (!ready || (!used && !chat?.open)) return null
  return (
    <Suspense fallback={null}>
      <LazyChatPanel />
    </Suspense>
  )
}
