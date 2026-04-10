/**
 * CommCare HQ settings Server Actions — verify credentials and manage storage.
 *
 * These replace the former `/api/settings/commcare` route handler. Server
 * Actions run on the server with full access to Firestore and KMS, while
 * being callable directly from client components — no HTTP round-trip.
 *
 * Both actions return result objects and never throw — Next.js surfaces
 * unhandled Server Action errors differently than route handlers, so we
 * catch everything internally.
 */

"use server";

import { getSession } from "@/lib/auth-utils";
import {
	type CommCareDomain,
	listDomains,
	testDomainAccess,
} from "@/lib/commcare/client";
import {
	deleteCommCareSettings,
	saveCommCareSettings,
} from "@/lib/db/settings";
import { log } from "@/lib/log";

// ── Types ──────────────────────────────────────────────────────────

export type VerifyResult =
	| { success: true; domain: CommCareDomain }
	| { success: false; error: string };

export type DeleteResult =
	| { success: true }
	| { success: false; error: string };

// ── Error messages ──────────────────────────────────────────────────

/** Map CommCare HQ status codes to user-facing messages for settings context. */
function settingsErrorMessage(status: number): string {
	if (status === 401)
		return "Invalid API key. Check that you copied it correctly.";
	if (status === 429)
		return "Rate limited by CommCare HQ. Wait a moment and try again.";
	if (status >= 500) return "CommCare HQ is unavailable. Try again later.";
	return `CommCare HQ returned an error (HTTP ${status}).`;
}

// ── Actions ─────────────────────────────────────────────────────────

/**
 * Verify CommCare HQ credentials against HQ's API, then save on success.
 *
 * Tests domains sequentially and bails on the first match — CommCare API
 * keys are scoped to a single domain, so at most one will pass.
 */
export async function verifyAndSaveCredentials(
	username: string,
	apiKey: string,
): Promise<VerifyResult> {
	try {
		const session = await getSession();
		if (!session) return { success: false, error: "Authentication required." };

		if (!username.trim())
			return { success: false, error: "Username is required." };
		if (!apiKey.trim())
			return { success: false, error: "API key is required." };

		const creds = { username: username.trim(), apiKey: apiKey.trim() };

		/* Step 1: Fetch the user's domain list to validate the key. */
		const allDomains = await listDomains(creds);
		if (!Array.isArray(allDomains)) {
			return { success: false, error: settingsErrorMessage(allDomains.status) };
		}
		if (allDomains.length === 0) {
			return {
				success: false,
				error: "No project spaces found for this account.",
			};
		}

		/* Step 2: Test domains one at a time, bail on first match. */
		let foundDomain: CommCareDomain | null = null;
		for (const domain of allDomains) {
			const result = await testDomainAccess(creds, domain.name);

			/* Non-boolean = a server error (5xx) — abort. */
			if (typeof result === "object") {
				return { success: false, error: settingsErrorMessage(result.status) };
			}
			if (result) {
				foundDomain = domain;
				break;
			}
		}

		if (!foundDomain) {
			return {
				success: false,
				error:
					"API key doesn't have access to any project space. CommCare keys are scoped to one domain — make sure this key matches the right project.",
			};
		}

		/* Step 3: Save encrypted credentials + authorized domain. */
		await saveCommCareSettings(session.user.id, {
			username: creds.username,
			apiKey: creds.apiKey,
			approvedDomains: [foundDomain],
		});

		return { success: true, domain: foundDomain };
	} catch (err) {
		log.error("[settings/commcare] verify error", err);
		return {
			success: false,
			error: "An unexpected error occurred. Please try again.",
		};
	}
}

/**
 * Remove all stored CommCare HQ credentials for the current user.
 */
export async function deleteCredentials(): Promise<DeleteResult> {
	try {
		const session = await getSession();
		if (!session) return { success: false, error: "Authentication required." };

		await deleteCommCareSettings(session.user.id);
		return { success: true };
	} catch (err) {
		log.error("[settings/commcare] delete error", err);
		return {
			success: false,
			error: "Failed to disconnect. Please try again.",
		};
	}
}
