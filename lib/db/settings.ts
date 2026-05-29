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
 *
 * Multi-space keys: an HQ API key can reach several project spaces, so this
 * module stores the full reachable set (`approved_domains`) plus the user's
 * chosen default (`active_domain`). Which space an upload targets is decided
 * by the pure `resolveUploadDomain` — never re-implemented here.
 */

import { FieldValue } from "@google-cloud/firestore";
import {
	type CommCareApiError,
	type CommCareCredentials,
	type CommCareDomain,
	discoverAccessibleDomains,
} from "@/lib/commcare/client";
import { decrypt, encrypt } from "@/lib/commcare/encryption";
import { resolveUploadDomain } from "./domainResolution";
import { docs } from "./firestore";
import type { UserSettingsDoc } from "./types";

// ── Public types ───────────────────────────────────────────────────

/**
 * Safe subset of settings returned to the client (never includes the raw
 * API key). Discriminated on `configured`.
 *
 * On a configured row, `availableDomains` is every space the key can upload to.
 * `domain` is the resolved default upload target: the sole space for a
 * single-space key, or the stored `active_domain` for a multi-space key. It is
 * `null` for a multi-space key with no stored default — the common case, since
 * the default is no longer user-settable in Settings (only auto-bound for
 * single-space keys, or carried on a legacy/migrated row). The upload dialog
 * is where the per-upload target is chosen; consumers use `domain` only as a
 * pre-selection hint.
 */
