import "server-only";

import { type Selectable, sql, type Transaction } from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import type { CommCareServer } from "@/lib/commcare/servers";
import {
	type AppDatabase,
	type AppDeploymentResourcesTable,
	type AppDeploymentsTable,
	getAppDb,
	notifyAppDeployments,
	withAppTx,
} from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { deploymentNotFound } from "./errors";
import {
	applyAttemptOutcome,
	applyObservation,
	applyPhaseOutcome,
	clearObservationOutcomes,
} from "./stateMachine";
import {
	type DeploymentPhase,
	type DeploymentPhaseOutcome,
	type DeploymentPhaseOutcomes,
	type DeploymentRecord,
	type DeploymentResource,
	type DeploymentResourceKind,
	type DeploymentResourceOwnership,
	type DeploymentWithResources,
	type DrivenDeploymentPhase,
	deploymentPhaseOutcomesSchema,
	deploymentPhaseSchema,
	deploymentResourceKindSchema,
	deploymentResourceOwnershipSchema,
	deploymentStateSchema,
	isDeploymentServer,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "./types";

/**
 * An authorized handle on one app's deployments.
 *
 * Built server-side from a freshly authorized app row, never from a
 * client-asserted app or Project id. The Project is the tenant; the role
 * is the authority; `actorUserId` is attribution and never a filter,
 * because every member of an app's Project shares its deployments the
 * same way they share its case rows.
 */
export interface DeploymentScope {
	readonly appId: string;
	readonly projectId: string;
	readonly role: string;
	readonly actorUserId: string;
}

/** Which CommCare HQ project space a deployment addresses. */
export interface DeploymentTargetKey {
	readonly server: CommCareServer;
	readonly domain: string;
}

/**
 * Take the app row, then re-prove the caller against the Project the lock
 * just froze.
 *
 * This is `lib/db`'s existing app-first lock prefix, not a new one: a
 * deployment write and a blueprint commit serialize on the same app row
 * rather than racing. An authorization decided before the lock is
 * worthless if the app changed tenant in between, so the Project is
 * compared again here and the role is re-read rather than trusted from
 * the scope.
 */
async function lockAppForDeploymentWrite(
	tx: Transaction<AppDatabase>,
	scope: DeploymentScope,
	capability: AppCapability,
): Promise<void> {
	const app = await tx
		.selectFrom("apps")
		.select(["project_id", "deleted_at"])
		.where("id", "=", scope.appId)
		.forShare()
		.executeTakeFirst();

	// A missing app, a soft-deleted app, and an app that moved out from
	// under the caller's snapshot collapse to one shape on purpose.
	if (
		app === undefined ||
		app.deleted_at !== null ||
		app.project_id === null ||
		app.project_id !== scope.projectId
	) {
		throw deploymentNotFound();
	}

	const role = await projectRoleForInTransaction(
		tx,
		scope.actorUserId,
		app.project_id,
	);
	if (role === null || !roleAllowsApp(role, capability)) {
		throw deploymentNotFound();
	}
}

function isoOrNull(value: Date | null): string | null {
	return value === null ? null : value.toISOString();
}

function numberOrNull(value: string | number | null): number | null {
	if (value === null) return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Turn a stored row into a record, reasserting every closed vocabulary.
 *
 * The `state`, `resume_phase`, `server`, `kind`, and `ownership` columns
 * are `text` with CHECK constraints in Postgres, so the database already
 * refuses a value outside the set. Parsing them again here is what keeps
 * TypeScript's narrower types honest without a cast, and what makes a
 * future vocabulary change fail loudly at the read instead of flowing
 * into a switch that silently has no arm for it.
 */
function toDeploymentRecord(
	row: Selectable<AppDeploymentsTable>,
): DeploymentRecord {
	if (!isDeploymentServer(row.server)) {
		throw new Error(
			`Deployment ${row.id} names CommCare server "${row.server}", which Nova does not know.`,
		);
	}
	const phases = deploymentPhaseOutcomesSchema.safeParse({
		...NO_DEPLOYMENT_PHASE_OUTCOMES,
		...(row.phases as Record<string, unknown>),
	});
	if (!phases.success) {
		throw new Error(
			`Deployment ${row.id} stored phase outcomes Nova could not read back: ${phases.error.issues[0]?.message ?? "unknown shape"}`,
		);
	}
	const state = deploymentStateSchema.safeParse(row.state);
	if (!state.success) {
		throw new Error(
			`Deployment ${row.id} is stored in state "${row.state}", which Nova does not know.`,
		);
	}
	const resumePhase =
		row.resume_phase === null
			? null
			: deploymentPhaseSchema.safeParse(row.resume_phase);
	if (resumePhase !== null && !resumePhase.success) {
		throw new Error(
			`Deployment ${row.id} resumes at phase "${row.resume_phase}", which Nova does not know.`,
		);
	}
	return {
		id: row.id,
		appId: row.app_id,
		projectId: row.project_id,
		server: row.server,
		domain: row.domain,
		state: state.data,
		resumePhase: resumePhase === null ? null : resumePhase.data,
		phases: phases.data,
		createdBy: row.created_by,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
		lastObservedAt: isoOrNull(row.last_observed_at),
	};
}

function toDeploymentResource(
	row: Selectable<AppDeploymentResourcesTable>,
): DeploymentResource {
	const kind = deploymentResourceKindSchema.safeParse(row.kind);
	if (!kind.success) {
		throw new Error(
			`A deployment names a "${row.kind}" resource, which Nova does not know.`,
		);
	}
	const ownership = deploymentResourceOwnershipSchema.safeParse(row.ownership);
	if (!ownership.success) {
		throw new Error(
			`A deployment records "${row.ownership}" ownership, which Nova does not know.`,
		);
	}
	return {
		deploymentId: row.deployment_id,
		kind: kind.data,
		novaResourceId: row.nova_resource_id,
		remoteId: row.remote_id,
		ownership: ownership.data,
		pushedIdentity: row.pushed_identity,
		adoptedAt: isoOrNull(row.adopted_at),
		adoptedBy: row.adopted_by,
		pushedRevision: numberOrNull(row.pushed_revision),
		pushedAt: isoOrNull(row.pushed_at),
		remoteRevision: numberOrNull(row.remote_revision),
		remoteObservedAt: isoOrNull(row.remote_observed_at),
		supersededAt: isoOrNull(row.superseded_at),
	};
}

function partitionResources(
	rows: readonly Selectable<AppDeploymentResourcesTable>[],
): Pick<DeploymentWithResources, "active" | "superseded"> {
	const mapped = rows.map(toDeploymentResource);
	return {
		active: mapped.filter((resource) => resource.supersededAt === null),
		superseded: mapped.filter((resource) => resource.supersededAt !== null),
	};
}

async function loadResources(
	db: Pick<Transaction<AppDatabase>, "selectFrom">,
	deploymentIds: readonly string[],
): Promise<Map<string, Selectable<AppDeploymentResourcesTable>[]>> {
	const byDeployment = new Map<
		string,
		Selectable<AppDeploymentResourcesTable>[]
	>();
	if (deploymentIds.length === 0) return byDeployment;
	const rows = await db
		.selectFrom("app_deployment_resources")
		.selectAll()
		.where("deployment_id", "in", [...deploymentIds])
		.orderBy("created_at", "asc")
		.execute();
	for (const row of rows) {
		const bucket = byDeployment.get(row.deployment_id) ?? [];
		bucket.push(row);
		byDeployment.set(row.deployment_id, bucket);
	}
	return byDeployment;
}

/** The one row query both list readers share, so they cannot drift. */
async function readDeploymentRowsForApp(
	scope: DeploymentScope,
): Promise<Selectable<AppDeploymentsTable>[]> {
	if (!roleAllowsApp(scope.role, "view")) throw deploymentNotFound();
	const db = await getAppDb();
	return db
		.selectFrom("app_deployments")
		.selectAll()
		.where("app_id", "=", scope.appId)
		.where("project_id", "=", scope.projectId)
		.orderBy("updated_at", "desc")
		.execute();
}

/**
 * Every deployment of one app, newest activity first.
 *
 * Reads authorize through the caller's already-resolved scope rather than
 * taking the app lock: a deployment list is advisory, and holding the app
 * row to render one would serialize reads against every commit.
 */
export async function readDeploymentsForApp(
	scope: DeploymentScope,
): Promise<readonly DeploymentWithResources[]> {
	const rows = await readDeploymentRowsForApp(scope);
	const db = await getAppDb();
	const resources = await loadResources(
		db,
		rows.map((row) => row.id),
	);
	return rows.map((row) => ({
		deployment: toDeploymentRecord(row),
		...partitionResources(resources.get(row.id) ?? []),
	}));
}

/**
 * Just the columns the target rules read, without the ownership ledger or
 * the phase history.
 *
 * Two rules share this read and ask slightly different questions. Preview
 * asks "which project space, and how far along", and needs the domain
 * alone. Attachment URLs need the origin as well, and an origin comes from
 * the server — CommCare's US, India, and EU installations are separate
 * systems that can each hold a project space of the same name, so `server`
 * belongs here even though Preview ignores it.
 */
export async function readDeploymentPreviewRecords(
	scope: DeploymentScope,
): Promise<
	readonly Pick<
		DeploymentRecord,
		"state" | "resumePhase" | "server" | "domain"
	>[]
> {
	if (!roleAllowsApp(scope.role, "view")) throw deploymentNotFound();
	const db = await getAppDb();
	const rows = await db
		.selectFrom("app_deployments")
		.select(["state", "resume_phase", "server", "domain"])
		.where("app_id", "=", scope.appId)
		.where("project_id", "=", scope.projectId)
		.execute();
	return rows.map((row) => {
		const state = deploymentStateSchema.safeParse(row.state);
		const resumePhase =
			row.resume_phase === null
				? null
				: deploymentPhaseSchema.safeParse(row.resume_phase);
		if (!state.success || (resumePhase !== null && !resumePhase.success)) {
			throw new Error(
				`A deployment of app ${scope.appId} is stored in a state Nova does not know.`,
			);
		}
		if (!isDeploymentServer(row.server)) {
			throw new Error(
				`A deployment of app ${scope.appId} names CommCare server "${row.server}", which Nova does not know.`,
			);
		}
		return {
			state: state.data,
			resumePhase: resumePhase === null ? null : resumePhase.data,
			server: row.server,
			domain: row.domain,
		};
	});
}

/** One deployment by target, or `null` when the app has never had one. */
export async function readDeployment(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<DeploymentWithResources | null> {
	if (!roleAllowsApp(scope.role, "view")) throw deploymentNotFound();
	const db = await getAppDb();
	const row = await db
		.selectFrom("app_deployments")
		.selectAll()
		.where("app_id", "=", scope.appId)
		.where("project_id", "=", scope.projectId)
		.where("server", "=", target.server)
		.where("domain", "=", target.domain)
		.executeTakeFirst();
	if (row === undefined) return null;
	const resources = await loadResources(db, [row.id]);
	return {
		deployment: toDeploymentRecord(row),
		...partitionResources(resources.get(row.id) ?? []),
	};
}

async function loadWithinTransaction(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
): Promise<DeploymentWithResources> {
	const row = await tx
		.selectFrom("app_deployments")
		.selectAll()
		.where("id", "=", deploymentId)
		.executeTakeFirst();
	if (row === undefined) throw deploymentNotFound();
	const resources = await loadResources(tx, [deploymentId]);
	return {
		deployment: toDeploymentRecord(row),
		...partitionResources(resources.get(deploymentId) ?? []),
	};
}

/**
 * Every write below is one transaction over the FRESH row.
 *
 * There is deliberately no cross-transaction lock around a publish or a
 * refresh, because both spend seconds to minutes talking to CommCare HQ
 * and a lock that spans that time has to hold a database session across
 * it: a pooled connection pinned idle while HQ thinks. Instead, each
 * write locks the app row, takes the deployment row `FOR UPDATE`, applies
 * the pure state-machine fold to what the row says NOW, and commits. A
 * fold computed against a snapshot another writer has since replaced can
 * therefore never land: the fold happens after the lock, not before it.
 *
 * What keeps interleaved network work honest is that every fold states
 * its precondition against the fresh row instead of assuming one:
 * `applyAttemptOutcome` changes nothing once the target displays as
 * reached, and an observation is applied only while the mapping it
 * observed is still the active one (`applyDeploymentObservation`).
 */
async function withDeploymentRow<T>(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	options: { readonly ensure: boolean },
	body: (
		tx: Transaction<AppDatabase>,
		row: Selectable<AppDeploymentsTable>,
	) => Promise<T>,
): Promise<T> {
	return withAppTx(async (tx) => {
		await lockAppForDeploymentWrite(tx, scope, "edit");
		if (options.ensure) {
			/* Creation is the honest starting state, not a placeholder:
			 * `preflight` means "prerequisites are being checked and nothing
			 * has been sent", which is exactly true of a record that has just
			 * come into existence. */
			await tx
				.insertInto("app_deployments")
				.values({
					app_id: scope.appId,
					project_id: scope.projectId,
					server: target.server,
					domain: target.domain,
					state: "preflight",
					resume_phase: null,
					phases: JSON.stringify(NO_DEPLOYMENT_PHASE_OUTCOMES),
					created_by: scope.actorUserId,
				})
				.onConflict((conflict) =>
					conflict
						.columns(["app_id", "project_id", "server", "domain"])
						.doNothing(),
				)
				.execute();
		}
		const row = await tx
			.selectFrom("app_deployments")
			.selectAll()
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.where("server", "=", target.server)
			.where("domain", "=", target.domain)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) throw deploymentNotFound();
		return body(tx, row);
	});
}

function progressUpdate(
	next: Pick<DeploymentRecord, "state" | "resumePhase">,
	phases: DeploymentPhaseOutcomes,
	now: Date,
) {
	return {
		state: next.state,
		resume_phase: next.resumePhase,
		phases: JSON.stringify(phases),
		updated_at: now,
	};
}

/**
 * Fold one publish-attempt outcome into the target's record.
 *
 * The fold is `applyAttemptOutcome`, applied to the row as it stands
 * inside the transaction: a refused attempt against a target that already
 * holds the app changes nothing (the refusal is the ATTEMPT's to report),
 * and in that case nothing is written. `ensure` creates the record first,
 * for the one caller allowed to bring it into existence: a publish whose
 * preflight just proved the target reachable.
 */
export async function foldDeploymentAttempt(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	phase: DrivenDeploymentPhase,
	outcome: DeploymentPhaseOutcome,
	options: { readonly ensure?: boolean } = {},
): Promise<DeploymentWithResources> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: options.ensure === true },
		async (tx, row) => {
			const record = toDeploymentRecord(row);
			const next = applyAttemptOutcome(record, phase, outcome);
			if (next !== record) {
				await tx
					.updateTable("app_deployments")
					.set(progressUpdate(next, next.phases, new Date()))
					.where("id", "=", row.id)
					.execute();
				/* Delivered on commit, so connected tabs re-resolve what
				 * Preview may name only once the fold is visible. */
				await notifyAppDeployments(tx, scope.appId);
			}
			return loadWithinTransaction(tx, row.id);
		},
	);
}

