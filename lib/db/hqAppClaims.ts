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
 *     deployment, for a person who stops publishing and for a settle.
 *   - `remapDeploymentMediaPathsInTransaction`: a Project move's media paths.
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
import { type AppDatabase, notifyAppDeployments } from "./pg";

export const HQ_APP_CLAIM_INDEX = "app_deployment_resources_hq_app_claim";

/** `server` is the stored text; the column's CHECK bounds it, and `lib/deployment` narrows it. */
export interface HqAppKey {
	readonly server: string;
	readonly domain: string;
	readonly remoteAppId: string;
}

export const HQ_APP_MAPPING_OWNERSHIPS = ["nova-created", "adopted"] as const;
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

async function lockHqApp(
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
 * The first step of a birth's transaction. Throws `HqAppAlreadyClaimedError`
 * where a live app holds the HQ app; where its holder is in recently deleted,
 * releases that holder's mapping and returns.
 */
export async function claimHqAppInTransaction(
	tx: Transaction<AppDatabase>,
	key: HqAppKey,
): Promise<void> {
	await lockHqApp(tx, key);
	const claim = await readLiveClaim(tx, key);
	if (claim === undefined) return;
	if (claim.deleted_at === null) {
		throw new HqAppAlreadyClaimedError(key, holderOf(claim));
	}
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

/**
 * Settle every released claim the locks hold, in their order: take back an HQ
 * app nobody holds, take it back from a holder in recently deleted (which
 * gives it up in turn), or end the deployment where a live app holds it.
 * Returns the project spaces it ended.
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
): Promise<readonly { readonly server: string; readonly domain: string }[]> {
	const stopped: { readonly server: string; readonly domain: string }[] = [];
	const notified = new Set<string>();
	for (const entry of input.locks.released) {
		const holder = entry.holder;
		if (holder !== null && !holder.appDeleted) {
			const { ended } = await endDeploymentInTransaction(tx, {
				deploymentId: entry.deploymentId,
				appId: input.appId,
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
	return stopped;
}

/**
 * End a deployment: supersede its live `app` mapping with who ended it and
 * why, delete its identity, keyed-case-id and media-path rows, clear what
 * described the HQ app and count the ending. The caller holds the app row
 * lock. Its baseline, its confirmations and every other mapping are kept.
 * `{ ended: false }`: there was no live `app` mapping, and nothing changed.
 */
export async function endDeploymentInTransaction(
	tx: Transaction<AppDatabase>,
	input: {
		readonly deploymentId: string;
		readonly appId: string;
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
		.where("superseded_at", "is", null)
		.returning("id")
		.execute();
	if (superseded.length === 0) return { ended: false };
	await tx
		.deleteFrom("app_deployment_identities")
		.where("deployment_id", "=", input.deploymentId)
		.execute();
	await tx
		.deleteFrom("app_deployment_keyed_case_ids")
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
