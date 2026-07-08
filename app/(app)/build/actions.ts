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
import { createApp, UNTITLED_APP_NAME } from "@/lib/db/apps";
import { surveyModuleMutations } from "@/lib/doc/scaffolds";
import { log } from "@/lib/logger";

/** Result of `createBlankApp`. Carries the new app's id so the client can navigate to it. */
export type CreateBlankAppResult =
	| { success: true; appId: string }
	| { success: false; error: string };

/**
 * Create the blank app — the starting point for a user who'd rather build
 * by hand than describe the app to the SA.
 *
 * "Blank" is a name plus ONE bare survey module, not an app with nothing in
 * it, and both halves are load-bearing:
 *
 *  - A nameless, moduleless app is a legal at-rest state (it's what the chat
 *    build and MCP `create_app` mint) but it is NOT export-ready — the
 *    boundary validator reports `EMPTY_APP_NAME` + `NO_MODULES`. Nova apps
 *    are always export-ready, so the blank app has to clear that bar the
 *    moment it exists.
 *  - A bare survey module is the smallest thing that clears it: every module
 *    rule is guarded on `caseType`, so a typeless, formless module
 *    introduces no finding. (Adding a case type instead would oblige forms,
 *    fields and case-list columns — see `lib/doc/scaffolds.ts`.)
 *
 * It is also what makes the builder render: `docHasData` is
 * `moduleOrder.length > 0`, so a moduleless app would land the user back on
 * the centered chat they just chose to skip.
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
				appName: UNTITLED_APP_NAME,
				status: "complete",
				seedMutations: (doc) => surveyModuleMutations(doc).mutations,
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