export interface RecordRemoteResourceInput {
	readonly kind: DeploymentResourceKind;
	readonly novaResourceId: string;
	readonly remoteId: string;
	readonly ownership: DeploymentResourceOwnership;
	/**
	 * The external name this resource carries on CommCare HQ, for the kinds
	 * that have one. Null for `app`, whose remote id is its name there.
	 */
	readonly pushedIdentity?: string | null;
	/**
	 * Who took over a resource Nova did not create. Required exactly when
	 * `ownership` is `adopted`, and refused otherwise — the ledger's own
	 * CHECK says the same thing, and disagreeing with it here would turn a
	 * reviewable decision into a constraint violation at 3am.
	 */
	readonly adoptedBy?: string | null;
	/** The Nova mutation sequence this remote resource was built from. */
	readonly pushedRevision: number | null;
	/**
	 * CommCare HQ's own version of the resource as the write that landed it
	 * reported — an in-place app update answers with the bumped version;
	 * a create answers with none, so this stays null and the next
	 * observation fills it.
	 */
	readonly remoteRevision: number | null;
}

/**
 * The app mapping, which additionally carries the moment the upload
 * landed, because recording it is what advances the record to `uploaded`.
 * The other kinds do not: their rung is folded once for the whole push
 * rather than once per resource.
 */
