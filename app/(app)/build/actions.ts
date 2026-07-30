/**
 * Server Actions for the builder's new-app screen.
 *
 * Mirrors the discriminated-union pattern in `(site)/app-actions.ts`:
 * never throws, always returns a structured result. An unhandled Server
 * Action error becomes a full-page error boundary, which would tear down
 * the live chat session sitting next to this affordance.
 */

"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { createApp } from "@/lib/db/apps";
import { CommitReauthError } from "@/lib/db/commitGuard";
import { log } from "@/lib/logger";

/** Result of `createStarterApp`. Carries the new app's id so the client can navigate to it. */
export type CreateStarterAppResult =
	| { success: true; appId: string }
	| { success: false; error: string };

/**
 * Create the canonical starter — the starting point for a user who'd rather
 * build from scratch than describe the app to the SA.
 *
 * `createApp` supplies the universal canonical starter: a real `Untitled` name
 * plus one survey module, survey form, and text question. Chat, builder, and MCP
 * creation all enter through that same genesis owner; no persisted pre-starter
 * app exists.
 *
 * Born `complete` with no run behind it, so nothing to charge, reserve or
 * finalize — the credit ledger only meters generation.
 */
export async function createStarterApp(
	expectedProjectId: string,
): Promise<CreateStarterAppResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Authentication required." };
		}
		if (
			typeof expectedProjectId !== "string" ||
			!expectedProjectId.trim() ||
			expectedProjectId.length > 255
		) {
			return { success: false, error: "Reload the page and try again." };
		}

		/* The page captured this Project when it rendered `/build/new`. A different
		 * tab may have switched the session's active Project since then, so creation
		 * authorizes and writes the captured id directly instead of re-resolving a
		 * mutable cookie. */
		try {
			await resolveProjectAccess(session.user.id, expectedProjectId, "edit");
		} catch (err) {
			if (err instanceof AppAccessError) {
				return {
					success: false,
					error: "You don't have permission to create apps in this Project.",
				};
			}
			throw err;
		}

		let appId: string;
		try {
			const receipt = await createApp(
				session.user.id,
				expectedProjectId,
				crypto.randomUUID(),
				{
					status: "complete",
				},
			);
			appId = receipt.appId;
		} catch (err) {
			if (err instanceof CommitReauthError) {
				return {
					success: false,
					error: "You don't have permission to create apps in this Project.",
				};
			}
			throw err;
		}

		revalidatePath("/");
		return { success: true, appId };
	} catch (err) {
		log.error("[build/create-starter-app] error", err);
		return {
			success: false,
			error: "Could not create the app. Please try again.",
		};
	}
}
