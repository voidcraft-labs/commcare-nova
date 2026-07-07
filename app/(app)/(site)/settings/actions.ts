/**
 * CommCare HQ settings Server Actions — verify credentials and manage storage.
 *
 * Both actions return result objects and never throw — Next.js surfaces
 * unhandled Server Action errors as full-page error boundaries, so we
 * catch everything internally and return structured error responses.
 *
 * An HQ API key can reach several project spaces, so these actions deal in
 * the full reachable set: verifying stores every reachable space, and refresh
 * re-reads it. Choosing which space an upload targets happens per-upload in
 * the upload dialog, not here. Each action returns the fresh
 * `CommCareSettingsPublic` so the client can replace its state wholesale.
 */

"use server";

import { getSession } from "@/lib/auth-utils";
import { discoverAccessibleDomains } from "@/lib/commcare/client";
import {
	COMMCARE_SERVERS,
	type CommCareServer,
	isCommCareServer,
} from "@/lib/commcare/servers";
import {
	type CommCareSettingsPublic,
	deleteCommCareSettings,
	getCommCareSettings,
	refreshApprovedDomains,
	saveCommCareSettings,
} from "@/lib/db/settings";
import { log } from "@/lib/logger";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Shared result for actions that mutate the connection — the success branch
 * carries the refreshed public settings so the client can swap its state in
 * one step (the full reachable set of project spaces).
 */
export type SettingsResult =
	| { success: true; settings: CommCareSettingsPublic }
	| { success: false; error: string };

export type DeleteResult =
	| { success: true }
	| { success: false; error: string };

// ── Error messages ──────────────────────────────────────────────────

/**
 * A verify-time 401, naming the deployment the key was tried against. The
 * US, India, and EU servers are separate deployments with separate accounts,
 * and a key carries no hint of which one issued it — so "invalid key"
 * against one server very often means "valid key, wrong server," and the
 * message has to point there or the user has nothing left to check.
 */
function invalidKeyMessage(server: CommCareServer): string {
	const { label, host } = COMMCARE_SERVERS[server];
	return `CommCare HQ (${label} — ${host}) rejected this API key. Check that you copied it correctly, and that ${label} is the server where your account lives — a key only works on the server that issued it.`;
}

/**
 * Map the non-401 CommCare HQ status codes to user-facing messages. Each
 * caller owns its 401 (verify → `invalidKeyMessage`; refresh → its
 * revoked-key copy) because what a 401 MEANS depends on whether the key was
 * just typed or has worked before.
 */
function settingsErrorMessage(status: number): string {
	if (status === 429)
		return "Rate limited by CommCare HQ. Wait a moment and try again.";
	if (status >= 500) return "CommCare HQ is unavailable. Try again later.";
	return `CommCare HQ returned an error (HTTP ${status}).`;
}

// ── Actions ─────────────────────────────────────────────────────────

/**
 * Verify CommCare HQ credentials against HQ's API, then save on success.
 *
 * Discovers every project space the key can actually upload to — one HQ list
 * call plus a parallel app-access probe per space — and stores all of them.
 * Storing the full set (not the first space that passes) is the fix for the
 * silent-wrong-target bug: a multi-space key now shows every space it reaches
 * so the user can pick the upload target.
 */
export async function verifyAndSaveCredentials(
	username: string,
	apiKey: string,
	server: string,
): Promise<SettingsResult> {
	try {
		const session = await getSession();
		if (!session) return { success: false, error: "Authentication required." };

		if (!username.trim())
			return { success: false, error: "Username is required." };
		if (!apiKey.trim())
			return { success: false, error: "API key is required." };
		/* Server Action args are untrusted; narrow to the closed catalog so
		 * an arbitrary string can never reach the HQ client or storage. */
		if (!isCommCareServer(server))
			return { success: false, error: "Pick a CommCare HQ server." };

		const creds = { username: username.trim(), apiKey: apiKey.trim(), server };

		const accessible = await discoverAccessibleDomains(creds);
		if (!Array.isArray(accessible)) {
			return {
				success: false,
				error:
					accessible.status === 401
						? invalidKeyMessage(server)
						: settingsErrorMessage(accessible.status),
			};
		}
		if (accessible.length === 0) {
			return {
				success: false,
				error:
					"This API key can't reach any project space. Check that the key is correct and that your CommCare account has access to a project.",
			};
		}

		await saveCommCareSettings(session.user.id, {
			username: creds.username,
			apiKey: creds.apiKey,
			server,
			approvedDomains: accessible,
		});

		return {
			success: true,
			settings: await getCommCareSettings(session.user.id),
		};
	} catch (err) {
		log.error("[settings/commcare] verify error", err);
		return {
			success: false,
			error: "An unexpected error occurred. Please try again.",
		};
	}
}

/**
 * Re-read the spaces the stored key can reach — picks up project memberships
 * added since the key was first saved.
 */
export async function refreshDomainsAction(): Promise<SettingsResult> {
	try {
		const session = await getSession();
		if (!session) return { success: false, error: "Authentication required." };

		const result = await refreshApprovedDomains(session.user.id);
		if (!result.ok) {
			/* `no_spaces` is distinct from an HQ outage: the key authenticated
			 * but reaches nothing now. Leave the stored connection intact and
			 * tell the user why, rather than mapping it to a generic error. */
			if (result.kind === "no_spaces") {
				return {
					success: false,
					error:
						"This API key no longer reaches any project space — it may have been revoked or had its access changed. Your saved connection is unchanged.",
				};
			}
			/* A refresh 401 can't be a copy/paste or wrong-server mistake — the
			 * stored key already verified once — so it means the key stopped
			 * being accepted (revoked, deactivated, or expired). */
			if (result.status === 401) {
				return {
					success: false,
					error:
						"CommCare HQ no longer accepts your stored API key — it may have been revoked or expired. Disconnect and reconnect with a new key.",
				};
			}
			return { success: false, error: settingsErrorMessage(result.status) };
		}
		return { success: true, settings: result.settings };
	} catch (err) {
		log.error("[settings/commcare] refresh error", err);
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
