import "server-only";

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
	type Kysely,
	type Selectable,
	type SqlBool,
	sql,
	type Transaction,
} from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import type { HqAppsSeen } from "@/lib/commcare/hq/apps";
import { parseHqJsonText } from "@/lib/commcare/hq/jsonText";
import type { CommCareServer } from "@/lib/commcare/servers";
import {
	type TargetFacts,
	targetFactsFromSource,
} from "@/lib/commcare/targetFacts";
import type { ColumnFieldWordRow } from "@/lib/commcare/wireIdentity";
import {
	admitRemoteWritesInTransaction,
	endDeploymentInTransaction,
	HqAppAlreadyClaimedError,
	type HqRemoteWriteKind,
	isHqAppClaimIndexViolation,
	lockHqApp,
	lockReleasedClaimsInTransaction,
	type SettledClaims,
	settleReleasedClaimsInTransaction,
} from "@/lib/db/hqAppClaims";
import { openRemoteWrite } from "@/lib/db/openRemoteWrite";
import {
	type AppDatabase,
	type AppDeploymentResourcesTable,
	type AppDeploymentsTable,
	getAppDb,
	notifyAppDeployments,
	withAppTx,
} from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { asUuid } from "@/lib/domain/uuid";
import { log } from "@/lib/logger";
import { lockLookupTablesForPublishInTransaction } from "@/lib/lookup/managed";
import {
	FIRST_PUBLISH_CHANGE_IDS,
	type FirstPublishChangeId,
	type FirstPublishView,
	type StoredFirstPublish,
	storedFirstPublishSchema,
} from "@/lib/publish/firstPublishChangeIds";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { heldMediaPathRows } from "./adoption";
import type { PublishedEntryPointManifest } from "./entryPointTypes";
import {
	APP_DELETED_READ,
	APP_DELETED_WRITE,
	DeploymentAppDeletedError,
	DeploymentEndedError,
	DeploymentError,
	deploymentNotFound,
} from "./errors";
import { type HqMediaRecord, hqMediaRecordSchema } from "./hqMedia";
import { type FirstPublishState, publishedRemoteApp } from "./resources";
import {
	applyAttemptOutcome,
	applyObservation,
	applyPhaseOutcome,
	clearObservationOutcomes,
	deploymentDisplaysAsReached,
} from "./stateMachine";
import {
	canonicalTargetIdentity,
	EMPTY_TARGET_IDENTITY,
	sameTargetIdentity,
	type TargetIdentity,
} from "./targetIdentity";
import {
	type AppBaseline,
	type AppBaselineWrite,
	type AppOwnership,
	type CanonicalLookupTable,
	type CanonicalPlace,
	confirmationSubject,
	DEPLOYMENT_CONFIRMATION_KINDS,
	DEPLOYMENT_END_REASONS,
	type DeploymentConfirmation,
	type DeploymentConfirmationKey,
	type DeploymentConfirmationKind,
	type DeploymentEndReason,
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
 * The one authorization every deployment read and write makes of the app row
 * it read, so the two answer a deleted app alike and cannot disagree on who
 * is told. A missing app, an app in another Project than the scope's, and a
 * caller who is no member there or lacks `capability` are the plain
 * not-found, in that order and before the deletion is looked at; only then is
 * an app in recently deleted `DeploymentAppDeletedError`, in `act`'s words, so
 * nobody but a member allowed the act learns the app was deleted.
 *
 * `roleIn` reads the caller's role in the app's Project in the caller's
 * transaction: a write locks the membership it reads, a read-only snapshot
 * cannot. Answers the role, as `auth_member` stores it (possibly several
 * roles, comma-joined), for a caller that asks more of it than `capability`.
 */
async function authorizeDeploymentApp(
	app:
		| {
				readonly project_id: string | null;
				readonly deleted_at: Date | null;
		  }
		| undefined,
	scope: DeploymentScope,
	capability: AppCapability,
	act: "read" | "write",
	roleIn: (projectId: string) => Promise<string | null>,
): Promise<string> {
	if (
		app === undefined ||
		app.project_id === null ||
		app.project_id !== scope.projectId
	)
		throw deploymentNotFound();
	const role = await roleIn(app.project_id);
	if (role === null || !roleAllowsApp(role, capability))
		throw deploymentNotFound();
	if (app.deleted_at !== null)
		throw new DeploymentAppDeletedError(
			act === "read" ? APP_DELETED_READ : APP_DELETED_WRITE,
		);
	return role;
}

/**
 * Take the app row, then re-prove the caller against the Project the lock
 * just froze (`authorizeDeploymentApp`, as a write).
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
): Promise<string> {
	const app = await tx
		.selectFrom("apps")
		.select(["project_id", "deleted_at"])
		.where("id", "=", scope.appId)
		.forShare()
		.executeTakeFirst();
	return authorizeDeploymentApp(app, scope, capability, "write", (projectId) =>
		projectRoleForInTransaction(tx, scope.actorUserId, projectId),
	);
}

declare const DEPLOYMENT_READ_SNAPSHOT: unique symbol;

/**
 * One moment of an app's deployments, read by a caller authorized at that
 * moment. Made only by `withDeploymentReadSnapshot`, which proves, as its
 * first statement inside the snapshot, that the app is the scope's Project's,
 * not deleted, and that the caller holds the capability there, so every read
 * that takes one answers from that one generation for a caller allowed to see
 * it. A ledger, a name or a baseline loaded by a deployment's id (which
 * outlives a Project move) is read only through one of these or through a
 * write transaction that holds the app and deployment rows
 * (`withDeploymentRow`).
 */
export interface DeploymentReadSnapshot {
	readonly scope: DeploymentScope;
	readonly db: Transaction<AppDatabase>;
	/** The caller's role as the snapshot read it. */
	readonly role: string;
	readonly [DEPLOYMENT_READ_SNAPSHOT]: true;
}

/** Where a deployment read reads: its own snapshot opened for `scope`, or the caller's. */
export type DeploymentReadFrom = DeploymentScope | DeploymentReadSnapshot;

/**
 * Run `body` in one read-only repeatable-read snapshot of the app's
 * deployments, authorized inside it at `capability`. A missing app, one in
 * another Project, and a caller who is no member there or lacks the
 * capability are the existing not-found; an app in recently deleted, for a
 * caller who passes all of that, is `DeploymentAppDeletedError`, so a surface
 * can tell its member the app was deleted. It takes no row lock, so it
 * neither waits behind a commit nor holds one up, and it pins one pooled
 * connection for a few short statements: no request to CommCare HQ is ever
 * made inside it.
 */
export async function withDeploymentReadSnapshot<T>(
	scope: DeploymentScope,
	capability: AppCapability,
	body: (snapshot: DeploymentReadSnapshot) => Promise<T>,
): Promise<T> {
	if (!roleAllowsApp(scope.role, capability)) throw deploymentNotFound();
	return withAppTx(
		async (tx) => {
			await sql`SET TRANSACTION READ ONLY`.execute(tx);
			const app = await tx
				.selectFrom("apps")
				.select(["project_id", "deleted_at"])
				.where("id", "=", scope.appId)
				.executeTakeFirst();
			const role = await authorizeDeploymentApp(
				app,
				scope,
				capability,
				"read",
				async (projectId) => {
					const member = await sql<{ role: string }>`
						SELECT role FROM auth_member
						WHERE "userId" = ${scope.actorUserId}
							AND "organizationId" = ${projectId}
					`.execute(tx);
					return member.rows[0]?.role ?? null;
				},
			);
			return body({ scope, db: tx, role } as DeploymentReadSnapshot);
		},
		{ isolationLevel: "repeatable read" },
	);
}

/**
 * Why a not-found met by a long act (a publish, whose reads outside this
 * store answer a deleted app as missing) is one: the app's deletion, told as
 * `authorizeDeploymentApp` tells it, where the caller is a member allowed
 * `capability`, and null for every other cause, which stays the plain
 * not-found.
 */
export async function deploymentAppDeletion(
	scope: DeploymentScope,
	capability: AppCapability,
): Promise<DeploymentAppDeletedError | null> {
	try {
		await withDeploymentReadSnapshot(scope, capability, async () => undefined);
		return null;
	} catch (error) {
		if (error instanceof DeploymentAppDeletedError) return error;
		if (error instanceof DeploymentError && error.code === "not_found")
			return null;
		throw error;
	}
}

/** `body` over `from`: in the caller's snapshot where it hands one, else in one of its own. */
async function readingIn<T>(
	from: DeploymentReadFrom,
	capability: AppCapability,
	body: (snapshot: DeploymentReadSnapshot) => Promise<T>,
): Promise<T> {
	if (!("db" in from))
		return withDeploymentReadSnapshot(from, capability, body);
	if (!roleAllowsApp(from.role, capability)) throw deploymentNotFound();
	return body(from);
}

/** A write transaction holding the app and deployment rows, as a ledger reader takes it. */
declare const LOCKED_LEDGER: unique symbol;
type LockedLedger = Transaction<AppDatabase> & {
	readonly [LOCKED_LEDGER]: true;
};

/** What may load a ledger by deployment id: an authorized snapshot or a locked write. */
type LedgerReader = DeploymentReadSnapshot | LockedLedger;

function ledgerDb(reader: LedgerReader): Transaction<AppDatabase> {
	return "scope" in reader ? reader.db : reader;
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
		endings: row.endings,
	};
}

function isEndReason(value: string): value is DeploymentEndReason {
	return (DEPLOYMENT_END_REASONS as readonly string[]).includes(value);
}

/**
 * Turn a stored mapping into a resource. `names` holds `auth_user.name` for
 * each person the ledger names (`adopted_by`, `ended_by`) who still exists;
 * one who does not reads as a former member.
 */
