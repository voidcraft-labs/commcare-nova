/**
 * User document CRUD helpers.
 *
 * UserDoc lives at `users/{userId}` where userId is Better Auth's user ID
 * (`session.user.id`). Three write paths:
 *
 * - `createUserDoc`   — `databaseHooks.user.create.after`: first sign-in only
 * - `ensureUserDoc`   — `databaseHooks.session.create.before`: every sign-in
 * - `touchUser`       — auth utilities on every authenticated request (fire-and-forget)
 *
 * Admin role is managed by Better Auth's admin plugin — `role` lives on
 * `auth_users`, not here. This collection stores app-level user data
 * (profile cache, activity timestamps) separate from auth state.
 */
import { FieldValue } from "@google-cloud/firestore";
import { log } from "@/lib/log";
import { collections, docs } from "./firestore";
import type { UserDoc } from "./types";

// ── Write ─────────────────────────────────────────────────────────

/**
 * Create the app's user doc on first sign-in.
 *
 * Called from `databaseHooks.user.create.after` — fires once when Better Auth
 * creates the auth user in `auth_users`. If this throws, the session creation
 * gate (`ensureUserDoc`) will detect the missing doc and abort the sign-in.
 */
export async function createUserDoc(
	userId: string,
	email: string,
	name: string,
	image: string | null,
): Promise<void> {
	await docs.user(userId).set({
		email,
		name,
		image,
		created_at: FieldValue.serverTimestamp(),
		last_active_at: FieldValue.serverTimestamp(),
	});
}

/**
 * Verify the app's user doc exists before allowing session creation.
 *
 * Called from `databaseHooks.session.create.before` — fires on every new
 * session. For new users, the doc was just created by `createUserDoc`. For
 * returning users, the doc already exists from their first sign-in.
 *
 * If the doc is missing (Firestore was down during `createUserDoc`, or it
 * was manually deleted), this throws — Better Auth aborts session creation
 * and the sign-in fails. The user can't end up with a valid session but
 * no user doc.
 */
export async function ensureUserDoc(userId: string): Promise<void> {
	const snap = await docs.user(userId).get();
	if (!snap.exists) {
		throw new Error(
			`User doc missing for ${userId} — cannot create session without it`,
		);
	}
}

/**
 * Bump the user's activity timestamp. Fire-and-forget — called from auth
 * utilities on every authenticated request (API routes, RSC pages, chat).
 * Only writes `last_active_at`; profile fields (name, image) are set once
 * by `createUserDoc` on first sign-in via the `user.create.after` hook.
 */
export function touchUser(userId: string): void {
	docs
		.user(userId)
		.set({ last_active_at: FieldValue.serverTimestamp() }, { merge: true })
		.catch((err) => log.error("[touchUser] Firestore write failed", err));
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Load a single user's profile. Returns null if no document exists.
 */
export async function getUser(userId: string): Promise<UserDoc | null> {
	const snap = await docs.user(userId).get();
	return snap.exists ? (snap.data() ?? null) : null;
}

/**
 * Load all user profiles with their IDs (document IDs = Better Auth user IDs).
 *
 * Used by the admin dashboard to list all users. For a small org (<100 users),
 * this is a single collection read — no pagination needed. Email is available
 * as a field inside each UserDoc.
 */
export async function listAllUsers(): Promise<Array<UserDoc & { id: string }>> {
	const snap = await collections.users().get();
	return snap.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
}
