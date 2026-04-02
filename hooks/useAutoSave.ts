/**
 * useAutoSave — debounced Firestore persistence for blueprint edits.
 *
 * Subscribes to blueprint mutations via builder.subscribeMutation and saves
 * the current blueprint to Firestore after 2 seconds of quiet time. Only
 * active when: (a) user is authenticated, (b) a projectId exists, (c) the
 * builder has a blueprint, and (d) phase is Done.
 *
 * Tracks builder.mutationCount to avoid unnecessary Firestore writes —
 * subscribeMutation fires on selection changes too, but mutationCount only
 * increments on actual blueprint mutations. Since Firestore charges per
 * write regardless of data changes, this distinction matters.
 *
 * All builder state is read live inside the subscribeMutation callback
 * (not captured from the render scope) to avoid stale closures — the builder
 * is a stable singleton so direct property access is always current.
 *
 * Silent failure — auto-save is best-effort. A Firestore outage does not
 * interrupt the user's editing experience.
 */
'use client'
import { useEffect, useRef } from 'react'
import { BuilderPhase, type Builder } from '@/lib/services/builder'

/** Quiet period before flushing edits to Firestore (ms). */
const DEBOUNCE_MS = 2000

export function useAutoSave(
  builder: Builder,
  isAuthenticated: boolean,
) {
  /** The mutationCount at the time of the last successful save. When this
   *  matches the current builder.mutationCount, there's nothing new to persist. */
  const lastSavedMutationRef = useRef(builder.mutationCount)

  /* Track the current auth state in a ref so the subscription callback
   * always reads the latest value without needing to re-subscribe. */
  const authRef = useRef(isAuthenticated)
  authRef.current = isAuthenticated

  /* Reset the saved-mutation watermark when the project changes. */
  useEffect(() => {
    lastSavedMutationRef.current = builder.mutationCount
  }, [builder.projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Single long-lived subscription — reads all state live from the builder
   * singleton inside the callback to avoid stale closure issues. The effect
   * only re-runs if the builder instance itself changes (it won't — it's a
   * module-level singleton). */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const unsub = builder.subscribeMutation(() => {
      /* Gate on auth, phase, and project existence — all read live. */
      if (!authRef.current) return
      if (builder.phase !== BuilderPhase.Done) return
      if (!builder.projectId || !builder.blueprint) return

      /* Skip if no actual blueprint mutations since last save. */
      if (builder.mutationCount === lastSavedMutationRef.current) return

      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        const bp = builder.blueprint
        const pid = builder.projectId
        const count = builder.mutationCount
        if (!bp || !pid || count === lastSavedMutationRef.current) return

        try {
          const res = await fetch(`/api/projects/${pid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blueprint: bp }),
          })
          if (res.ok) {
            lastSavedMutationRef.current = count
          }
        } catch {
          /* Silent — auto-save is best-effort. */
        }
      }, DEBOUNCE_MS)
    })

    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [builder]) // eslint-disable-line react-hooks/exhaustive-deps
}