function toDeploymentResource(
	row: Selectable<AppDeploymentResourcesTable> & {
		readonly held_by_another_app: SqlBool;
	},
	names: ReadonlyMap<string, string>,
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
	const endedReason = row.ended_reason;
	if (endedReason !== null && !isEndReason(endedReason)) {
		throw new Error(
			`A deployment records that it ended for the reason "${endedReason}", which Nova does not know.`,
		);
	}
	const nameOf = (userId: string | null): string | null =>
		userId === null ? null : (names.get(userId) ?? FORMER_MEMBER_NAME);
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
		adoptedByName: nameOf(row.adopted_by),
		releasedAt: isoOrNull(row.released_at),
		endedReason,
		endedByName: endedReason === null ? null : nameOf(row.ended_by),
		heldByAnotherApp: row.held_by_another_app === true,
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
 * confirmation, an adoption and an ending name their person by
 * `auth_user.name`, read only for the people the rows name, and a user who
 * no longer exists reads as a former member.
 */
async function loadResources(
	reader: LedgerReader,
	deploymentIds: readonly string[],
): Promise<Map<string, DeploymentLedger>> {
	if (deploymentIds.length === 0) return new Map();
	const db = ledgerDb(reader);
	const ids = [...deploymentIds];
	/* A superseded `app` mapping whose HQ app another deployment now holds by
	 * the claim's own predicate (live, unreleased) belongs to that Nova app,
	 * so the left-behind report must never name it here. */
	const resourceRows = await db
		.selectFrom("app_deployment_resources as r")
		.selectAll("r")
		.select((eb) =>
			eb
				.and([
					eb("r.kind", "=", "app"),
					eb("r.superseded_at", "is not", null),
					eb.exists(
						eb
							.selectFrom("app_deployment_resources as holder")
							.select(sql<number>`1`.as("one"))
							.whereRef("holder.server", "=", "r.server")
							.whereRef("holder.domain", "=", "r.domain")
							.whereRef("holder.remote_id", "=", "r.remote_id")
							.whereRef("holder.deployment_id", "<>", "r.deployment_id")
							.where("holder.kind", "=", "app")
							.where("holder.superseded_at", "is", null)
							.where("holder.released_at", "is", null),
					),
				])
				.as("held_by_another_app"),
		)
		.where("r.deployment_id", "in", ids)
		.orderBy("r.created_at", "asc")
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
	const names = await confirmerNames(reader, [
		...confirmationRows.map((row) => row.confirmed_by),
		...resourceRows.flatMap((row) =>
			[row.adopted_by, row.ended_by].filter(
				(userId): userId is string => userId !== null,
			),
		),
	]);
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
		const resource = toDeploymentResource(row, names);
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

/** `auth_user.name` for each user the ledger names who still exists. */
async function confirmerNames(
	reader: LedgerReader,
	userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	const distinct = [...new Set(userIds)];
	if (distinct.length === 0) return new Map();
	const rows = await sql<{ id: string; name: string }>`
		SELECT id, name FROM auth_user WHERE id = ANY(${distinct}::text[])
	`.execute(ledgerDb(reader));
	return new Map(rows.rows.map((row) => [row.id, row.name]));
}

/**
 * The name of each member a deployment's surface names by user id, as
 * `adoptedByName` resolves one: `auth_user.name` where the user still
 * exists, and no entry where not. A review of changes made in CommCare HQ
 * names who changed the app since the publish, and who moved its head,
 * each read in the caller's authorized snapshot.
 */
export async function readMemberNames(
	snapshot: DeploymentReadSnapshot,
	userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	return confirmerNames(snapshot, userIds);
}

/**
 * The name of the Project a scope stands in, which a review of changes made
 * in CommCare HQ names where a table it newly reads asks its choice. A
 * scope is resolved from a membership of that Project, and no Project is
 * deleted, so the row is there.
 */
export async function readProjectName(scope: DeploymentScope): Promise<string> {
	const rows = await sql<{ name: string }>`
		SELECT name FROM auth_organization WHERE id = ${scope.projectId}
	`.execute(await getAppDb());
	const name = rows.rows[0]?.name;
	if (name === undefined)
		throw new Error(
			`Nova looked for the name of Project ${scope.projectId} to word a review of changes made in CommCare HQ, and found no such Project. A deployment scope comes from a membership of its Project, so check how this scope was built.`,
		);
	return name;
}

/**
 * Every deployment of one app, newest activity first, each with its ledger,
 * all from one authorized snapshot (`withDeploymentReadSnapshot`): a move or
 * a stop that commits while it reads is wholly before it or wholly after it,
 * never a record from one Project with a ledger written in another. It takes
 * no lock, so rendering a list never serializes against a commit.
 */
export async function readDeploymentsForApp(
	from: DeploymentReadFrom,
): Promise<readonly DeploymentWithResources[]> {
	return readingIn(from, "view", async (snapshot) => {
		const { scope } = snapshot;
		const rows = await snapshot.db
			.selectFrom("app_deployments")
			.selectAll()
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.orderBy("updated_at", "desc")
			.execute();
		const resources = await loadResources(
			snapshot,
			rows.map((row) => row.id),
		);
		return rows.map((row) => ({
			deployment: toDeploymentRecord(row),
			...(resources.get(row.id) ?? NO_DEPLOYMENT_LEDGER),
		}));
	});
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
	from: DeploymentReadFrom,
): Promise<
	readonly Pick<
		DeploymentRecord,
		"state" | "resumePhase" | "server" | "domain"
	>[]
> {
	return readingIn(from, "view", (snapshot) => previewRecordsIn(snapshot));
}

async function previewRecordsIn(
	snapshot: DeploymentReadSnapshot,
): Promise<
	readonly Pick<
		DeploymentRecord,
		"state" | "resumePhase" | "server" | "domain"
	>[]
> {
	const { scope } = snapshot;
	/* A deployment whose live app mapping is released still displays as
	 * uploaded, but no publish goes there until a settle takes the HQ app
	 * back, so Preview does not name its project space. */
	const rows = await snapshot.db
		.selectFrom("app_deployments as d")
		.select(["d.state", "d.resume_phase", "d.server", "d.domain"])
		.where("d.app_id", "=", scope.appId)
		.where("d.project_id", "=", scope.projectId)
		.where(({ not, exists, selectFrom }) =>
			not(
				exists(
					selectFrom("app_deployment_resources as r")
						.select(sql<number>`1`.as("one"))
						.whereRef("r.deployment_id", "=", "d.id")
						.where("r.kind", "=", "app")
						.where("r.superseded_at", "is", null)
						.where("r.released_at", "is not", null),
				),
			),
		)
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

/** One deployment by target with its ledger, from one authorized snapshot, or `null` when the
 *  app has never had one. */
export async function readDeployment(
	from: DeploymentReadFrom,
	target: DeploymentTargetKey,
): Promise<DeploymentWithResources | null> {
	return readingIn(from, "view", async (snapshot) => {
		const { scope } = snapshot;
		const row = await snapshot.db
			.selectFrom("app_deployments")
			.selectAll()
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.where("server", "=", target.server)
			.where("domain", "=", target.domain)
			.executeTakeFirst();
		if (row === undefined) return null;
		const resources = await loadResources(snapshot, [row.id]);
		return {
			deployment: toDeploymentRecord(row),
			...(resources.get(row.id) ?? NO_DEPLOYMENT_LEDGER),
		};
	});
}

/**
 * The revision of this app that CommCare HQ's copy was last known to match,
 * for each of the app's deployments, by deployment id: the `nova_revision`
 * of a baseline Nova read of the HQ app the live app mapping names. A
 * deployment whose baseline is unread, describes no revision or is of
 * another HQ app has no entry. After changes made in CommCare HQ are
 * brought in, it is the revision that holds them, which `pushed_revision`
 * is not, so a surface that compares the app's head with it does not read a
 * brought-in change as one waiting to be published.
 *
 * Kept out of `DeploymentWithResources` on purpose, as the identities are:
 * the deployment surfaces that project it read it beside the record, and
 * no fold or publish needs it. It reads no source.
 */
export async function readDeploymentNovaRevisions(
	from: DeploymentReadFrom,
): Promise<ReadonlyMap<string, number>> {
	return readingIn(from, "view", (snapshot) => novaRevisionsIn(snapshot));
}

async function novaRevisionsIn(
	snapshot: DeploymentReadSnapshot,
): Promise<ReadonlyMap<string, number>> {
	const { scope } = snapshot;
	const rows = await snapshot.db
		.selectFrom("app_deployment_baselines as b")
		.innerJoin("app_deployments as d", "d.id", "b.deployment_id")
		.innerJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "b.deployment_id")
				.onRef("r.remote_id", "=", "b.remote_app_id"),
		)
		.select(["b.deployment_id", "b.nova_revision"])
		.where("d.app_id", "=", scope.appId)
		.where("d.project_id", "=", scope.projectId)
		.where("r.kind", "=", "app")
		.where("r.superseded_at", "is", null)
		.where((eb) =>
			eb.or([
				eb("b.origin", "in", ["read", "changes"]),
				eb.and([
					eb("b.origin", "=", "push"),
					eb("b.nova_revision", "=", eb.ref("r.pushed_revision")),
				]),
			]),
		)
		.where("b.nova_revision", "is not", null)
		.execute();
	const revisions = new Map<string, number>();
	for (const row of rows) {
		const revision = numberOrNull(row.nova_revision);
		if (revision !== null) revisions.set(row.deployment_id, revision);
	}
	return revisions;
}

/**
 * What a deployment on `target` holds of where CommCare HQ keeps things
 * (`targetIdentity.ts::TargetIdentity`): the ids of its menus and forms that
 * are not the derivation, the prefix each keyed create's cases stand under,
 * and the path each media file is kept at, each media row read through
 * `adoption.ts::heldMediaPathRows` (a row the rule refuses is logged and its
 * file takes its derived path). The empty record for a target this app has no
 * deployment on. THE ONE READER: a publish, a `.ccz`, the HQ import file,
 * preflight and a review of changes made in CommCare HQ read it, and
 * `targetIdentity.ts::exportIdentityOf` is what each prints under.
 *
 * Kept out of `DeploymentWithResources` on purpose: no status read carries it.
 */
export async function readTargetIdentity(
	from: DeploymentReadFrom,
	target: DeploymentTargetKey,
): Promise<TargetIdentity> {
	return readingIn(from, "view", async (snapshot) => {
		const { scope } = snapshot;
		const deployment = await snapshot.db
			.selectFrom("app_deployments")
			.select("id")
			.where("app_id", "=", scope.appId)
			.where("project_id", "=", scope.projectId)
			.where("server", "=", target.server)
			.where("domain", "=", target.domain)
			.executeTakeFirst();
		if (deployment === undefined) return EMPTY_TARGET_IDENTITY;
		return readTargetIdentityRows(snapshot.db, deployment.id, {
			appId: scope.appId,
			server: target.server,
		});
	});
}

/** The record's rows of one deployment, through `db` or a caller's transaction. */
async function readTargetIdentityRows(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	deploymentId: string,
	context: { readonly appId: string; readonly server: string },
): Promise<TargetIdentity> {
	const [entityRows, keyedRows, pathRows, wordRows] = await Promise.all([
		db
			.selectFrom("app_deployment_identities")
			.select(["entity_kind", "nova_entity_uuid", "unique_id", "xmlns"])
			.where("deployment_id", "=", deploymentId)
			.execute(),
		db
			.selectFrom("app_deployment_keyed_case_ids")
			.select(["nova_operation_uuid", "case_type", "case_id_prefix"])
			.where("deployment_id", "=", deploymentId)
			.execute(),
		db
			.selectFrom("app_deployment_media_paths")
			.select(["media_asset_id", "wire_path"])
			.where("deployment_id", "=", deploymentId)
			.execute(),
		db
			.selectFrom("app_deployment_column_field_words")
			.select(["nova_column_uuid", "screen", "field_word"])
			.where("deployment_id", "=", deploymentId)
			.execute(),
	]);
	const entities = entityRows.map((row): DeploymentIdentityOverride => {
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
	const { held, notHoldable } = heldMediaPathRows(
		pathRows.map((row) => ({
			assetId: row.media_asset_id,
			wirePath: row.wire_path,
		})),
	);
	if (notHoldable.length > 0)
		/* The assets alone: a path is the app's own words. */
		log.error(
			"[deployment] a held media path is no path a file can keep",
			undefined,
			{
				appId: context.appId,
				server: context.server,
				assetIds: notHoldable,
			},
		);
	return canonicalTargetIdentity({
		entities,
		keyedCaseIds: keyedRows.map((row) => ({
			operationUuid: asUuid(row.nova_operation_uuid),
			caseType: row.case_type,
			prefix: row.case_id_prefix,
		})),
		mediaPaths: [...held].map(([assetId, wirePath]) => ({
			assetId,
			wirePath,
		})),
		columnWords: wordRows.map((row): ColumnFieldWordRow => {
			if (row.screen !== "short" && row.screen !== "long")
				throw new Error(
					`A deployment records a case list column's word on a "${row.screen}" screen, which CommCare HQ does not have.`,
				);
			return {
				columnUuid: row.nova_column_uuid,
				screen: row.screen,
				word: row.field_word,
			};
		}),
	});
}

/**
 * The record a reading resolved (`targetIdentity.ts::resolveTargetIdentity`)
 * did not resolve over what the deployment holds now: another write moved it
 * between the read that resolved and this one. Nothing was written.
 */
class TargetIdentityMovedError extends Error {
	constructor(deploymentId: string) {
		super(
			`Deployment ${deploymentId} holds other ids, keyed case prefixes, media paths or case list column words than the reading that is being recorded resolved over, so nothing was recorded. Another write landed in between; the caller works the record out again over what is stored now.`,
		);
		this.name = "TargetIdentityMovedError";
	}
}

/**
 * THE ONE WRITER of a deployment's target-identity record, inside a caller's
 * transaction that holds the deployment row (a birth's new row, or the row
 * `FOR UPDATE`): where the rows stored are still `read`, the record the caller
 * resolved over, it writes the difference to `next`, deleting each row
 * `next` does not hold and inserting each it adds, so a row the record keeps
 * keeps its date. Otherwise it throws `TargetIdentityMovedError` and writes
 * nothing. The runtime role inserts and deletes these rows and updates none.
 * An ending and a Project move are the only other writers of these tables.
 */
export async function writeTargetIdentityInTransaction(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	context: { readonly appId: string; readonly server: string },
	write: { readonly read: TargetIdentity; readonly next: TargetIdentity },
): Promise<void> {
	const stored = await readTargetIdentityRows(tx, deploymentId, context);
	if (!sameTargetIdentity(stored, write.read))
		throw new TargetIdentityMovedError(deploymentId);
	const next = canonicalTargetIdentity(write.next);
	const entityKey = (row: DeploymentIdentityOverride) =>
		JSON.stringify([
			row.entityKind,
			row.novaEntityUuid,
			row.uniqueId,
			row.xmlns,
		]);
	const keyedKey = (row: TargetIdentity["keyedCaseIds"][number]) =>
		JSON.stringify([row.operationUuid, row.caseType, row.prefix]);
	const pathKey = (row: TargetIdentity["mediaPaths"][number]) =>
		JSON.stringify([row.assetId, row.wirePath]);
	const wordKey = (row: TargetIdentity["columnWords"][number]) =>
		JSON.stringify([row.columnUuid, row.screen, row.word]);
	const without = <T>(
		rows: readonly T[],
		others: readonly T[],
		key: (row: T) => string,
	) => {
		const kept = new Set(others.map(key));
		return rows.filter((row) => !kept.has(key(row)));
	};

	/* Every stored row, read whole: a media row the read rule refused is no
	 * row of `stored`, and it goes too. */
	const storedPathRows = await tx
		.selectFrom("app_deployment_media_paths")
		.select(["media_asset_id", "wire_path"])
		.where("deployment_id", "=", deploymentId)
		.execute();
	const goneEntities = without(stored.entities, next.entities, entityKey);
	for (const row of goneEntities)
		await tx
			.deleteFrom("app_deployment_identities")
			.where("deployment_id", "=", deploymentId)
			.where("entity_kind", "=", row.entityKind)
			.where("nova_entity_uuid", "=", row.novaEntityUuid)
			.execute();
	const goneKeyed = without(stored.keyedCaseIds, next.keyedCaseIds, keyedKey);
	if (goneKeyed.length > 0)
		await tx
			.deleteFrom("app_deployment_keyed_case_ids")
			.where("deployment_id", "=", deploymentId)
			.where(
				"nova_operation_uuid",
				"in",
				goneKeyed.map((row) => row.operationUuid),
			)
			.execute();
	const keptPaths = new Set(next.mediaPaths.map(pathKey));
	const gonePaths = storedPathRows.filter(
		(row) =>
			!keptPaths.has(
				pathKey({ assetId: row.media_asset_id, wirePath: row.wire_path }),
			),
	);
	if (gonePaths.length > 0)
		await tx
			.deleteFrom("app_deployment_media_paths")
			.where("deployment_id", "=", deploymentId)
			.where(
				"media_asset_id",
				"in",
				gonePaths.map((row) => row.media_asset_id),
			)
			.execute();

	const goneWords = without(stored.columnWords, next.columnWords, wordKey);
	for (const row of goneWords)
		await tx
			.deleteFrom("app_deployment_column_field_words")
			.where("deployment_id", "=", deploymentId)
			.where("nova_column_uuid", "=", row.columnUuid)
			.where("screen", "=", row.screen)
			.execute();

	const newEntities = without(next.entities, stored.entities, entityKey);
	if (newEntities.length > 0)
		await tx
			.insertInto("app_deployment_identities")
			.values(
				newEntities.map((row) => ({
					deployment_id: deploymentId,
					entity_kind: row.entityKind,
					nova_entity_uuid: row.novaEntityUuid,
					unique_id: row.uniqueId,
					xmlns: row.xmlns,
				})),
			)
			.execute();
	const newKeyed = without(next.keyedCaseIds, stored.keyedCaseIds, keyedKey);
	if (newKeyed.length > 0)
		await tx
			.insertInto("app_deployment_keyed_case_ids")
			.values(
				newKeyed.map((row) => ({
					deployment_id: deploymentId,
					nova_operation_uuid: row.operationUuid,
					case_type: row.caseType,
					case_id_prefix: row.prefix,
				})),
			)
			.execute();
	const storedPaths = new Set(
		storedPathRows.map((row) =>
			pathKey({ assetId: row.media_asset_id, wirePath: row.wire_path }),
		),
	);
	const newPaths = next.mediaPaths.filter(
		(row) => !storedPaths.has(pathKey(row)),
	);
	if (newPaths.length > 0)
		await tx
			.insertInto("app_deployment_media_paths")
			.values(
				newPaths.map((row) => ({
					deployment_id: deploymentId,
					media_asset_id: row.assetId,
					wire_path: row.wirePath,
				})),
			)
			.execute();
	const newWords = without(next.columnWords, stored.columnWords, wordKey);
	if (newWords.length > 0)
		await tx
			.insertInto("app_deployment_column_field_words")
			.values(
				newWords.map((row) => ({
					deployment_id: deploymentId,
					nova_column_uuid: row.columnUuid,
					screen: row.screen,
					field_word: row.word,
				})),
			)
			.execute();
}

/** One live lookup-table mapping another app of the Project holds on a project space. */
export interface SiblingLookupMapping {
	readonly tableId: string;
	readonly appId: string;
	readonly remoteId: string;
	readonly pushedIdentity: string;
	readonly ownership: DeploymentResourceOwnership;
	readonly adoptedAt: string | null;
	readonly adoptedBy: string | null;
}

/**
 * Live lookup-table mappings of the Project's other apps on one project
 * space, for the tables named: every app of the Project but `scope.appId`,
 * an app in recently deleted and a deployment that was ended included, since
 * what either put in CommCare HQ is still there. A mapping with no pushed
 * name says nothing about which table CommCare HQ holds under a tag, so it is
 * left out. Ordered by table, then the earliest adoption, then the oldest
 * mapping. `view`.
 *
 * A bring-in's read passes the app's derived id, which names no deployment
 * yet, so every app of the Project is a sibling; the birth passes its
 * transaction, so the answer is read under the locks it holds.
 */
export async function readSiblingLookupMappings(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	tableIds: readonly string[],
	tx?: Transaction<AppDatabase>,
): Promise<readonly SiblingLookupMapping[]> {
	if (!roleAllowsApp(scope.role, "view")) throw deploymentNotFound();
	if (tableIds.length === 0) return [];
	const db = tx ?? (await getAppDb());
	const rows = await db
		.selectFrom("app_deployment_resources as r")
		.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
		.select([
			"r.nova_resource_id",
			"d.app_id",
			"r.remote_id",
			"r.pushed_identity",
			"r.ownership",
			"r.adopted_at",
			"r.adopted_by",
		])
		.where("d.project_id", "=", scope.projectId)
		.where("d.server", "=", target.server)
		.where("d.domain", "=", target.domain)
		.where("d.app_id", "<>", scope.appId)
		.where("r.kind", "=", "lookup-table")
		.where("r.superseded_at", "is", null)
		.where("r.pushed_identity", "is not", null)
		.where("r.nova_resource_id", "in", [...tableIds])
		.orderBy("r.nova_resource_id")
		.orderBy("r.adopted_at", (order) => order.asc().nullsLast())
		.orderBy("r.created_at")
		.orderBy("r.id")
		.execute();
	return rows.map((row) => {
		const ownership = deploymentResourceOwnershipSchema.safeParse(
			row.ownership,
		);
		if (!ownership.success) {
			throw new Error(
				`A deployment records "${row.ownership}" ownership, which Nova does not know.`,
			);
		}
		if (row.pushed_identity === null) {
			throw new Error(
				"A lookup table mapping read for its pushed name holds none.",
			);
		}
		return {
			tableId: row.nova_resource_id,
			appId: row.app_id,
			remoteId: row.remote_id,
			pushedIdentity: row.pushed_identity,
			ownership: ownership.data,
			adoptedAt: isoOrNull(row.adopted_at),
			adoptedBy: row.adopted_by,
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
	/** The live app mapping is one Nova brought in (`ownership` `adopted`). */
	readonly adopted: boolean;
}

/**
 * Every project space this app's content is on: each deployment that
 * displays as uploaded and whose live app mapping is not reported gone and
 * holds content. A mapping to the empty shell of a first publish is never
 * among them, whatever the record displays.
 */
export async function readReachedDeploymentTargets(
	from: DeploymentReadFrom,
): Promise<readonly ReachedDeploymentTargetRow[]> {
	const deployments = await readDeploymentsForApp(from);
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
				adopted: remote.ownership === "adopted",
			},
		];
	});
}

/** Who holds an HQ app that is already in Nova, as the viewer may know it. */
export type HqAppClaimView =
	/** The viewer is a member of the holding Project. */
	| {
			readonly remoteAppId: string;
			readonly kind: "open";
			readonly appId: string;
			readonly appName: string;
	  }
	| {
			readonly remoteAppId: string;
			readonly kind: "elsewhere";
			/** When the holder's mapping began: `adopted_at`, or the mapping's `created_at`. */
			readonly at: string;
			/** Who to ask: the person who brought the app in or first published it there, while they
			 *  are a member of that Project, else its owners. */
			readonly contact: {
				readonly role: "person" | "owners";
				readonly names: readonly string[];
			};
	  };

interface HqAppClaimRow {
	readonly remote_id: string;
	readonly app_id: string;
	readonly app_name: string;
	readonly began_at: Date;
	readonly viewer_is_member: boolean;
	readonly person_is_member: boolean;
	readonly person_name: string | null;
	readonly owner_names: readonly (string | null)[];
}

/**
 * Which of these CommCare HQ apps a live Nova app already publishes to, as
 * the viewer may know each holder. An HQ app no live Nova app holds is
 * absent: it is free. A holder in recently deleted holds nothing.
 *
 * Advice for the picker and the reading, never authority: the claim itself
 * is decided by `lib/db/hqAppClaims.ts::claimHqAppInTransaction` in the
 * birth's transaction. It answers only about apps CommCare HQ itself said,
 * in this request, the key reaches (`seen`, which only HQ's list and HQ's
 * answer with an app's document make), so a key HQ no longer answers learns
 * nothing of who holds an app; this reads nothing of CommCare HQ. For a
 * Project the viewer is not part of, neither the Project's name nor the
 * app's is returned.
 */
export async function readHqAppClaims(input: {
	readonly viewerUserId: string;
	readonly seen: HqAppsSeen;
}): Promise<readonly HqAppClaimView[]> {
	const { server, domain } = input.seen;
	const remoteAppIds = [...input.seen.remoteAppIds];
	if (remoteAppIds.length === 0) return [];
	const db = await getAppDb();
	/* The person is whoever began the mapping: the adopter of an adopted one,
	 * the deployment's creator for one Nova created. */
	const { rows } = await sql<HqAppClaimRow>`
		SELECT mapping.remote_id, app.id AS app_id, app.app_name,
			COALESCE(mapping.adopted_at, mapping.created_at) AS began_at,
			EXISTS (
				SELECT 1 FROM auth_member AS viewer
				WHERE viewer."organizationId" = app.project_id
					AND viewer."userId" = ${input.viewerUserId}
			) AS viewer_is_member,
			EXISTS (
				SELECT 1 FROM auth_member AS person_member
				WHERE person_member."organizationId" = app.project_id
					AND person_member."userId" = holder.person_id
			) AS person_is_member,
			person.name AS person_name,
			ARRAY(
				SELECT owner_user.name
				FROM auth_member AS owner_member
				LEFT JOIN auth_user AS owner_user ON owner_user.id = owner_member."userId"
				WHERE owner_member."organizationId" = app.project_id
					AND 'owner' = ANY(string_to_array(owner_member.role, ','))
				ORDER BY owner_user.name COLLATE "C", owner_member."userId" COLLATE "C"
			) AS owner_names
		FROM app_deployment_resources AS mapping
		JOIN app_deployments AS deployment ON deployment.id = mapping.deployment_id
		JOIN apps AS app ON app.id = deployment.app_id AND app.deleted_at IS NULL
		CROSS JOIN LATERAL (
			SELECT CASE WHEN mapping.ownership = 'adopted'
				THEN mapping.adopted_by ELSE deployment.created_by END AS person_id
		) AS holder
		LEFT JOIN auth_user AS person ON person.id = holder.person_id
		WHERE mapping.server = ${server} AND mapping.domain = ${domain}
			AND mapping.remote_id = ANY(${remoteAppIds}::text[])
			AND mapping.kind = 'app' AND mapping.superseded_at IS NULL
			AND mapping.released_at IS NULL
		ORDER BY mapping.remote_id COLLATE "C"
	`.execute(db);
	return rows.map((row): HqAppClaimView => {
		if (row.viewer_is_member) {
			return {
				remoteAppId: row.remote_id,
				kind: "open",
				appId: row.app_id,
				appName: row.app_name,
			};
		}
		return {
			remoteAppId: row.remote_id,
			kind: "elsewhere",
			at: row.began_at.toISOString(),
			contact: row.person_is_member
				? {
						role: "person",
						names: [row.person_name ?? FORMER_MEMBER_NAME],
					}
				: {
						role: "owners",
						names: row.owner_names.map((name) => name ?? FORMER_MEMBER_NAME),
					},
		};
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
	/* Every caller holds the app row and the deployment row in `tx`. */
	const resources = await loadResources(tx as LockedLedger, [deploymentId]);
	return {
		deployment: toDeploymentRecord(row),
		...(resources.get(deploymentId) ?? NO_DEPLOYMENT_LEDGER),
	};
}

/** The deployment row of the scope's app on the target, `FOR UPDATE`. */
async function lockDeploymentRow(
	tx: Transaction<AppDatabase>,
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<Selectable<AppDeploymentsTable>> {
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
	return row;
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
 *
 * A publish's writes carry `expectedEndings`, the count of endings the
 * publish read first: where the locked row holds another count, the
 * deployment was ended since, and the write throws `DeploymentEndedError`
 * having written nothing, so a publish never records a mapping to the HQ
 * app a person stopped publishing to.
 */
async function withDeploymentRow<T>(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	options: { readonly ensure: boolean; readonly expectedEndings?: number },
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
		const row = await lockDeploymentRow(tx, scope, target);
		if (
			options.expectedEndings !== undefined &&
			options.expectedEndings !== row.endings
		) {
			throw new DeploymentEndedError(
				row.id,
				options.expectedEndings,
				row.endings,
			);
		}
		return body(tx, row);
	});
}

/** The count of endings a publish read first, which each of its store writes carries. */
export interface DeploymentFence {
	readonly expectedEndings: number;
}

/** Refuse a publish's write where the deployment was ended since the publish read it. */
function holdFence(
	row: Selectable<AppDeploymentsTable>,
	expectedEndings: number,
): void {
	if (row.endings !== expectedEndings)
		throw new DeploymentEndedError(row.id, expectedEndings, row.endings);
}

/** How CommCare HQ ended some of the writes a record states the outcome of. */
export interface WritesEnded {
	readonly writeIds: readonly string[];
	readonly how: RemoteWriteSettlement;
}

/**
 * The admitted writes a record states the outcome of, which authorize it:
 * what a write Nova let out to CommCare HQ made is recorded on the authority
 * of that write's admission (`lockAppForAdmittedRecord`), whether or not the
 * app is still live and its caller may still edit it. `settle` says how
 * CommCare HQ ended the writes this record is the last word on, and they are
 * settled in the record's own transaction, so each stays open, holding off
 * every transition its admission holds off, until what it made is recorded.
 */
export interface AdmittedRecord {
	readonly writeIds: readonly string[];
	readonly settle: readonly WritesEnded[];
}

/**
 * What the caller of a record may do with the deployment now, read in the
 * record's own transaction by the one authorization every deployment read and
 * write makes (`authorizeDeploymentApp`): `read` where the app is live in the
 * scope's Project and the caller is a member allowed to view it, `edit` where
 * they may also edit it. A record with no admission behind it is authorized
 * at `edit`, so its caller holds both.
 */
interface RecordAccess {
	readonly read: boolean;
	readonly edit: boolean;
}

/** One thing a caller's admitted writes put on CommCare HQ, as their record names it. */
export interface LandedResource {
	readonly kind: DeploymentResourceKind;
	/** The Nova app, table, place or persona it stands for. */
	readonly novaResourceId: string;
	/** Its id on CommCare HQ. */
	readonly remoteId: string;
	/** Its name there, for the kinds that have one: a table's tag, a place's site code, a worker's username. */
	readonly pushedIdentity: string | null;
}

/**
 * What a record of a caller's writes answers that caller. `landed` is what
 * the writes it records put on CommCare HQ, which is the caller's own work
 * and always theirs to know. `deployment` is the record as it now stands,
 * only where the caller may read the deployment now (`RecordAccess`): a
 * record rests on the admissions of the writes it states, not on the caller
 * still belonging to the app's Project, so a publisher removed from it, or
 * whose app was deleted, between the admission and the record still has what
 * they made recorded, and is answered `null`, never the record's other
 * members' names, confirmations or history.
 */
export interface RecordAnswer {
	readonly landed: readonly LandedResource[];
	readonly deployment: DeploymentWithResources | null;
}

/**
 * What the record of an import answers: `RecordAnswer`, and the tables and
 * places the imported content stands on as the record holds them once it
 * lands, which the publish's entry-point manifest names whether or not its
 * caller may read the deployment. Never answered to a person: it is the
 * publish's own evidence for a later deep-link check.
 */
export interface RecordedImport extends RecordAnswer {
	/** This import's mapping token, or null when a later import already stood there. */
	readonly pushToken: string | null;
	readonly dependencies: PublishedEntryPointManifest["dependencies"];
}

/** The live table and place mappings of a deployment, as an entry-point manifest names them. */
async function contentDependencies(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
): Promise<PublishedEntryPointManifest["dependencies"]> {
	const rows = await tx
		.selectFrom("app_deployment_resources")
		.select(["kind", "nova_resource_id", "remote_id", "pushed_identity"])
		.where("deployment_id", "=", deploymentId)
		.where("kind", "in", ["lookup-table", "location"])
		.where("superseded_at", "is", null)
		.orderBy("created_at", "asc")
		.execute();
	return rows.flatMap((row) =>
		row.kind === "lookup-table" || row.kind === "location"
			? [
					{
						kind: row.kind,
						novaResourceId: row.nova_resource_id,
						remoteId: row.remote_id,
						pushedIdentity: row.pushed_identity,
					},
				]
			: [],
	);
}

/** The answer to a record of `landed`, in its own transaction, for a caller with `access`. */
async function answerRecord(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	access: RecordAccess,
	landed: readonly LandedResource[],
): Promise<RecordAnswer> {
	return {
		landed,
		deployment: access.read
			? await loadWithinTransaction(tx, deploymentId)
			: null,
	};
}

/** What one recorded mapping put on CommCare HQ, without who adopted it. */
function landedResource(input: RecordRemoteResourceInput): LandedResource {
	return {
		kind: input.kind,
		novaResourceId: input.novaResourceId,
		remoteId: input.remoteId,
		pushedIdentity: input.pushedIdentity ?? null,
	};
}

/**
 * `body` over the deployment row, as the record of what admitted writes made.
 * Where `record.admitted` names writes, the record rests on their admissions
 * (`lockAppForAdmittedRecord`); otherwise it is authorized as every deployment
 * write is (`lockAppForDeploymentWrite`, `edit` on a live app), so a record
 * with no admission behind it is refused for a deleted app or a caller who
 * may no longer edit. It holds no fence: `body` reads `row.endings`, since an
 * ending keeps some records and refuses others. `body` is told what the
 * caller may do with the deployment now (`RecordAccess`): whether they may
 * edit the live app, which a reconcile against the document needs, and
 * whether they may read it, which decides what the record answers them
 * (`answerRecord`). The writes `admitted.settle` names are settled in the
 * same transaction, and also where `body` throws `DeploymentEndedError`, once
 * it has rolled back, since no record of them comes after that.
 */
async function withRecordRow<T>(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	record: {
		readonly admitted: AdmittedRecord | undefined;
		/** The kinds of admitted write this record states the outcome of. */
		readonly writeKinds: readonly HqRemoteWriteKind[];
	},
	body: (
		tx: Transaction<AppDatabase>,
		row: Selectable<AppDeploymentsTable>,
		access: RecordAccess,
	) => Promise<T>,
): Promise<T> {
	const writeIds = record.admitted?.writeIds ?? [];
	const settle = record.admitted?.settle ?? [];
	if (
		settle.some((ended) => ended.writeIds.some((id) => !writeIds.includes(id)))
	) {
		throw new Error(
			"A record settles only the writes it rests on, and was asked to settle one it does not name in its writeIds.",
		);
	}
	try {
		return await withAppTx(async (tx) => {
			let access: RecordAccess = { read: true, edit: true };
			if (writeIds.length === 0)
				await lockAppForDeploymentWrite(tx, scope, "edit");
			else
				access = await lockAppForAdmittedRecord(
					tx,
					scope,
					target,
					writeIds,
					record.writeKinds,
				);
			const row = await lockDeploymentRow(tx, scope, target);
			const result = await body(tx, row, access);
			for (const ended of settle)
				await settleRemoteWritesIn(tx, ended.writeIds, ended.how);
			return result;
		});
	} catch (error) {
		if (error instanceof DeploymentEndedError) {
			for (const ended of settle) {
				try {
					await settleRemoteWrites(ended.writeIds, ended.how);
				} catch (settleError) {
					log.error(
						"[deployment] could not settle a write whose record an ending refused",
						settleError,
						{ writes: ended.writeIds.length, how: ended.how.kind },
					);
				}
			}
		}
		throw error;
	}
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
 *
 * `expectedEndings` is the count of endings the publish read first, 0 where
 * the target had no record yet.
 */
export async function foldDeploymentAttempt(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	phase: DrivenDeploymentPhase,
	outcome: DeploymentPhaseOutcome,
	options: DeploymentFence & {
		readonly ensure?: boolean;
		readonly confirmations?: readonly DeploymentConfirmationKey[];
		/**
		 * The confirmations CommCare HQ's own answer contradicted, withdrawn in
		 * this fold: a first publish's `hq_plan_lacks_web_apps` stop withdraws
		 * the `web-apps` plan feature. Only with a failed `resources` outcome.
		 */
		readonly withdraw?: readonly DeploymentConfirmationKey[];
	},
): Promise<DeploymentWithResources> {
	const confirmations = options.confirmations ?? [];
	const withdraw = options.withdraw ?? [];
	if (
		confirmations.length > 0 &&
		(phase !== "preflight" || outcome.status !== "succeeded")
	) {
		throw new Error(
			"A confirmation is stored only with a preflight that passed, and this fold was not one.",
		);
	}
	if (
		withdraw.length > 0 &&
		(phase !== "resources" || outcome.status !== "failed")
	) {
		throw new Error(
			"A confirmation is withdrawn by a publish only where CommCare HQ's own answer contradicted it, at resources, and this fold was not one.",
		);
	}
	return withDeploymentRow(
		scope,
		target,
		{
			ensure: options.ensure === true,
			expectedEndings: options.expectedEndings,
		},
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
			await insertDeploymentConfirmationsInTransaction(
				tx,
				row.id,
				scope.actorUserId,
				confirmations,
			);
			let withdrew = false;
			for (const key of withdraw) {
				const withdrawn = await tx
					.updateTable("app_deployment_confirmations")
					.set({ withdrawn_by: scope.actorUserId, withdrawn_at: sql`now()` })
					.where("deployment_id", "=", row.id)
					.where("kind", "=", key.kind)
					.where("subject", "=", confirmationSubject(key))
					.where("withdrawn_at", "is", null)
					.executeTakeFirst();
				if (Number(withdrawn.numUpdatedRows) > 0) withdrew = true;
			}
			if (next !== record || confirmations.length > 0 || withdrew) {
				/* Delivered on commit, so connected tabs re-resolve what
				 * Preview may name only once the fold is visible. */
				await notifyAppDeployments(tx, scope.appId);
			}
			return loadWithinTransaction(tx, row.id);
		},
	);
}

/**
 * Record what a person confirmed about a deployment's project space, inside a
 * caller's transaction. Each key is attributed to `actorUserId`; one already
 * in force is kept as it is, so its first confirmer stays on record. Which
 * writes may confirm is the caller's rule: a passed preflight's fold, and the
 * birth of an app brought in from CommCare HQ.
 */
async function insertDeploymentConfirmationsInTransaction(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	actorUserId: string,
	keys: readonly DeploymentConfirmationKey[],
): Promise<void> {
	if (keys.length === 0) return;
	await tx
		.insertInto("app_deployment_confirmations")
		.values(
			keys.map((key) => ({
				deployment_id: deploymentId,
				kind: key.kind,
				subject: confirmationSubject(key),
				confirmed_by: actorUserId,
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

/** Everything an app brought in from CommCare HQ records about where it came from. */
export interface AdoptedDeploymentWrite {
	readonly appId: string;
	readonly projectId: string;
	readonly actorUserId: string;
	readonly target: DeploymentTargetKey;
	readonly remoteAppId: string;
	/** HQ's save counter the create's own bracketed read held. */
	readonly remoteRevision: number;
	/** The birth's sequence. */
	readonly pushedRevision: number;
	readonly baseline: AppBaselineWrite & { readonly origin: "read" };
	/**
	 * Where the source project space keeps the app's menus and forms, keyed
	 * creates and media files: the reading resolved over nothing
	 * (`targetIdentity.ts::resolveTargetIdentity`), the value the review's
	 * digest bound.
	 */
	readonly targetIdentity: TargetIdentity;
	readonly confirmations: readonly DeploymentConfirmationKey[];
	readonly at: Date;
}

/**
 * Records an adopted deployment inside the transaction that births its app.
 *
 * It runs after the genesis tail inserted the app row and after the claim
 * took the HQ app's lock, so the app, its claim and where it came from
 * commit together or not at all. It takes no row lock: every row it writes
 * is new, and the claim has already serialized births of this HQ app. The
 * genesis tail asserted the person's membership in this transaction, so the
 * role is not read again. A unique violation on the claim index is the
 * floor under the claim, and answers `HqAppAlreadyClaimedError` with no
 * holder.
 */
export async function recordAdoptedDeploymentInTransaction(
	tx: Transaction<AppDatabase>,
	write: AdoptedDeploymentWrite,
): Promise<DeploymentWithResources> {
	const app = await tx
		.selectFrom("apps")
		.select(["project_id", "deleted_at"])
		.where("id", "=", write.appId)
		.executeTakeFirst();
	if (
		app === undefined ||
		app.project_id !== write.projectId ||
		app.deleted_at !== null
	) {
		throw new Error(
			`Nova tried to record where app ${write.appId} came from and found no such app in Project ${write.projectId}. The app's birth and its deployment are written together, so this is Nova's fault to fix: check the order of the creation transaction.`,
		);
	}
	const deployment = await tx
		.insertInto("app_deployments")
		.values({
			app_id: write.appId,
			project_id: write.projectId,
			server: write.target.server,
			domain: write.target.domain,
			state: "uploaded",
			resume_phase: null,
			phases: JSON.stringify(NO_DEPLOYMENT_PHASE_OUTCOMES),
			created_by: write.actorUserId,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const deploymentId = deployment.id;
	try {
		await writeResourceMapping(
			tx,
			deploymentId,
			{
				kind: "app",
				novaResourceId: write.appId,
				remoteId: write.remoteAppId,
				ownership: "adopted",
				adoptedBy: write.actorUserId,
				pushedRevision: write.pushedRevision,
				remoteRevision: write.remoteRevision,
			},
			write.at,
		);
	} catch (error) {
		if (isHqAppClaimIndexViolation(error)) {
			throw new HqAppAlreadyClaimedError(
				{
					server: write.target.server,
					domain: write.target.domain,
					remoteAppId: write.remoteAppId,
				},
				null,
			);
		}
		throw error;
	}
	await writeAppBaseline(tx, deploymentId, write.actorUserId, write.baseline);
	await writeTargetIdentityInTransaction(
		tx,
		deploymentId,
		{ appId: write.appId, server: write.target.server },
		{ read: EMPTY_TARGET_IDENTITY, next: write.targetIdentity },
	);
	await insertDeploymentConfirmationsInTransaction(
		tx,
		deploymentId,
		write.actorUserId,
		write.confirmations,
	);
	await notifyAppDeployments(tx, write.appId);
	return loadWithinTransaction(tx, deploymentId);
}

/**
 * Settle every released claim of the scope's app: take back each HQ app
 * nobody holds, take it back from a holder in recently deleted, or end the
 * deployment where a live Nova app publishes there now.
 *
 * One transaction in the claim protocol's order: the HQ apps' locks, then
 * the app rows (`lockReleasedClaimsInTransaction`), then the Project and the
 * `edit` role proved on the locked app row as every deployment write proves
 * them, then the settle, with the scope's actor as the one who ended what it
 * ends. Where the claims changed between the read and the locks, the
 * transaction ends having written nothing and another starts, three in all;
 * after the third, nothing was written and the answer is `settled: false`. A
 * claim whose HQ app another app's write has not settled on stays released
 * (`waiting`).
 */
export async function settleReleasedClaims(scope: DeploymentScope): Promise<
	| {
			readonly settled: true;
			/** The project spaces the settle ended, because a live Nova app publishes there now. */
			readonly stoppedPublishing: SettledClaims["stopped"];
			/**
			 * The project spaces whose claim stays released, because a write
			 * another app let out to that HQ app has not settled yet.
			 */
			readonly waiting: SettledClaims["waiting"];
	  }
	/** Three tries each found the claims changed under their locks. Nothing was written. */
	| { readonly settled: false }
> {
	for (let attempt = 0; attempt < SETTLE_CLAIM_TRIES; attempt++) {
		const settled = await withAppTx(async (tx) => {
			const locks = await lockReleasedClaimsInTransaction(tx, scope.appId);
			if (locks === null) return null;
			await authorizeDeploymentApp(
				locks.app,
				scope,
				"edit",
				"write",
				(projectId) =>
					projectRoleForInTransaction(tx, scope.actorUserId, projectId),
			);
			return settleReleasedClaimsInTransaction(tx, {
				appId: scope.appId,
				actorUserId: scope.actorUserId,
				at: new Date(),
				locks,
			});
		});
		if (settled !== null) {
			return {
				settled: true,
				stoppedPublishing: settled.stopped,
				waiting: settled.waiting,
			};
		}
	}
	return { settled: false };
}

/** How many transactions a settle of released claims starts before it answers that they kept changing. */
const SETTLE_CLAIM_TRIES = 3;

/**
 * Stop publishing this app to one project space: "Stop publishing here".
 *
 * An admin or owner of the app's Project may, the members who may delete its
 * apps; an editor sees the deployment and may publish to it, so the answer to
 * an editor names who can (`not_permitted`) rather than hiding it. A viewer
 * or a stranger finds nothing to stop. CommCare HQ is not asked anything: the
 * HQ app stays exactly as it is.
 *
 * The stop names the HQ app the person looked at, and ends that mapping or
 * nothing, decided under the deployment row's lock:
 *
 *   - a live mapping of that HQ app is ended;
 *   - a mapping of it an ending already superseded answers the deployment as
 *     it stands, writing nothing: the stop landed before, and a repeat of it
 *     is the same stop, whatever a publish since made there;
 *   - a deployment that publishes to another HQ app now, or that superseded
 *     that one without an ending, refuses `stale`, writing nothing;
 *   - a deployment with no app mapping at all has nothing to stop.
 *
 * Another Nova app is granted the HQ app only once every write this app let
 * out to it has settled (`lib/db/hqAppClaims.ts::claimHqAppInTransaction`).
 */
export async function endDeployment(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	hqAppId: string,
): Promise<DeploymentWithResources> {
	return withAppTx(async (tx) => {
		const role = await lockAppForDeploymentWrite(tx, scope, "edit");
		if (!roleAllowsApp(role, "delete")) {
			throw new DeploymentError(
				"not_permitted",
				"Only an admin or owner of this Project can stop publishing here. You can ask one of them to.",
			);
		}
		const row = await lockDeploymentRow(tx, scope, target);
		const { ended } = await endDeploymentInTransaction(tx, {
			deploymentId: row.id,
			appId: scope.appId,
			remoteAppId: hqAppId,
			byUserId: scope.actorUserId,
			reason: "stopped",
			at: new Date(),
		});
		if (ended) return loadWithinTransaction(tx, row.id);
		const mappings = await tx
			.selectFrom("app_deployment_resources")
			.select(["remote_id", "superseded_at", "ended_reason"])
			.where("deployment_id", "=", row.id)
			.where("kind", "=", "app")
			.execute();
		if (mappings.length === 0) {
			throw new DeploymentError(
				"invalid",
				`Nova isn't publishing this app to “${target.domain}”, so there's nothing to stop.`,
			);
		}
		/* An ending superseded that HQ app's mapping: the stop landed, and
		 * where a publish since made a new app there, that publish is a later
		 * decision this stop does not undo. */
		if (
			mappings.some(
				(mapping) =>
					mapping.remote_id === hqAppId && mapping.ended_reason !== null,
			)
		)
			return loadWithinTransaction(tx, row.id);
		throw new DeploymentError(
			"stale",
			`This app publishes to a different app in “${target.domain}” than the one you were looking at, so Nova didn't stop anything. Have another look, and stop it from there if you still want to.`,
		);
	});
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
	/**
	 * When the resource was handed to Nova, where that moment is not this
	 * write's: a lookup table a sibling app adopted, or one a person took over
	 * with Manage in Nova, keeps their moment beside their name. Absent or
	 * null on an adoption, the write's own moment. Only with `adoptedBy`.
	 */
	readonly adoptedAt?: string | null;
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
export interface RecordRemoteAppInput
	extends RecordRemoteResourceInput,
		DeploymentFence {
	readonly uploadedAt: string;
	/**
	 * The target's `USH_EMPTY_CASE_LIST_TEXT` as this publish read it, written
	 * with the upload's fold. Left out where the read failed, so the column
	 * keeps what an earlier publish read.
	 */
	readonly targetEmptyCaseListText?: boolean;
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
 * Two publishes of one HQ app record in CommCare HQ's save order, not in the
 * order their transactions commit: where the live mapping of that HQ app
 * holds a push HQ acknowledged at a higher save counter than this one, this
 * publish's import was overwritten by that one's, so its mapping, baseline
 * and state are left as they are and the record answers as it stands. An
 * acknowledgement that carried no counter cannot be ordered and records.
 *
 * The record's observation history is cleared in the same write, because
 * those answers described what the target held before this publish, not
 * what it holds now.
 *
 * `admitted` is the import's admission, which authorizes the record and is
 * settled with it: an app deleted, or a publisher who lost edit or left the
 * Project, since the import was admitted still has it recorded, and is
 * answered the record only where they may still read it (`RecordAnswer`).
 * Under the fence all the same: an ending since throws `DeploymentEndedError`
 * and records nothing, since the ending took this deployment off that HQ app.
 */
export async function recordRemoteResource(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: RecordRemoteAppInput,
	admitted?: AdmittedRecord,
): Promise<RecordedImport> {
	const landed = [landedResource(input)];
	return withRecordRow(
		scope,
		target,
		{ admitted, writeKinds: ["import"] },
		async (tx, row, access) => {
			holdFence(row, input.expectedEndings);
			const answer = async (
				pushToken: string | null,
			): Promise<RecordedImport> => ({
				pushToken,
				...(await answerRecord(tx, row.id, access, landed)),
				dependencies: await contentDependencies(tx, row.id),
			});
			const live = await tx
				.selectFrom("app_deployment_resources")
				.select(["remote_id", "pushed_remote_revision"])
				.where("deployment_id", "=", row.id)
				.where("kind", "=", input.kind)
				.where("nova_resource_id", "=", input.novaResourceId)
				.where("superseded_at", "is", null)
				.executeTakeFirst();
			const recorded =
				live === undefined ? null : numberOrNull(live.pushed_remote_revision);
			if (
				live?.remote_id === input.remoteId &&
				recorded !== null &&
				input.remoteRevision !== null &&
				input.remoteRevision < recorded
			) {
				log.info("[deployment] a later publish recorded first", {
					appId: scope.appId,
					domain: target.domain,
					hqAppId: input.remoteId,
					remoteRevision: input.remoteRevision,
					recordedRemoteRevision: recorded,
				});
				return answer(null);
			}
			const now = new Date();
			const pushToken = await writeResourceMapping(tx, row.id, input, now);
			await writeAppBaseline(tx, row.id, scope.actorUserId, input.baseline);

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
					...(input.offeredLogoContentHash !== undefined && {
						offered_logo_content_hash: input.offeredLogoContentHash,
					}),
				})
				.where("id", "=", row.id)
				.execute();
			await notifyAppDeployments(tx, scope.appId);

			return answer(pushToken);
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
 *
 * `admitted` is the create's admission, which authorizes the record and is
 * settled with it, naming the app: until then no other Nova app takes any HQ
 * app on the project space (`hqAppClaims.ts::openWriteSettlesAt`). On an app
 * deleted since the admission the mapping is recorded live and unreleased, as
 * if it had landed before the deletion, so the app holds the new HQ app as an
 * app in recently deleted holds every HQ app it published to. The caller is
 * answered the record only where they may still read it (`RecordAnswer`).
 * Under the fence: an ending since throws `DeploymentEndedError`, and the
 * publish names the app with `recordOrphanedRemoteApp`.
 */
export async function recordCreatedRemoteApp(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: DeploymentFence & {
		readonly remoteId: string;
		/** The read after the create as the `create` baseline, or `unread` when it failed. */
		readonly baseline: AppBaselineWrite;
	},
	admitted?: AdmittedRecord,
): Promise<RecordAnswer> {
	const mapping: RecordRemoteResourceInput = {
		kind: "app",
		novaResourceId: scope.appId,
		remoteId: input.remoteId,
		ownership: "nova-created",
		pushedRevision: null,
		remoteRevision: null,
	};
	return withRecordRow(
		scope,
		target,
		{ admitted, writeKinds: ["create"] },
		async (tx, row, access) => {
			holdFence(row, input.expectedEndings);
			await writeResourceMapping(tx, row.id, mapping, new Date());
			await writeAppBaseline(tx, row.id, scope.actorUserId, input.baseline);
			await notifyAppDeployments(tx, scope.appId);
			return answerRecord(tx, row.id, access, [landedResource(mapping)]);
		},
	);
}

/**
 * Record the empty app a first publish created on CommCare HQ after the
 * deployment was ended while CommCare HQ made it, so that no app Nova made
 * stands there unnamed: a superseded mapping of it, dated the moment the
 * publish began, which is before the ending that fenced it. The ending stays
 * the deployment's latest, and the left-behind report names this app beside
 * it. It writes nothing where the deployment already names that HQ app.
 * `admitted` is the create's admission, which authorizes the record and is
 * settled with it, so a deleted app holds the record too and its restore
 * reports the app.
 */
export async function recordOrphanedRemoteApp(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: { readonly remoteId: string; readonly publishStartedAt: Date },
	admitted?: AdmittedRecord,
): Promise<void> {
	await withRecordRow(
		scope,
		target,
		{ admitted, writeKinds: ["create"] },
		async (tx, row) => {
			const named = await tx
				.selectFrom("app_deployment_resources")
				.select("id")
				.where("deployment_id", "=", row.id)
				.where("kind", "=", "app")
				.where("remote_id", "=", input.remoteId)
				.executeTakeFirst();
			if (named !== undefined) return;
			await tx
				.insertInto("app_deployment_resources")
				.values({
					deployment_id: row.id,
					kind: "app",
					nova_resource_id: scope.appId,
					remote_id: input.remoteId,
					ownership: "nova-created",
					pushed_revision: null,
					pushed_at: null,
					remote_revision: null,
					remote_observed_at: null,
					superseded_at: input.publishStartedAt,
				})
				.execute();
			await notifyAppDeployments(tx, scope.appId);
		},
	);
}

/**
 * How long a write stays open, in seconds, when the process that sent it
 * never says how it ended: the request's own deadline, then the time CommCare
 * HQ may still be applying a request whose answer never reached Nova.
 */
const REMOTE_WRITE_HOLD_SECONDS = {
	/** The import's 60-second deadline, then five minutes. */
	import: 60 + 5 * 60,
	/** The create is an import of the empty app: the same. */
	create: 60 + 5 * 60,
	/** The upload's minute and the status reads' 45 seconds, then the hour HQ keeps a job's status. */
	media: 60 + 45 + 60 * 60,
	/** The workbook upload's deadline, then five minutes. */
	workbook: 60 + 5 * 60,
	/** One batch of places: its 30-second deadline, then five minutes. */
	places: 30 + 5 * 60,
	/** A worker's create and its places' update, 30 seconds each, then five minutes. */
	worker: 2 * 30 + 5 * 60,
} as const;

/** How long a write stays open once CommCare HQ's answer was lost: the import's grace. */
const UNANSWERED_WRITE_GRACE_SECONDS = 5 * 60;
/** How long a media job HQ accepted stays open: the hour HQ keeps its status (`hqmedia/cache.py`). */
const MEDIA_JOB_HOLD_SECONDS = 60 * 60;

/** What an admission of a write to the deployment's HQ app answered. */
export type AppWriteAdmission =
	| { readonly kind: "admitted"; readonly writeId: string }
	/**
	 * The deployment's live app mapping no longer names that HQ app, or another
	 * Nova app took it: this publish no longer publishes there. Nothing was
	 * recorded, and nothing may be sent.
	 */
	| { readonly kind: "mapping-moved" };

/**
 * Admit one write to the HQ app the deployment publishes to, immediately
 * before it is sent: an import or a media bundle. One transaction, in the
 * claim protocol's order: the HQ app's advisory lock, the app row with the
 * Project and the role proved, then the deployment row `FOR UPDATE`. Under
 * them it holds the fence (an ending since throws `DeploymentEndedError`) and
 * the deployment's live, unreleased app mapping naming that HQ app, and only
 * then records the write, open for its hold.
 *
 * An ending takes the deployment row, so it commits wholly before or after
 * this; a birth's claim takes the advisory lock, so it either sees this write
 * open or finds the mapping it would release already ended. Either way no
 * other Nova app is granted the HQ app while a write this one let out to it
 * may still change it.
 */
export async function admitAppWrite(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: DeploymentFence & {
		readonly remoteAppId: string;
		readonly writeKind: "import" | "media";
	},
): Promise<AppWriteAdmission> {
	return withAppTx(async (tx) => {
		await lockHqApp(tx, {
			server: target.server,
			domain: target.domain,
			remoteAppId: input.remoteAppId,
		});
		await lockAppForDeploymentWrite(tx, scope, "edit");
		const row = await lockDeploymentRow(tx, scope, target);
		if (row.endings !== input.expectedEndings) {
			throw new DeploymentEndedError(
				row.id,
				input.expectedEndings,
				row.endings,
			);
		}
		const live = await tx
			.selectFrom("app_deployment_resources")
			.select(["remote_id", "released_at"])
			.where("deployment_id", "=", row.id)
			.where("kind", "=", "app")
			.where("superseded_at", "is", null)
			.executeTakeFirst();
		if (
			live === undefined ||
			live.remote_id !== input.remoteAppId ||
			live.released_at !== null
		) {
			return { kind: "mapping-moved" };
		}
		const [writeId] = await admitRemoteWritesInTransaction(tx, [
			{
				deploymentId: row.id,
				server: target.server,
				domain: target.domain,
				appId: scope.appId,
				projectId: scope.projectId,
				actorUserId: scope.actorUserId,
				resourceKind: "app",
				resourceId: input.remoteAppId,
				writeKind: input.writeKind,
				holdSeconds: REMOTE_WRITE_HOLD_SECONDS[input.writeKind],
			},
		]);
		if (writeId === undefined) {
			throw new Error("An admitted write to CommCare HQ returned no id.");
		}
		return { kind: "admitted", writeId };
	});
}

/**
 * Admit the create of a new app on CommCare HQ, immediately before it is
 * sent. It crosses no claim, since no Nova app names an app HQ has not made,
 * so it holds only the fence under the deployment row; its record keeps a
 * Project move waiting while the create may still land. Answers the write's
 * id, whose HQ app is named once HQ answers (`settleRemoteWrites`).
 */
export async function admitAppCreate(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	fence: DeploymentFence,
): Promise<string> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false, expectedEndings: fence.expectedEndings },
		async (tx, row) => {
			const [writeId] = await admitRemoteWritesInTransaction(tx, [
				{
					deploymentId: row.id,
					server: target.server,
					domain: target.domain,
					appId: scope.appId,
					projectId: scope.projectId,
					actorUserId: scope.actorUserId,
					resourceKind: "app",
					resourceId: null,
					writeKind: "create",
					holdSeconds: REMOTE_WRITE_HOLD_SECONDS.create,
				},
			]);
			if (writeId === undefined) {
				throw new Error("An admitted create on CommCare HQ returned no id.");
			}
			return writeId;
		},
	);
}

/** What an admission of a lookup table workbook answered. */
export type WorkbookAdmission =
	| { readonly kind: "admitted"; readonly writeIds: readonly string[] }
	/** Tables handed back to CommCare HQ from this project space, by tag in tag order. Nothing was recorded. */
	| { readonly kind: "handed-back"; readonly tags: readonly string[] };

/**
 * Admit a lookup table workbook, immediately before it is sent. One
 * transaction: the app row and the deployment row (the fence), then the
 * Project's lookup state and every table of the workbook `FOR UPDATE`, in the
 * lookup writers' order. A table handed back to CommCare HQ from this project
 * space refuses the workbook, and otherwise each table's write is recorded,
 * open for its hold. A hand-back takes the same table row and waits while a
 * workbook carrying the table is open
 * (`lib/lookup/managed.ts::refreshManagedLookupTableInTransaction`), so a
 * table is never handed back while Nova's copy of it may still be written
 * over CommCare HQ's.
 */
export async function admitWorkbookWrite(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: DeploymentFence & { readonly tableIds: readonly string[] },
): Promise<WorkbookAdmission> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false, expectedEndings: input.expectedEndings },
		async (tx, row) => {
			const tables = await lockLookupTablesForPublishInTransaction(
				tx,
				{ projectId: scope.projectId, actorId: scope.actorUserId },
				input.tableIds,
			);
			const handedBack = tables
				.filter(
					(table) =>
						table.hqServer === target.server &&
						table.hqDomain === target.domain &&
						!table.takenOver,
				)
				.map((table) => table.tag)
				.sort();
			if (handedBack.length > 0)
				return { kind: "handed-back", tags: handedBack };
			const writeIds = await admitRemoteWritesInTransaction(
				tx,
				tables.map((table) => ({
					deploymentId: row.id,
					server: target.server,
					domain: target.domain,
					appId: scope.appId,
					projectId: scope.projectId,
					actorUserId: scope.actorUserId,
					resourceKind: "lookup-table" as const,
					resourceId: table.id,
					writeKind: "workbook" as const,
					holdSeconds: REMOTE_WRITE_HOLD_SECONDS.workbook,
				})),
			);
			return { kind: "admitted", writeIds };
		},
	);
}

/**
 * Admit one batch of places, immediately before it is sent: under the fence
 * (an ending since throws `DeploymentEndedError` and sends nothing), and only
 * for a live app whose caller may edit it, it records one write per place,
 * open for its hold, which keeps a Project move of the app waiting until the
 * places the batch makes are recorded (`recordPushedResources`).
 */
export async function admitPlacesWrite(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: DeploymentFence & { readonly locationUuids: readonly string[] },
): Promise<readonly string[]> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false, expectedEndings: input.expectedEndings },
		async (tx, row) =>
			admitRemoteWritesInTransaction(
				tx,
				input.locationUuids.map((locationUuid) => ({
					deploymentId: row.id,
					server: target.server,
					domain: target.domain,
					appId: scope.appId,
					projectId: scope.projectId,
					actorUserId: scope.actorUserId,
					resourceKind: "location" as const,
					resourceId: locationUuid,
					writeKind: "places" as const,
					holdSeconds: REMOTE_WRITE_HOLD_SECONDS.places,
				})),
			),
	);
}

/** How a write CommCare HQ was sent ended, as `settleRemoteWrites` records it. */
export type RemoteWriteSettlement =
	| { readonly kind: "settled"; readonly resourceId?: string }
	| { readonly kind: "unanswered"; readonly resourceId?: string }
	| { readonly kind: "media-job"; readonly jobId: string };

/**
 * Say how a write ended, once its process knows: `settled` where CommCare HQ
 * answered and is done with it, `unanswered` where the answer never reached
 * Nova and HQ may still apply it, `media-job` where HQ accepted a media
 * bundle whose job Nova stopped watching. `settled` sets `settled_at`, which
 * closes the write for every reader whatever its transaction's clock; the
 * other two set the hold's end, and leave a write already settled closed.
 * `resourceId` names the HQ app a create made. Outside any lock: the row is
 * never locked, and only the process that admitted the write moves it.
 */
export async function settleRemoteWrites(
	writeIds: readonly string[],
	how: RemoteWriteSettlement,
): Promise<void> {
	if (writeIds.length === 0) return;
	await settleRemoteWritesIn(await getAppDb(), writeIds, how);
}

/** `settleRemoteWrites` through `db`, or a caller's transaction that records what the writes made. */
async function settleRemoteWritesIn(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	writeIds: readonly string[],
	how: RemoteWriteSettlement,
): Promise<void> {
	if (writeIds.length === 0) return;
	const holdSeconds =
		how.kind === "unanswered"
			? UNANSWERED_WRITE_GRACE_SECONDS
			: MEDIA_JOB_HOLD_SECONDS;
	await db
		.updateTable("hq_remote_writes")
		.set({
			...(how.kind === "settled"
				? { settled_at: sql<Date>`now()` }
				: {
						held_until: sql<Date>`greatest(opened_at, now() + make_interval(secs => ${holdSeconds}))`,
					}),
			...(how.kind !== "media-job" &&
				how.resourceId !== undefined && { resource_id: how.resourceId }),
			...(how.kind === "media-job" && { hq_job_id: how.jobId }),
		})
		.where("id", "in", [...writeIds])
		.execute();
}

/** A media job CommCare HQ accepted for an HQ app whose write is still open, to poll by its id. */
export interface OpenMediaJob {
	readonly writeId: string;
	readonly jobId: string;
}

/** The open media jobs of one HQ app, whichever Nova app sent them, oldest first. */
export async function readOpenMediaJobs(key: {
	readonly server: string;
	readonly domain: string;
	readonly remoteAppId: string;
}): Promise<readonly OpenMediaJob[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("hq_remote_writes")
		.select(["id", "hq_job_id"])
		.where("resource_kind", "=", "app")
		.where("server", "=", key.server)
		.where("domain", "=", key.domain)
		.where("resource_id", "=", key.remoteAppId)
		.where("write_kind", "=", "media")
		.where("hq_job_id", "is not", null)
		.where(openRemoteWrite)
		.orderBy("opened_at")
		.execute();
	return rows.flatMap((row) =>
		row.hq_job_id === null ? [] : [{ writeId: row.id, jobId: row.hq_job_id }],
	);
}

/**
 * Replace a deployment's app baseline with a fresh read that compared equal
 * to it, and answer whether the baseline now holds what the read saw.
 *
 * The read was compared outside any transaction, so the write states its
 * precondition against the row as it stands under the lock: the stored
 * baseline is still the one the read was compared with (same HQ app, same
 * digest, an origin that holds a read), it carries no later date than the
 * read, and the live app mapping still names that app. A publish writes its
 * read-back under the same lock, so where one landed while HQ was answering,
 * the digest or the date has moved and nothing is written (`superseded`).
 * The date test covers the one case the digest cannot: a publish whose
 * read-back equals the old baseline byte for byte. The read's `observedAt`
 * is taken before its request was sent, so it never outdates a publish that
 * imported after that moment.
 *
 * A stored baseline that already holds this read's digest is `current`
 * whatever moved it there: another refresh that read the same, or a publish
 * whose read-back is this read, so two refreshes of an unchanged project
 * space both answer as refreshed, whichever lands first. It is written again
 * only where this read is the later, which moves the date and nothing else.
 * `superseded` therefore names a newer read that differs from this one, a
 * publish's or another refresh's, or a publish that moved the app or could
 * not read it back.
 *
 * The stored origin, ownership and Nova revision are kept: they say how the
 * app came to be there, what Nova's upload owned in it and which revision of
 * the app it describes, which a read without a publish does not change. A
 * stored discard record is kept too, and so are the media record and the
 * first-publish list unless the input carries what the next publish changes:
 * that keeps a stored list of that kind by `hqChangesFirstPublishList`, and
 * never touches the list of an app brought in and not yet published.
 */
export async function recordRefreshedAppBaseline(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: DeploymentFence & {
		readonly remoteAppId: string;
		/** The `sourceDigest` of the baseline the read was compared with. */
		readonly comparedDigest: string;
		/** The fresh read: gzip, bytes, digest and `observedAt`. */
		readonly read: Pick<
			AppBaselineWrite,
			"sourceGzip" | "sourceBytes" | "sourceDigest" | "observedAt"
		>;
		/**
		 * What a review that read the same app gives for the next publish's
		 * list, kept by `hqChangesFirstPublishList`. Absent: the stored one
		 * stays.
		 */
		readonly nextPublish?: HqChangesFirstPublish;
		/** The media record with an id a review learned. Absent: it stays. */
		readonly mediaFiles?: HqMediaRecord;
		/**
		 * The target-identity record a review that read the same app
		 * resolved, and the record it resolved over, written whether or not
		 * the source is (`writeTargetIdentityInTransaction`). Absent: it
		 * stays.
		 */
		readonly targetIdentity?: {
			readonly read: TargetIdentity;
			readonly next: TargetIdentity;
		};
	},
): Promise<{
	readonly outcome: "current" | "superseded";
	readonly deployment: DeploymentWithResources;
}> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false, expectedEndings: input.expectedEndings },
		async (tx, row) => {
			const stored = await tx
				.selectFrom("app_deployment_baselines")
				.select([
					"remote_app_id",
					"origin",
					"source_digest",
					"ownership",
					"nova_revision",
					"observed_at",
					"first_publish_changes",
				])
				.where("deployment_id", "=", row.id)
				.executeTakeFirst();
			const liveMapping = await tx
				.selectFrom("app_deployment_resources")
				.select("remote_id")
				.where("deployment_id", "=", row.id)
				.where("kind", "=", "app")
				.where("nova_resource_id", "=", scope.appId)
				.where("superseded_at", "is", null)
				.executeTakeFirst();
			const ownership =
				stored === undefined ? null : appOwnershipFromRow(stored.ownership);
			const origin = stored?.origin;
			const superseded = async () => ({
				outcome: "superseded" as const,
				deployment: await loadWithinTransaction(tx, row.id),
			});
			/* Every origin that holds a read Nova compares as a publish's is
			 * refreshed; a shell's and a failed read's are not. */
			if (
				stored === undefined ||
				stored.remote_app_id !== input.remoteAppId ||
				(origin !== "push" &&
					origin !== "cutover" &&
					origin !== "read" &&
					origin !== "changes") ||
				ownership === null ||
				liveMapping?.remote_id !== input.remoteAppId
			) {
				return superseded();
			}
			const readAt = Date.parse(input.read.observedAt);
			const storedList = storedFirstPublish(
				row.id,
				stored.first_publish_changes,
			);
			/* Where CommCare HQ keeps things is no part of the source's digest
			 * (a form's id normalizes out), so the record goes where the fences
			 * pass, whether or not the source does. */
			if (input.targetIdentity !== undefined) {
				try {
					await writeTargetIdentityInTransaction(
						tx,
						row.id,
						{ appId: scope.appId, server: target.server },
						input.targetIdentity,
					);
				} catch (error) {
					if (error instanceof TargetIdentityMovedError) return superseded();
					throw error;
				}
			}
			/* The stored baseline already holds what this read saw: another
			 * refresh that read the same landed first, or a publish whose
			 * read-back is byte for byte this read. The row is current either
			 * way, and only a later date moves it. */
			if (stored.source_digest === input.read.sourceDigest) {
				if (stored.observed_at.getTime() >= readAt) {
					if (
						input.targetIdentity !== undefined &&
						!sameTargetIdentity(
							input.targetIdentity.read,
							input.targetIdentity.next,
						)
					)
						await notifyAppDeployments(tx, scope.appId);
					return {
						outcome: "current",
						deployment: await loadWithinTransaction(tx, row.id),
					};
				}
			} else if (
				stored.source_digest !== input.comparedDigest ||
				stored.observed_at.getTime() > readAt
			) {
				return superseded();
			}
			await writeAppBaseline(tx, row.id, scope.actorUserId, {
				origin,
				remoteAppId: input.remoteAppId,
				sourceGzip: input.read.sourceGzip,
				sourceBytes: input.read.sourceBytes,
				sourceDigest: input.read.sourceDigest,
				ownership,
				observedAt: input.read.observedAt,
				discard: null,
				novaRevision: numberOrNull(stored.nova_revision),
				mediaFiles:
					input.mediaFiles === undefined
						? { kind: "keep" }
						: { kind: "set", files: input.mediaFiles },
				/* An app brought in and not yet published keeps its own list: the
				 * first publish still makes every change of it, and a read that
				 * compared equal reads the same app it was given for. */
				firstPublish:
					input.nextPublish === undefined || storedList?.of === "first-publish"
						? { kind: "keep" }
						: {
								kind: "set",
								list: hqChangesFirstPublishList(storedList, input.nextPublish),
							},
			});
			await notifyAppDeployments(tx, scope.appId);
			return {
				outcome: "current",
				deployment: await loadWithinTransaction(tx, row.id),
			};
		},
	);
}

/**
 * Writes the media record a publish's upload earned: which CommCare HQ file
 * stands at each path the publish sent. `edit`.
 *
 * It writes only where the baseline row still names that HQ app and the
 * live mapping's unique push token and the digest this publish wrote, so a later publish's baseline,
 * which that publish records its own files beside, is left alone. A publish
 * whose read-back failed wrote an `unread` baseline with a null digest,
 * and passes null. On a deployment someone stopped since the publish began
 * it writes nothing and throws nothing: the app had already landed, which
 * the publish reports, as `finishDeploymentContentWrite` holds it.
 *
 * `admitted` names the import, and the media bundle where one went, which
 * authorize the record: an app deleted, or a publisher who lost edit, since
 * the import keeps the record of what it and the bundle left. It settles
 * neither: the import settled with its own record, and a bundle settles by
 * its job.
 */
export async function recordDeploymentMediaFiles(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: DeploymentFence & {
		readonly remoteAppId: string;
		readonly pushToken: string | null;
		/** The digest of the baseline this publish wrote; null when HQ returned no verifiable source. */
		readonly sourceDigest: string | null;
		readonly files: HqMediaRecord;
		readonly admitted?: AdmittedRecord;
	},
): Promise<void> {
	await withRecordRow(
		scope,
		target,
		{ admitted: input.admitted, writeKinds: ["import", "media"] },
		async (tx, row) => {
			const { pushToken } = input;
			if (row.endings !== input.expectedEndings || pushToken === null) return;
			await tx
				.updateTable("app_deployment_baselines")
				.set({ media_files: JSON.stringify(input.files) })
				.where("deployment_id", "=", row.id)
				.where("remote_app_id", "=", input.remoteAppId)
				.where((eb) =>
					eb.exists(
						tx
							.selectFrom("app_deployment_resources as r")
							.select("r.id")
							.where("r.deployment_id", "=", row.id)
							.where("r.kind", "=", "app")
							.where("r.remote_id", "=", input.remoteAppId)
							.where("r.superseded_at", "is", null)
							.where("r.push_token", "=", pushToken),
					),
				)
				.where((eb) =>
					input.sourceDigest === null
						? eb("source_digest", "is", null)
						: eb("source_digest", "=", input.sourceDigest),
				)
				.execute();
		},
	);
}

/** Which of the baseline's facts a bring-in of changes found moved under its lock. */
export type HqChangesBaselineFence =
	| "source-digest"
	| "nova-revision"
	| "remote-app"
	| "observed-at"
	| "target-identity";

/**
 * Thrown by `recordHqChangesTaken` where the baseline, its revision or the
 * live app mapping is not the one the plan read, or a newer read of the app
 * is stored. Nothing was recorded, and the transaction it ran in rolls back.
 */
export class HqChangesBaselineMovedError extends Error {
	readonly fence: HqChangesBaselineFence;
	readonly expected: string;
	readonly found: string | null;

	constructor(
		fence: HqChangesBaselineFence,
		expected: string,
		found: string | null,
	) {
		const what = {
			"source-digest": "source digest",
			"nova-revision": "Nova revision",
			"remote-app": "CommCare HQ app",
			"observed-at": "read no later than",
			"target-identity": "target identity",
		}[fence];
		super(
			`The deployment's baseline is not the one this plan read (expected ${what} ${expected}, found ${found ?? "none"}), so nothing was recorded. Another write landed in between; the caller answers the review as it now stands.`,
		);
		this.name = "HqChangesBaselineMovedError";
		this.fence = fence;
		this.expected = expected;
		this.found = found;
	}
}

/** The two Web App lines a list never stores: each is worked out again from where the app runs. */
const WEB_APPS_LINES: ReadonlySet<FirstPublishChangeId> = new Set([
	"web-apps-turned-off",
	"web-apps-turned-on",
]);

/** What the list a bring-in of changes leaves on the baseline is made from. */
export interface HqChangesFirstPublish {
	/** The list acceptance gave this request's reading for the app's declaration, as a list stores it
	 *  (`reading/firstPublishChanges.ts::firstPublishListToStore`). */
	readonly accepted: FirstPublishView;
	/** The ids of what the next publish changes in CommCare HQ, from the plan. */
	readonly publishChanges: readonly FirstPublishChangeId[];
	/** The Web App setting the source CommCare HQ served holds (`HqAppSource.cloudcareEnabled`). */
	readonly webAppsOnInHq: boolean;
}

/** `ids` in registry order, once each, less the two Web App lines. */
function storedIds(
	ids: readonly FirstPublishChangeId[],
): readonly FirstPublishChangeId[] {
	const present = new Set(ids);
	return FIRST_PUBLISH_CHANGE_IDS.filter(
		(id) => present.has(id) && !WEB_APPS_LINES.has(id),
	);
}

/**
 * The list the baseline holds after a bring-in of changes. Where it held a
 * list of an app brought in and not yet published, the first publish still
 * makes every change of this reading's own list over the app as it now is.
 * Otherwise the next publish's changes: each change of a stored list of the
 * next publish that this reading still gives (an earlier bring-in's change
 * the next publish still makes, since only a push ends it), and the plan's
 * own; else none.
 */
function hqChangesFirstPublishList(
	stored: StoredFirstPublish | null,
	input: HqChangesFirstPublish,
): StoredFirstPublish | null {
	if (stored?.of === "first-publish") {
		return {
			ids: storedIds(input.accepted.ids),
			webAppsOnInHq: input.webAppsOnInHq,
			of: "first-publish",
		};
	}
	const given = new Set(input.accepted.ids);
	const carried =
		stored?.of === "next-publish"
			? stored.ids.filter((id) => given.has(id))
			: [];
	const ids = storedIds([...carried, ...input.publishChanges]);
	if (ids.length === 0) return null;
	return {
		ids,
		webAppsOnInHq: input.webAppsOnInHq,
		of: "next-publish",
	};
}

/** What a bring-in of changes made in CommCare HQ records beside its commit. */
export interface HqChangesTaken extends DeploymentFence {
	readonly scope: DeploymentScope;
	readonly target: DeploymentTargetKey;
	/** The CommCare HQ app the review read: the live app mapping must still name it. */
	readonly remoteAppId: string;
	/** The stored baseline the plan read. */
	readonly read: {
		readonly sourceDigest: string;
		readonly novaRevision: number;
	};
	/** CommCare HQ's source as this request read it, normalized, compressed and digested. */
	readonly source: {
		readonly sourceGzip: Buffer;
		readonly sourceBytes: number;
		readonly sourceDigest: string;
		/** Taken before CommCare HQ was asked. */
		readonly observedAt: string;
	};
	/** The ownership the next publish's body gives over that source and the document taken. */
	readonly ownership: AppOwnership;
	/** Which CommCare HQ file stands at each path the app publishes. */
	readonly mediaFiles: HqMediaRecord;
	/**
	 * The deployment's target-identity record as the take read it (`read`)
	 * and as the reading resolves it (`next`,
	 * `targetIdentity.ts::resolveTargetIdentity`), the record the take's export
	 * and ownership were computed over.
	 */
	readonly targetIdentity: {
		readonly read: TargetIdentity;
		readonly next: TargetIdentity;
	};
	readonly firstPublish: HqChangesFirstPublish;
}

/**
 * Where `recordHqChangesTaken` runs: in a commit's own transaction, with the
 * sequence that commit takes, or in a short transaction of its own, for a
 * take whose batch is empty, at the head the plan read.
 */
export type HqChangesRecordAt =
	| {
			readonly kind: "commit";
			readonly tx: Transaction<AppDatabase>;
			readonly seq: number;
	  }
	| { readonly kind: "own"; readonly headSeq: number };

/**
 * Records a bring-in of changes made in CommCare HQ: moves the pair of the
 * deployment's baseline and the Nova revision it describes to CommCare HQ's
 * source as this request read it and the revision that holds it. `edit`.
 *
 * It takes the deployment row `FOR UPDATE` after the app's row, as every
 * deployment write does (in a commit's transaction the kernel already holds
 * the app's), carries `expectedEndings`, and then:
 *
 * 1. fences: the baseline is still the one the plan read, by its digest and
 *    its revision, no newer read of the app is stored, and the live app
 *    mapping still names the HQ app that was read, else it throws
 *    `HqChangesBaselineMovedError`;
 * 2. writes the baseline of origin `changes` at the revision, with the
 *    ownership and the media record the caller computed;
 * 3. writes the target-identity record the reading resolved
 *    (`writeTargetIdentityInTransaction`), where the stored one is still the
 *    one it resolved over, else it throws `HqChangesBaselineMovedError`;
 * 4. keeps the next publish's list by `hqChangesFirstPublishList`.
 *
 * The mapping's pushed revision, the deployment's state and its phase
 * outcomes do not change: nothing was sent to CommCare HQ.
 */
export async function recordHqChangesTaken(
	at: HqChangesRecordAt,
	input: HqChangesTaken,
): Promise<DeploymentWithResources> {
	if (at.kind === "own") {
		return withDeploymentRow(
			input.scope,
			input.target,
			{ ensure: false, expectedEndings: input.expectedEndings },
			(tx, row) => recordHqChangesInTransaction(tx, row.id, at.headSeq, input),
		);
	}
	const { tx } = at;
	await lockAppForDeploymentWrite(tx, input.scope, "edit");
	const row = await lockDeploymentRow(tx, input.scope, input.target);
	if (row.endings !== input.expectedEndings) {
		throw new DeploymentEndedError(row.id, input.expectedEndings, row.endings);
	}
	return recordHqChangesInTransaction(tx, row.id, at.seq, input);
}

async function recordHqChangesInTransaction(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	novaRevision: number,
	input: HqChangesTaken,
): Promise<DeploymentWithResources> {
	const { scope } = input;
	// 1. The fences.
	const stored = await tx
		.selectFrom("app_deployment_baselines")
		.select([
			"origin",
			"source_digest",
			"nova_revision",
			"observed_at",
			"first_publish_changes",
		])
		.where("deployment_id", "=", deploymentId)
		.executeTakeFirst();
	const liveMapping = await tx
		.selectFrom("app_deployment_resources")
		.select("remote_id")
		.where("deployment_id", "=", deploymentId)
		.where("kind", "=", "app")
		.where("nova_resource_id", "=", scope.appId)
		.where("superseded_at", "is", null)
		.where("released_at", "is", null)
		.executeTakeFirst();
	if (liveMapping?.remote_id !== input.remoteAppId) {
		throw new HqChangesBaselineMovedError(
			"remote-app",
			input.remoteAppId,
			liveMapping?.remote_id ?? null,
		);
	}
	const holdsAPair =
		stored !== undefined &&
		(stored.origin === "push" ||
			stored.origin === "read" ||
			stored.origin === "changes");
	if (!holdsAPair || stored.source_digest !== input.read.sourceDigest) {
		throw new HqChangesBaselineMovedError(
			"source-digest",
			input.read.sourceDigest,
			holdsAPair ? stored.source_digest : null,
		);
	}
	const storedRevision = numberOrNull(stored.nova_revision);
	if (storedRevision !== input.read.novaRevision) {
		throw new HqChangesBaselineMovedError(
			"nova-revision",
			String(input.read.novaRevision),
			storedRevision === null ? null : String(storedRevision),
		);
	}
	if (stored.observed_at.getTime() > Date.parse(input.source.observedAt)) {
		throw new HqChangesBaselineMovedError(
			"observed-at",
			input.source.observedAt,
			stored.observed_at.toISOString(),
		);
	}

	// 2. The pair, and 4. the next publish's list.
	await writeAppBaseline(tx, deploymentId, scope.actorUserId, {
		origin: "changes",
		remoteAppId: input.remoteAppId,
		sourceGzip: input.source.sourceGzip,
		sourceBytes: input.source.sourceBytes,
		sourceDigest: input.source.sourceDigest,
		ownership: input.ownership,
		observedAt: input.source.observedAt,
		discard: null,
		novaRevision,
		mediaFiles: { kind: "set", files: input.mediaFiles },
		firstPublish: {
			kind: "set",
			list: hqChangesFirstPublishList(
				storedFirstPublish(deploymentId, stored.first_publish_changes),
				input.firstPublish,
			),
		},
	});

	// 3. Where CommCare HQ keeps the app's menus, forms, keyed creates and files.
	await writeTakenTargetIdentity(tx, deploymentId, input);

	await notifyAppDeployments(tx, scope.appId);
	return loadWithinTransaction(tx, deploymentId);
}

/**
 * The record a take resolved, written where the stored one is still the one it
 * resolved over: otherwise another write moved it between the review and the
 * take, and the take is the review again (`HqChangesBaselineMovedError`).
 */
async function writeTakenTargetIdentity(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	input: Pick<HqChangesTaken, "scope" | "target" | "targetIdentity">,
): Promise<void> {
	try {
		await writeTargetIdentityInTransaction(
			tx,
			deploymentId,
			{ appId: input.scope.appId, server: input.target.server },
			input.targetIdentity,
		);
	} catch (error) {
		if (error instanceof TargetIdentityMovedError)
			throw new HqChangesBaselineMovedError(
				"target-identity",
				"the record the review resolved over",
				null,
			);
		throw error;
	}
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
 *
 * `nova_revision` is written as given. The media record and the
 * first-publish list are each written as a `set` gives them; a `keep` keeps
 * the row's value where the HQ app is the same and writes null where it is
 * another app, whose files and list the row never described.
 * `observedBy` is the person whose read this is, who also made any discard
 * it carries.
 */
async function writeAppBaseline(
	tx: Transaction<AppDatabase>,
	deploymentId: string,
	observedBy: string,
	baseline: AppBaselineWrite,
): Promise<void> {
	const discarded = baseline.discard !== null;
	const keepMediaFiles = baseline.mediaFiles.kind === "keep";
	const mediaFiles =
		baseline.mediaFiles.kind === "set" && baseline.mediaFiles.files !== null
			? JSON.stringify(baseline.mediaFiles.files)
			: null;
	const keepFirstPublish = baseline.firstPublish.kind === "keep";
	const firstPublish =
		baseline.firstPublish.kind === "set" && baseline.firstPublish.list !== null
			? JSON.stringify(baseline.firstPublish.list)
			: null;
	await sql`
		INSERT INTO app_deployment_baselines AS existing (
			deployment_id, remote_app_id, origin, source_gzip, source_bytes,
			source_digest, ownership, observed_at, observed_by,
			discarded_digest, discarded_by, discarded_at,
			nova_revision, media_files, first_publish_changes
		) VALUES (
			${deploymentId}, ${baseline.remoteAppId}, ${baseline.origin},
			${baseline.sourceGzip}, ${baseline.sourceBytes},
			${baseline.sourceDigest},
			${baseline.ownership === null ? null : JSON.stringify(baseline.ownership)}::jsonb,
			${baseline.observedAt}::timestamptz, ${observedBy},
			${baseline.discard?.digest ?? null},
			${discarded ? observedBy : null},
			${discarded ? sql`now()` : null},
			${baseline.novaRevision}::bigint,
			${mediaFiles}::jsonb,
			${firstPublish}::jsonb
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
				ELSE EXCLUDED.discarded_at END,
			nova_revision = EXCLUDED.nova_revision,
			media_files = CASE
				WHEN ${keepMediaFiles}::boolean AND EXCLUDED.remote_app_id = existing.remote_app_id
					THEN existing.media_files
				ELSE EXCLUDED.media_files END,
			first_publish_changes = CASE
				WHEN ${keepFirstPublish}::boolean AND EXCLUDED.remote_app_id = existing.remote_app_id
					THEN existing.first_publish_changes
				ELSE EXCLUDED.first_publish_changes END
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
 *
 * `admitted` names the push's writes, which authorize the record and are
 * settled with it, with no fence: an ending keeps every table and place
 * mapping, and these baselines are what CommCare HQ holds of them. With
 * nothing admitted it is under the fence and needs a live app and `edit`.
 */
export async function markResourceBaselinesUnread(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	refs: readonly ResourceBaselineRef[],
	fence: DeploymentFence,
	admitted?: AdmittedRecord,
): Promise<void> {
	if (refs.length === 0 && (admitted?.settle ?? []).length === 0) return;
	const observedAt = new Date().toISOString();
	await withRecordRow(
		scope,
		target,
		{ admitted, writeKinds: ["workbook", "places"] },
		async (tx, row) => {
			if (admitted === undefined || admitted.writeIds.length === 0)
				holdFence(row, fence.expectedEndings);
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
		},
	);
}

/**
 * The app as CommCare HQ returned it when Nova last read it on this target,
 * or null when no baseline was ever written.
 *
 * `edit`, not `view`: the row holds HQ app source. The stored text is
 * verified against its digest outside any transaction; a row that does not
 * verify is not a read Nova can compare with, so it is logged and returned
 * as `unread`, which stops the next publish to ask, with the origin the row
 * holds as `storedOrigin`, so the copy can say what Nova could not confirm.
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
			"b.source_bytes",
			"b.source_digest",
			"b.ownership",
			"b.observed_at",
			"b.observed_by",
			"b.nova_revision",
			"b.media_files",
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
		novaRevision: numberOrNull(row.nova_revision),
		mediaFiles: storedMediaFiles(row.deployment_id, row.media_files),
	};
	if (row.origin === "unread") {
		return {
			origin: "unread",
			storedOrigin: "unread",
			...observed,
			novaRevision: null,
		};
	}
	const origin = knownReadOrigin(row.deployment_id, row.origin);
	const verified = verifiedBaselineSource(row);
	if (
		verified === null ||
		row.source_digest === null ||
		row.source_bytes === null
	) {
		return { origin: "unread", storedOrigin: origin, ...observed };
	}
	return {
		origin,
		...observed,
		source: verified.source,
		sourceDigest: row.source_digest,
		ownership: verified.ownership,
		sourceBytes: row.source_bytes,
	};
}

/**
 * The stored media record, or null where the row holds none. Nova wrote the
 * value, so one that fails the parse is logged at error and read as no
 * record, which a publish treats as knowing no file at any path.
 */
function storedMediaFiles(
	deploymentId: string,
	value: unknown,
): HqMediaRecord | null {
	if (value === null) return null;
	const parsed = hqMediaRecordSchema.safeParse(value);
	if (parsed.success) return parsed.data;
	log.error("[deployment] stored media record does not parse", undefined, {
		deploymentId,
		/* The issue's code alone: a path is the app's own words. */
		reason: parsed.error.issues[0]?.code ?? "unknown shape",
	});
	return null;
}

/** The origin of a stored baseline that holds a read, or a throw for one Nova does not know. */
function knownReadOrigin(
	deploymentId: string,
	origin: string,
): "create" | "push" | "cutover" | "read" | "changes" {
	if (
		origin === "create" ||
		origin === "push" ||
		origin === "cutover" ||
		origin === "read" ||
		origin === "changes"
	) {
		return origin;
	}
	throw new Error(
		`Deployment ${deploymentId} stores an app baseline of origin "${origin}", which Nova does not know.`,
	);
}

/**
 * Gunzip, check the digest, parse the JSON and read the ownership of one
 * stored baseline row.
 *
 * A row that does not verify is no read Nova can use: it is logged and
 * answers null, which `readAppBaseline` reports as `unread` and
 * `readTargetFacts` as no facts.
 */
function verifiedBaselineSource(row: {
	readonly deployment_id: string;
	readonly source_gzip: Buffer | null;
	readonly source_digest: string | null;
	readonly ownership: unknown;
}): { readonly source: unknown; readonly ownership: AppOwnership } | null {
	const unverified = (reason: string): null => {
		log.error("[deployment] app baseline does not verify", undefined, {
			deploymentId: row.deployment_id,
			reason,
		});
		return null;
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
		source = parseHqJsonText(text.toString("utf8"));
	} catch {
		return unverified("json");
	}
	const ownership = appOwnershipFromRow(row.ownership);
	if (ownership === null) return unverified("ownership");
	return { source, ownership };
}

/** At most this many projections are held per instance. */
const TARGET_FACTS_CACHE_LIMIT = 64;

/**
 * Projections already made, keyed by the row, the bytes its digest names,
 * the ownership of `auto_gps_capture` and whether the app was brought in:
 * everything the projection reads but the date, which each read applies.
 * The digest names the bytes, so an entry is never stale; the limit bounds
 * the memory an instance spends. The oldest entry leaves first, and a hit
 * moves its entry to the newest place.
 */
const targetFactsCache = new Map<string, TargetFacts | null>();

function targetFactsCacheKey(
	deploymentId: string,
	sourceDigest: string,
	novaOwnsAutoGpsCapture: boolean,
	adopted: boolean,
): string {
	return [
		deploymentId,
		sourceDigest,
		novaOwnsAutoGpsCapture ? "nova-gps" : "target-gps",
		adopted ? "adopted" : "created",
	].join("\u0000");
}

function rememberTargetFacts(key: string, facts: TargetFacts | null): void {
	targetFactsCache.delete(key);
	targetFactsCache.set(key, facts);
	while (targetFactsCache.size > TARGET_FACTS_CACHE_LIMIT) {
		const oldest = targetFactsCache.keys().next();
		if (oldest.done === true) break;
		targetFactsCache.delete(oldest.value);
	}
}

/**
 * The first-publish list each of the app's deployments keeps on its
 * baseline, keyed by deployment id, with the HQ app the baseline was read
 * from. A deployment that keeps none has no entry.
 *
 * `view`, where `readAppBaseline` takes `edit`: it selects the list and the
 * HQ app's id and never the source, so the Publishing section and the
 * pre-publish check read it as a viewer does. A stored id the registry no
 * longer holds is dropped with a warning, and a value of any other shape is
 * logged at error and read as no list: an edit of the registry stops no
 * page and no publish.
 */
export async function readFirstPublishStates(
	from: DeploymentReadFrom,
): Promise<ReadonlyMap<string, FirstPublishState>> {
	return readingIn(from, "view", (snapshot) => firstPublishStatesIn(snapshot));
}

async function firstPublishStatesIn(
	snapshot: DeploymentReadSnapshot,
): Promise<ReadonlyMap<string, FirstPublishState>> {
	const { scope } = snapshot;
	const rows = await snapshot.db
		.selectFrom("app_deployment_baselines as b")
		.innerJoin("app_deployments as d", "d.id", "b.deployment_id")
		.select(["b.deployment_id", "b.remote_app_id", "b.first_publish_changes"])
		.where("d.app_id", "=", scope.appId)
		.where("d.project_id", "=", scope.projectId)
		.where("b.first_publish_changes", "is not", null)
		.execute();
	const states = new Map<string, FirstPublishState>();
	for (const row of rows) {
		const stored = storedFirstPublish(
			row.deployment_id,
			row.first_publish_changes,
		);
		if (stored !== null)
			states.set(row.deployment_id, {
				remoteAppId: row.remote_app_id,
				stored,
			});
	}
	return states;
}

const REGISTERED_FIRST_PUBLISH_IDS: ReadonlySet<string> = new Set(
	FIRST_PUBLISH_CHANGE_IDS,
);

/**
 * A stored first-publish list as the registry reads it now, or null. A null
 * column is no list. Nova wrote every other value, so one that is no list of
 * ids beside a Web App setting and a kind is logged at error; an id the
 * registry has since lost is dropped with a warning and the rest kept.
 */
function storedFirstPublish(
	deploymentId: string,
	value: unknown,
): StoredFirstPublish | null {
	if (value === null) return null;
	const unreadable = (issue: string): null => {
		log.error(
			`The deployment ${deploymentId} holds first-publish changes Nova can't read (${issue}). They are written when an app is brought in, by lib/deployment/adoption.ts::adoptedAppBaselineWrite, and when changes made in CommCare HQ are brought in or recorded, by lib/deployment/store.ts::recordHqChangesTaken and ::recordRefreshedAppBaseline. Nova is showing this deployment with no list.`,
			undefined,
			{ deploymentId },
		);
		return null;
	};
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return unreadable("not an object");
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.join(",") !== "ids,of,webAppsOnInHq")
		return unreadable(`keys ${keys.join(", ")}`);
	if (!Array.isArray(record.ids)) return unreadable("ids is not a list");
	const ids = record.ids.filter((id) => {
		if (typeof id !== "string" || REGISTERED_FIRST_PUBLISH_IDS.has(id))
			return true;
		log.warn("[deployment] first-publish change no longer registered", {
			deploymentId,
			changeId: id,
		});
		return false;
	});
	const parsed = storedFirstPublishSchema.safeParse({ ...record, ids });
	if (!parsed.success)
		return unreadable(parsed.error.issues[0]?.code ?? "unknown shape");
	return parsed.data;
}

