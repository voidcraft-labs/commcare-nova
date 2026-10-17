import "server-only";

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
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
import { log } from "@/lib/logger";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { deploymentNotFound } from "./errors";
import { publishedRemoteApp } from "./resources";
import {
	applyAttemptOutcome,
	applyObservation,
	applyPhaseOutcome,
	clearObservationOutcomes,
	deploymentDisplaysAsReached,
} from "./stateMachine";
import {
	type AppBaseline,
	type AppBaselineWrite,
	type AppOwnership,
	type CanonicalLookupTable,
	type CanonicalPlace,
	confirmationSubject,
	DEPLOYMENT_CONFIRMATION_KINDS,
	type DeploymentConfirmation,
	type DeploymentConfirmationKey,
	type DeploymentConfirmationKind,
	type DeploymentIdentityOverride,
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
	type ResourceBaseline,
	type ResourceBaselineRef,
	type ResourceBaselineWrite,
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
		offeredLogoContentHash: row.offered_logo_content_hash,
		targetEmptyCaseListText: row.target_empty_case_list_text,
		targetWebAppsEnabled: row.target_web_apps_enabled,
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
		pushToken: row.push_token,
		remoteRevision: numberOrNull(row.remote_revision),
		remoteObservedAt: isoOrNull(row.remote_observed_at),
		supersededAt: isoOrNull(row.superseded_at),
		remoteMissingAt: isoOrNull(row.remote_missing_at),
	};
}

/** The name a confirmation shows for a person whose user no longer exists. */
const FORMER_MEMBER_NAME = "A former member";

interface ConfirmationRow {
	readonly deployment_id: string;
	readonly kind: string;
	readonly subject: string;
	readonly confirmed_by: string;
	readonly confirmed_at: Date;
}

function isConfirmationKind(
	value: string,
): value is DeploymentConfirmationKind {
	return (DEPLOYMENT_CONFIRMATION_KINDS as readonly string[]).includes(value);
}

function toDeploymentConfirmation(
	row: ConfirmationRow,
	names: ReadonlyMap<string, string>,
): DeploymentConfirmation {
	if (!isConfirmationKind(row.kind)) {
		throw new Error(
			`Deployment ${row.deployment_id} records a "${row.kind}" confirmation, which Nova does not know.`,
		);
	}
	return {
		kind: row.kind,
		subject: row.subject,
		confirmedByName: names.get(row.confirmed_by) ?? FORMER_MEMBER_NAME,
		confirmedAt: row.confirmed_at.toISOString(),
	};
}

type DeploymentLedger = Pick<
	DeploymentWithResources,
	"active" | "superseded" | "confirmations"
>;

const NO_DEPLOYMENT_LEDGER: DeploymentLedger = {
	active: [],
	superseded: [],
	confirmations: [],
};

/**
 * The resource mappings and the live confirmations of each deployment. A
 * confirmation names its person by `auth_user.name`, read only when a
 * confirmation exists, and a user who no longer exists reads as a former
 * member.
 */
async function loadResources(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	deploymentIds: readonly string[],
): Promise<Map<string, DeploymentLedger>> {
	if (deploymentIds.length === 0) return new Map();
	const ids = [...deploymentIds];
	const resourceRows = await db
		.selectFrom("app_deployment_resources")
		.selectAll()
		.where("deployment_id", "in", ids)
		.orderBy("created_at", "asc")
		.execute();
	const confirmationRows = await db
		.selectFrom("app_deployment_confirmations")
		.select([
			"deployment_id",
			"kind",
			"subject",
			"confirmed_by",
			"confirmed_at",
		])
		.where("deployment_id", "in", ids)
		.where("withdrawn_at", "is", null)
		.orderBy("confirmed_at", "asc")
		.orderBy("id", "asc")
		.execute();
	const names = await confirmerNames(
		db,
		confirmationRows.map((row) => row.confirmed_by),
	);
	const building = new Map(
		ids.map((id) => [
			id,
			{
				active: [] as DeploymentResource[],
				superseded: [] as DeploymentResource[],
				confirmations: [] as DeploymentConfirmation[],
			},
		]),
	);
	for (const row of resourceRows) {
		const resource = toDeploymentResource(row);
		const ledger = building.get(row.deployment_id);
		if (resource.supersededAt === null) ledger?.active.push(resource);
		else ledger?.superseded.push(resource);
	}
	for (const row of confirmationRows) {
		building
			.get(row.deployment_id)
			?.confirmations.push(toDeploymentConfirmation(row, names));
	}
	return building;
}

