/**
 * One CommCare HQ app, one Nova app.
 *
 * A live, unreleased `app` mapping holds its HQ app against every other Nova
 * app, across Projects and both ownerships; the partial unique index
 * `app_deployment_resources_hq_app_claim` is the floor under that rule. This
 * module is every statement that takes, gives up, takes back or ends a claim:
 *
 *   - `claimHqAppInTransaction`: the first step of a birth from CommCare HQ.
 *     A holder in recently deleted gives its HQ app up here, at the take,
 *     never when it is deleted.
 *   - `lockReleasedClaimsInTransaction` + `settleReleasedClaimsInTransaction`:
 *     a restore (and a publish that finds a released mapping) takes back each
 *     HQ app the app gave up, from a holder in recently deleted too, or ends
 *     the deployment where a live Nova app holds it.
 *   - `endDeploymentInTransaction`: the one transaction that ends a
 *     deployment, for a person who stops publishing and for a settle. It
 *     ends the mapping of the HQ app it names, or nothing.
 *   - `remapDeploymentMediaPathsInTransaction`: a Project move's media paths.
 *
 * It also holds the ledger of writes Nova lets out to CommCare HQ
 * (`hq_remote_writes`): `admitRemoteWritesInTransaction` records one under
 * its admission's locks, and a write is open until its process settles it or
 * its hold ends (`openRemoteWrite.ts`, the one rule). No grant of an HQ app
 * to another Nova app happens while a write of another app to that HQ app is
 * open: a birth refuses with `HqAppWriteInFlightError`, and a settle leaves
 * the claim released.
 *
 * Lock order. Every HQ app's transaction advisory lock (keyed on
 * `nova-hq-app-claim-v1`) is taken before any app row: a birth takes its one
 * lock as the first statement of its transaction and then at most one existing
 * app row; a settle takes all of its advisory locks in key order, then app rows
 * in ascending app id, then the membership gate. Nothing waits for an advisory
 * lock while it holds an app row, and app rows are always waited for in one
 * order, so the protocols never form a cycle.
 *
 * It imports nothing of `lib/deployment` or `lib/commcare`: the server is the
 * stored text, and the vocabularies it writes are declared here and held equal
 * to the deployment vocabulary by `lib/deployment/__tests__/hqAppClaimsVocabulary.test.ts`.
 */

import "server-only";

import { sql, type Transaction } from "kysely";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	lockAppRow,
	type PersistedBlueprintAppRow,
} from "./canonicalCommitKernel";
import { openRemoteWrite } from "./openRemoteWrite";
import { type AppDatabase, notifyAppDeployments } from "./pg";

export const HQ_APP_CLAIM_INDEX = "app_deployment_resources_hq_app_claim";

/** `server` is the stored text; the column's CHECK bounds it, and `lib/deployment` narrows it. */
export interface HqAppKey {
	readonly server: string;
	readonly domain: string;
	readonly remoteAppId: string;
}

export const HQ_APP_MAPPING_OWNERSHIPS = ["nova-created", "adopted"] as const;

/** What a write Nova lets out to CommCare HQ is, by the resource it writes. */
export const HQ_REMOTE_APP_WRITE_KINDS = ["create", "import", "media"] as const;
export type HqRemoteAppWriteKind = (typeof HQ_REMOTE_APP_WRITE_KINDS)[number];
/** Every kind of write the ledger holds: an app's, a lookup table workbook or one JSON request for a table, a batch of places, a worker account. */
export type HqRemoteWriteKind =
	| HqRemoteAppWriteKind
	| "workbook"
	| "lookup-json"
	| "places"
	| "worker";
export const HQ_APP_END_REASONS = ["stopped", "claimed-elsewhere"] as const;
export type HqAppEndReason = (typeof HQ_APP_END_REASONS)[number];

/** The live Nova app that publishes to an HQ app. */
export interface HqAppClaimHolder {
	readonly appId: string;
	readonly projectId: string;
	readonly ownership: (typeof HQ_APP_MAPPING_OWNERSHIPS)[number];
	/** `adopted_by` for an adopted mapping, the deployment's `created_by` otherwise. */
	readonly byUserId: string;
	/** `adopted_at`, or the mapping's `created_at`. */
	readonly at: string;
}