export type CommCareSettingsPublic =
	| { configured: false }
	| {
			configured: true;
			username: string;
			domain: CommCareDomain | null;
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

// ── Internal helpers ───────────────────────────────────────────────

/**
 * Pick the default space to persist after the reachable set changes.
 *
 * Preserves a prior default that's still reachable; otherwise a single-space
 * key auto-binds to its sole space and a multi-space key is left unset. Since
 * the Settings picker was removed, the only `priorActive` a multi-space key
 * can carry is a legacy/migrated value — a fresh multi-space save now always
 * leaves the default unset, and the upload dialog chooses the target instead.
 */
export function reconcileActiveDomain(
	approvedDomains: CommCareDomain[],
	priorActive: string | undefined,
): string | undefined {
	if (priorActive && approvedDomains.some((d) => d.name === priorActive)) {
		return priorActive;
	}
	return approvedDomains.length === 1 ? approvedDomains[0].name : undefined;
}

// ── Read operations ────────────────────────────────────────────────

/**
 * Get the user's CommCare settings in a client-safe format.
 *
 * Returns `configured: false` when no settings exist OR when the persisted
 * row is missing the username / reachable spaces a configured row must have —
 * the save flow rejects partial rows, so the defensive collapse turns an
 * in-place schema corruption into a "not configured" UX rather than an
 * inconsistent half-state. Never exposes the raw API key.
 */
export async function getCommCareSettings(
	userId: string,
): Promise<CommCareSettingsPublic> {
	const snap = await docs.settings(userId).get();
	if (!snap.exists) return { configured: false };
	const data = snap.data();
	if (!data) return { configured: false };

	const availableDomains = data.approved_domains ?? [];
	if (!data.commcare_username || availableDomains.length === 0) {
		return { configured: false };
	}

	/* Resolve the active target with no explicit request: the resolver returns
	 * `ok` for a single space or a valid chosen default, and otherwise (multi
	 * space, no default) signals ambiguity — which we surface to the client as
	 * a `null` domain meaning "pick one." */
	const resolved = resolveUploadDomain({
		availableDomains,
		activeDomainName: data.active_domain,
	});

	return {
		configured: true,
		username: data.commcare_username,
		domain: resolved.ok ? resolved.domain : null,
		availableDomains,
	};
}

/**
 * Resolve decrypted credentials AND the target project space for an upload,
 * in a single Firestore read. `requested` is an optional explicit space name
 * (per-call MCP arg / per-request body field) that overrides the stored
 * default. Used by both the MCP upload tool and the HTTP upload route so they
 * share one authorization decision.
 *
 * The API key is decrypted only after the target resolves, so an unauthorized
 * or ambiguous request never reaches KMS.
 */
export async function getCredentialsForUpload(
	userId: string,
	requested?: string,
): Promise<CredentialsForUploadResult> {
	const snap = await docs.settings(userId).get();
	if (!snap.exists) return { ok: false, error: "not_configured" };
	const data = snap.data();
	const availableDomains = data?.approved_domains ?? [];
	if (!data?.commcare_username || availableDomains.length === 0) {
		return { ok: false, error: "not_configured" };
	}

	const resolved = resolveUploadDomain({
		availableDomains,
		activeDomainName: data.active_domain,
		requested,
	});
	if (!resolved.ok) {
		return { ok: false, error: resolved.reason, available: resolved.available };
	}

	const apiKey = await decrypt(data.commcare_api_key);
	return {
		ok: true,
		creds: { username: data.commcare_username, apiKey },
		domain: resolved.domain,
	};
}

// ── Write operations ───────────────────────────────────────────────

/** Input shape for saving CommCare credentials. */
export interface SaveCommCareSettingsInput {
	username: string;
	apiKey: string;
	/** Every space the key can upload to (already access-probed by the caller). */
	approvedDomains: CommCareDomain[];
}

/**
 * Save (or update) a user's CommCare HQ credentials.
 *
 * Encrypts the API key via Cloud KMS, stores the full reachable space set,
 * and reconciles the chosen default (see `reconcileActiveDomain`). A cleared
 * default is removed with `FieldValue.delete()` so a re-save that goes from
 * single-space to multi-space doesn't leave a stale auto-bound default behind
 * the `merge: true` write.
 */
export async function saveCommCareSettings(
	userId: string,
	input: SaveCommCareSettingsInput,
): Promise<void> {
	const [encryptedKey, existing] = await Promise.all([
		encrypt(input.apiKey),
		docs.settings(userId).get(),
	]);
	const priorActive = existing.exists
		? existing.data()?.active_domain
		: undefined;
	const activeName = reconcileActiveDomain(input.approvedDomains, priorActive);

	await docs.settings(userId).set(
		{
			commcare_username: input.username,
			commcare_api_key: encryptedKey,
			approved_domains: input.approvedDomains,
			active_domain: activeName ?? FieldValue.delete(),
			updated_at: FieldValue.serverTimestamp(),
		} as unknown as UserSettingsDoc,
		{ merge: true },
	);
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
 * Decrypts the stored key, re-runs domain discovery, and reconciles the
 * default. A row with no stored key reads back as unconfigured (nothing to
 * refresh). An HQ API error returns `hq_error` WITHOUT writing.
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
	const snap = await docs.settings(userId).get();
	const data = snap.exists ? snap.data() : undefined;
	if (!data?.commcare_username || !data.commcare_api_key) {
		return { ok: true, settings: { configured: false } };
	}

	const apiKey = await decrypt(data.commcare_api_key);
	const accessible: CommCareDomain[] | CommCareApiError =
		await discoverAccessibleDomains({
			username: data.commcare_username,
			apiKey,
		});
	if (!Array.isArray(accessible))
		return { ok: false, kind: "hq_error", status: accessible.status };
	if (accessible.length === 0) return { ok: false, kind: "no_spaces" };

	const activeName = reconcileActiveDomain(accessible, data.active_domain);
	await docs.settings(userId).set(
		{
			approved_domains: accessible,
			active_domain: activeName ?? FieldValue.delete(),
			updated_at: FieldValue.serverTimestamp(),
		} as unknown as UserSettingsDoc,
		{ merge: true },
	);

	return { ok: true, settings: await getCommCareSettings(userId) };
}

/**
 * Delete a user's CommCare HQ credentials entirely.
 *
 * Used when the user wants to disconnect their CommCare account.
 */
export async function deleteCommCareSettings(userId: string): Promise<void> {
	await docs.settings(userId).delete();
}
