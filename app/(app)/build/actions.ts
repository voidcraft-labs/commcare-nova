/**
 * Server Actions for the builder's new-app screen.
 *
 * Mirrors the discriminated-union pattern in `(site)/app-actions.ts`:
 * never throws, always returns a structured result. An unhandled Server
 * Action error becomes a full-page error boundary, which would tear down
 * the live chat session sitting next to this affordance.
 */

"use server";

import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { createExplicitBlankApp, genesisBatchId } from "@/lib/db/appGenesis";
import { CommitReauthError } from "@/lib/db/commitGuard";
import { toRscSerializableDoc } from "@/lib/doc/ownRecords";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { log } from "@/lib/logger";

/**
 * The one-shot creation receipt, byte-identical in shape to the
 * `data-app-materialized` frame the chat route emits when a design build's
 * first meaningful workflow commits.
 *
 * Nova has exactly two ways an app is born — `explicit-blank` (this action)
 * and `design-slice` (materialization) — and both hand the client the same
 * thing: identity, the Project capability the SERVER resolved (never one the
 * client asserted), the exact sequence-1 blueprint with its canonical
 * digest, and the cursor multiplayer must start from. Keeping one shape is
 * what lets one client-side installer serve both, so a new app can never
 * land two different ways. `ChatContainer.parseAppMaterializationReceipt`
 * is the strict boundary that admits it, and it accepts this key set
 * exactly. The blank path has no design lineage or change set, so those
 * slots are explicit nulls, and `starter` names the canonical
 * Survey/Form/Question identities only this path guarantees.
 */
export interface CreatedAppReceiptPayload {
	readonly eventVersion: 1;
	readonly designSessionId: null;
	readonly appId: string;
	readonly projectId: string;
	readonly role: string;
	readonly canEdit: boolean;
	readonly seq: 1;
	readonly batchId: string;
	readonly changeSetId: null;
	readonly snapshotDigest: string;
	readonly blueprint: PersistableDoc;
	readonly starter: {
		readonly moduleUuid: string;
		readonly formUuid: string;
		readonly fieldUuid: string;
	};
}

/** Result of `createStarterApp`. Carries the whole creation receipt, not just
 *  the id: the caller installs the app in place rather than navigating to it. */
export type CreateStarterAppResult =
	| { success: true; receipt: CreatedAppReceiptPayload }
	| { success: false; error: string };

/**
 * Create the canonical starter: the starting point for a user who'd rather
 * build from scratch than describe the app to the SA.
 *
 * `createApp` supplies the universal canonical starter: a real `Untitled` name
 * plus one survey module, survey form, and text question. Chat, builder, and MCP
 * creation all enter through that same genesis owner; no persisted pre-starter
 * app exists.
 *
 * Born `complete` with no run behind it, so nothing to charge, reserve or
 * finalize: the credit ledger only meters generation.
 *
 * Returns the whole creation receipt so the caller can install the app without
 * leaving the page. The builder is a single-page app: a route change here would
 * remount the entire builder tree under a new `key={buildId}`, throwing away a
 * live chat session and the brand handoff mid-gesture, to arrive at state the
 * client already holds.
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
		let role: string;
		try {
			const access = await resolveProjectAccess(
				session.user.id,
				expectedProjectId,
				"edit",
			);
			role = access.role;
		} catch (err) {
			if (err instanceof AppAccessError) {
				return {
					success: false,
					error: "You don't have permission to create apps in this Project.",
				};
			}
			throw err;
		}

		let payload: CreatedAppReceiptPayload;
		try {
			const receipt = await createExplicitBlankApp(
				session.user.id,
				expectedProjectId,
				crypto.randomUUID(),
				{
					status: "complete",
				},
			);
			payload = {
				eventVersion: 1,
				designSessionId: null,
				appId: receipt.appId,
				projectId: expectedProjectId,
				role,
				/* The capability the gate above resolved, never one the caller sent. */
				canEdit: roleAllowsApp(role, "edit"),
				seq: receipt.baseSeq,
				batchId: genesisBatchId(receipt.appId),
				changeSetId: null,
				snapshotDigest: receipt.snapshotDigest,
				/* React Flight can't carry the null-prototype records the reducer
				 * builds, and the client normalizes what it receives anyway. */
				blueprint: toRscSerializableDoc(receipt.blueprint),
				starter: receipt.starter,
			};
		} catch (err) {
			if (err instanceof CommitReauthError) {
				return {
					success: false,
					error: "You don't have permission to create apps in this Project.",
				};
			}
			throw err;
		}

		/* Deliberately no `revalidatePath("/")`, unlike the app-list actions.
		 * The router re-render that carries a revalidation restores Next's own
		 * canonical URL, undoing the promotion to `/build/{id}` this receipt
		 * exists to make — and running it afterwards instead leaves a second
		 * history entry, so Back lands in the builder rather than on the list.
		 * The client marks the list stale instead (`lib/ui/appListFreshness`). */
		return { success: true, receipt: payload };
	} catch (err) {
		log.error("[build/create-starter-app] error", err);
		return {
			success: false,
			error: "Could not create the app. Please try again.",
		};
	}
}