/** `app_deployments.phases` as an ending writes it: every phase, never run. */
export const NO_PHASE_OUTCOMES_JSON =
	'{"preflight":null,"resources":null,"upload":null,"build":null,"release":null,"probe":null}';

export class HqAppAlreadyClaimedError extends Error {
	readonly name = "HqAppAlreadyClaimedError";
	constructor(
		readonly key: HqAppKey,
		readonly holder: HqAppClaimHolder | null,
	) {
		super(
			`Another Nova app already publishes to this CommCare HQ app on “${key.domain}”, so it can't be brought in again.`,
		);
	}
}

/**
 * A birth met a write another Nova app let out to this HQ app that has not
 * settled yet: the app that stopped publishing there may still be changing
 * it. Nothing was written. `settlesAt` is when the latest such write settles
 * at the latest.
 */
export class HqAppWriteInFlightError extends Error {
	readonly name = "HqAppWriteInFlightError";
	constructor(
		readonly key: HqAppKey,
		readonly settlesAt: string,
	) {
		super(
			`A publish to this CommCare HQ app on “${key.domain}” is still finishing, so no other Nova app can take it until ${settlesAt} at the latest.`,
		);
	}
}

/** Whether an error is a unique violation of the one-HQ-app-one-Nova-app index. */
export function isHqAppClaimIndexViolation(error: unknown): boolean {
	const candidate = error as { code?: unknown; constraint?: unknown } | null;
	return (
		candidate?.code === "23505" && candidate.constraint === HQ_APP_CLAIM_INDEX
	);
}

/** The text the HQ app's transaction advisory lock is keyed on. */
function claimLockText(key: HqAppKey): string {
	return JSON.stringify([
		"nova-hq-app-claim-v1",
		key.server,
		key.domain,
		key.remoteAppId,
	]);
}

/**
 * The HQ app's transaction advisory lock. Every protocol takes it before any
 * app row: a birth, a settle, and the admission of a write to that HQ app.
 */
export async function lockHqApp(
	tx: Transaction<AppDatabase>,
	key: HqAppKey,
): Promise<void> {
	await sql`SELECT pg_advisory_xact_lock(hashtextextended(${claimLockText(key)}, 0))`.execute(
		tx,
	);
}

function isMappingOwnership(
	value: string,
): value is HqAppClaimHolder["ownership"] {
	return (HQ_APP_MAPPING_OWNERSHIPS as readonly string[]).includes(value);
}

interface LiveClaimRow {
	readonly mapping_id: string;
	readonly ownership: string;
	readonly adopted_by: string | null;
	readonly adopted_at: Date | null;
	readonly mapping_created_at: Date;
	readonly app_id: string;
	readonly project_id: string;
	readonly created_by: string;
	readonly deleted_at: Date | null;
}

function holderOf(row: LiveClaimRow): HqAppClaimHolder {
	if (!isMappingOwnership(row.ownership)) {
		throw new Error(
			`The mapping ${row.mapping_id} holds the ownership "${row.ownership}", which Nova does not know. The ledger's CHECK admits only ${HQ_APP_MAPPING_OWNERSHIPS.join(" and ")}.`,
		);
	}
	const adopted = row.ownership === "adopted";
	const byUserId = adopted ? row.adopted_by : row.created_by;
	const at = adopted ? row.adopted_at : row.mapping_created_at;
	if (byUserId === null || at === null) {
		throw new Error(
			`The adopted mapping ${row.mapping_id} carries no adopted_by or adopted_at, which the ledger's CHECK sets together with the ownership.`,
		);
	}
	return {
		appId: row.app_id,
		projectId: row.project_id,
		ownership: row.ownership,
		byUserId,
		at: at.toISOString(),
	};
}

