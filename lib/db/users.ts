/**
 * User document CRUD helpers.
 *
 * UserDoc lives at `users/{email}`. Two write paths:
 * - `provisionUser` — called on every sign-in (Better Auth after hook), creates or updates
 * - `touchUser` — called on every authenticated request (fire-and-forget), updates `last_active_at`
 *
 * The `role` field is intentionally never set by application code — changes
 * happen via direct Firestore console edits only.
 */
import { FieldValue } from "@google-cloud/firestore";
import { log } from "@/lib/log";
import { collections, docs } from "./firestore";
import type { UserDoc } from "./types";

// ── Write ─────────────────────────────────────────────────────────

/**
 * Ensure the app's user doc exists and has a current profile.
 *
 * Called on every OAuth sign-in (new and returning users). First sign-in
 * creates the doc with a default `user` role. Subsequent sign-ins sync
 * `name` and `image` (profile changes from Google) via `merge: true`
 * without overwriting `role` or `created_at`.
 *
 * Returns whether the user has the admin role — derived from the same
 * Firestore read that checks existence, avoiding a redundant second read
 * in the auth after-hook.
 */
export async function provisionUser(
	email: string,
	name: string,
	image: string | null,
): Promise<boolean> {
	const ref = docs.user(email);
	const snap = await ref.get();
	if (snap.exists) {
		/* Profile sync — update mutable fields only, preserve created_at and role */
		await ref.set(
			{
				name,
				image,
				last_active_at: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
		return snap.data()?.role === "admin";
	} else {
		/* First sign-in — set created_at and default role */
		await ref.set({
			name,
			image,
			role: "user",
			created_at: FieldValue.serverTimestamp(),
			last_active_at: FieldValue.serverTimestamp(),
		});
		return false;
	}
}

/**
 * Bump the user's activity timestamp. Fire-and-forget — called from auth
 * utilities on every authenticated request (API routes, RSC pages, chat).
 * Only writes `last_active_at`; profile fields (name, image) are synced
 * exclusively by `provisionUser` with fresh OAuth data on sign-in.
 */
export function touchUser(email: string): void {
	docs
		.user(email)
		.set({ last_active_at: FieldValue.serverTimestamp() }, { merge: true })
		.catch((err) => log.error("[touchUser] Firestore write failed", err));
}

/**
 * Check if a user has the admin role. Shared by `requireAdmin` (throws on
 * false) and the `/api/admin/check` endpoint (returns boolean).
 */
export async function isUserAdmin(email: string): Promise<boolean> {
	const snap = await docs.user(email).get();
	return snap.exists && snap.data()?.role === "admin";
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Load a single user's profile. Returns null if no document exists
 * (user signed in via OAuth but never chatted).
 */
export async function getUser(email: string): Promise<UserDoc | null> {
	const snap = await docs.user(email).get();
	return snap.exists ? (snap.data() ?? null) : null;
}

/**
 * Load all user profiles with their emails (document IDs).
 *
 * Used by the admin dashboard to list all users. For a small org (<100 users),
 * this is a single collection read — no pagination needed.
 */
export async function listAllUsers(): Promise<
	Array<UserDoc & { email: string }>
> {
	const snap = await collections.users().get();
	return snap.docs.map((doc) => ({ ...doc.data(), email: doc.id }));
}