export interface RecordRemoteAppInput extends RecordRemoteResourceInput {
	readonly uploadedAt: string;
}

/**
 * Point a deployment at the app CommCare HQ now holds, and fold the
 * successful upload into the record: one transaction, so a publish that
 * recorded the remote app but not the `uploaded` state cannot exist.
 * `writeResourceMapping` owns the update-versus-supersede rule.
 *
 * The record's observation history is cleared in the same write, because
 * those answers described what the target held before this publish, not
 * what it holds now.
 */
export async function recordRemoteResource(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: RecordRemoteAppInput,
): Promise<DeploymentWithResources> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			const now = new Date();
			await writeResourceMapping(tx, row.id, input, now);

			const record = toDeploymentRecord(row);
			const progress = applyPhaseOutcome(record, "upload", {
				status: "succeeded",
				at: input.uploadedAt,
			});
			await tx
				.updateTable("app_deployments")
				.set(
					progressUpdate(
						progress,
						clearObservationOutcomes(progress.phases),
						now,
					),
				)
				.where("id", "=", row.id)
				.execute();
			await notifyAppDeployments(tx, scope.appId);

			return loadWithinTransaction(tx, row.id);
		},
	);
}

/**
 * Point one mapping at its remote resource, inside a caller's transaction.
 *
 * Recording the SAME remote id the mapping already holds is the mainline
 * republish — the resource was updated on CommCare HQ in place — so the
 * live row is updated rather than filed as something left behind.
 * Recording a DIFFERENT one supersedes the previous mapping: the mapped
 * app was deleted on CommCare HQ and a fresh one created, or a lookup
 * table's tag changed so the push made a new table beside the old one.
 * The old row is retained with `superseded_at` set rather than deleted,
 * because "report any old remote resource left behind" is impossible if
 * the row is thrown away.
 */