async function readLiveClaim(
	tx: Transaction<AppDatabase>,
	key: HqAppKey,
): Promise<LiveClaimRow | undefined> {
	const { rows } = await sql<LiveClaimRow>`
		SELECT mapping.id AS mapping_id, mapping.ownership, mapping.adopted_by,
			mapping.adopted_at, mapping.created_at AS mapping_created_at,
			deployment.app_id, deployment.project_id, deployment.created_by,
			app.deleted_at
		FROM app_deployment_resources AS mapping
		JOIN app_deployments AS deployment ON deployment.id = mapping.deployment_id
		JOIN apps AS app ON app.id = deployment.app_id
		WHERE mapping.server = ${key.server} AND mapping.domain = ${key.domain}
			AND mapping.remote_id = ${key.remoteAppId} AND mapping.kind = 'app'
			AND mapping.superseded_at IS NULL AND mapping.released_at IS NULL
	`.execute(tx);
	return rows[0];
}

/**
 * When the last hold of an open write to the HQ app by an app other than
 * `exceptAppId` ends, or null where none is open. Read under the HQ app's
 * advisory lock, which every admission of a write to it takes first, so an
 * admission either committed before this read and is seen, or waits and then
 * finds the mapping it needs gone or released.
 *
 * An open create on the same project space whose app is not recorded yet
 * counts too: CommCare HQ may have made the very app this claim is for, and
 * only the create's record names it (`lib/deployment/store.ts::recordCreatedRemoteApp`,
 * which settles the create in its own transaction). A create is admitted
 * before it is sent, so one HQ answers after this read made no app the
 * claimant could have read.
 */
async function openWriteHeldUntil(
	tx: Transaction<AppDatabase>,
	key: HqAppKey,
	exceptAppId: string | null,
): Promise<Date | null> {
	let query = tx
		.selectFrom("hq_remote_writes")
		.select((eb) => eb.fn.max("held_until").as("held_until"))
		.where("resource_kind", "=", "app")
		.where("server", "=", key.server)
		.where("domain", "=", key.domain)
		.where((eb) =>
			eb.or([
				eb("resource_id", "=", key.remoteAppId),
				eb.and([
					eb("write_kind", "=", "create"),
					eb("resource_id", "is", null),
				]),
			]),
		)
		.where(openRemoteWrite);
	if (exceptAppId !== null) query = query.where("app_id", "<>", exceptAppId);
	const row = await query.executeTakeFirst();
	return row?.held_until ?? null;
}

/**
 * The first step of a birth's transaction. Throws `HqAppAlreadyClaimedError`
 * where a live app holds the HQ app, and `HqAppWriteInFlightError` where a
 * write another app let out to it has not settled; where its holder is in
 * recently deleted, releases that holder's mapping and returns.
 */
export async function claimHqAppInTransaction(
	tx: Transaction<AppDatabase>,
	key: HqAppKey,
): Promise<void> {
	await lockHqApp(tx, key);
	const claim = await readLiveClaim(tx, key);
	if (claim !== undefined && claim.deleted_at === null) {
		throw new HqAppAlreadyClaimedError(key, holderOf(claim));
	}
	const inFlight = await openWriteHeldUntil(tx, key, null);
	if (inFlight !== null) {
		throw new HqAppWriteInFlightError(key, inFlight.toISOString());
	}
	if (claim === undefined) return;
	/* The holder is in recently deleted. Its row lock keeps it there until this
	 * transaction ends; a restore that committed in between makes it live. */
	const holderApp = await lockAppRow(tx, claim.app_id);
	if (holderApp === undefined) return;
	if (holderApp.deleted_at === null) {
		throw new HqAppAlreadyClaimedError(key, holderOf(claim));
	}
	await tx
		.updateTable("app_deployment_resources")
		.set({ released_at: sql<Date>`now()` })
		.where("id", "=", claim.mapping_id)
		.where("superseded_at", "is", null)
		.where("released_at", "is", null)
		.execute();
	await notifyAppDeployments(tx, claim.app_id);
}

