/**
 * User settings persistence — Firestore CRUD for `user_settings/{userId}`.
 *
 * Handles CommCare HQ credential storage with Cloud KMS encryption.
 * API keys are encrypted via Google Cloud KMS before writing to Firestore
 * and decrypted on-demand when making API calls. Key rotation is handled
 * entirely by KMS — no application-level rotation logic needed.
 *
 * The settings document is separate from `auth_users` to avoid leaking
 * secrets into Better Auth session cookies and to keep auth concerns
 * cleanly separated from app preferences.
 */

import { FieldValue } from "@google-cloud/firestore";
import type {
	CommCareCredentials,
	CommCareDomain,
} from "@/lib/commcare/client";
import { decrypt, encrypt } from "@/lib/commcare/encryption";
import { docs } from "./firestore";
import type { UserSettingsDoc } from "./types";

// ── Public types ───────────────────────────────────────────────────

/** Safe subset of settings returned to the client (never includes raw API key). */
export interface CommCareSettingsPublic {
	configured: boolean;
	username: string;
	/** The authorized project space, or null when not configured. */
	domain: { name: string; displayName: string } | null;
}

// ── Read operations ────────────────────────────────────────────────

/**
 * Get the user's CommCare settings in a client-safe format.
 *
 * Returns `configured: false` when no settings exist. Never exposes
 * the raw API key — only whether credentials are present.
 */
export async function getCommCareSettings(
	userId: string,
): Promise<CommCareSettingsPublic> {
	const snap = await docs.settings(userId).get();
	if (!snap.exists) {
		return { configured: false, username: "", domain: null };
	}
	const data = snap.data();
	if (!data) return { configured: false, username: "", domain: null };
	return {
		configured: true,
		username: data.commcare_username,
		domain: data.approved_domains?.[0] ?? null,
	};
}

/**
 * Retrieve decrypted CommCare HQ credentials for server-side API calls.
 *
 * Returns null if no settings exist. Decryption is delegated to Cloud KMS —
 * the plaintext key only exists in-memory for the duration of the API call.
 * KMS handles key version detection automatically, so rotated keys just work.
 */
export async function getDecryptedCredentials(
	userId: string,
): Promise<CommCareCredentials | null> {
	const snap = await docs.settings(userId).get();
	if (!snap.exists) return null;
	const data = snap.data();
	if (!data) return null;

	const apiKey = await decrypt(data.commcare_api_key);
	return { username: data.commcare_username, apiKey };
}

/**
 * Retrieve decrypted credentials AND the approved domain in a single
 * Firestore read. Used by the upload route which needs both to
 * authorize the target domain and execute the import.
 */
export async function getDecryptedCredentialsWithDomain(
	userId: string,
): Promise<{
	creds: CommCareCredentials;
	domain: CommCareDomain;
} | null> {
	const snap = await docs.settings(userId).get();
	if (!snap.exists) return null;
	const data = snap.data();
	if (!data) return null;

	const domain = data.approved_domains?.[0];
	if (!domain) return null;

	const apiKey = await decrypt(data.commcare_api_key);
	return {
		creds: { username: data.commcare_username, apiKey },
		domain,
	};
}

// ── Write operations ───────────────────────────────────────────────

/** Input shape for saving CommCare credentials. */
export interface SaveCommCareSettingsInput {
	username: string;
	apiKey: string;
	/** Domains where the API key has verified access. */
	approvedDomains: CommCareDomain[];
}

/**
 * Save (or update) a user's CommCare HQ credentials.
 *
 * Encrypts the API key via Cloud KMS before writing to Firestore.
 * The approved domains list is stored alongside the credentials —
 * safe because API key scope and domain slugs are immutable in CommCare HQ.
 */
export async function saveCommCareSettings(
	userId: string,
	input: SaveCommCareSettingsInput,
): Promise<void> {
	const encryptedKey = await encrypt(input.apiKey);

	await docs.settings(userId).set(
		{
			commcare_username: input.username,
			commcare_api_key: encryptedKey,
			approved_domains: input.approvedDomains,
			updated_at: FieldValue.serverTimestamp(),
		} as unknown as UserSettingsDoc,
		{ merge: true },
	);
}

/**
 * Delete a user's CommCare HQ credentials entirely.
 *
 * Used when the user wants to disconnect their CommCare account.
 */
export async function deleteCommCareSettings(userId: string): Promise<void> {
	await docs.settings(userId).delete();
}