async function writeResourceMapping(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	input: RecordRemoteResourceInput,
	now: Date,
): Promise<void> {
	const adopted = input.ownership === "adopted";
	const adoptedBy = input.adoptedBy ?? null;
	/* The ledger's CHECK says the same thing, and hitting it would surface
	 * as a constraint violation with no useful name attached. Refusing
	 * here says which call was wrong. */
	if (adopted !== (adoptedBy !== null && adoptedBy.trim() !== "")) {
		throw new Error(
			adopted
				? "Adopting a CommCare HQ resource needs the member who adopted it; the ledger records who took it over."
				: "Only an adopted resource records who adopted it; a resource Nova created has no such decision to attribute.",
		);
	}
	const attribution = {
		ownership: input.ownership,
		adopted_at: adopted ? now : null,
		adopted_by: adopted ? adoptedBy : null,
		pushed_identity: input.pushedIdentity ?? null,
	} as const;

	/* An adoption is attributed ONCE, to the person who made it.
	 *
	 * Every republish of an already-adopted table lands in the conflict arm
	 * carrying a fresh `now` and whoever clicked today, so writing the
	 * attribution straight through would quietly reassign a decision A made
	 * in March to B in August, and the ledger's whole purpose is that the
	 * decision is auditable rather than folklore. `COALESCE` keeps the
	 * first one and still records a genuine nova-created -> adopted
	 * transition, whose existing columns are null.
	 *
	 * The `CASE` is what keeps the reverse transition legal: the row's
	 * CHECK ties `ownership = 'adopted'` to exactly the rows that name a
	 * member and a time, so a resource that stops being adopted has to drop
	 * both in the same statement. */
	const conflictAttribution = {
		ownership: input.ownership,
		adopted_at: sql<Date | null>`CASE WHEN EXCLUDED.ownership = 'adopted' THEN COALESCE(app_deployment_resources.adopted_at, EXCLUDED.adopted_at) ELSE NULL END`,
		adopted_by: sql<
			string | null
		>`CASE WHEN EXCLUDED.ownership = 'adopted' THEN COALESCE(app_deployment_resources.adopted_by, EXCLUDED.adopted_by) ELSE NULL END`,
		pushed_identity: input.pushedIdentity ?? null,
	} as const;

	await tx
		.updateTable("app_deployment_resources")
		.set({ superseded_at: now })
		.where("deployment_id", "=", deploymentId)
		.where("kind", "=", input.kind)
		.where("nova_resource_id", "=", input.novaResourceId)
		.where("superseded_at", "is", null)
		// Re-pointing at the same remote id is not a supersession: it is
		// the same resource, so the row is updated below instead of being
		// filed as something left behind.
		.where("remote_id", "!=", input.remoteId)
		.execute();

	/* `remote_revision`/`remote_observed_at` are written in BOTH arms:
	 * a republish always lands in the conflict arm, so an insert-only
	 * write would silently drop the version an in-place update
	 * reported. */
	await tx
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: deploymentId,
			kind: input.kind,
			nova_resource_id: input.novaResourceId,
			remote_id: input.remoteId,
			...attribution,
			pushed_revision: input.pushedRevision,
			pushed_at: input.pushedRevision === null ? null : now,
			remote_revision: input.remoteRevision,
			remote_observed_at: input.remoteRevision === null ? null : now,
		})
		.onConflict((conflict) =>
			conflict
				.columns(["deployment_id", "kind", "nova_resource_id"])
				.where("superseded_at", "is", null)
				.doUpdateSet({
					remote_id: input.remoteId,
					...conflictAttribution,
					pushed_revision: input.pushedRevision,
					pushed_at: input.pushedRevision === null ? null : now,
					remote_revision: input.remoteRevision,
					remote_observed_at: input.remoteRevision === null ? null : now,
				}),
		)
		.execute();
}

