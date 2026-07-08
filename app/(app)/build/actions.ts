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
import { getSession, resolveActiveProjectId } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { createApp } from "@/lib/db/apps";
import { BLANK_APP_NAME, blankAppMutations } from "@/lib/doc/scaffolds";
import { log } from "@/lib/logger";

/** Result of `createBlankApp`. Carries the new app's id so the client can navigate to it. */
export type CreateBlankAppResult =
	| { success: true; appId: string }
	| { success: false; error: string };

/**
 * Create the blank app — the starting point for a user who'd rather build
 * by hand than describe the app to the SA.
 *
 * "Blank" is `BLANK_APP_NAME` plus `blankAppMutations`, not an app with
 * nothing in it: a nameless, moduleless app is a legal at-rest state (it's
 * what the chat build and MCP `create_app` mint) but it is NOT export-ready,
 * and there is no SA run here to finish it. `createApp` enforces that —
 * a template whose app couldn't be exported throws. See `lib/doc/scaffolds.ts`
 * for why one bare survey module is the smallest thing that clears the bar.
 *
 * Born `complete` with no run behind it, so nothing to charge, reserve or
 * finalize — the credit ledger only meters generation.
 */
export async function createBlankApp(): Promise<CreateBlankAppResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Authentication required." };
		}

		/* `resolveActiveProjectId` only proves the caller can VIEW the active
		 * Project — a viewer must not create apps in it. Same gate, same
		 * ordering as the chat route's app-minting path. */
		const projectId = await resolveActiveProjectId(session);
		try {
			await resolveProjectAccess(session.user.id, projectId, "edit");
		} catch (err) {
			if (err instanceof AppAccessError) {
				return {
					success: false,
					error: "You don't have permission to create apps in this Project.",
				};
			}
			throw err;
		}

		const appId = await createApp(
			session.user.id,
			projectId,
			crypto.randomUUID(),
			{
				appName: BLANK_APP_NAME,
				status: "complete",
				seedMutations: blankAppMutations,
			},
		);

		revalidatePath("/");
		return { success: true, appId };
	} catch (err) {
		log.error("[build/create-blank-app] error", err);
		return {
			success: false,
			error: "Could not create the app. Please try again.",
		};
	}
}
