/**
 * In-memory session manager for coordinating SSE ↔ respond endpoints.
 *
 * When an agent tool needs user input:
 *   1. Tool handler sends SSE event to client
 *   2. Stores a Promise resolver here
 *   3. Awaits the Promise (agent loop blocks)
 *
 * When the client responds (POST /api/chat/respond):
 *   1. Looks up the resolver by sessionId
 *   2. Resolves the Promise with the client's data
 *   3. Agent loop unblocks and continues
 */

const pending = new Map<string, (data: unknown) => void>()

export function setPending(sessionId: string, resolve: (data: unknown) => void) {
  pending.set(sessionId, resolve)
}

export function respond(sessionId: string, data: unknown): boolean {
  const resolver = pending.get(sessionId)
  if (!resolver) return false
  pending.delete(sessionId)
  resolver(data)
  return true
}

export function hasPending(sessionId: string): boolean {
  return pending.has(sessionId)
}

export function removePending(sessionId: string) {
  pending.delete(sessionId)
}