/**
 * What the project space holds of the values Nova leaves to CommCare HQ,
 * projected from this target's stored app baseline, or null where there is
 * no observed source, the source is an empty shell's, or it does not verify.
 *
 * `view`, where `readAppBaseline` takes `edit`: this returns the typed
 * projection and never the source, and every value of it is one a viewer's
 * own `.ccz` carries. It reads the stored bytes in its own snapshot
 * (`holdTargetFacts`) and verifies and projects them once that snapshot has
 * given its connection back (`targetFactsOf`).
 */
export async function readTargetFacts(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<TargetFacts | null> {
	return targetFactsOf(
		await withDeploymentReadSnapshot(scope, "view", (snapshot) =>
			holdTargetFacts(snapshot, target),
		),
	);
}

/**
 * A target's kept facts as one snapshot read them: the projection itself,
 * where there is none to make or this instance already made it for the
 * stored digest, or the stored row's bytes, which `targetFactsOf` verifies
 * and projects. The bytes are the row the snapshot authorized, read in it,
 * so projecting them after the snapshot is released answers from that one
 * generation all the same: nothing read later goes into the answer.
 */
export type HeldTargetFacts =
	| { readonly kind: "made"; readonly facts: TargetFacts | null }
	| {
			readonly kind: "bytes";
			readonly deploymentId: string;
			readonly sourceGzip: Buffer | null;
			readonly sourceDigest: string | null;
			readonly ownership: unknown;
			readonly observedAt: Date;
			readonly adopted: boolean;
	  };

/**
 * Read inside `snapshot` what `targetFactsOf` needs for one target's kept
 * facts. It reads in two steps so a page load does not unzip the source each
 * time: the row without its bytes first, then the bytes only for a
 * projection this instance has not made before. Both name the scope's app and
 * Project, so the bytes are the row the first step authorized, whatever a
 * move or a publish commits between them. It does no CPU work over the
 * bytes: the gunzip, the digest and the parse of up to the largest source
 * Nova reads wait until the snapshot's pooled connection is given back.
 */
export async function holdTargetFacts(
	snapshot: DeploymentReadSnapshot,
	target: DeploymentTargetKey,
): Promise<HeldTargetFacts> {
	if (!roleAllowsApp(snapshot.role, "view")) throw deploymentNotFound();
	const { scope, db } = snapshot;
	const row = await db
		.selectFrom("app_deployment_baselines as b")
		.innerJoin("app_deployments as d", "d.id", "b.deployment_id")
		.leftJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "d.id")
				.on("r.kind", "=", "app")
				.on("r.superseded_at", "is", null),
		)
		.select([
			"b.deployment_id",
			"b.origin",
			"b.source_digest",
			"b.ownership",
			"b.observed_at",
			"r.ownership as app_ownership",
		])
		.where("d.app_id", "=", scope.appId)
		.where("d.project_id", "=", scope.projectId)
		.where("d.server", "=", target.server)
		.where("d.domain", "=", target.domain)
		.executeTakeFirst();
	const none = { kind: "made", facts: null } as const;
	if (row === undefined || row.source_digest === null) return none;
	if (
		row.origin !== "unread" &&
		knownReadOrigin(row.deployment_id, row.origin) === "create"
	)
		return none;
	const observedAt = row.observed_at.toISOString();
	const adopted = row.app_ownership === "adopted";
	const ownership = appOwnershipFromRow(row.ownership);
	if (ownership !== null) {
		const key = targetFactsCacheKey(
			row.deployment_id,
			row.source_digest,
			ownership.autoGpsCapture,
			adopted,
		);
		if (targetFactsCache.has(key)) {
			const facts = targetFactsCache.get(key) ?? null;
			rememberTargetFacts(key, facts);
			return {
				kind: "made",
				facts: facts === null ? null : { ...facts, observedAt },
			};
		}
	}

	/* The bytes come with their own row's origin and date: a publish or a
	 * refresh that rewrote the baseline between the two statements is
	 * answered from the read it stored, never from the first row's date. */
	const bytes = await db
		.selectFrom("app_deployment_baselines as b")
		.innerJoin("app_deployments as d", "d.id", "b.deployment_id")
		.select([
			"b.origin",
			"b.source_gzip",
			"b.source_digest",
			"b.ownership",
			"b.observed_at",
		])
		.where("b.deployment_id", "=", row.deployment_id)
		.where("d.app_id", "=", scope.appId)
		.where("d.project_id", "=", scope.projectId)
		.executeTakeFirst();
	if (bytes === undefined || bytes.source_digest === null) return none;
	if (
		bytes.origin !== "unread" &&
		knownReadOrigin(row.deployment_id, bytes.origin) === "create"
	)
		return none;
	return {
		kind: "bytes",
		deploymentId: row.deployment_id,
		sourceGzip: bytes.source_gzip,
		sourceDigest: bytes.source_digest,
		ownership: bytes.ownership,
		observedAt: bytes.observed_at,
		adopted,
	};
}

