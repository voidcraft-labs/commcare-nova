/**
 * User settings persistence — Postgres CRUD for the `user_settings` row
 * (keyed by `user_id`).
 *
 * Handles CommCare HQ credential storage with Cloud KMS encryption. API keys
 * are encrypted via Google Cloud KMS before writing and decrypted on-demand
 * when making API calls. Key rotation is handled entirely by KMS — no
 * application-level rotation logic needed.
 *
 * The settings row is separate from `auth_users` to avoid leaking secrets into
 * Better Auth session cookies and to keep auth concerns cleanly separated from
 * app preferences.
 *
 * Multi-space keys: an HQ API key can reach several project spaces, so this
 * module stores the full reachable set (`approved_domains`). Which space an
 * upload targets is decided per-upload by the pure `resolveUploadDomain` —
 * never re-implemented here, and deliberately never remembered as a stored
 * default (a multi-space key exists to operate across spaces).
 */

import {
	type CommCareApiError,
	type CommCareCredentials,
	type CommCareDomain,
	discoverAccessibleDomains,
} from "@/lib/commcare/client";
import { decrypt, encrypt } from "@/lib/commcare/encryption";
import type { CommCareServer } from "@/lib/commcare/servers";
import { resolveUploadDomain } from "./domainResolution";
import { getAppDb } from "./pg";

// ── Public types ───────────────────────────────────────────────────

/**
 * Safe subset of settings returned to the client (never includes the raw
 * API key). Discriminated on `configured`.
 *
 * On a configured row, `availableDomains` is every space the key can upload to
 * (length 1 ⇒ a single-space key). There is no stored default target: a
 * single-space key resolves to its sole space at upload time, and a multi-space
 * key's target is chosen per-upload (the dialog, or the MCP caller) — so this
 * shape carries the reachable set and nothing to pre-select from.
 */
export type CommCareSettingsPublic =
	| { configured: false }
	| {
			configured: true;
			username: string;
			/** Which HQ deployment the connection lives on (US / India / EU). */
			server: CommCareServer;
			availableDomains: CommCareDomain[];
	  };

/**
 * Result of resolving credentials + target space for an upload. Mirrors the
 * pure resolver's failure shapes, plus `not_configured` for the no-settings
 * case. The decrypted key is only attached on success, so a doomed request
 * never triggers a KMS call.
 */
export type CredentialsForUploadResult =
	| { ok: true; creds: CommCareCredentials; domain: CommCareDomain }
	| { ok: false; error: "not_configured" }
	| {
			ok: false;
			error: "not_authorized" | "ambiguous";
			available: CommCareDomain[];
	  };

// ── Read operations ────────────────────────────────────────────────

/**
 * Get the user's CommCare settings in a client-safe format.
 *
 * Returns `configured: false` when no settings exist OR when the persisted
 * row is missing the username / server / reachable spaces a configured row
 * must have — the save flow rejects partial rows, so the defensive collapse
 * turns an in-place schema corruption into a "not configured" UX rather than
 * an inconsistent half-state. Never exposes the raw API key.
 */
