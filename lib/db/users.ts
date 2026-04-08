/**
 * User document CRUD helpers.
 *
 * UserDoc lives at `users/{userId}` where userId is Better Auth's user ID
 * (`session.user.id`). Two write paths:
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

/** Result from provisioning — the auth after-hook writes isAdmin to the session. */
export interface ProvisionResult {
	isAdmin: boolean;
}

/**
 * Ensure the app's user doc exists and has a current profile.
 *
 * Called on every OAuth sign-in (new and returning users). The `userId`
 * parameter is Better Auth's built-in user ID — used directly as the
 * Firestore document ID so there's no indirection or email-based lookup.
 *
 * Returning users get a profile sync (name, image, activity timestamp).
 * First-time users get a fresh document. Returns admin status so the
 * after-hook can write it to the session.
 */
export async function provisionUser(
	userId: string,
	email: string,
	name: string,
	image: string | null,
): Promise<ProvisionResult> {
	const snap = await docs.user(userId).get();
	if (snap.exists) {
		/* Returning user — sync profile fields, preserve created_at and role. */
		await docs.user(userId).set(
			{
				email,
				name,
				image,
				last_active_at: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
		return { isAdmin: snap.data()?.role === "admin" };
	}

	/* First sign-in — create the user doc keyed by Better Auth's user ID */
	await docs.user(userId).set({
		email,
		name,
		image,
		role: "user",
		created_at: FieldValue.serverTimestamp(),
		last_active_at: FieldValue.serverTimestamp(),
	});
	return { isAdmin: false };
}

/**
 * Bump the user's activity timestamp. Fire-and-forget — called from auth
 * utilities on every authenticated request (API routes, RSC pages, chat).
 * Only writes `last_active_at`; profile fields (name, image) are synced
 * exclusively by `provisionUser` with fresh OAuth data on sign-in.
 */
export function touchUser(userId: string): void {
	docs
		.user(userId)
		.set({ last_active_at: FieldValue.serverTimestamp() }, { merge: true })
		.catch((err) => log.error("[touchUser] Firestore write failed", err));
}

/**
 * Check if a user has the admin role. Shared by `requireAdmin` (throws on
 * false) and the `/api/admin/check` endpoint (returns boolean).
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
	const snap = await docs.user(userId).get();
	return snap.exists && snap.data()?.role === "admin";
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Load a single user's profile. Returns null if no document exists
 * (user signed in via OAuth but never chatted).
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