/** What a settle of one app's released claims holds locked. */
export interface ReleasedClaimLocks {
	/** The app's row, locked `FOR UPDATE`, as `lockAppRow` answers it. */
	readonly app: PersistedBlueprintAppRow | undefined;
	/** The app's live `app` mappings with `released_at` set, in `(server, domain, remote_id)` order,
	 *  each with the live, unreleased mapping another app holds on that HQ app, if one does. */
	readonly released: readonly {
		readonly deploymentId: string;
		readonly key: HqAppKey;
		readonly holder: {
			readonly mappingId: string;
			readonly appId: string;
			readonly appDeleted: boolean;
		} | null;
	}[];
}

interface ReleasedClaimRow {
	readonly deployment_id: string;
	readonly server: string;
	readonly domain: string;
	readonly remote_id: string;
	readonly holder_mapping_id: string | null;
	readonly holder_app_id: string | null;
	readonly holder_app_deleted: boolean | null;
}

/**
 * The app's live released `app` mappings, each with the live, unreleased
 * mapping of another app on its HQ app and whether that app is in recently
 * deleted. The index allows at most one such holder per HQ app.
 */
async function readReleasedClaims(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<ReleasedClaimLocks["released"]> {
	const { rows } = await sql<ReleasedClaimRow>`
		SELECT mine.deployment_id, mine.server, mine.domain, mine.remote_id,
			holder.mapping_id AS holder_mapping_id, holder.app_id AS holder_app_id,
			holder.app_deleted AS holder_app_deleted
		FROM app_deployment_resources AS mine
		JOIN app_deployments AS mine_deployment ON mine_deployment.id = mine.deployment_id
		LEFT JOIN LATERAL (
			SELECT other.id AS mapping_id, other_deployment.app_id,
				other_app.deleted_at IS NOT NULL AS app_deleted
			FROM app_deployment_resources AS other
			JOIN app_deployments AS other_deployment
				ON other_deployment.id = other.deployment_id
			JOIN apps AS other_app ON other_app.id = other_deployment.app_id
			WHERE other.kind = 'app' AND other.superseded_at IS NULL
				AND other.released_at IS NULL
				AND other.server = mine.server AND other.domain = mine.domain
				AND other.remote_id = mine.remote_id
				AND other_deployment.app_id <> mine_deployment.app_id
		) AS holder ON true
		WHERE mine_deployment.app_id = ${appId} AND mine.kind = 'app'
			AND mine.superseded_at IS NULL AND mine.released_at IS NOT NULL
		ORDER BY mine.server COLLATE "C", mine.domain COLLATE "C",
			mine.remote_id COLLATE "C", mine.deployment_id
	`.execute(tx);
	return rows.map((row) => ({
		deploymentId: row.deployment_id,
		key: { server: row.server, domain: row.domain, remoteAppId: row.remote_id },
		holder:
			row.holder_mapping_id === null || row.holder_app_id === null
				? null
				: {
						mappingId: row.holder_mapping_id,
						appId: row.holder_app_id,
						appDeleted: row.holder_app_deleted === true,
					},
	}));
}

function sameKeys(
	left: ReleasedClaimLocks["released"],
	right: ReleasedClaimLocks["released"],
): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => {
			const other = right[index];
			return (
				other !== undefined &&
				entry.deploymentId === other.deploymentId &&
				entry.key.server === other.key.server &&
				entry.key.domain === other.key.domain &&
				entry.key.remoteAppId === other.key.remoteAppId
			);
		})
	);
}

function sameClaims(
	left: ReleasedClaimLocks["released"],
	right: ReleasedClaimLocks["released"],
): boolean {
	return (
		sameKeys(left, right) &&
		left.every((entry, index) => {
			const holder = right[index]?.holder ?? null;
			if (entry.holder === null || holder === null)
				return entry.holder === holder;
			return (
				entry.holder.mappingId === holder.mappingId &&
				entry.holder.appId === holder.appId &&
				entry.holder.appDeleted === holder.appDeleted
			);
		})
	);
}