/** `auth_user.name` for each confirming user that still exists. */
async function confirmerNames(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	const distinct = [...new Set(userIds)];
	if (distinct.length === 0) return new Map();
	const rows = await sql<{ id: string; name: string }>`
		SELECT id, name FROM auth_user WHERE id = ANY(${distinct}::text[])
	`.execute(db);
	return new Map(rows.rows.map((row) => [row.id, row.name]));
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
		...(resources.get(row.id) ?? NO_DEPLOYMENT_LEDGER),
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
		...(resources.get(row.id) ?? NO_DEPLOYMENT_LEDGER),
	};
}

/**
 * The ids this target holds that are not Nova's derivation, for every
 * entity that has one. Empty for a target this app has no deployment on.
 *
 * Kept out of `DeploymentWithResources` on purpose: only the two readers
 * that emit an app for a target (a publish and a `.ccz` made for one
 * project space) need them, and no status read should carry them.
 */
export async function readDeploymentIdentityOverrides(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<readonly DeploymentIdentityOverride[]> {
	if (!roleAllowsApp(scope.role, "view")) throw deploymentNotFound();
	const db = await getAppDb();
	const rows = await db
		.selectFrom("app_deployment_identities as i")
		.innerJoin("app_deployments as d", "d.id", "i.deployment_id")
		.select(["i.entity_kind", "i.nova_entity_uuid", "i.unique_id", "i.xmlns"])
		.where("d.app_id", "=", scope.appId)
		.where("d.project_id", "=", scope.projectId)
		.where("d.server", "=", target.server)
		.where("d.domain", "=", target.domain)
		.orderBy("i.entity_kind")
		.orderBy("i.nova_entity_uuid")
		.execute();
	return rows.map((row) => {
		if (row.entity_kind !== "module" && row.entity_kind !== "form") {
			throw new Error(
				`A deployment records an id for a "${row.entity_kind}", which Nova does not know.`,
			);
		}
		return {
			entityKind: row.entity_kind,
			novaEntityUuid: row.nova_entity_uuid,
			uniqueId: row.unique_id,
			xmlns: row.xmlns,
		};
	});
}

/** A project space this app's content is on, with the HQ app that holds it. */
export interface ReachedDeploymentTargetRow {
	readonly server: CommCareServer;
	readonly domain: string;
	readonly hqAppId: string;
	/**
	 * The target's `USH_EMPTY_CASE_LIST_TEXT` as the last publish read it;
	 * false where no publish has read it.
	 */
	readonly emptyCaseListText: boolean;
	/** How many HQ apps the deployment held before this one: its superseded `app` mappings. */
	readonly earlierHqApps: number;
}

/**
 * Every project space this app's content is on: each deployment that
 * displays as uploaded and whose live app mapping is not reported gone and
 * holds content. A mapping to the empty shell of a first publish is never
 * among them, whatever the record displays.
 */
export async function readReachedDeploymentTargets(
	scope: DeploymentScope,
): Promise<readonly ReachedDeploymentTargetRow[]> {
	const deployments = await readDeploymentsForApp(scope);
	return deployments.flatMap((view) => {
		const remote = publishedRemoteApp(view);
		if (
			remote === null ||
			!deploymentDisplaysAsReached(view.deployment, "uploaded")
		) {
			return [];
		}
		return [
			{
				server: view.deployment.server,
				domain: view.deployment.domain,
				hqAppId: remote.remoteId,
				emptyCaseListText: view.deployment.targetEmptyCaseListText === true,
				earlierHqApps: view.superseded.filter(
					(resource) => resource.kind === "app",
				).length,
			},
		];
	});
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
		...(resources.get(deploymentId) ?? NO_DEPLOYMENT_LEDGER),
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
 *
 * `confirmations` are what a person confirmed about the project space for
 * this publish, stored only with a succeeded preflight: a refused attempt
 * stores none, so the caller sends them again until an attempt passes. Each
 * is attributed to the scope's actor, and one already in force is kept as
 * it is, so its first confirmer stays on record.
 */
export async function foldDeploymentAttempt(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	phase: DrivenDeploymentPhase,
	outcome: DeploymentPhaseOutcome,
	options: {
		readonly ensure?: boolean;
		readonly confirmations?: readonly DeploymentConfirmationKey[];
	} = {},
): Promise<DeploymentWithResources> {
	const confirmations = options.confirmations ?? [];
	if (
		confirmations.length > 0 &&
		(phase !== "preflight" || outcome.status !== "succeeded")
	) {
		throw new Error(
			"A confirmation is stored only with a preflight that passed, and this fold was not one.",
		);
	}
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
			}
			if (confirmations.length > 0) {
				await tx
					.insertInto("app_deployment_confirmations")
					.values(
						confirmations.map((key) => ({
							deployment_id: row.id,
							kind: key.kind,
							subject: confirmationSubject(key),
							confirmed_by: scope.actorUserId,
						})),
					)
					.onConflict((conflict) =>
						conflict
							.columns(["deployment_id", "kind", "subject"])
							.where("withdrawn_at", "is", null)
							.doNothing(),
					)
					.execute();
			}
			if (next !== record || confirmations.length > 0) {
				/* Delivered on commit, so connected tabs re-resolve what
				 * Preview may name only once the fold is visible. */
				await notifyAppDeployments(tx, scope.appId);
			}
			return loadWithinTransaction(tx, row.id);
		},
	);
}

