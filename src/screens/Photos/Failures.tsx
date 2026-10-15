import type { CaptureFailure } from './capture.ts'
import { useFailureText } from './text.ts'

/** Files that could not be added, each with what to do; the same failure twice is said once. */
export function Failures({ failed, className }: { failed: readonly CaptureFailure[]; className?: string }) {
  const text = useFailureText()
  const unique = [...new Map(failed.map((f) => [`${f.reason}:${f.name}`, f])).entries()]
  if (unique.length === 0) return null
  return (
    <ul className={className} role="alert">
      {unique.map(([key, f]) => (
        <li key={key}>{text(f)}</li>
      ))}
    </ul>
  )
}
