"use server";

import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { declaresAndroid } from "@/lib/domain";
import { log } from "@/lib/logger";
import { OrganizationError } from "@/lib/organization/errors";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import { cczStandingOf, selectionsHeldFromHq } from "./downloadTarget";
import { getEntryPointLink } from "./entryPointLinks";
import {
	type EntryPointLink,
	getEntryPointLinkSchema,
} from "./entryPointTypes";
import { DeploymentAppDeletedError, DeploymentError } from "./errors";
import { previewDeploymentAnswerFor } from "./previewSpace";
import { firstPublishOf, leftBehindResources } from "./resources";
import type { CczUnavailable } from "./runtimeTarget";
import {
	currentResourceIdentities,
	deploymentKept,
	faultCode,
	type HeldDeploymentKept,
	holdDeploymentKept,
	type KeptReadAfter,
	keptFromHeld,
	landedDeploymentKept,
	landedFirstPublish,
	refreshDeployment,
	refreshKeptValues,
	setupArtifactFor,
	stopPublishing,
} from "./service";
import type { SetupArtifact } from "./setupArtifact";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	holdTargetFacts,
	readDeploymentsForApp,
	readFirstPublishStates,
	readReachedDeploymentTargets,
	withDeploymentReadSnapshot,
	withdrawDeploymentConfirmation,
} from "./store";
import {
	type CommCareServer,
	type DeploymentKept,
	type DeploymentResource,
	type DeploymentWithResources,
	deploymentAppIdSchema,
	deploymentTargetSchema,
	type PreviewDeploymentAnswer,
	provisionWorkersSchema,
	stopPublishingSchema,
	withdrawDeploymentConfirmationSchema,
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
	/**
	 * The settings this project space keeps in CommCare HQ at another value
	 * than a new app's, with the date Nova read them; an empty list still
	 * has its date. Null where the app's content is not there or Nova holds
	 * no read of it (none stored, an unread one, a shell's).
	 */
	readonly kept: DeploymentKept | null;
	/**
	 * What the first publish over an app Nova brought in, or the next publish
	 * after changes made in CommCare HQ were brought in, changes there, as the
	 * baseline keeps it, with the Web Apps line worked out from where the app
	 * runs now (`resources.ts::firstPublishOf`). Null where no list is kept or
	 * the live app mapping is not the one it was kept for.
	 */
	readonly firstPublish: FirstPublishView | null;
}

/**
 * A refresh's answer: the updated record, what Preview may now name for
 * `commcare_project`, and what that one project space keeps of the settings
 * Preview plays.
 *
 * The project space rides along because a refresh can CHANGE it: an
 * observation that finds the app gone walks the deployment back below
 * `uploaded`, at which point the server-side identity resolvers stop
 * naming that space. A client that kept its old value would make one
 * expression answer two ways depending on which side evaluated it, so the
 * same response that changes the record hands the client the new answer.
 * The facts follow the same rule for the same reason.
 *
 * `preview` is `null` where Nova could not read the answer just now: the
 * refresh's write has landed, so the tab keeps what it holds, and the
 * stream's deployment lane, which that write poked, brings the new answer.
 * `kept` is `unread` for the same reason (`service.ts::landedDeploymentKept`):
 * the card keeps the list it shows (`keptListModel.ts::refreshedViewToShow`),
 * and the next read of the records reads it again.
 */
export interface RefreshedDeploymentView
	extends Omit<DeploymentView, "kept" | "firstPublish"> {
	readonly kept: DeploymentKept | null | "unread";
	/** `unread` as `kept` is (`service.ts::landedFirstPublish`): the card keeps the list it shows. */
	readonly firstPublish: FirstPublishView | null | "unread";
	readonly preview: PreviewDeploymentAnswer | null;
}

export type DeploymentActionResult<T> =
	| { readonly success: true; readonly data: T }
	| {
			readonly success: false;
			readonly code:
				| "unauthenticated"
				| "not_found"
				| "invalid_input"
				/**
				 * The caller can see and edit the deployment and may not do this
				 * to it. The message names who may.
				 */
				| "not_permitted"
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
 * The committed blueprint plus the app's organization (its places and where
 * CommCare HQ manages them), from ONE snapshot read.
 *
 * The authoring snapshot already carries the organization beside the
 * blueprint, and the artifact needs both: reading them, throwing the
 * organization away, and re-running the same authorized transaction to read
 * it again was this module's most expensive no-op.
 */