/**
 * The kept facts `holdTargetFacts` read, verified and projected outside any
 * snapshot, and remembered for the stored digest.
 */
export function targetFactsOf(held: HeldTargetFacts): TargetFacts | null {
	if (held.kind === "made") return held.facts;
	const verified = verifiedBaselineSource({
		deployment_id: held.deploymentId,
		source_gzip: held.sourceGzip,
		source_digest: held.sourceDigest,
		ownership: held.ownership,
	});
	if (verified === null || held.sourceDigest === null) return null;
	const facts = targetFactsFromSource(verified.source, {
		observedAt: held.observedAt.toISOString(),
		novaOwnsAutoGpsCapture: verified.ownership.autoGpsCapture,
		adopted: held.adopted,
	});
	rememberTargetFacts(
		targetFactsCacheKey(
			held.deploymentId,
			held.sourceDigest,
			verified.ownership.autoGpsCapture,
			held.adopted,
		),
		facts,
	);
	return facts;
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
	const profileFeatures =
		stored.profileFeatures === undefined
			? undefined
			: stringList(stored.profileFeatures);
	if (
		addOns === null ||
		profileProperties === null ||
		profileCustomProperties === null ||
		profileFeatures === null ||
		typeof stored.autoGpsCapture !== "boolean"
	)
		return null;
	return {
		addOns,
		profileProperties,
		profileCustomProperties,
		...(profileFeatures !== undefined && { profileFeatures }),
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
): Promise<string> {
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
	const adoptedAt = input.adoptedAt ?? null;
	if (!adopted && adoptedAt !== null) {
		throw new Error(
			"Only an adopted resource records when it was adopted; a resource Nova created has no such decision to date.",
		);
	}
	const attribution = {
		ownership: input.ownership,
		adopted_at: adopted
			? adoptedAt === null
				? now
				: new Date(adoptedAt)
			: null,
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

	/* The save counter the import that wrote these push fields acknowledged,
	 * which orders two publishes of one app (`recordRemoteResource`). */
	const pushedRemoteRevision =
		input.pushedRevision === null ? null : input.remoteRevision;

	/* `remote_revision`/`remote_observed_at` are written in BOTH arms:
	 * a republish always lands in the conflict arm, so an insert-only
	 * write would silently drop the version an in-place update
	 * reported. */
	const pushed = await tx
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: deploymentId,
			kind: input.kind,
			nova_resource_id: input.novaResourceId,
			remote_id: input.remoteId,
			...attribution,
			pushed_revision: input.pushedRevision,
			pushed_at: input.pushedRevision === null ? null : now,
			pushed_remote_revision: pushedRemoteRevision,
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
					pushed_remote_revision: pushedRemoteRevision,
					remote_revision: input.remoteRevision,
					remote_observed_at: input.remoteRevision === null ? null : now,
					/* A write that landed on this remote id is CommCare HQ
					 * answering for it, so it is not gone. */
					remote_missing_at: null,
				}),
		)
		.returning("push_token")
		.executeTakeFirstOrThrow();
	return pushed.push_token;
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
 * superseded here (provisioning, which is no publish, says the same of its
 * one kind from the personas the app still has: `recordProvisionedWorkers`).
 * Dropping the last select that read a table, or
 * archiving a place, leaves that resource sitting on the project space
 * under Nova's own claim, and without this its row would stay live forever
 * and `leftBehindResources` — which only ever scans superseded rows —
 * would never mention it. Superseding is the whole fix: Nova still deletes
 * nothing on CommCare HQ, it just stops claiming the resource and starts
 * reporting it.
 *
 * `write.admitted` names the push's writes (the workbook's, or each batch of
 * places'), which authorize the record and are settled with it: an app
 * deleted, or a publisher who lost edit, since the push was admitted keeps the
 * mappings and baselines of what it made, and a complete push still says
 * which resources of its kinds the app it published uses; the caller is
 * answered the record only where they may still read it (`RecordAnswer`).
 * Its record is fenced only in what an ending changes: an ending keeps every table and place
 * mapping, so what the push made is recorded all the same, as a `partial`
 * push that supersedes nothing and folds no rung, since the ending is the
 * deployment's latest word. A record with nothing admitted (an app that
 * stopped carrying a kind) needs a live app and `edit`, and an ending since
 * throws `DeploymentEndedError`.
 */