/**
 * How far one resource push got, which is what decides whether its
 * mappings are also a STATEMENT about the resources it did not name.
 *
 * Both kinds of push can stop partway, and the reason is CommCare HQ's
 * rather than Nova's. A table push is one workbook, but
 * `views.py::UploadFixtureAPIResponse.response_codes` has three verdicts
 * rather than two: `warning` means the workbook was processed and part of
 * it did not take. A place push is a batch per level
 * (`locations/resources/v0_6.py::LocationResource.patch_list` is atomic at
 * 100 places), so a tree can genuinely stop with three levels of places
 * really sitting on somebody's project space. Recording what landed is
 * not optional either way: it is there, a retry has to update it rather
 * than make a second copy, and a mapping Nova never wrote would make its
 * own resource read as a stranger's on the next publish and stop it to
 * ask.
 */
export type ResourcePushOutcome =
	| {
			/**
			 * The push finished. `mappings` is therefore the COMPLETE live
			 * set for every kind in `kinds`, and any live mapping of one of
			 * those kinds it does not name is superseded.
			 */
			readonly status: "complete";
			readonly kinds: readonly DeploymentResourceKind[];
			readonly pushedAt: string;
	  }
	| {
			/**
			 * The push stopped partway. What landed is real and is recorded;
			 * nothing is superseded, because a resource this call did not
			 * name may simply not have been reached yet, and no rung folds,
			 * because the phase did not succeed.
			 */
			readonly status: "partial";
	  };