/**
 * Withdraw what a person confirmed about the project space, so the next
 * publish asks again. The row is kept with who withdrew it and when; a
 * subject with no confirmation in force changes nothing.
 */
export async function withdrawDeploymentConfirmation(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	key: DeploymentConfirmationKey,
): Promise<DeploymentWithResources> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			const withdrawn = await tx
				.updateTable("app_deployment_confirmations")
				.set({ withdrawn_by: scope.actorUserId, withdrawn_at: sql`now()` })
				.where("deployment_id", "=", row.id)
				.where("kind", "=", key.kind)
				.where("subject", "=", confirmationSubject(key))
				.where("withdrawn_at", "is", null)
				.executeTakeFirst();
			if (Number(withdrawn.numUpdatedRows) > 0) {
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
	/**
	 * The target's `USH_EMPTY_CASE_LIST_TEXT` as this publish read it, written
	 * with the upload's fold. Left out where the read failed, so the column
	 * keeps what an earlier publish read.
	 */
	readonly targetEmptyCaseListText?: boolean;
	/**
	 * HQ's `cloudcare_enabled` for the app as this publish read it: the read
	 * after the import, or the last read before it where that read failed.
	 * Written with the upload's fold; the setup artifact reads it.
	 */
	readonly targetWebAppsEnabled: boolean;
	/**
	 * The content hash of the logo this publish offered for upload in
	 * CommCare HQ. Written only when present; `null` clears it.
	 */
	readonly offeredLogoContentHash?: string | null;
	/**
	 * HQ's read of the app right after this upload, or the fact that Nova
	 * could not read it, written with the mapping so the two never disagree.
	 */
	readonly baseline: AppBaselineWrite;
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
			await writeAppBaseline(tx, row.id, scope, input.baseline);

			const record = toDeploymentRecord(row);
			const progress = applyPhaseOutcome(record, "upload", {
				status: "succeeded",
				at: input.uploadedAt,
			});
			await tx
				.updateTable("app_deployments")
				.set({
					...progressUpdate(
						progress,
						clearObservationOutcomes(progress.phases),
						now,
					),
					...(input.targetEmptyCaseListText !== undefined && {
						target_empty_case_list_text: input.targetEmptyCaseListText,
					}),
					target_web_apps_enabled: input.targetWebAppsEnabled,
					...(input.offeredLogoContentHash !== undefined && {
						offered_logo_content_hash: input.offeredLogoContentHash,
					}),
				})
				.where("id", "=", row.id)
				.execute();
			await notifyAppDeployments(tx, scope.appId);

			return loadWithinTransaction(tx, row.id);
		},
	);
}

