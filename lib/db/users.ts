/**
 * User document CRUD helpers.
 *
 * UserDoc lives at `users/{email}`. Two write paths:
 * - `createUser` — called once at sign-in (Better Auth after hook), sets `created_at`
 * - `touchUser` — called on every chat request (fire-and-forget), updates `last_active_at`
 *
 * The `role` field is intentionally never set by application code — changes
 * happen via direct Firestore console edits only.
 */
import { FieldValue } from '@google-cloud/firestore'
import type { UserDoc } from './types'
import { collections, docs } from './firestore'

// ── Write ─────────────────────────────────────────────────────────

/**
 * Create the user profile on first sign-in. Uses `merge: true` so
 * subsequent sign-ins update `name` and `image` (profile changes from
 * Google) without overwriting `role` or `created_at`.
 *
 * `created_at` is only set here, not in `touchUser`, because `merge: true`
 * overwrites all fields in the payload — if `created_at` were included in
 * every call, the "joined" date would silently advance.
 */
export async function createUser(email: string, name: string, image: string | null): Promise<void> {
  const ref = docs.user(email)
  const snap = await ref.get()
  if (snap.exists) {
    /* Profile sync — update mutable fields only, preserve created_at and role */
    await ref.set({
      name,
      image,
      last_active_at: FieldValue.serverTimestamp(),
    }, { merge: true })
  } else {
    /* First sign-in — set created_at and default role */
    await ref.set({
      name,
      image,
      role: 'user',
      created_at: FieldValue.serverTimestamp(),
      last_active_at: FieldValue.serverTimestamp(),
    })
  }
}

/**
 * Update the user's activity timestamp and sync profile fields.
 * Fire-and-forget — called from the chat route on every authenticated
 * request. Never touches `created_at` or `role`.
 */
export function touchUser(email: string, name: string, image: string | null): void {
  docs.user(email).set({
    name,
    image,
    last_active_at: FieldValue.serverTimestamp(),
  }, { merge: true })
    .catch(err => console.error('[touchUser] Firestore write failed:', err))
}

/**
 * Check if a user has the admin role. Shared by `requireAdmin` (throws on
 * false) and the `/api/admin/check` endpoint (returns boolean).
 */
export async function isUserAdmin(email: string): Promise<boolean> {
  const snap = await docs.user(email).get()
  return snap.exists && snap.data()!.role === 'admin'
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Load a single user's profile. Returns null if no document exists
 * (user signed in via OAuth but never chatted).
 */
export async function getUser(email: string): Promise<UserDoc | null> {
  const snap = await docs.user(email).get()
  return snap.exists ? snap.data()! : null
}

/**
 * Load all user profiles with their emails (document IDs).
 *
 * Used by the admin dashboard to list all users. For a small org (<100 users),
 * this is a single collection read — no pagination needed.
 */
export async function listAllUsers(): Promise<Array<UserDoc & { email: string }>> {
  const snap = await collections.users().get()
  return snap.docs.map(doc => ({ ...doc.data(), email: doc.id }))
}