/**
 * Record everything one resource push put on the target, and fold the
 * `resources` rung, in a single transaction.
 *
 * The rung folds through `applyAttemptOutcome`, not `applyPhaseOutcome`.
 * That is what stops a republish of an app already `runnable` from being
 * walked backward to `resources` by its own successful push, and it is the
 * same rule preflight and upload already follow. The mappings are written
 * either way, because those are target information rather than attempt
 * information: the tables and places really are there now.
 *
 * A COMPLETE push is also the AUTHORITATIVE statement of which resources
 * of its kinds this app still uses, so any mapping it does not name is
 * superseded here. Dropping the last select that read a table, or
 * archiving a place, leaves that resource sitting on the project space
 * under Nova's own claim, and without this its row would stay live forever
 * and `leftBehindResources` — which only ever scans superseded rows —
 * would never mention it. Superseding is the whole fix: Nova still deletes
 * nothing on CommCare HQ, it just stops claiming the resource and starts
 * reporting it.
 */
export async function recordPushedResources(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	inputs: readonly RecordRemoteResourceInput[],
	outcome: ResourcePushOutcome,
): Promise<DeploymentWithResources> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			const now = new Date();
			for (const input of inputs) {
				await writeResourceMapping(tx, row.id, input, now);
			}
			if (outcome.status === "partial") {
				await notifyAppDeployments(tx, scope.appId);
				return loadWithinTransaction(tx, row.id);
			}
			for (const kind of outcome.kinds) {
				const stillUsed = inputs
					.filter((input) => input.kind === kind)
					.map((input) => input.novaResourceId);
				await tx
					.updateTable("app_deployment_resources")
					.set({ superseded_at: now })
					.where("deployment_id", "=", row.id)
					.where("kind", "=", kind)
					.where("superseded_at", "is", null)
					.$if(stillUsed.length > 0, (qb) =>
						qb.where("nova_resource_id", "not in", stillUsed),
					)
					.execute();
			}
			const record = toDeploymentRecord(row);
			const progress = applyAttemptOutcome(record, "resources", {
				status: "succeeded",
				at: outcome.pushedAt,
			});
			if (progress !== record) {
				await tx
					.updateTable("app_deployments")
					.set(progressUpdate(progress, progress.phases, now))
					.where("id", "=", row.id)
					.execute();
			}
			await notifyAppDeployments(tx, scope.appId);
			return loadWithinTransaction(tx, row.id);
		},
	);
}

