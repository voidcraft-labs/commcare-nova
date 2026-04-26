/**
 * OAuth client revocation Server Action. Mirrors the discriminated-
 * union pattern in `actions.ts` — never throws, always returns a
 * structured result, because Next.js surfaces unhandled Server Action
 * errors as full-page error boundaries.
 */

"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth-utils";
import { revokeAuthorizedClient } from "@/lib/db/oauth-consents";
import { log } from "@/lib/logger";

// ── Types ──────────────────────────────────────────────────────────

export type RevokeResult =
	| { success: true }
	| { success: false; error: string };

// ── Action ─────────────────────────────────────────────────────────

/**
 * Revoke a connected application's authorization. Ownership is
 * enforced inside `revokeAuthorizedClient`'s Firestore transaction —
 * a session check here alone would have a TOCTOU window. The optimistic
 * UI drives the user-visible refresh; `revalidatePath` is a correctness
 * backstop for a hard navigation.
 */
export async function revokeClientAccess(
	consentId: string,
): Promise<RevokeResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Authentication required." };
		}

		/* Server Actions deserialize JSON; the `string` annotation alone
		 * doesn't enforce type at runtime, so a malformed client could
		 * send anything. The guard maps that to the same missing-id
		 * branch the UI already handles. */
		if (typeof consentId !== "string" || !consentId.trim()) {
			return { success: false, error: "Missing consent identifier." };
		}

		await revokeAuthorizedClient(session.user.id, consentId);
		revalidatePath("/settings");
		return { success: true };
	} catch (err) {
		log.error("[settings/oauth] revoke error", err);
		return {
			success: false,
			error: "Could not revoke access. Please try again.",
		};
	}
}