export async function getCommCareSettings(
	userId: string,
): Promise<CommCareSettingsPublic> {
	const db = await getAppDb();
	const data = await db
		.selectFrom("user_settings")
		.select(["commcare_username", "commcare_server", "approved_domains"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!data) return { configured: false };

	const availableDomains = data.approved_domains ?? [];
	if (
		!data.commcare_username ||
		!data.commcare_server ||
		availableDomains.length === 0
	) {
		return { configured: false };
	}

	return {
		configured: true,
		username: data.commcare_username,
		server: data.commcare_server as CommCareServer,
		availableDomains,
	};
}

/**
 * Resolve decrypted credentials AND the target project space for an upload,
 * in a single Postgres read. `requested` is an optional explicit space name
 * (per-call MCP arg / per-request body field); with none supplied the resolver
 * uses the sole reachable space (single-space key) or returns `ambiguous` for a
 * multi-space key. Used by both the MCP upload tool and the HTTP upload route so
 * they share one authorization decision.
 *
 * The API key is decrypted only after the target resolves, so an unauthorized
 * or ambiguous request never reaches KMS.
 */
export async function getCredentialsForUpload(
	userId: string,
	requested?: string,
): Promise<CredentialsForUploadResult> {
	const db = await getAppDb();
	const data = await db
		.selectFrom("user_settings")
		.select([
			"commcare_username",
			"commcare_api_key",
			"commcare_server",
			"approved_domains",
		])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	const availableDomains = data?.approved_domains ?? [];
	if (
		!data?.commcare_username ||
		!data.commcare_server ||
		availableDomains.length === 0
	) {
		return { ok: false, error: "not_configured" };
	}

	const resolved = resolveUploadDomain({ availableDomains, requested });
	if (!resolved.ok) {
		return { ok: false, error: resolved.reason, available: resolved.available };
	}

	const apiKey = await decrypt(data.commcare_api_key);
	return {
		ok: true,
		creds: {
			username: data.commcare_username,
			apiKey,
			server: data.commcare_server as CommCareServer,
		},
		domain: resolved.domain,
	};
}

// ── Write operations ───────────────────────────────────────────────

/** Input shape for saving CommCare credentials. */
export interface SaveCommCareSettingsInput {
	username: string;
	apiKey: string;
	/** The HQ deployment the key was verified against — stored with it. */
	server: CommCareServer;
	/** Every space the key can upload to (already access-probed by the caller). */
	approvedDomains: CommCareDomain[];
}

/**
 * Save (or update) a user's CommCare HQ credentials.
 *
 * Encrypts the API key via Cloud KMS and stores the full reachable space set.
 * No upload default is persisted — the target is chosen per-upload — so an
 * INSERT-or-UPDATE of exactly these fields is safe.
 */
export async function saveCommCareSettings(
	userId: string,
	input: SaveCommCareSettingsInput,
): Promise<void> {
	const encryptedKey = await encrypt(input.apiKey);
	const db = await getAppDb();
	const values = {
		commcare_username: input.username,
		commcare_api_key: encryptedKey,
		commcare_server: input.server,
		approved_domains: JSON.stringify(input.approvedDomains),
		updated_at: new Date(),
	};
	await db
		.insertInto("user_settings")
		.values({ user_id: userId, ...values })
		.onConflict((oc) => oc.column("user_id").doUpdateSet(values))
		.execute();
}

/** Outcome of a refresh — distinct failure kinds so the caller can compose
 * a contextual message and tell "HQ is down" from "key lost all access." */
export type RefreshDomainsResult =
	| { ok: true; settings: CommCareSettingsPublic }
	| { ok: false; kind: "hq_error"; status: number }
	| { ok: false; kind: "no_spaces" };

/**
 * Re-introspect the key's reachable spaces and persist the refreshed set.
 *
 * Decrypts the stored key and re-runs domain discovery. A row with no stored
 * key reads back as unconfigured (nothing to refresh). An HQ API error returns
 * `hq_error` WITHOUT writing.
 *
 * Empty-but-successful result guard: `testDomainAccess` maps a per-domain
 * 401/403 to a definitive `false` (only 5xx propagates as an error), so a
 * transient HQ access blip can make discovery return an empty set with no
 * error. Persisting that would zero `approved_domains` and silently flip an
 * already-connected user to "not configured" with their key still stored.
 * So an empty result returns `no_spaces` and leaves the stored row untouched —
 * mirroring the save path, which also refuses to store a zero-space key.
 */
export async function refreshApprovedDomains(
	userId: string,
): Promise<RefreshDomainsResult> {
	const db = await getAppDb();
	const data = await db
		.selectFrom("user_settings")
		.select(["commcare_username", "commcare_api_key", "commcare_server"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (
		!data?.commcare_username ||
		!data.commcare_api_key ||
		!data.commcare_server
	) {
		return { ok: true, settings: { configured: false } };
	}

	const apiKey = await decrypt(data.commcare_api_key);
	const accessible: CommCareDomain[] | CommCareApiError =
		await discoverAccessibleDomains({
			username: data.commcare_username,
			apiKey,
			server: data.commcare_server as CommCareServer,
		});
	if (!Array.isArray(accessible))
		return { ok: false, kind: "hq_error", status: accessible.status };
	if (accessible.length === 0) return { ok: false, kind: "no_spaces" };

	await db
		.updateTable("user_settings")
		.set({
			approved_domains: JSON.stringify(accessible),
			updated_at: new Date(),
		})
		.where("user_id", "=", userId)
		.execute();

	return { ok: true, settings: await getCommCareSettings(userId) };
}

/**
 * Delete a user's CommCare HQ credentials entirely.
 *
 * Used when the user wants to disconnect their CommCare account.
 */
export async function deleteCommCareSettings(userId: string): Promise<void> {
	const db = await getAppDb();
	await db.deleteFrom("user_settings").where("user_id", "=", userId).execute();
}
