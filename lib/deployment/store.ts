import "server-only";

import type { Selectable, Transaction } from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import type { CommCareServer } from "@/lib/commcare/servers";
import {
	type AppDatabase,
	type AppDeploymentResourcesTable,
	type AppDeploymentsTable,
	getAppDb,
	withAppTx,
} from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { DeploymentError, deploymentNotFound } from "./errors";
import { clearObservationOutcomes } from "./stateMachine";
import {
	type DeploymentPhase,
	type DeploymentPhaseOutcome,
	type DeploymentPhaseOutcomes,
	type DeploymentRecord,
	type DeploymentResource,
	type DeploymentResourceKind,
	type DeploymentResourceOwnership,
	type DeploymentState,
	type DeploymentWithResources,
	deploymentPhaseOutcomesSchema,
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
	return {
		id: row.id,
		appId: row.app_id,
		projectId: row.project_id,
		server: row.server,
		domain: row.domain,
		state: row.state as DeploymentState,
		resumePhase: row.resume_phase as DeploymentPhase | null,
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
	return {
		deploymentId: row.deployment_id,
		kind: row.kind as DeploymentResourceKind,
		novaResourceId: row.nova_resource_id,
		remoteId: row.remote_id,
		ownership: row.ownership as DeploymentResourceOwnership,
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
	if (!roleAllowsApp(scope.role, "view")) throw deploymentNotFound();
	const db = await getAppDb();
	const rows = await db
		.selectFrom("app_deployments")
		.selectAll()
		.where("app_id", "=", scope.appId)
		.where("project_id", "=", scope.projectId)
		.orderBy("updated_at", "desc")
		.execute();
	const resources = await loadResources(
		db,
		rows.map((row) => row.id),
	);
	return rows.map((row) => ({
		deployment: toDeploymentRecord(row),
		...partitionResources(resources.get(row.id) ?? []),
	}));
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
 * Get the deployment for a target, creating it in `preflight` if this is
 * the first time the app has been pointed at that project space.
 *
 * Creation is the honest starting state, not a placeholder: `preflight`
 * means "prerequisites are being checked and nothing has been sent", which
 * is exactly true of a record that has just come into existence.
 */
export async function ensureDeployment(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<DeploymentWithResources> {
	return withAppTx(async (tx) => {
		await lockAppForDeploymentWrite(tx, scope, "edit");
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
		const row = await tx
			.selectFrom("app_deployments")
			.select("id")
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.where("server", "=", target.server)
			.where("domain", "=", target.domain)
			.executeTakeFirst();
		if (row === undefined) {
			throw new Error(
				"The deployment disappeared immediately after its locked upsert.",
			);
		}
		return loadWithinTransaction(tx, row.id);
	});
}

/**
 * Write the deployment's new state and phase history in one place.
 *
 * The caller folds outcomes through the pure state machine and hands the
 * result here, so the transition rules live in exactly one module and this
 * one only persists. `lastObservedAt` moves only when an observation
 * actually reached CommCare HQ.
 */
export async function saveDeploymentProgress(
	scope: DeploymentScope,
	deploymentId: string,
	next: Pick<DeploymentRecord, "state" | "resumePhase" | "phases">,
	options: { readonly observed?: boolean } = {},
): Promise<DeploymentWithResources> {
	return withAppTx(async (tx) => {
		await lockAppForDeploymentWrite(tx, scope, "edit");
		const updated = await tx
			.updateTable("app_deployments")
			.set({
				state: next.state,
				resume_phase: next.resumePhase,
				phases: JSON.stringify(next.phases),
				updated_at: new Date(),
				...(options.observed === true ? { last_observed_at: new Date() } : {}),
			})
			.where("id", "=", deploymentId)
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.executeTakeFirst();
		if (Number(updated.numUpdatedRows ?? 0) === 0) throw deploymentNotFound();
		return loadWithinTransaction(tx, deploymentId);
	});
}

export interface RecordRemoteResourceInput {
	readonly kind: DeploymentResourceKind;
	readonly novaResourceId: string;
	readonly remoteId: string;
	readonly ownership: DeploymentResourceOwnership;
	/** The Nova mutation sequence this remote resource was built from. */
	readonly pushedRevision: number | null;
	/**
	 * Phase history to persist alongside the mapping, so the state change
	 * and the ownership change land in one transaction. A publish that
	 * recorded the remote app but not the `uploaded` state would leave a
	 * deployment claiming nothing happened while an app sat on HQ.
	 */
	readonly progress: Pick<DeploymentRecord, "state" | "resumePhase" | "phases">;
	/**
	 * Prove no other app in this Project already owns `remoteId`, inside
	 * the same transaction that writes it.
	 *
	 * Adoption sets this. A publish does not: it names an id CommCare HQ
	 * has just minted, which nothing else can be holding.
	 */
	readonly requireUnclaimed?: boolean;
}

/**
 * Point a deployment at a remote resource, superseding whatever it named
 * before.
 *
 * The previous mapping is retained with `superseded_at` set rather than
 * deleted. CommCare HQ has no atomic app update, so a second publish makes
 * a second app there and leaves the first one in place; the contract is to
 * REPORT what was left behind, which is impossible if the row is thrown
 * away. Its observation history is cleared in the same write because those
 * answers described the previous remote resource, not this one.
 */
export async function recordRemoteResource(
	scope: DeploymentScope,
	deploymentId: string,
	input: RecordRemoteResourceInput,
): Promise<DeploymentWithResources> {
	return withAppTx(async (tx) => {
		await lockAppForDeploymentWrite(tx, scope, "edit");
		const deployment = await tx
			.selectFrom("app_deployments")
			.select(["id"])
			.where("id", "=", deploymentId)
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.forUpdate()
			.executeTakeFirst();
		if (deployment === undefined) throw deploymentNotFound();

		if (input.requireUnclaimed === true) {
			await assertRemoteAppUnclaimedInTransaction(
				tx,
				scope,
				deploymentId,
				input.remoteId,
			);
		}

		const now = new Date();
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

		await tx
			.insertInto("app_deployment_resources")
			.values({
				deployment_id: deploymentId,
				kind: input.kind,
				nova_resource_id: input.novaResourceId,
				remote_id: input.remoteId,
				ownership: input.ownership,
				adopted_at: input.ownership === "adopted" ? now : null,
				adopted_by: input.ownership === "adopted" ? scope.actorUserId : null,
				pushed_revision: input.pushedRevision,
				pushed_at: input.pushedRevision === null ? null : now,
			})
			.onConflict((conflict) =>
				conflict
					.columns(["deployment_id", "kind", "nova_resource_id"])
					.where("superseded_at", "is", null)
					/* Ownership travels with the write. Adopting an id this
					 * deployment already created must record WHO adopted it and
					 * WHEN, or the row keeps claiming Nova made it. */
					.doUpdateSet({
						remote_id: input.remoteId,
						ownership: input.ownership,
						adopted_at: input.ownership === "adopted" ? now : null,
						adopted_by:
							input.ownership === "adopted" ? scope.actorUserId : null,
						pushed_revision: input.pushedRevision,
						pushed_at: input.pushedRevision === null ? null : now,
					}),
			)
			.execute();

		await tx
			.updateTable("app_deployments")
			.set({
				state: input.progress.state,
				resume_phase: input.progress.resumePhase,
				phases: JSON.stringify(clearObservationOutcomes(input.progress.phases)),
				updated_at: now,
			})
			.where("id", "=", deploymentId)
			.execute();

		return loadWithinTransaction(tx, deploymentId);
	});
}

/**
 * Record what CommCare HQ says its own version of a resource is.
 *
 * Separate from the pushed revision on purpose: one is what Nova sent, the
 * other is what the target holds, and collapsing them would make a
 * hand-edited remote app look like Nova's own work.
 */
export async function recordRemoteRevision(
	scope: DeploymentScope,
	deploymentId: string,
	input: {
		readonly kind: DeploymentResourceKind;
		readonly novaResourceId: string;
		readonly remoteRevision: number | null;
	},
): Promise<void> {
	await withAppTx(async (tx) => {
		await lockAppForDeploymentWrite(tx, scope, "edit");
		await tx
			.updateTable("app_deployment_resources")
			.set({
				remote_revision: input.remoteRevision,
				remote_observed_at: new Date(),
			})
			.where("deployment_id", "=", deploymentId)
			.where("kind", "=", input.kind)
			.where("nova_resource_id", "=", input.novaResourceId)
			.where("superseded_at", "is", null)
			.execute();
	});
}

/** The mapping currently in force for one Nova resource, if there is one. */
export function activeResource(
	deployment: DeploymentWithResources,
	kind: DeploymentResourceKind,
	novaResourceId: string,
): DeploymentResource | null {
	return (
		deployment.active.find(
			(resource) =>
				resource.kind === kind && resource.novaResourceId === novaResourceId,
		) ?? null
	);
}

/**
 * The CommCare HQ app this deployment currently points at.
 *
 * The app's own Nova id is the resource id for the `app` kind, so this is
 * a lookup rather than a special case in the table.
 */
export function activeRemoteApp(
	deployment: DeploymentWithResources,
): DeploymentResource | null {
	return activeResource(deployment, "app", deployment.deployment.appId);
}

/**
 * Refuse to adopt a remote app another deployment of this Project already
 * owns.
 *
 * Adoption is explicit, but explicit is not the same as unchecked: two
 * Nova apps both claiming the same CommCare HQ app would each believe they
 * may repoint it, and whichever published second would silently take it
 * over.
 *
 * **This runs inside the writing transaction**, not before it. A check on
 * its own connection is a time-of-check/time-of-use gap: two concurrent
 * adoptions of the same CommCare HQ app both pass it and both insert,
 * because they write different `deployment_id`s and so never collide on
 * the partial unique index. Holding the app row for the duration is what
 * actually makes it exclusive.
 */
async function assertRemoteAppUnclaimedInTransaction(
	tx: Transaction<AppDatabase>,
	scope: DeploymentScope,
	deploymentId: string,
	remoteId: string,
): Promise<void> {
	const clash = await tx
		.selectFrom("app_deployment_resources")
		.innerJoin(
			"app_deployments",
			"app_deployments.id",
			"app_deployment_resources.deployment_id",
		)
		.select(["app_deployments.app_id as app_id", "app_deployments.domain"])
		.where("app_deployments.project_id", "=", scope.projectId)
		.where("app_deployment_resources.kind", "=", "app")
		.where("app_deployment_resources.remote_id", "=", remoteId)
		.where("app_deployment_resources.superseded_at", "is", null)
		.where("app_deployment_resources.deployment_id", "!=", deploymentId)
		.executeTakeFirst();
	if (clash !== undefined) {
		throw new DeploymentError(
			"already_mapped",
			`Another app in this project already publishes to the CommCare HQ app "${remoteId}" on ${clash.domain}. Two apps cannot share one CommCare HQ app, because each would believe it may replace the other's work.`,
		);
	}
}

export type { DeploymentPhaseOutcome, DeploymentPhaseOutcomes };