/**
 * Take every lock a settle of `appId`'s released claims needs, in the one
 * order: each HQ app's advisory lock in key order, then this app's row and the
 * row of each holder in recently deleted, in ascending app id. The caller
 * takes the membership gate after this.
 *
 * Null: what was read before the locks no longer holds under them. The caller
 * ends its transaction, having written nothing, and starts again.
 */
export async function lockReleasedClaimsInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<ReleasedClaimLocks | null> {
	const unlocked = await readReleasedClaims(tx, appId);
	if (unlocked.length === 0) {
		const app = await lockAppRow(tx, appId);
		const locked = await readReleasedClaims(tx, appId);
		return locked.length === 0 ? { app, released: [] } : null;
	}
	for (const entry of unlocked) await lockHqApp(tx, entry.key);
	/* Under the advisory locks no birth and no other settle changes who holds
	 * these HQ apps; a restore, a deletion or an ending of a holder still can. */
	const advised = await readReleasedClaims(tx, appId);
	if (!sameKeys(unlocked, advised)) return null;
	const rowIds = [
		...new Set([
			appId,
			...advised.flatMap((entry) =>
				entry.holder?.appDeleted ? [entry.holder.appId] : [],
			),
		]),
	].sort();
	let app: PersistedBlueprintAppRow | undefined;
	for (const id of rowIds) {
		if (id === appId) app = await lockAppRow(tx, id);
		else
			await tx
				.selectFrom("apps")
				.select("id")
				.where("id", "=", id)
				.forUpdate()
				.execute();
	}
	const settled = await readReleasedClaims(tx, appId);
	if (!sameClaims(advised, settled)) return null;
	return { app, released: settled };
}

/** What a settle of an app's released claims did. */
export interface SettledClaims {
	/** The project spaces it ended, because a live Nova app publishes there now. */
	readonly stopped: readonly {
		readonly server: string;
		readonly domain: string;
	}[];
	/**
	 * The project spaces whose claim it left released, because a write another
	 * app let out to that HQ app has not settled yet. A later settle takes it
	 * back once it has.
	 */
	readonly waiting: readonly {
		readonly server: string;
		readonly domain: string;
	}[];
}

/**
 * Settle every released claim the locks hold, in their order: take back an HQ
 * app nobody holds, take it back from a holder in recently deleted (which
 * gives it up in turn), or end the deployment where a live app holds it. A
 * take-back waits, leaving the claim released, while a write another app let
 * out to that HQ app is open.
 *
 * Every case was read under the locks that decide it, so no statement here can
 * meet the claim index: a violation of it is an invariant failure.
 */
export async function settleReleasedClaimsInTransaction(
	tx: Transaction<AppDatabase>,
	input: {
		readonly appId: string;
		readonly actorUserId: string;
		readonly at: Date;
		readonly locks: ReleasedClaimLocks;
	},
): Promise<SettledClaims> {
	const stopped: { readonly server: string; readonly domain: string }[] = [];
	const waiting: { readonly server: string; readonly domain: string }[] = [];
	const notified = new Set<string>();
	for (const entry of input.locks.released) {
		const holder = entry.holder;
		if (holder !== null && !holder.appDeleted) {
			const { ended } = await endDeploymentInTransaction(tx, {
				deploymentId: entry.deploymentId,
				appId: input.appId,
				remoteAppId: entry.key.remoteAppId,
				byUserId: input.actorUserId,
				reason: "claimed-elsewhere",
				at: input.at,
			});
			if (!ended) {
				throw new Error(
					`The released mapping of deployment ${entry.deploymentId} was gone under the locks that read it.`,
				);
			}
			stopped.push({ server: entry.key.server, domain: entry.key.domain });
			continue;
		}
		if ((await openWriteHeldUntil(tx, entry.key, input.appId)) !== null) {
			waiting.push({ server: entry.key.server, domain: entry.key.domain });
			continue;
		}
		if (holder !== null) {
			await tx
				.updateTable("app_deployment_resources")
				.set({ released_at: input.at })
				.where("id", "=", holder.mappingId)
				.where("superseded_at", "is", null)
				.where("released_at", "is", null)
				.execute();
			notified.add(holder.appId);
		}
		await tx
			.updateTable("app_deployment_resources")
			.set({ released_at: null })
			.where("deployment_id", "=", entry.deploymentId)
			.where("kind", "=", "app")
			.where("superseded_at", "is", null)
			.where("released_at", "is not", null)
			.execute();
		notified.add(input.appId);
	}
	for (const appId of [...notified].sort())
		await notifyAppDeployments(tx, appId);
	return { stopped, waiting };
}

