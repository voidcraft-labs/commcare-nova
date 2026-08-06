"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { log } from "@/lib/logger";
import { OrganizationError } from "@/lib/organization/errors";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import { DeploymentError } from "./errors";
import { refreshDeployment } from "./service";
import type { SetupArtifact } from "./setupArtifact";
import type { DeploymentScope } from "./store";
import { type DeploymentWithResources, deploymentServerSchema } from "./types";

/**
 * The browser's refresh surface for deployments.
 *
 * Publishing itself stays on `/api/commcare/upload`, because it is one
 * long request whose warnings and feature-flag report the dialog already
 * consumes. Reading a deployment needs no action either: a publish
 * answers with the record, and the builder page resolves the Preview
 * target server-side. So this file holds exactly one operation, the one
 * the dialog's Check status button needs.
 *
 * Adoption is deliberately MCP-only (`adopt_hq_app`). It is the recovery
 * path for an app somebody imported by hand, and it needs the exact
 * CommCare HQ app id, which is not something the publish dialog asks for.
 *
 * Every argument is plain JSON on purpose. A `Map`, `Set`, or `File` in a
 * Server Action argument makes React encode the call as multipart, which
 * the WAF in front of Nova rejects outright.
 */

/** One deployment plus the setup instructions it currently implies. */
export interface DeploymentView {
	readonly deployment: DeploymentWithResources;
	readonly artifact: SetupArtifact;
}

export type DeploymentActionResult<T> =
	| { readonly success: true; readonly data: T }
	| {
			readonly success: false;
			readonly code:
				| "unauthenticated"
				| "not_found"
				| "invalid_input"
				| "conflict"
				| "unavailable";
			readonly message: string;
	  };

const appIdSchema = z.string().trim().min(1).max(255);

const targetInputSchema = z
	.object({
		appId: appIdSchema,
		server: deploymentServerSchema,
		domain: z.string().trim().min(1).max(255),
	})
	.strict();

/**
 * Refreshing WRITES the observed state, so it authorizes as an edit.
 *
 * Reading it as a view would let a viewer through the action and then
 * fail inside the store's `edit` check — and only for a deployment that
 * has actually been published, since refresh returns early otherwise. A
 * capability that depends on how far a deployment got is not a
 * capability.
 */
async function resolveScope(
	appId: string,
): Promise<
	| { readonly ok: true; readonly scope: DeploymentScope }
	| { readonly ok: false; readonly result: DeploymentActionResult<never> }
> {
	const session = await getSession();
	if (session === null) {
		return {
			ok: false,
			result: {
				success: false,
				code: "unauthenticated",
				message: "Sign in to check on this deployment.",
			},
		};
	}
	try {
		const access = await resolveAppScope(appId, session.user.id, "edit");
		return {
			ok: true,
			scope: {
				appId,
				projectId: access.projectId,
				role: access.role,
				actorUserId: session.user.id,
			},
		};
	} catch (error) {
		if (error instanceof AppAccessError) {
			return { ok: false, result: notFound() };
		}
		throw error;
	}
}

function notFound(): DeploymentActionResult<never> {
	return {
		success: false,
		code: "not_found",
		message:
			"That app isn't available, or you no longer have access to it. Reload to get the latest state.",
	};
}

function unavailable(): DeploymentActionResult<never> {
	return {
		success: false,
		code: "unavailable",
		message:
			"Nova couldn't check on this deployment just now. Try again in a moment.",
	};
}

/** The committed blueprint the artifact is derived from. */
async function committedDoc(scope: DeploymentScope) {
	const snapshot = await readOrganizationAuthoringSnapshot({
		appId: scope.appId,
		projectId: scope.projectId,
		role: scope.role,
		actorUserId: scope.actorUserId,
	});
	return snapshot.blueprint;
}

/**
 * Ask CommCare HQ again what has happened to a published app.
 *
 * Read-only against the target, and the only way a deployment moves past
 * `uploaded` — because Nova cannot make a build or release one with an
 * API key.
 */
export async function refreshDeploymentAction(
	input: unknown,
): Promise<DeploymentActionResult<DeploymentView>> {
	const parsed = targetInputSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message: "That deployment request wasn't in a shape Nova understands.",
		};
	}
	const resolved = await resolveScope(parsed.data.appId);
	if (!resolved.ok) return resolved.result;
	try {
		const doc = await committedDoc(resolved.scope);
		const refreshed = await refreshDeployment(
			resolved.scope,
			{ server: parsed.data.server, domain: parsed.data.domain },
			doc,
		);
		if (refreshed === null) return notFound();
		return { success: true, data: refreshed };
	} catch (error) {
		return failure(error, "refresh", resolved.scope);
	}
}

function failure(
	error: unknown,
	operation: string,
	scope: DeploymentScope,
): DeploymentActionResult<never> {
	if (
		error instanceof DeploymentError ||
		error instanceof AppAccessError ||
		(error instanceof OrganizationError && error.code === "not_found")
	) {
		return notFound();
	}
	log.error(`[deployment] ${operation} failed`, error, {
		appId: scope.appId,
		userId: scope.actorUserId,
	});
	return unavailable();
}
