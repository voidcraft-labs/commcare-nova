"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { log } from "@/lib/logger";
import { OrganizationError } from "@/lib/organization/errors";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import { DeploymentError } from "./errors";
import { adoptRemoteApp, refreshDeployment, setupArtifactFor } from "./service";
import type { SetupArtifact } from "./setupArtifact";
import type { DeploymentScope } from "./store";
import { readDeploymentsForApp } from "./store";
import {
	type DeploymentWithResources,
	deploymentServerSchema,
	hqAppIdSchema,
} from "./types";

/**
 * The browser's read and refresh surface for deployments.
 *
 * Publishing itself stays on `/api/commcare/upload`, because it is one
 * long request whose warnings and feature-flag report the dialog already
 * consumes. These are the operations around it: see what a target
 * currently holds, ask CommCare HQ again, and attach a deployment to an
 * app that is already there.
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

const listInputSchema = z.object({ appId: appIdSchema }).strict();

const targetInputSchema = z
	.object({
		appId: appIdSchema,
		server: deploymentServerSchema,
		domain: z.string().trim().min(1).max(255),
	})
	.strict();

const adoptInputSchema = targetInputSchema.extend({
	hqAppId: hqAppIdSchema,
});

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
				message: "Sign in to see where this app is published.",
			},
		};
	}
	try {
		const access = await resolveAppScope(appId, session.user.id, "view");
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

/** Every project space this app has been published to. */
export async function listDeploymentsAction(
	input: unknown,
): Promise<DeploymentActionResult<readonly DeploymentView[]>> {
	const parsed = listInputSchema.safeParse(input);
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
		const deployments = await readDeploymentsForApp(resolved.scope);
		const views = await Promise.all(
			deployments.map(async (deployment) => ({
				deployment,
				artifact: await setupArtifactFor(resolved.scope, deployment, doc),
			})),
		);
		return { success: true, data: views };
	} catch (error) {
		return failure(error, "list", resolved.scope);
	}
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

/**
 * Attach this app's deployment to an app that is already on CommCare HQ.
 *
 * Always explicit: the caller names the exact CommCare HQ app id. Nova
 * never matches by name, so an app called the same thing on the target is
 * never adopted by accident.
 */
export async function adoptRemoteAppAction(
	input: unknown,
): Promise<DeploymentActionResult<DeploymentView>> {
	const parsed = adoptInputSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message:
				parsed.error.issues[0]?.message ??
				"That CommCare HQ app id wasn't in a shape Nova understands.",
		};
	}
	const session = await getSession();
	if (session === null) {
		return {
			success: false,
			code: "unauthenticated",
			message: "Sign in to connect this app to CommCare HQ.",
		};
	}
	let scope: DeploymentScope;
	try {
		const access = await resolveAppScope(
			parsed.data.appId,
			session.user.id,
			"edit",
		);
		scope = {
			appId: parsed.data.appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: session.user.id,
		};
	} catch (error) {
		if (error instanceof AppAccessError) return notFound();
		throw error;
	}
	try {
		const deployment = await adoptRemoteApp(
			scope,
			{ server: parsed.data.server, domain: parsed.data.domain },
			parsed.data.hqAppId,
		);
		const doc = await committedDoc(scope);
		return {
			success: true,
			data: {
				deployment,
				artifact: await setupArtifactFor(scope, deployment, doc),
			},
		};
	} catch (error) {
		if (error instanceof DeploymentError && error.code === "already_mapped") {
			return { success: false, code: "conflict", message: error.message };
		}
		return failure(error, "adopt", scope);
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