export async function recordPushedResources(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	inputs: readonly RecordRemoteResourceInput[],
	outcome: ResourcePushOutcome,
	write: DeploymentFence & {
		/** HQ's reads of what the push left, written with the mappings whatever the outcome. */
		readonly baselines?: readonly ResourceBaselineWrite[];
		readonly admitted?: AdmittedRecord;
	},
): Promise<RecordAnswer> {
	const admitted =
		write.admitted !== undefined && write.admitted.writeIds.length > 0;
	const landed = inputs.map(landedResource);
	return withRecordRow(
		scope,
		target,
		{ admitted: write.admitted, writeKinds: ["workbook", "places"] },
		async (tx, row, access) => {
			const ended = row.endings !== write.expectedEndings;
			if (ended && !admitted) holdFence(row, write.expectedEndings);
			const now = new Date();
			for (const input of inputs) {
				await writeResourceMapping(tx, row.id, input, now);
			}
			await writeResourceBaselines(tx, scope, target, write.baselines ?? []);
			if (outcome.status === "partial" || ended) {
				await notifyAppDeployments(tx, scope.appId);
				return answerRecord(tx, row.id, access, landed);
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
			return answerRecord(tx, row.id, access, landed);
		},
	);
}

/**
 * Record the levels a person confirmed take workers in the project space,
 * immediately before provisioning writes the first account there. Under the
 * fence: an ending since throws `DeploymentEndedError` and records nothing.
 * One already in force is kept as it is, so its first confirmer stays on
 * record.
 */
export async function recordWorkerLevelConfirmations(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	levelCodes: readonly string[],
	fence: DeploymentFence,
): Promise<void> {
	if (levelCodes.length === 0) return;
	await withDeploymentRow(
		scope,
		target,
		{ ensure: false, expectedEndings: fence.expectedEndings },
		async (tx, row) => {
			await insertDeploymentConfirmationsInTransaction(
				tx,
				row.id,
				scope.actorUserId,
				levelCodes.map((subject) => ({ kind: "worker-level", subject })),
			);
			await notifyAppDeployments(tx, scope.appId);
		},
	);
}

/**
 * Admit one worker account's write, immediately before it is sent: under the
 * fence (an ending since throws `DeploymentEndedError` and sends nothing), it
 * records the write open for its hold, which keeps a Project move of the app
 * waiting until the account it may make is recorded
 * (`recordProvisionedWorkers`).
 */
export async function admitWorkerWrite(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: DeploymentFence & { readonly personaUuid: string },
): Promise<string> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false, expectedEndings: input.expectedEndings },
		async (tx, row) => {
			const [writeId] = await admitRemoteWritesInTransaction(tx, [
				{
					deploymentId: row.id,
					server: target.server,
					domain: target.domain,
					appId: scope.appId,
					projectId: scope.projectId,
					actorUserId: scope.actorUserId,
					resourceKind: "worker",
					resourceId: input.personaUuid,
					writeKind: "worker",
					holdSeconds: REMOTE_WRITE_HOLD_SECONDS.worker,
				},
			]);
			if (writeId === undefined) {
				throw new Error("An admitted worker write returned no id.");
			}
			return writeId;
		},
	);
}