export interface ApplyObservationInput {
	/** The CommCare HQ app the observation asked about. */
	readonly observedRemoteId: string;
	/**
	 * The active mapping's `pushedAt` as the caller read it before asking
	 * CommCare HQ — the per-publish staleness token. A republish updates
	 * the app in place and keeps the remote id, so the id alone can no
	 * longer tell "the publish I read" from "a publish that landed while I
	 * was asking"; `pushed_at` changes on every publish and does.
	 */
	readonly observedPushedAt: string | null;
	/** In phase order, ready for the state machine to fold. */
	readonly outcomes: readonly (readonly [
		DeploymentPhase,
		DeploymentPhaseOutcome,
	])[];
	/** CommCare HQ's own version of the app, when it answered. */
	readonly remoteRevision: number | null;
}

/**
 * Fold what an observation heard into the record, but only while the
 * mapping it observed is still the publish it read.
 *
 * Observation reads the record, spends seconds asking CommCare HQ about
 * the app it names, then comes back here. If a publish landed in that
 * window, the answers describe what the target held BEFORE it, and
 * writing them would overwrite the fresh record with stale facts. So the
 * write re-reads the active mapping under the row lock and discards the
 * observation unless both the remote id AND the publish token
 * (`observedPushedAt`) still match, returning the fresh view either way;
 * `applied` says which happened.
 */
export async function applyDeploymentObservation(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: ApplyObservationInput,
): Promise<{
	readonly view: DeploymentWithResources;
	readonly applied: boolean;
}> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			const now = new Date();
			const active = await tx
				.selectFrom("app_deployment_resources")
				.select(["remote_id", "pushed_at"])
				.where("deployment_id", "=", row.id)
				.where("kind", "=", "app")
				.where("nova_resource_id", "=", scope.appId)
				.where("superseded_at", "is", null)
				.executeTakeFirst();
			/* The column is timestamptz(3) and JS Dates carry milliseconds, so
			 * the epoch-ms comparison is lossless in both directions. Null on
			 * both sides matches — a mapping that never recorded a push has one
			 * spelling. Two publishes landing inside the same millisecond would
			 * share a token; accepted as negligible. */
			const activePushedAtMs =
				active === undefined || active.pushed_at === null
					? null
					: active.pushed_at.getTime();
			const observedPushedAtMs =
				input.observedPushedAt === null
					? null
					: new Date(input.observedPushedAt).getTime();
			if (
				active === undefined ||
				active.remote_id !== input.observedRemoteId ||
				activePushedAtMs !== observedPushedAtMs
			) {
				return {
					view: await loadWithinTransaction(tx, row.id),
					applied: false,
				};
			}
			const record = toDeploymentRecord(row);
			const next = applyObservation(record, input.outcomes);
			await tx
				.updateTable("app_deployments")
				.set({
					...progressUpdate(next, next.phases, now),
					last_observed_at: now,
				})
				.where("id", "=", row.id)
				.execute();
			await notifyAppDeployments(tx, scope.appId);
			if (input.remoteRevision !== null) {
				/* What CommCare HQ says its own version is, kept separate from the
				 * pushed revision on purpose: one is what Nova sent, the other is
				 * what the target holds, and collapsing them would make a
				 * hand-edited remote app look like Nova's own work. */
				await tx
					.updateTable("app_deployment_resources")
					.set({
						remote_revision: input.remoteRevision,
						remote_observed_at: now,
					})
					.where("deployment_id", "=", row.id)
					.where("kind", "=", "app")
					.where("nova_resource_id", "=", scope.appId)
					.where("superseded_at", "is", null)
					.execute();
			}
			return { view: await loadWithinTransaction(tx, row.id), applied: true };
		},
	);
}