/**
 * Record the empty app a first publish just created on CommCare HQ, before
 * any of the app's Project data or content is sent.
 *
 * The mapping carries no pushed revision, which is what marks it a shell
 * Nova has not filled (`resources.ts::remoteAppHoldsContent`), and folds no
 * rung: the deployment is not `uploaded` until the update fills the app,
 * and saying so earlier would make it observable and a download target.
 * A mapping CommCare HQ reported gone is superseded by this one.
 */
export async function recordCreatedRemoteApp(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: {
		readonly remoteId: string;
		/** The read after the create as the `create` baseline, or `unread` when it failed. */
		readonly baseline: AppBaselineWrite;
	},
): Promise<DeploymentWithResources> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			await writeResourceMapping(
				tx,
				row.id,
				{
					kind: "app",
					novaResourceId: scope.appId,
					remoteId: input.remoteId,
					ownership: "nova-created",
					pushedRevision: null,
					remoteRevision: null,
				},
				new Date(),
			);
			await writeAppBaseline(tx, row.id, scope, input.baseline);
			await notifyAppDeployments(tx, scope.appId);
			return loadWithinTransaction(tx, row.id);
		},
	);
}

/**
 * Upsert the one app baseline of a deployment, inside a caller's
 * transaction.
 *
 * The `WHERE` is the fold's precondition: two publishes that read back and
 * record out of order leave the newer read stored, so the baseline is
 * always HQ's latest known state and a late writer never makes the next
 * publish stop over Nova's own push. A baseline for another HQ app always
 * replaces the row, discard record included; one for the same app keeps
 * the stored discard record unless this write carries one.
 */
async function writeAppBaseline(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	scope: DeploymentScope,
	baseline: AppBaselineWrite,
): Promise<void> {
	const discarded = baseline.discard !== null;
	await sql`
		INSERT INTO app_deployment_baselines AS existing (
			deployment_id, remote_app_id, origin, source_gzip, source_bytes,
			source_digest, ownership, observed_at, observed_by,
			discarded_digest, discarded_by, discarded_at
		) VALUES (
			${deploymentId}, ${baseline.remoteAppId}, ${baseline.origin},
			${baseline.sourceGzip}, ${baseline.sourceBytes},
			${baseline.sourceDigest},
			${baseline.ownership === null ? null : JSON.stringify(baseline.ownership)}::jsonb,
			${baseline.observedAt}::timestamptz, ${scope.actorUserId},
			${baseline.discard?.digest ?? null},
			${discarded ? scope.actorUserId : null},
			${discarded ? sql`now()` : null}
		)
		ON CONFLICT (deployment_id) DO UPDATE SET
			remote_app_id = EXCLUDED.remote_app_id,
			origin = EXCLUDED.origin,
			source_gzip = EXCLUDED.source_gzip,
			source_bytes = EXCLUDED.source_bytes,
			source_digest = EXCLUDED.source_digest,
			ownership = EXCLUDED.ownership,
			observed_at = EXCLUDED.observed_at,
			observed_by = EXCLUDED.observed_by,
			discarded_digest = CASE WHEN EXCLUDED.remote_app_id = existing.remote_app_id
				THEN COALESCE(EXCLUDED.discarded_digest, existing.discarded_digest)
				ELSE EXCLUDED.discarded_digest END,
			discarded_by = CASE WHEN EXCLUDED.remote_app_id = existing.remote_app_id
				THEN COALESCE(EXCLUDED.discarded_by, existing.discarded_by)
				ELSE EXCLUDED.discarded_by END,
			discarded_at = CASE WHEN EXCLUDED.remote_app_id = existing.remote_app_id
				THEN COALESCE(EXCLUDED.discarded_at, existing.discarded_at)
				ELSE EXCLUDED.discarded_at END
		WHERE existing.remote_app_id <> EXCLUDED.remote_app_id
			OR existing.observed_at <= EXCLUDED.observed_at
	`.execute(tx);
}

function compareResourceBaselines(
	left: ResourceBaselineWrite,
	right: ResourceBaselineWrite,
): number {
	if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
	if (left.remoteId === right.remoteId) return 0;
	return left.remoteId < right.remoteId ? -1 : 1;
}