/**
 * Record the worker accounts a provisioning call made or updated, reconcile
 * the worker mappings against the personas the app still has, and settle the
 * call's admitted writes, in one transaction.
 *
 * Under no fence: an ending keeps every worker mapping
 * (`hqAppClaims.ts::endDeploymentInTransaction`), since the accounts are still
 * on the project space, so an account made while someone stopped publishing is
 * recorded like any other rather than left as a stranger's for the next
 * call to stop over. The admissions kept a Project move waiting, so the app is
 * where the call found it.
 *
 * What the call's writes made is recorded on the authority of their
 * admissions (`lockAppForAdmittedRecord`): an app deleted since, or a caller
 * who lost edit since, still gets the accounts the call made recorded, since
 * they are on the project space either way and only the record says they are
 * Nova's. The reconciliation is the document's and is made only by a caller
 * who may edit a live app, so it waits for the next call where either changed.
 * The caller is answered the record only where they may still read it
 * (`RecordAnswer`); the accounts and their passwords are the call's own answer.
 */
export async function recordProvisionedWorkers(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: {
		readonly landed: readonly RecordRemoteResourceInput[];
		/** The personas the app still has. */
		readonly stillUsed: readonly string[];
		/** The call's admitted writes, settled here except for a write whose outcome is still unknown. */
		readonly writeIds: readonly string[];
		readonly unansweredWriteId?: string;
	},
): Promise<RecordAnswer> {
	for (const landed of input.landed) {
		if (landed.kind !== "worker") {
			throw new Error(
				`Provisioning records worker accounts only, and was handed a ${landed.kind} mapping.`,
			);
		}
	}
	const settle: WritesEnded[] = [
		{
			writeIds: input.writeIds.filter((id) => id !== input.unansweredWriteId),
			how: { kind: "settled" },
		},
	];
	if (input.unansweredWriteId !== undefined) {
		settle.push({
			writeIds: [input.unansweredWriteId],
			how: { kind: "unanswered" },
		});
	}
	return withRecordRow(
		scope,
		target,
		{
			admitted: { writeIds: input.writeIds, settle },
			writeKinds: ["worker"],
		},
		async (tx, row, access) => {
			const now = new Date();
			for (const landed of input.landed) {
				await writeResourceMapping(tx, row.id, landed, now);
			}
			if (access.edit)
				await tx
					.updateTable("app_deployment_resources")
					.set({ superseded_at: now })
					.where("deployment_id", "=", row.id)
					.where("kind", "=", "worker")
					.where("superseded_at", "is", null)
					.$if(input.stillUsed.length > 0, (qb) =>
						qb.where("nova_resource_id", "not in", input.stillUsed),
					)
					.execute();
			await notifyAppDeployments(tx, scope.appId);
			return answerRecord(tx, row.id, access, input.landed.map(landedResource));
		},
	);
}