async function committedDocWithOrganization(scope: DeploymentScope) {
	const snapshot = await readOrganizationAuthoringSnapshot({
		appId: scope.appId,
		projectId: scope.projectId,
		role: scope.role,
		actorUserId: scope.actorUserId,
	});
	return {
		doc: snapshot.blueprint,
		sourceSequence: snapshot.blueprintSeq,
		organization: snapshot.organization,
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
		const { doc, organization } = await committedDocWithOrganization(
			resolved.scope,
		);
		const refreshed = await refreshDeployment(
			resolved.scope,
			{ server: parsed.data.server, domain: parsed.data.domain },
			doc,
			organization,
		);
		if (refreshed === null) return notFound();
		return {
			success: true,
			data: await refreshedView(
				resolved.scope,
				refreshed.deployment,
				refreshed.artifact,
				doc,
				"check-status",
			),
		};
	} catch (error) {
		return failure(error, "refresh", resolved.scope);
	}
}

/**
 * A record as a refresh hands it back: the record, its setup notes, what it
 * left behind, its kept list, and what Preview may now name and play. The
 * refresh's write has landed by now, so neither the kept list nor Preview's
 * answer can turn it into a failure: each answers that it could not be read.
 */
async function refreshedView(
	scope: DeploymentScope,
	deployment: DeploymentWithResources,
	artifact: SetupArtifact,
	doc: CommittedDoc["doc"],
	after: KeptReadAfter,
): Promise<RefreshedDeploymentView> {
	const [identities, kept, preview, firstPublish] = await Promise.all([
		currentResourceIdentities(scope, doc),
		landedDeploymentKept(scope, deployment, after),
		previewDeploymentAnswerFor(scope),
		landedFirstPublish(scope, deployment, doc.appSettings.runsOnlyOn, after),
	]);
	return {
		deployment,
		artifact,
		leftBehind: leftBehindResources(deployment, identities),
		kept,
		firstPublish,
		preview,
	};
}

/** A kept refresh's outcome as the card reads it. */
export type KeptRefreshView =
	| {
			readonly kind: "refreshed" | "superseded";
			/** With `preview`, as Check status returns it. */
			readonly deployment: RefreshedDeploymentView;
	  }
	| {
			readonly kind:
				| "changed-in-hq"
				| "no-baseline"
				| "app-gone"
				| "unreadable"
				| "too-large"
				| "browser-only"
				| "key-not-accepted"
				| "no-permission"
				| "unavailable";
	  };

/**
 * Read again the settings this project space keeps in CommCare HQ, without
 * a publish (`service.ts::refreshKeptValues`). An edit, as Check status is:
 * it writes the baseline and reads CommCare HQ with the caller's own key,
 * and a key that is missing or cannot reach the project space is this
 * action's `success: false`.
 */
export async function refreshKeptValuesAction(input: {
	readonly appId: string;
	readonly server: CommCareServer;
	readonly domain: string;
}): Promise<DeploymentActionResult<KeptRefreshView>> {
	const parsed = deploymentTargetSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message: "That refresh request wasn't in a shape Nova understands.",
		};
	}
	const resolved = await resolveScope(parsed.data.appId, "edit");
	if (!resolved.ok) return resolved.result;
	try {
		const outcome = await refreshKeptValues(resolved.scope, {
			server: parsed.data.server,
			domain: parsed.data.domain,
		});
		if (outcome.kind !== "refreshed" && outcome.kind !== "superseded") {
			return { success: true, data: { kind: outcome.kind } };
		}
		const { doc, organization } = await committedDocWithOrganization(
			resolved.scope,
		);
		const artifact = await setupArtifactFor(
			resolved.scope,
			outcome.deployment,
			doc,
			organization,
		);
		return {
			success: true,
			data: {
				kind: outcome.kind,
				deployment: await refreshedView(
					resolved.scope,
					outcome.deployment,
					artifact,
					doc,
					"kept-refresh",
				),
			},
		};
	} catch (error) {
		return failure(error, "refresh kept values", resolved.scope);
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
		/* The records, their ledgers, every first-publish list and every kept
		 * list of one moment, for a caller allowed to see them then: a move or a
		 * stop that commits meanwhile is wholly before or wholly after. One
		 * deployment's kept facts at a time, on the snapshot's one connection,
		 * each list projected once the snapshot has given it back. */
		const { deployments, firstPublishStates, heldKept } =
			await withDeploymentReadSnapshot(
				resolved.scope,
				"view",
				async (snapshot) => {
					const deployments = await readDeploymentsForApp(snapshot);
					const heldKept = new Map<string, HeldDeploymentKept>();
					for (const deployment of deployments)
						heldKept.set(
							deployment.deployment.id,
							await holdDeploymentKept(snapshot, deployment),
						);
					return {
						deployments,
						firstPublishStates: await readFirstPublishStates(snapshot),
						heldKept,
					};
				},
			);
		const kept = new Map<string, DeploymentKept | null>(
			[...heldKept].map(([id, held]) => [id, keptFromHeld(held)]),
		);
		if (deployments.length === 0) return { success: true, data: [] };
		/* Read the document and its places ONCE. They belong to the app, not
		 * to any one project space, so building three artifacts must not cost
		 * three reads of the same rows. */
		const { doc, organization } = await committedDocWithOrganization(
			resolved.scope,
		);
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
						organization,
					),
					leftBehind: leftBehindResources(deployment, identities),
					kept: kept.get(deployment.deployment.id) ?? null,
					firstPublish: firstPublishOf(
						deployment,
						firstPublishStates.get(deployment.deployment.id),
						doc.appSettings.runsOnlyOn,
					),
				})),
			),
		};
	} catch (error) {
		return failure(error, "read", resolved.scope);
	}
}