/**
 * Upsert the baselines of the HQ tables and places one push read back,
 * inside a caller's transaction.
 *
 * A row is keyed by the HQ resource within the Project and project space,
 * so two apps of a Project that map one HQ table share it and a sibling's
 * push refreshes what this app compares with. One statement inserts the
 * rows in `(kind, remote_id)` order, so two pushes writing overlapping sets
 * cannot deadlock, and the newer read wins as in `writeAppBaseline`. Where
 * one call names a resource twice, its newer read is the one written, as
 * the guard would leave it. The conflict arm is the Project move's
 * (`lib/db/apps.ts::copyPlaceBaselinesToProject`).
 */
async function writeResourceBaselines(
	tx: Transaction<AppDatabase>,
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	baselines: readonly ResourceBaselineWrite[],
): Promise<void> {
	const newest = new Map<string, ResourceBaselineWrite>();
	for (const baseline of baselines) {
		const key = `${baseline.kind}\u0000${baseline.remoteId}`;
		const held = newest.get(key);
		if (held === undefined || held.observedAt <= baseline.observedAt)
			newest.set(key, baseline);
	}
	const ordered = [...newest.values()].sort(compareResourceBaselines);
	if (ordered.length === 0) return;
	await sql`
		INSERT INTO project_space_resource_baselines AS existing (
			project_id, server, domain, kind, remote_id, origin, canonical,
			digest, observed_at, observed_by, observed_from_app_id,
			discarded_digest, discarded_by, discarded_at
		)
		SELECT ${scope.projectId}, ${target.server}, ${target.domain},
			baseline.kind, baseline.remote_id, baseline.origin,
			baseline.canonical::jsonb, baseline.digest,
			baseline.observed_at::timestamptz, ${scope.actorUserId}, ${scope.appId},
			baseline.discarded_digest,
			CASE WHEN baseline.discarded_digest IS NULL THEN NULL ELSE ${scope.actorUserId} END,
			CASE WHEN baseline.discarded_digest IS NULL THEN NULL ELSE now() END
		FROM unnest(
			${sql.val(ordered.map((baseline) => baseline.kind))}::text[],
			${sql.val(ordered.map((baseline) => baseline.remoteId))}::text[],
			${sql.val(ordered.map((baseline) => baseline.origin))}::text[],
			${sql.val(ordered.map((baseline) => (baseline.canonical === null ? null : JSON.stringify(baseline.canonical))))}::text[],
			${sql.val(ordered.map((baseline) => baseline.digest))}::text[],
			${sql.val(ordered.map((baseline) => baseline.observedAt))}::text[],
			${sql.val(ordered.map((baseline) => baseline.discard?.digest ?? null))}::text[]
		) WITH ORDINALITY AS baseline(
			kind, remote_id, origin, canonical, digest, observed_at,
			discarded_digest, position
		)
		ORDER BY baseline.position
		ON CONFLICT (project_id, server, domain, kind, remote_id) DO UPDATE SET
			origin = EXCLUDED.origin,
			canonical = EXCLUDED.canonical,
			digest = EXCLUDED.digest,
			observed_at = EXCLUDED.observed_at,
			observed_by = EXCLUDED.observed_by,
			observed_from_app_id = EXCLUDED.observed_from_app_id,
			discarded_digest = COALESCE(EXCLUDED.discarded_digest, existing.discarded_digest),
			discarded_by = COALESCE(EXCLUDED.discarded_by, existing.discarded_by),
			discarded_at = COALESCE(EXCLUDED.discarded_at, existing.discarded_at)
		WHERE existing.observed_at <= EXCLUDED.observed_at
	`.execute(tx);
}

/**
 * Record that Nova could not read back some of the tables and places a push
 * may have changed, so the next publish asks before writing over them.
 */
export async function markResourceBaselinesUnread(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	refs: readonly ResourceBaselineRef[],
): Promise<void> {
	if (refs.length === 0) return;
	const observedAt = new Date().toISOString();
	await withDeploymentRow(scope, target, { ensure: false }, async (tx) => {
		await writeResourceBaselines(
			tx,
			scope,
			target,
			refs.map((ref) => ({
				origin: "unread",
				kind: ref.kind,
				remoteId: ref.remoteId,
				canonical: null,
				digest: null,
				observedAt,
				discard: null,
			})),
		);
	});
}

