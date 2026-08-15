/**
 * Server Action for the Designs-in-progress section: discard a pre-app design
 * (§15.10).
 *
 * Same discipline as the app-list actions: never throws, always returns a
 * structured result, because Next surfaces an unhandled Server Action error as
 * a full-page error boundary, which would tear the section's confirmation
 * state down mid-flight.
 *
 * The caller sends only the design-session id. Its Project is resolved
 * server-side through the shared generation-target resolver, so a forged or
 * stale Project id cannot be presented, and every denial — unknown id, another
 * tenant's id, an under-privileged member — collapses to the same not-found
 * message.
 */

"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	AppProjectChangedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import {
	DesignSessionBusyError,
	DesignSessionStateError,
	discardDesignSession,
} from "@/lib/db/designSessions";
import { resolveGenerationTargetScope } from "@/lib/db/generationTargetScope";
import { log } from "@/lib/logger";

export type DiscardDesignResult =
	| { success: true }
	| { success: false; error: string };

const NOT_FOUND = "This design is no longer here.";

export async function discardDesign(
	designSessionId: string,
): Promise<DiscardDesignResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Authentication required." };
		}
		/* Server Actions deserialize JSON, so the `string` annotation is not a
		 * runtime guarantee — the trim guard is real. */
		if (typeof designSessionId !== "string" || !designSessionId.trim()) {
			return { success: false, error: "Missing design identifier." };
		}

		const scope = await resolveGenerationTargetScope(
			{ kind: "design-session", designSessionId },
			session.user.id,
			"edit",
		);
		await discardDesignSession(
			designSessionId,
			session.user.id,
			scope.projectId,
		);
		revalidatePath("/");
		return { success: true };
	} catch (err) {
		if (err instanceof DesignSessionBusyError) {
			/* The honest refusal: a run still owns this design, and its own
			 * message already names what to do about it. */
			return { success: false, error: err.message };
		}
		if (err instanceof DesignSessionStateError) {
			return {
				success: false,
				error: err.reason === "not_found" ? NOT_FOUND : err.message,
			};
		}
		if (
			err instanceof AppAccessError ||
			err instanceof CommitReauthError ||
			err instanceof AppProjectChangedError
		) {
			return { success: false, error: NOT_FOUND };
		}
		log.error("[home/discard-design] error", err);
		return {
			success: false,
			error:
				"Nova couldn't discard this design. Check your connection and try again.",
		};
	}
}
