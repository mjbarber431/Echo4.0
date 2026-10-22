import { useEffect, useMemo, useRef, useState } from 'react'
import type { Client, Note } from '@shared/types'
import { coachItems, nextCoverage, type CoachItem, type CoverageState } from '@shared/coach'
import { api, errorMessage } from './util'

// Checks what the dictation covers so far. It runs shortly after the text stops
// changing, and at least every few seconds while it keeps changing (live text
// arrives continuously while the clinician talks). One request at a time: a
// change during a request is picked up by the next one.

const SETTLE_MS = 2500
const MAX_WAIT_MS = 10_000

export interface Coverage {
  items: CoachItem[]
  covered: Record<string, boolean>
  checking: boolean
  /** Why the last check failed, until one succeeds. */
  error: string | null
  /** Every item is covered. */
  ready: boolean
}

export function useCoverage(note: Note, client: Client, text: string, enabled: boolean): Coverage {
  const items = useMemo(() => coachItems(note, client, text), [note, client, text])
  const key = items.map((i) => i.id).join(',')
  const [state, setState] = useState<CoverageState>({ covered: {}, misses: {} })
  const covered = state.covered
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(text)
  latest.current = text
  const run = useRef<{ busy: boolean; again: boolean; since: number; timer?: number; checked: string }>({ busy: false, again: false, since: 0, checked: '' })

  useEffect(() => {
    const r = run.current
    if (!enabled || !text.trim()) {
      window.clearTimeout(r.timer)
      r.since = 0
      if (!text.trim()) setState({ covered: {}, misses: {} })
      return
    }
    const check = async () => {
      r.since = 0
      if (r.busy) {
        r.again = true
        return
      }
      const sent = latest.current
      const sig = `${key}|${sent}`
      if (sig === r.checked) return
      r.busy = true
      setChecking(true)
      try {
        const answers = await api().coverage(note.id, sent)
        r.checked = sig
        setState((prev) => nextCoverage(prev, answers))
        setError(null)
      } catch (err) {
        // Feedback is a convenience: say why it's stuck, and try again on the next change.
        setError(errorMessage(err))
      } finally {
        r.busy = false
        setChecking(false)
        if (r.again) {
          r.again = false
          void check()
        }
      }
    }
    const now = Date.now()
    if (!r.since) r.since = now
    window.clearTimeout(r.timer)
    r.timer = window.setTimeout(() => void check(), Math.min(SETTLE_MS, Math.max(0, r.since + MAX_WAIT_MS - now)))
  }, [enabled, text, key, note.id])

  useEffect(() => () => window.clearTimeout(run.current.timer), [])

  const ready = enabled && items.length > 0 && items.every((i) => covered[i.id])
  return { items, covered, checking, error, ready }
}
