"use server";

import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { log } from "@/lib/logger";
import { OrganizationError } from "@/lib/organization/errors";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import { DeploymentError } from "./errors";
import { previewProjectSpaceFor } from "./previewSpace";
import { leftBehindResources } from "./resources";
import {
	currentResourceIdentities,
	refreshDeployment,
	setupArtifactFor,
} from "./service";
import type { SetupArtifact } from "./setupArtifact";
import { type DeploymentScope, readDeploymentsForApp } from "./store";
import {
	type DeploymentResource,
	type DeploymentWithResources,
	deploymentAppIdSchema,
	deploymentTargetSchema,
	provisionWorkersSchema,
} from "./types";
import type {
	ProvisionedWorker,
	UnconfirmedWorker,
	WorkerProvisionRefusal,
} from "./workers";
import { provisionWorkers } from "./workers";

/**
 * The browser's refresh surface for deployments.
 *
 * Publishing itself stays on `/api/commcare/upload`, because it is one
 * long request whose warnings and compatibility report the dialog already
 * consumes. What is here is what a publish cannot answer: where the app
 * already stands when the dialog opens, and what CommCare HQ has done
 * since. Both outlive the request that created the record.
 *
 * Every argument is plain JSON on purpose. A `Map`, `Set`, or `File` in a
 * Server Action argument makes React encode the call as multipart, which
 * the WAF in front of Nova rejects outright.
 */

/** One deployment plus the setup instructions it currently implies. */
export interface DeploymentView {
	readonly deployment: DeploymentWithResources;
	readonly artifact: SetupArtifact;
	/**
	 * What an earlier publish left on the project space and this app no
	 * longer points at.
	 *
	 * Derived HERE rather than in the dialog, because telling a rename
	 * (something really is sitting there) from a recreate (nothing is)
	 * needs to know what each resource is called right now, which is a
	 * server-side read. It is also the same derivation MCP's `left_behind`
	 * uses, so the two surfaces cannot disagree about what is abandoned.
	 */
	readonly leftBehind: readonly DeploymentResource[];
}

/**
 * A refresh's answer: the updated record, and what Preview may now name
 * for `commcare_project`.
 *
 * The project space rides along because a refresh can CHANGE it: an
 * observation that finds the app gone walks the deployment back below
 * `uploaded`, at which point the server-side identity resolvers stop
 * naming that space. A client that kept its old value would make one
 * expression answer two ways depending on which side evaluated it, so the
 * same response that changes the record hands the client the new answer.
 */
export interface RefreshedDeploymentView extends DeploymentView {
	readonly previewProjectSpace: string | null;
}

export type DeploymentActionResult<T> =
	| { readonly success: true; readonly data: T }
	| {
			readonly success: false;
			readonly code:
				| "unauthenticated"
				| "not_found"
				| "invalid_input"
				| "unavailable";
			readonly message: string;
	  };

/* The wire shapes live with the vocabulary they validate, so the browser
 * and MCP cannot drift into accepting different things. */

/**
 * The capability is the caller's to state, because the two operations
 * here genuinely differ. Refreshing WRITES the observed state, so it is an
 * edit; reading changes nothing on the target, so a viewer may do it and
 * see exactly where the app stands.
 *
 * Refresh must not settle for `view` and let the store's `edit` check
 * refuse it later: that check is only reached for a deployment far enough
 * along to observe, so a viewer would be refused with two different
 * messages depending on how far the app had got, and a capability that
 * depends on that is not a capability.
 */
