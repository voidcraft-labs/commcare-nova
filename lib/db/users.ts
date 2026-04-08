/**
 * User document CRUD helpers.
 *
 * UserDoc lives at `users/{userId}` where userId is a UUID. Two write paths:
 * - `provisionUser` — called on every sign-in (Better Auth after hook), creates or updates
 * - `touchUser` — called on every authenticated request (fire-and-forget), updates `last_active_at`
 *
 * On first sign-in, a new UUID is generated via `crypto.randomUUID()` and
 * becomes the permanent document ID. Email is stored as a field for display
 * and lookup. `findUserByEmail` resolves email → userId via a Firestore
 * query (requires index on `users.email`).
 *
 * The `role` field is intentionally never set by application code — changes
 * happen via direct Firestore console edits only.
 */
import { FieldValue } from "@google-cloud/firestore";
import { log } from "@/lib/log";
import { collections, docs } from "./firestore";
import type { UserDoc } from "./types";

// ── Lookup ─────────────────────────────────────────────────────────

/** Result of resolving an existing user by email. */
interface ExistingUser {
	userId: string;
	isAdmin: boolean;
}

/**
 * Resolve an existing user by email. Requires Firestore index on `users.email`.
 * Returns userId + admin status from the same query so `provisionUser` avoids
 * a second read.
 */
async function findUserByEmail(email: string): Promise<ExistingUser | null> {
	const snap = await collections
		.users()
		.where("email", "==", email)
		.limit(1)
		.get();
	if (snap.empty) return null;
	const doc = snap.docs[0];
	return { userId: doc.id, isAdmin: doc.data().role === "admin" };
}

// ── Write ─────────────────────────────────────────────────────────

/** Result from provisioning — the auth after-hook needs both values. */
export interface ProvisionResult {
	isAdmin: boolean;
	userId: string;
}

/**
 * Ensure the app's user doc exists and has a current profile.
 *
 * Called on every OAuth sign-in (new and returning users). Returning users
 * are found via `findUserByEmail` and get a profile sync. First-time users
 * get a new UUID and a fresh document.
 *
 * Returns the user's UUID and admin status — the after-hook writes both
 * to the Better Auth session so they're available on every request.
 */
export async function provisionUser(
	email: string,
	name: string,
	image: string | null,
): Promise<ProvisionResult> {
	const existing = await findUserByEmail(email);
	if (existing) {
		/* Returning user — sync profile fields, preserve created_at and role.
		 * Admin status was already read by findUserByEmail — no second read. */
		await docs.user(existing.userId).set(
			{
				name,
				image,
				last_active_at: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
		return existing;
	}

	/* First sign-in — generate a UUID and create the user doc */
	const userId = crypto.randomUUID();
	await docs.user(userId).set({
		email,
		name,
		image,
		role: "user",
		created_at: FieldValue.serverTimestamp(),
		last_active_at: FieldValue.serverTimestamp(),
	});
	return { isAdmin: false, userId };
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
 * Load all user profiles with their IDs (document IDs = UUIDs).
 *
 * Used by the admin dashboard to list all users. For a small org (<100 users),
 * this is a single collection read — no pagination needed. Email is available
 * as a field inside each UserDoc.
 */
export async function listAllUsers(): Promise<Array<UserDoc & { id: string }>> {
	const snap = await collections.users().get();
	return snap.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
}
