import { Square, Volume2 } from 'lucide-react'
import { type JSX, useEffect, useState } from 'react'
import { useT } from '../i18n/react.tsx'
import { IconButton } from './components/IconButton.tsx'

function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** Picks the best installed voice for a BCP 47 tag: exact match, then same language. */
function pickVoice(lang: string | undefined): SpeechSynthesisVoice | undefined {
  if (lang === undefined) return undefined
  const voices = window.speechSynthesis.getVoices()
  const wanted = lang.toLowerCase()
  const base = wanted.split('-')[0]
  return (
    voices.find((v) => v.lang.toLowerCase() === wanted) ??
    voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base)
  )
}

/** Reads `text` aloud with a voice for `lang`. Renders nothing where speech synthesis is unavailable. */
export function SpeakButton(props: { text: string; lang?: string; label?: string }): JSX.Element | null {
  const t = useT()
  const [speaking, setSpeaking] = useState(false)
  const supported = speechSupported()

  useEffect(() => {
    if (!supported) return
    return () => {
      window.speechSynthesis.cancel()
    }
  }, [supported])

  if (!supported) return null

  const toggle = () => {
    const synth = window.speechSynthesis
    if (speaking) {
      synth.cancel()
      setSpeaking(false)
      return
    }
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(props.text)
    if (props.lang !== undefined) utterance.lang = props.lang
    const voice = pickVoice(props.lang)
    if (voice !== undefined) utterance.voice = voice
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    setSpeaking(true)
    synth.speak(utterance)
  }

  const label = speaking ? t('common.stopReading') : (props.label ?? t('common.readAloud'))
  return <IconButton label={label} icon={speaking ? Square : Volume2} aria-pressed={speaking} onClick={toggle} />
}