/**
 * The app as CommCare HQ returned it when Nova last read it on this target,
 * or null when no baseline was ever written.
 *
 * `edit`, not `view`: the row holds HQ app source. The stored text is
 * verified against its digest outside any transaction; a row that does not
 * verify is not a read Nova can compare with, so it is logged and returned
 * as `unread`, which stops the next publish to ask.
 */
export async function readAppBaseline(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<AppBaseline | null> {
	if (!roleAllowsApp(scope.role, "edit")) throw deploymentNotFound();
	const db = await getAppDb();
	const row = await db
		.selectFrom("app_deployment_baselines as b")
		.innerJoin("app_deployments as d", "d.id", "b.deployment_id")
		.select([
			"b.deployment_id",
			"b.remote_app_id",
			"b.origin",
			"b.source_gzip",
			"b.source_digest",
			"b.ownership",
			"b.observed_at",
			"b.observed_by",
		])
		.where("d.app_id", "=", scope.appId)
		.where("d.project_id", "=", scope.projectId)
		.where("d.server", "=", target.server)
		.where("d.domain", "=", target.domain)
		.executeTakeFirst();
	if (row === undefined) return null;
	const observed = {
		remoteAppId: row.remote_app_id,
		observedAt: row.observed_at.toISOString(),
		observedBy: row.observed_by,
	};
	if (row.origin === "unread") return { origin: "unread", ...observed };
	if (
		row.origin !== "create" &&
		row.origin !== "push" &&
		row.origin !== "cutover"
	) {
		throw new Error(
			`Deployment ${row.deployment_id} stores an app baseline of origin "${row.origin}", which Nova does not know.`,
		);
	}
	const unverified = (reason: string): AppBaseline => {
		log.error("[deployment] app baseline does not verify", undefined, {
			deploymentId: row.deployment_id,
			reason,
		});
		return { origin: "unread", ...observed };
	};
	if (row.source_gzip === null || row.source_digest === null) {
		return unverified("missing source");
	}
	let text: Buffer;
	try {
		text = gunzipSync(row.source_gzip);
	} catch {
		return unverified("gzip");
	}
	if (createHash("sha256").update(text).digest("hex") !== row.source_digest) {
		return unverified("digest");
	}
	let source: unknown;
	try {
		source = JSON.parse(text.toString("utf8"));
	} catch {
		return unverified("json");
	}
	const ownership = appOwnershipFromRow(row.ownership);
	if (ownership === null) return unverified("ownership");
	return {
		origin: row.origin,
		...observed,
		source,
		sourceDigest: row.source_digest,
		ownership,
	};
}

function stringList(value: unknown): readonly string[] | null {
	return Array.isArray(value) &&
		value.every((item): item is string => typeof item === "string")
		? value
		: null;
}

function appOwnershipFromRow(value: unknown): AppOwnership | null {
	if (typeof value !== "object" || value === null) return null;
	const stored = value as Record<string, unknown>;
	const addOns = stringList(stored.addOns);
	const profileProperties = stringList(stored.profileProperties);
	const profileCustomProperties = stringList(stored.profileCustomProperties);
	if (
		addOns === null ||
		profileProperties === null ||
		profileCustomProperties === null ||
		typeof stored.autoGpsCapture !== "boolean"
	)
		return null;
	return {
		addOns,
		profileProperties,
		profileCustomProperties,
		autoGpsCapture: stored.autoGpsCapture,
	};
}

/**
 * The stored baselines of this Project's HQ tables and places on the
 * target, for the `(kind, remoteId)` pairs `refs` names. A pair with no row
 * is absent from the result, and the caller treats it as `unread`.
 */
export async function readResourceBaselines(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	refs: readonly ResourceBaselineRef[],
): Promise<readonly ResourceBaseline[]> {
	if (!roleAllowsApp(scope.role, "edit")) throw deploymentNotFound();
	if (refs.length === 0) return [];
	const db = await getAppDb();
	const rows = await db
		.selectFrom("project_space_resource_baselines")
		.select([
			"kind",
			"remote_id",
			"origin",
			"canonical",
			"digest",
			"observed_at",
		])
		.where("project_id", "=", scope.projectId)
		.where("server", "=", target.server)
		.where("domain", "=", target.domain)
		.where(
			sql<boolean>`(kind, remote_id) IN (
				SELECT * FROM unnest(
					${sql.val(refs.map((ref) => ref.kind))}::text[],
					${sql.val(refs.map((ref) => ref.remoteId))}::text[]
				)
			)`,
		)
		.execute();
	return rows.map((row): ResourceBaseline => {
		if (row.kind !== "lookup-table" && row.kind !== "location") {
			throw new Error(
				`A resource baseline names a "${row.kind}", which Nova does not know.`,
			);
		}
		const observedAt = row.observed_at.toISOString();
		if (row.origin === "unread") {
			return {
				origin: "unread",
				kind: row.kind,
				remoteId: row.remote_id,
				observedAt,
			};
		}
		if (
			(row.origin !== "push" && row.origin !== "cutover") ||
			row.canonical === null ||
			row.digest === null
		) {
			throw new Error(
				`The baseline of ${row.kind} ${row.remote_id} is stored as "${row.origin}" without the content that origin holds.`,
			);
		}
		return {
			origin: row.origin,
			kind: row.kind,
			remoteId: row.remote_id,
			canonical: row.canonical as unknown as
				| CanonicalLookupTable
				| CanonicalPlace,
			digest: row.digest,
			observedAt,
		};
	});
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
					/* A write that landed on this remote id is CommCare HQ
					 * answering for it, so it is not gone. */
					remote_missing_at: null,
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
	  }
	| {
			/**
			 * Not a push at all: an act OUTSIDE the publish that wrote some
			 * of one kind's resources and separately knows which of that
			 * kind the app still has.
			 *
			 * Provisioning workers is the case. Somebody names three
			 * personas and gets three accounts, which says nothing about the
			 * other twelve personas — so supersession cannot be read off
			 * what the call named, the way a publish's can. What it CAN be
			 * read off is the document: a persona that no longer exists has
			 * an account on the project space that nothing in Nova names any
			 * more, and `stillUsed` is what tells the ledger to stop claiming
			 * it and start reporting it. No rung folds, because provisioning
			 * is not a rung.
			 */
			readonly status: "reconciled";
			readonly kind: DeploymentResourceKind;
			/** Every Nova resource of that kind the app still has. */
			readonly stillUsed: readonly string[];
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
 * superseded here. A RECONCILED write says the same thing about one kind
 * from a list it was handed rather than from what it wrote, which is what
 * an act outside the publish needs. Dropping the last select that read a table, or
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
	/** HQ's reads of what the push left, written with the mappings whatever the outcome. */
	baselines: readonly ResourceBaselineWrite[] = [],
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
			await writeResourceBaselines(tx, scope, target, baselines);
			if (outcome.status === "partial") {
				await notifyAppDeployments(tx, scope.appId);
				return loadWithinTransaction(tx, row.id);
			}
			const supersede = async (
				kind: DeploymentResourceKind,
				stillUsed: readonly string[],
			) => {
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
			};
			if (outcome.status === "reconciled") {
				await supersede(outcome.kind, outcome.stillUsed);
				await notifyAppDeployments(tx, scope.appId);
				return loadWithinTransaction(tx, row.id);
			}
			for (const kind of outcome.kinds) {
				await supersede(
					kind,
					inputs
						.filter((input) => input.kind === kind)
						.map((input) => input.novaResourceId),
				);
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
	/** The accepted push identity read before asking CommCare HQ. A republish
	 * keeps the remote id and may share its timestamp and source revision,
	 * but always gets a fresh token. */
	readonly observedPushToken: string;
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
 * (`observedPushToken`) still match, returning the fresh view either way;
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
				.select(["remote_id", "push_token"])
				.where("deployment_id", "=", row.id)
				.where("kind", "=", "app")
				.where("nova_resource_id", "=", scope.appId)
				.where("superseded_at", "is", null)
				.executeTakeFirst();
			if (
				active === undefined ||
				active.remote_id !== input.observedRemoteId ||
				active.push_token !== input.observedPushToken
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
			/* Whether CommCare HQ holds the app is a fact about the target, so
			 * the mapping carries it: the next publish creates afresh while it
			 * is set. HQ answering for the app again, after its own undo, clears
			 * it. Outside the push-token trigger's columns, so it rotates no
			 * token. */
			const upload = input.outcomes.find(([phase]) => phase === "upload")?.[1];
			const gone =
				upload?.status === "failed" &&
				upload.failure.code === "remote_app_missing";
			const answered = upload?.status === "succeeded";
			if (input.remoteRevision !== null || gone || answered) {
				await tx
					.updateTable("app_deployment_resources")
					.set({
						/* What CommCare HQ says its own version is, kept separate
						 * from the pushed revision on purpose: one is what Nova
						 * sent, the other is what the target holds, and collapsing
						 * them would make a hand-edited remote app look like Nova's
						 * own work. */
						...(input.remoteRevision !== null && {
							remote_revision: input.remoteRevision,
							remote_observed_at: now,
						}),
						...(gone && {
							remote_missing_at: sql<Date>`COALESCE(remote_missing_at, ${now})`,
						}),
						...(answered && { remote_missing_at: null }),
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

/** Invalidate link evidence BEFORE any remote dependency or app mutation. */
export async function beginDeploymentContentWrite(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<string> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			const generation = crypto.randomUUID();
			await tx
				.updateTable("app_deployments")
				.set({ content_generation: generation, entry_point_manifest: null })
				.where("id", "=", row.id)
				.execute();
			return generation;
		},
	);
}

/** Superseded completion proves the remote write order uncertain. Fail closed. */
export async function finishDeploymentContentWrite(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	generation: string,
	manifest: import("./entryPointTypes").PublishedEntryPointManifest | null,
): Promise<boolean> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			if (row.content_generation !== generation) {
				await tx
					.updateTable("app_deployments")
					.set({
						content_generation: crypto.randomUUID(),
						entry_point_manifest: null,
					})
					.where("id", "=", row.id)
					.execute();
				return false;
			}
			const active = await tx
				.selectFrom("app_deployment_resources")
				.select("remote_id")
				.where("deployment_id", "=", row.id)
				.where("kind", "=", "app")
				.where("superseded_at", "is", null)
				.executeTakeFirst();
			const accepted =
				manifest !== null && active?.remote_id === manifest.remoteAppId;
			await tx
				.updateTable("app_deployments")
				.set({
					entry_point_manifest: accepted ? JSON.stringify(manifest) : null,
				})
				.where("id", "=", row.id)
				.execute();
			return accepted;
		},
	);
}

export async function readEntryPointEvidence(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
) {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (_tx, row) => ({
			generation: row.content_generation,
			manifest: row.entry_point_manifest,
			observation: row.entry_point_observation,
		}),
	);
}

/** The observed mapping and content generation must still be current. */
export async function recordEntryPointObservation(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	observation: import("./entryPointTypes").EntryPointObservation,
): Promise<boolean> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false },
		async (tx, row) => {
			const app = await tx
				.selectFrom("apps")
				.select("mutation_seq")
				.where("id", "=", scope.appId)
				.executeTakeFirst();
			if (
				app === undefined ||
				safePersistedSequence(
					app.mutation_seq,
					"entry point observation app.mutation_seq",
				) !== observation.sourceSequence ||
				row.entry_point_manifest?.sourceSequence !== observation.sourceSequence
			)
				return false;
			if (
				row.content_generation !== observation.generation ||
				row.entry_point_manifest?.generation !== observation.generation
			)
				return false;
			const active = await tx
				.selectFrom("app_deployment_resources")
				.select("remote_id")
				.where("deployment_id", "=", row.id)
				.where("kind", "=", "app")
				.where("superseded_at", "is", null)
				.executeTakeFirst();
			if (active?.remote_id !== observation.remoteAppId) return false;
			await tx
				.updateTable("app_deployments")
				.set({ entry_point_observation: JSON.stringify(observation) })
				.where("id", "=", row.id)
				.execute();
			return true;
		},
	);
}