/**
 * End a deployment: supersede its live `app` mapping of the HQ app
 * `remoteAppId` names with who ended it and why, delete its identity,
 * keyed-case-id, media-path and column-word rows, clear what described the HQ app and
 * count the ending. The caller holds the app row lock and the deployment row.
 * Its baseline, its confirmations and every other mapping are kept.
 * `{ ended: false }`: there was no live `app` mapping of that HQ app, and
 * nothing changed.
 */
export async function endDeploymentInTransaction(
	tx: Transaction<AppDatabase>,
	input: {
		readonly deploymentId: string;
		readonly appId: string;
		/** The HQ app whose mapping ends: a mapping of any other is left as it is. */
		readonly remoteAppId: string;
		readonly byUserId: string;
		readonly reason: HqAppEndReason;
		readonly at: Date;
	},
): Promise<{ readonly ended: boolean }> {
	const superseded = await tx
		.updateTable("app_deployment_resources")
		.set({
			superseded_at: input.at,
			ended_by: input.byUserId,
			ended_reason: input.reason,
			released_at: null,
		})
		.where("deployment_id", "=", input.deploymentId)
		.where("kind", "=", "app")
		.where("remote_id", "=", input.remoteAppId)
		.where("superseded_at", "is", null)
		.returning("id")
		.execute();
	if (superseded.length === 0) return { ended: false };
	await tx
		.updateTable("app_deployment_baselines")
		.set({ reference_fold_seq: null, reference_source_digest: null })
		.where("deployment_id", "=", input.deploymentId)
		.where("remote_app_id", "=", input.remoteAppId)
		.where("reference_fold_seq", "is not", null)
		.execute();
	await tx
		.deleteFrom("app_deployment_identities")
		.where("deployment_id", "=", input.deploymentId)
		.execute();
	await tx
		.deleteFrom("app_deployment_keyed_case_ids")
		.where("deployment_id", "=", input.deploymentId)
		.execute();
	await tx
		.deleteFrom("app_deployment_column_field_words")
		.where("deployment_id", "=", input.deploymentId)
		.execute();
	await tx
		.deleteFrom("app_deployment_media_paths")
		.where("deployment_id", "=", input.deploymentId)
		.execute();
	await tx
		.updateTable("app_deployments")
		.set({
			state: "ended",
			resume_phase: null,
			phases: NO_PHASE_OUTCOMES_JSON,
			endings: sql<number>`endings + 1`,
			content_generation: sql<string>`gen_random_uuid()`,
			entry_point_manifest: null,
			entry_point_observation: null,
			offered_logo_content_hash: null,
			target_empty_case_list_text: null,
			last_observed_at: null,
			updated_at: input.at,
		})
		.where("id", "=", input.deploymentId)
		.execute();
	await notifyAppDeployments(tx, input.appId);
	return { ended: true };
}

/** One write to record in `hq_remote_writes`, as its admission inserts it. */
export interface RemoteWriteAdmission {
	readonly claimGeneration?: string;
	readonly reviewGeneration?: string | null;
	readonly identityDigest?: string;
	readonly deploymentId: string;
	readonly server: string;
	readonly domain: string;
	readonly appId: string;
	readonly projectId: string;
	readonly actorUserId: string;
	readonly resourceKind: "app" | "lookup-table" | "location" | "worker";
	/** The HQ app's id, the Nova table's, the Nova place's, or the persona's; null only for a create. */
	readonly resourceId: string | null;
	readonly writeKind: HqRemoteWriteKind;
	/** How long, from now, the write stays open if its process never says. */
	readonly holdSeconds: number;
}