/**
 * Withdraw what a person confirmed about a project space, so the next
 * publish there asks again. The confirmation's row is kept with who
 * withdrew it and when. An edit: it changes what the next publish does.
 */
export async function withdrawDeploymentConfirmationAction(
	input: unknown,
): Promise<DeploymentActionResult<DeploymentView>> {
	const parsed = withdrawDeploymentConfirmationSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message:
				"That request to withdraw a confirmation wasn't in a shape Nova understands.",
		};
	}
	const resolved = await resolveScope(parsed.data.appId, "edit");
	if (!resolved.ok) return resolved.result;
	try {
		const target = { server: parsed.data.server, domain: parsed.data.domain };
		const deployment = await withdrawDeploymentConfirmation(
			resolved.scope,
			target,
			parsed.data.confirmation,
		);
		const { doc, organization } = await committedDocWithOrganization(
			resolved.scope,
		);
		return {
			success: true,
			data: {
				deployment,
				artifact: await setupArtifactFor(
					resolved.scope,
					deployment,
					doc,
					organization,
				),
				leftBehind: leftBehindResources(
					deployment,
					await currentResourceIdentities(resolved.scope, doc),
				),
				kept: await deploymentKept(resolved.scope, deployment),
				firstPublish: await deploymentFirstPublish(
					resolved.scope,
					deployment,
					doc,
				),
			},
		};
	} catch (error) {
		return failure(error, "withdraw confirmation", resolved.scope);
	}
}

/**
 * A stop's answer. Every part of it is read after the ending committed, so
 * none of it can turn the stop into a failure: what cannot be read just now
 * is null, and the stop still answers as stopped.
 */
export interface StoppedPublishingView {
	/**
	 * The ended record as a card draws it. Null where Nova could not read it
	 * back after the ending landed: the surface reads its records again.
	 */
	readonly view: DeploymentView | null;
	/**
	 * What Preview names and plays now, the project space and its kept
	 * settings together, read as Check status reads it
	 * (`previewDeploymentAnswerFor`). An ending can take the project space
	 * away, or leave one other space for Preview to name. Null where it could
	 * not be read: the tab keeps what it holds, and the stream's deployment
	 * lane, which the ending poked, brings the answer.
	 */
	readonly preview: PreviewDeploymentAnswer | null;
}

/**
 * "Stop publishing here" (`service.ts::stopPublishing`): this app stops
 * publishing to one project space, and the app there stays as it is.
 *
 * The scope resolves at `edit`, as Check status does, so a viewer or a
 * stranger finds nothing to stop; an editor, who can see and publish to the
 * deployment, gets `not_permitted` with who may. The request names the HQ
 * app the person was looking at: a repeat of a stop that landed answers as
 * stopped, and a deployment that publishes to another HQ app now answers
 * `invalid_input` with the sentence that says so, having stopped nothing. A
 * failure is answered only for a stop that did not land; once the ending
 * commits, the answer is `success` whatever faults after it
 * (`StoppedPublishingView`).
 */