async function resolveScope(
	appId: string,
	capability: "view" | "edit",
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
		const access = await resolveAppScope(appId, session.user.id, capability);
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

/**
 * The committed blueprint plus the app's places, from ONE snapshot read.
 *
 * The authoring snapshot already carries the locations beside the
 * blueprint, and the artifact needs both: reading them, throwing the
 * locations away, and re-running the same authorized transaction to read
 * them again was this module's most expensive no-op.
 */
async function committedDocWithLocations(scope: DeploymentScope) {
	const snapshot = await readOrganizationAuthoringSnapshot({
		appId: scope.appId,
		projectId: scope.projectId,
		role: scope.role,
		actorUserId: scope.actorUserId,
	});
	return {
		doc: snapshot.blueprint,
		locations: snapshot.organization.locations,
	};
}

/**
 * Ask CommCare HQ again what has happened to a published app.
 *
 * Read-only against the target, and the only way a deployment moves past
 * `uploaded`: Nova cannot make a build or release one with an API key.
 */
export async function refreshDeploymentAction(
	input: unknown,
): Promise<DeploymentActionResult<RefreshedDeploymentView>> {
	const parsed = deploymentTargetSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message: "That deployment request wasn't in a shape Nova understands.",
		};
	}
	const resolved = await resolveScope(parsed.data.appId, "edit");
	if (!resolved.ok) return resolved.result;
	try {
		const { doc, locations } = await committedDocWithLocations(resolved.scope);
		const refreshed = await refreshDeployment(
			resolved.scope,
			{ server: parsed.data.server, domain: parsed.data.domain },
			doc,
			locations,
		);
		if (refreshed === null) return notFound();
		return {
			success: true,
			data: {
				...refreshed,
				leftBehind: leftBehindFor(
					refreshed.deployment,
					await currentResourceIdentities(resolved.scope, doc),
				),
				previewProjectSpace: await previewProjectSpaceFor(resolved.scope),
			},
		};
	} catch (error) {
		return failure(error, "refresh", resolved.scope);
	}
}

/**
 * Where this app already stands on every project space it has reached.
 *
 * The publish dialog opens on this rather than on a blank form, because
 * the record outlives the publish that made it: somebody who published
 * yesterday, made the build on CommCare HQ, and came back today needs
 * Check status, and without this the only route to it would be
 * publishing the app all over again just to see where things stand. The
 * records are also what tells the dialog whether the selected project
 * space gets an in-place update or a fresh app. A read authorizes as a
 * view; reading a target changes nothing on it.
 */
export async function readDeploymentsAction(
	input: unknown,
): Promise<DeploymentActionResult<readonly DeploymentView[]>> {
	const parsed = deploymentAppIdSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message: "That app request wasn't in a shape Nova understands.",
		};
	}
	const resolved = await resolveScope(parsed.data, "view");
	if (!resolved.ok) return resolved.result;
	try {
		const deployments = await readDeploymentsForApp(resolved.scope);
		if (deployments.length === 0) return { success: true, data: [] };
		/* Read the document and its places ONCE. They belong to the app, not
		 * to any one project space, so building three artifacts must not cost
		 * three reads of the same rows. */
		const { doc, locations } = await committedDocWithLocations(resolved.scope);
		/* Also once: the names belong to the app's tables, not to any one
		 * project space, and `null` means Nova could not tell. */
		const identities = await currentResourceIdentities(resolved.scope, doc);
		return {
			success: true,
			data: await Promise.all(
				deployments.map(async (deployment) => ({
					deployment,
					artifact: await setupArtifactFor(
						resolved.scope,
						deployment,
						doc,
						locations,
					),
					leftBehind: leftBehindFor(deployment, identities),
				})),
			),
		};
	} catch (error) {
		return failure(error, "read", resolved.scope);
	}
}

/**
 * One deployment's left-behind list, or nothing when Nova could not tell.
 *
 * `null` identities means the Project read was unavailable, which is NOT
 * the same as every table having been deleted. Falling back to apps only
 * keeps the honest half of the answer rather than sending somebody to
 * CommCare HQ after tables that are perfectly fine.
 */
function leftBehindFor(
	deployment: DeploymentWithResources,
	identities: ReadonlyMap<string, string> | null,
): readonly DeploymentResource[] {
	return identities === null
		? deployment.superseded.filter((resource) => resource.kind === "app")
		: leftBehindResources(deployment, identities);
}

/**
 * What one provisioning call gives the screen back.
 *
 * The refusal and the workers travel TOGETHER rather than as a
 * discriminated pair, because a call that stopped halfway has both: three
 * real accounts whose passwords exist only in this answer, and a sentence
 * about the fourth. A shape that made them exclusive would make throwing
 * the passwords away the easy thing to do.
 */
export interface ProvisionWorkersView {
	readonly refusal: WorkerProvisionRefusal | null;
	readonly workers: readonly ProvisionedWorker[];
	/**
	 * The accounts CommCare HQ may or may not have made, with their
	 * passwords. On the view for the same reason `workers` is: the screen
	 * is the only place these will ever appear.
	 */
	readonly unconfirmed: readonly UnconfirmedWorker[];
	/**
	 * The deployment as it stands now, in the same shape the dialog already
	 * renders, so a call that made accounts redraws that project space's
	 * card without a second round trip. Null when nothing was written.
	 */
	readonly view: DeploymentView | null;
}