/**
 * Record writes the caller is about to send, open for `holdSeconds` from the
 * transaction's own clock, and answer their ids. The caller holds the locks
 * that admit them: for a write to an HQ app, that app's advisory lock, then
 * the app row and the deployment row, under which it proved the deployment's
 * live, unreleased mapping names that HQ app; for a workbook, the app row,
 * the deployment row, the Project's lookup state and each table's row.
 */
export async function admitRemoteWritesInTransaction(
	tx: Transaction<AppDatabase>,
	writes: readonly RemoteWriteAdmission[],
	firstContentGeneration?: string,
): Promise<readonly string[]> {
	const first = writes[0];
	if (!first) return [];
	if (firstContentGeneration !== undefined) {
		if (!writes.every((write) => write.deploymentId === first.deploymentId))
			throw new Error("A publish admits content for one deployment.");
		await tx
			.updateTable("app_deployments")
			.set({
				content_generation: firstContentGeneration,
				entry_point_manifest: null,
			})
			.where("id", "=", first.deploymentId)
			.executeTakeFirstOrThrow();
	}
	const rows = await tx
		.insertInto("hq_remote_writes")
		.values(
			writes.map((write) => ({
				deployment_id: write.deploymentId,
				claim_generation: write.claimGeneration ?? null,
				identity_digest: write.identityDigest ?? null,
				review_generation: write.reviewGeneration ?? null,
				server: write.server,
				domain: write.domain,
				app_id: write.appId,
				project_id: write.projectId,
				actor_user_id: write.actorUserId,
				resource_kind: write.resourceKind,
				resource_id: write.resourceId,
				write_kind: write.writeKind,
				held_until: sql<Date>`now() + make_interval(secs => ${write.holdSeconds})`,
			})),
		)
		.returning("id")
		.execute();
	return rows.map((row) => row.id);
}

/** Whether a write `appId` let out to CommCare HQ is still open: a Project move waits for it. */
export async function appHasOpenRemoteWriteInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<boolean> {
	const row = await tx
		.selectFrom("hq_remote_writes")
		.select("id")
		.where("app_id", "=", appId)
		.where(openRemoteWrite)
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
}

/**
 * Re-key the app's held media paths to the destination Project's asset ids.
 * Runs inside a Project move's own transaction, after its `app_deployments`
 * update. Two source assets that map to one destination asset keep the path
 * first in code-unit order; a row whose asset the map does not name is
 * dropped, because the document no longer references it.
 */
export async function remapDeploymentMediaPathsInTransaction(
	tx: Transaction<AppDatabase>,
	input: {
		readonly appId: string;
		readonly assetIdMap: ReadonlyMap<MediaAssetId, MediaAssetId>;
	},
): Promise<void> {
	const rows = await tx
		.selectFrom("app_deployment_media_paths as path")
		.innerJoin(
			"app_deployments as deployment",
			"deployment.id",
			"path.deployment_id",
		)
		.select([
			"path.deployment_id",
			"path.media_asset_id",
			"path.wire_path",
			"path.recorded_at",
		])
		.where("deployment.app_id", "=", input.appId)
		.execute();
	if (rows.length === 0) return;
	const kept = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const destination = input.assetIdMap.get(row.media_asset_id);
		if (destination === undefined) continue;
		const slot = JSON.stringify([row.deployment_id, destination]);
		const previous = kept.get(slot);
		if (previous === undefined || row.wire_path < previous.wire_path)
			kept.set(slot, { ...row, media_asset_id: destination });
	}
	await tx
		.deleteFrom("app_deployment_media_paths")
		.where(
			"deployment_id",
			"in",
			[...new Set(rows.map((row) => row.deployment_id))].sort(),
		)
		.execute();
	if (kept.size === 0) return;
	await tx
		.insertInto("app_deployment_media_paths")
		.values(
			[...kept.values()].map((row) => ({
				deployment_id: row.deployment_id,
				media_asset_id: row.media_asset_id,
				wire_path: row.wire_path,
				recorded_at: row.recorded_at,
			})),
		)
		.execute();
}