/**
 * Lock the app row for recording what admitted writes made, on the authority
 * of those admissions: each must be a write of one of `writeKinds` this caller
 * admitted for this app, Project and project space (`admitAppCreate`,
 * `admitAppWrite`, `admitWorkbookWrite`, `admitPlacesWrite`,
 * `admitWorkerWrite`), and the app must still be in that Project, which a
 * move cannot change while an admission is open. Neither the app's deletion
 * nor the caller's role since decides whether it records: the record states
 * what the writes already made. Both decide what the caller may do now, read
 * here by the authorization every deployment read and write makes
 * (`authorizeDeploymentApp`, with the membership locked as a write locks it):
 * a record that reconciles against the document needs `edit`, and a record
 * answers the deployment only to a caller who may `read` it.
 */
async function lockAppForAdmittedRecord(
	tx: Transaction<AppDatabase>,
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	writeIds: readonly string[],
	writeKinds: readonly HqRemoteWriteKind[],
): Promise<RecordAccess> {
	const app = await tx
		.selectFrom("apps")
		.select(["project_id", "deleted_at"])
		.where("id", "=", scope.appId)
		.forShare()
		.executeTakeFirst();
	if (app === undefined || app.project_id !== scope.projectId)
		throw deploymentNotFound();
	const admitted = await tx
		.selectFrom("hq_remote_writes")
		.select("id")
		.where("id", "in", writeIds)
		.where("app_id", "=", scope.appId)
		.where("project_id", "=", scope.projectId)
		.where("actor_user_id", "=", scope.actorUserId)
		.where("server", "=", target.server)
		.where("domain", "=", target.domain)
		.where("write_kind", "in", [...writeKinds])
		.execute();
	if (admitted.length !== new Set(writeIds).size) throw deploymentNotFound();
	try {
		const role = await authorizeDeploymentApp(
			app,
			scope,
			"view",
			"read",
			(projectId) =>
				projectRoleForInTransaction(tx, scope.actorUserId, projectId),
		);
		return { read: true, edit: roleAllowsApp(role, "edit") };
	} catch (error) {
		/* A deleted app (`DeploymentAppDeletedError`) is a not-found too. */
		if (error instanceof DeploymentError && error.code === "not_found")
			return { read: false, edit: false };
		throw error;
	}
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
 * `applied` says which happened. A mapping another Nova app's birth
 * released in that window is discarded too: CommCare HQ's answers are then
 * about that app's publishes.
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
				.where("released_at", "is", null)
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
	fence: DeploymentFence,
): Promise<string> {
	return withDeploymentRow(
		scope,
		target,
		{ ensure: false, expectedEndings: fence.expectedEndings },
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

/**
 * Superseded completion proves the remote write order uncertain. Fail closed.
 *
 * A deployment ended since the publish read it answers false and writes
 * nothing: the ending already cleared the manifest and rotated the
 * generation.
 *
 * `admitted` names every write the publish let out, which authorize the
 * write: the manifest is the record of what the import made, so an app
 * deleted, or a publisher who lost edit, since keeps it. It settles none.
 */
export async function finishDeploymentContentWrite(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	generation: string,
	manifest: PublishedEntryPointManifest | null,
	fence: DeploymentFence,
	admitted?: AdmittedRecord,
): Promise<boolean> {
	return withRecordRow(
		scope,
		target,
		{
			admitted,
			writeKinds: ["create", "import", "media", "workbook", "places"],
		},
		async (tx, row) => {
			if (row.endings !== fence.expectedEndings) return false;
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
