/**
 * JSONL parsing utility for StoredEvent log files.
 *
 * Deliberately isolated from types.ts so it can be imported by client-side
 * code without pulling in @google-cloud/firestore (which types.ts imports
 * for Firestore Timestamp validation on other schemas).
 */
import type { StoredEvent } from './types'

/** Parse a JSONL string into an array of StoredEvents. Skips blank lines. */
export function parseJsonlEvents(text: string): StoredEvent[] {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as StoredEvent)
}