export async function stopPublishingAction(
	input: unknown,
): Promise<DeploymentActionResult<StoppedPublishingView>> {
	const parsed = stopPublishingSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			code: "invalid_input",
			message:
				"That request to stop publishing wasn't in a shape Nova understands.",
		};
	}
	const resolved = await resolveScope(parsed.data.appId, "edit");
	if (!resolved.ok) return resolved.result;
	let stopped: Awaited<ReturnType<typeof stopPublishing>>;
	let doc: CommittedDoc["doc"];
	try {
		const committed = await committedDocWithOrganization(resolved.scope);
		doc = committed.doc;
		stopped = await stopPublishing(
			resolved.scope,
			{ server: parsed.data.server, domain: parsed.data.domain },
			parsed.data.hqAppId,
			doc,
			committed.organization,
		);
	} catch (error) {
		return failure(error, "stop publishing", resolved.scope);
	}
	const [view, preview] = await Promise.all([
		stoppedView(resolved.scope, stopped, doc),
		previewDeploymentAnswerFor(resolved.scope),
	]);
	return { success: true, data: { view, preview } };
}

/**
 * The ended record as a card draws it, read after the ending landed, or null
 * where any of its reads faulted. Logged by the fault's class and code alone,
 * as `service.ts::landedDeploymentKept` logs one.
 */
async function stoppedView(
	scope: DeploymentScope,
	stopped: Awaited<ReturnType<typeof stopPublishing>>,
	doc: CommittedDoc["doc"],
): Promise<DeploymentView | null> {
	if (stopped.artifact === null) return null;
	try {
		const [identities, kept, firstPublish] = await Promise.all([
			currentResourceIdentities(scope, doc),
			deploymentKept(scope, stopped.deployment),
			deploymentFirstPublish(scope, stopped.deployment, doc),
		]);
		return {
			deployment: stopped.deployment,
			artifact: stopped.artifact,
			leftBehind: leftBehindResources(stopped.deployment, identities),
			kept,
			firstPublish,
		};
	} catch (error) {
		log.error(
			"[deployment] record unavailable after a stop landed",
			undefined,
			{
				appId: scope.appId,
				domain: stopped.deployment.deployment.domain,
				errorName: error instanceof Error ? error.name : typeof error,
				errorCode: faultCode(error),
			},
		);
		return null;
	}
}

/**
 * One project space this app is published to, as the publish dialog lists
 * it for a CCZ: whether one can be made there, and where not, why.
 */
export interface DownloadTargetOption extends DeploymentTargetKey {
	/** Why there is no CCZ for this project space; null where one can be made. */
	readonly unavailable: CczUnavailable | null;
}

/** The project spaces a CCZ of this app can be made for, as the dialog offers them. */
export interface DownloadTargetsView {
	readonly targets: readonly DownloadTargetOption[];
	/**
	 * With no target: one line per selection of the app CommCare HQ cannot
	 * take, which is why it can be published nowhere yet. Empty otherwise.
	 */
	readonly heldFromHq: readonly string[];
	/**
	 * The app does not declare Android, so it has no CCZ for any project
	 * space. `targets` and `heldFromHq` are then empty.
	 */
	readonly webAppsOnly: boolean;
}

/**
 * Which project spaces the publish dialog offers a CCZ for.
 *
 * The same ledger read and the same lines the two compile surfaces answer
 * from (`downloadTarget.ts`), and for each project space the standing the
 * download itself reads (`downloadTarget.ts::cczStandingOf`), from what
 * Nova holds of that space and nothing it asks CommCare HQ: one whose app in
 * CommCare HQ keeps a custom base URL elsewhere is listed with that reason,
 * so the person learns it before choosing rather than from the download.
 * The committed document is read first, because an app that does not
 * declare Android has no CCZ for any space. A read authorizes as a view.
 */