/**
 * Make mobile workers for this app's personas on a project space.
 *
 * An explicit act rather than part of publishing: it creates accounts for
 * named people and hands back a password for each new one, which is not
 * something a publish should do on the way past. Authorizes as an EDIT —
 * it writes to CommCare HQ and to the ownership ledger.
 *
 * The passwords in the answer are the only copies. Nova stores none of
 * them, and this action is the one moment they exist outside CommCare HQ.
 */
export async function provisionWorkersAction(
	input: unknown,
): Promise<DeploymentActionResult<ProvisionWorkersView>> {
	const parsed = provisionWorkersSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message: "That worker request wasn't in a shape Nova understands.",
		};
	}
	const resolved = await resolveScope(parsed.data.appId, "edit");
	if (!resolved.ok) return resolved.result;
	try {
		const { doc, locations } = await committedDocWithLocations(resolved.scope);
		const outcome = await provisionWorkers({
			scope: resolved.scope,
			doc,
			locations,
			server: parsed.data.server,
			domain: parsed.data.domain,
			workers: parsed.data.workers,
			...(parsed.data.adoptPersonaUuids && {
				adoptPersonaUuids: parsed.data.adoptPersonaUuids,
			}),
		});
		/* Everything after this point is REPORTING, and none of it may cost
		 * the answer. The accounts are on CommCare HQ and their passwords
		 * exist nowhere but `outcome.workers` — an artifact read or a
		 * left-behind read that throws would land in the catch below and
		 * hand back a failure, destroying the only copy of credentials for
		 * accounts that now exist. So the view is built inside its own
		 * guard and degrades to null. */
		const view = await provisionedView(
			resolved.scope,
			outcome.deployment,
			doc,
			locations,
		);
		return {
			success: true,
			data: {
				refusal: outcome.refusal,
				workers: outcome.workers,
				unconfirmed: outcome.unconfirmed,
				view,
			},
		};
	} catch (error) {
		return failure(error, "provision workers", resolved.scope);
	}
}

/** What `committedDocWithLocations` hands back, so this file names it once. */
type CommittedDoc = Awaited<ReturnType<typeof committedDocWithLocations>>;

/** The record `provisionWorkers` reports, which may be absent. */
type ProvisionWorkersOutcomeDeployment = Awaited<
	ReturnType<typeof provisionWorkers>
>["deployment"];

/**
 * The deployment view to show beside a provisioning answer, or nothing.
 *
 * Its two reads are the app's setup artifact and the left-behind report,
 * both of which reach Postgres. Neither is worth a generated password: by
 * the time they run the accounts exist, and the answer being assembled is
 * the only place their credentials will ever be. So a failure here is
 * recorded and the panel simply shows no refreshed record — one click of
 * Check restores it, which is not true of a password nobody wrote down.
 */
async function provisionedView(
	scope: DeploymentScope,
	deployment: ProvisionWorkersOutcomeDeployment,
	doc: CommittedDoc["doc"],
	locations: CommittedDoc["locations"],
): Promise<ProvisionWorkersView["view"]> {
	if (deployment === null) return null;
	try {
		return {
			deployment,
			artifact: await setupArtifactFor(scope, deployment, doc, locations),
			leftBehind: leftBehindFor(
				deployment,
				await currentResourceIdentities(scope, doc),
			),
		};
	} catch (error) {
		log.error("[deployment] provisioning view could not be built", error, {
			appId: scope.appId,
		});
		return null;
	}
}

function failure(
	error: unknown,
	operation: string,
	scope: DeploymentScope,
): DeploymentActionResult<never> {
	/* An expected rejection already says what happened in the author's
	 * words: a key on the wrong CommCare server, a project space it cannot
	 * reach. Replacing that with "Nova couldn't check just now" would ask
	 * somebody to retry a thing that will never work. */
	if (error instanceof DeploymentError) {
		return error.code === "not_found"
			? notFound()
			: { success: false, code: "invalid_input", message: error.message };
	}
	if (
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