export async function readDownloadTargetsAction(
	input: unknown,
): Promise<DeploymentActionResult<DownloadTargetsView>> {
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
		const { doc } = await committedDocWithOrganization(resolved.scope);
		if (!declaresAndroid(doc)) {
			return {
				success: true,
				data: { targets: [], heldFromHq: [], webAppsOnly: true },
			};
		}
		/* The targets and each one's facts come from one snapshot, as the
		 * download's do, so a stop or a refresh committing meanwhile is wholly
		 * before the list or wholly after it; each standing is projected from
		 * the facts' bytes once the snapshot has given its connection back. */
		const held = await withDeploymentReadSnapshot(
			resolved.scope,
			"view",
			async (snapshot) => {
				const read = [];
				for (const target of await readReachedDeploymentTargets(snapshot))
					read.push({ target, facts: await holdTargetFacts(snapshot, target) });
				return read;
			},
		);
		const targets: DownloadTargetOption[] = held.map(
			({ target: { server, domain }, facts }) => ({
				server,
				domain,
				unavailable: cczStandingOf({ server, domain }, facts).unavailable,
			}),
		);
		if (targets.length > 0) {
			return {
				success: true,
				data: { targets, heldFromHq: [], webAppsOnly: false },
			};
		}
		return {
			success: true,
			data: {
				targets: [],
				heldFromHq: selectionsHeldFromHq(doc),
				webAppsOnly: false,
			},
		};
	} catch (error) {
		return failure(error, "read", resolved.scope);
	}
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
		const { doc, organization } = await committedDocWithOrganization(
			resolved.scope,
		);
		const outcome = await provisionWorkers({
			scope: resolved.scope,
			doc,
			locations: organization.locations,
			server: parsed.data.server,
			domain: parsed.data.domain,
			workers: parsed.data.workers,
			...(parsed.data.adoptPersonaUuids && {
				adoptPersonaUuids: parsed.data.adoptPersonaUuids,
			}),
			...(parsed.data.confirmWorkerLevels && {
				confirmWorkerLevels: parsed.data.confirmWorkerLevels,
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
			organization,
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

/** What `committedDocWithOrganization` hands back, so this file names it once. */
type CommittedDoc = Awaited<ReturnType<typeof committedDocWithOrganization>>;

/** One deployment's first-publish list as a view shows it (`resources.ts::firstPublishOf`). */
async function deploymentFirstPublish(
	scope: DeploymentScope,
	deployment: DeploymentWithResources,
	doc: CommittedDoc["doc"],
): Promise<FirstPublishView | null> {
	const states = await readFirstPublishStates(scope);
	return firstPublishOf(
		deployment,
		states.get(deployment.deployment.id),
		doc.appSettings.runsOnlyOn,
	);
}

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
	organization: CommittedDoc["organization"],
): Promise<ProvisionWorkersView["view"]> {
	if (deployment === null) return null;
	try {
		return {
			deployment,
			artifact: await setupArtifactFor(scope, deployment, doc, organization),
			leftBehind: leftBehindResources(
				deployment,
				await currentResourceIdentities(scope, doc),
			),
			kept: await deploymentKept(scope, deployment),
			firstPublish: await deploymentFirstPublish(scope, deployment, doc),
		};
	} catch (error) {
		/* The app went to recently deleted, or the caller lost it, during the
		 * call: there is no record of it to show them, which is expected, and
		 * the accounts go out either way. */
		if (error instanceof DeploymentError && error.code === "not_found")
			return null;
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
		/* A member whose app was deleted meanwhile is told so, not that it
		 * isn't available. */
		if (error instanceof DeploymentAppDeletedError)
			return { success: false, code: "not_found", message: error.message };
		if (error.code === "not_found") return notFound();
		return {
			success: false,
			code: error.code === "not_permitted" ? "not_permitted" : "invalid_input",
			message: error.message,
		};
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

/** Copy checks one released build; opening the URL remains HQ-authenticated. */
export async function getEntryPointLinkAction(
	input: unknown,
): Promise<DeploymentActionResult<EntryPointLink>> {
	const parsed = getEntryPointLinkSchema.safeParse(input);
	if (!parsed.success)
		return {
			success: false,
			code: "invalid_input",
			message: "Choose an entry point and provide its required case IDs.",
		};
	const resolved = await resolveScope(parsed.data.appId, "edit");
	if (!resolved.ok) return resolved.result;
	try {
		const { doc, sourceSequence } = await committedDocWithOrganization(
			resolved.scope,
		);
		return {
			success: true,
			data: await getEntryPointLink({
				scope: resolved.scope,
				target: { server: parsed.data.server, domain: parsed.data.domain },
				doc,
				sourceSequence,
				entryPointUuid: parsed.data.entryPointUuid,
				selections: parsed.data.selections,
			}),
		};
	} catch (error) {
		return failure(error, "check deep link", resolved.scope);
	}
}
