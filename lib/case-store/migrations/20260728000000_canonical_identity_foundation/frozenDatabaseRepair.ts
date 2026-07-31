/**
 * The one SQL authority for the closed pre-canonical identity repair.
 *
 * This deliberately bypasses the final PersistableDoc writer because its input
 * is the exact frozen pre-cutover production shape. It accepts an externally
 * owned transaction, verifies the frozen plan and every source digest, performs
 * only the named row and catalog writes, proves the stored result and reverse
 * indexes, and returns without committing.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import {
	assertFrozenRepairAllowedDelta,
	captureFrozenCutoverCatalogEvidence,
	captureFrozenCutoverLeaseState,
	createFrozenCutoverPlan,
	type FrozenCutoverAppDisposition,
	type FrozenCutoverLeaseState,
	type FrozenCutoverLookupContextEvidence,
	type FrozenCutoverPlan,
	frozenRawCarrierEvidence,
	reviewedFrozenCapacity,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenCutoverPlan";
import { readFrozenFoldFamilyObjectKeys } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenDatabaseMigration";
import {
	type FrozenVerifiedJson,
	verifyFrozenJsonCarriers,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenJsonCarriers";
import { readFrozenProjectLookupContext } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenLookupContext";
import {
	captureFrozenStorageSnapshot,
	dispatchFrozenStorageOccurrences,
	type FrozenStorageSnapshot,
	frozenExactTextSequenceDigest,
	frozenThreadAttachmentInventory,
	parseFrozenExactJson,
	resolveFrozenCasesSchema,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import { FROZEN_OCCURRENCE_TABLES } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	decodeFrozenStoredApp,
	materializeFrozenBlueprintJson,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenPersistableBlueprintDecoder";
import type { FrozenLookupValidationContext } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenPersistableBlueprintValidator.generated.mjs";
import {
	assertFrozenProjectOrphanSummary,
	captureFrozenProjectOrphanInventory,
	summarizeFrozenProjectOrphanInventory,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenProjectTenancy";
import { classifyFrozenFoldFamily } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRelationLifecycle";
import { applyFrozenCanonicalIdentityRepair } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepair";
import {
	CANONICAL_IDENTITY_AFFECTED_APPS,
	CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST,
	CANONICAL_IDENTITY_REPAIR_VERSION,
	CANONICAL_IDENTITY_ROW_DELETES,
	FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST,
	FROZEN_PROJECT_ORPHAN_APP_ID_TABLES,
	FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
	FROZEN_THREAD_ATTACHMENT_REPAIRS,
	type FrozenThreadAttachmentRepair,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepairManifest";
import {
	canonicalIdentityDigest,
	type LegacyAppSnapshot,
	type LegacyEntityKind,
	type LegacyEntityRow,
	planCanonicalAppMigration,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenTransform";

/* Every helper here runs inside a transaction the CALLER owns. Kysely's
 * `Migrator` hands `up` a transaction-backed handle typed as `Kysely`, so
 * naming the parameter `Transaction` described how the standalone script
 * happened to obtain one rather than what these functions require. */
type DbTx<DB> = Kysely<DB> | Transaction<DB>;
const frozenVerifiedRepairSnapshot: unique symbol = Symbol(
	"frozenVerifiedRepairSnapshot",
);
const EXACT_ZERO = BigInt(0);
const EXACT_ONE = BigInt(1);
const CANONICAL_IDENTITY_MIGRATION_LEDGER_NAME =
	"20260728000000_canonical_identity_foundation";

function exactCount(value: string | undefined, family: string): bigint {
	if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error(`Frozen repair ${family} is not an exact decimal count.`);
	}
	return BigInt(value);
}

export type FrozenVerifiedRepairSnapshot = LegacyAppSnapshot & {
	readonly [frozenVerifiedRepairSnapshot]: true;
};

function requiredCarrier(
	carriers: ReadonlyMap<string, FrozenVerifiedJson>,
	id: string,
): FrozenVerifiedJson {
	const carrier = carriers.get(id);
	if (carrier === undefined) {
		throw new Error(`Frozen repair JSON carrier ${id} disappeared.`);
	}
	return carrier;
}

function entityKind(value: string): LegacyEntityKind {
	switch (value) {
		case "module":
		case "form":
		case "field":
		case "user_property":
		case "user_type":
		case "persona":
			return value;
		default:
			throw new Error(
				`Unsupported canonical repair entity kind (${canonicalIdentityDigest(value)}).`,
			);
	}
}

function materializeRepairJson<T>(
	carrier: FrozenVerifiedJson,
	family: string,
	allowSqlNull = false,
): T | null {
	const materialized = materializeFrozenBlueprintJson<T>(carrier, {
		id: `${family}:${carrier.sourceDigest}`,
	});
	if (materialized.kind === "sql-null") {
		if (!allowSqlNull) {
			throw new Error(`Frozen repair ${family} carrier is SQL NULL.`);
		}
		return null;
	}
	return materialized.value;
}

function verifiedRepairSnapshot(
	value: LegacyAppSnapshot,
): FrozenVerifiedRepairSnapshot {
	return Object.freeze({
		...value,
		[frozenVerifiedRepairSnapshot]: true,
	});
}

async function assertCompleteFrozenRepairSnapshots<DB>(
	tx: DbTx<DB>,
	snapshots: readonly LegacyAppSnapshot[],
): Promise<void> {
	const snapshotByApp = new Map(
		snapshots.map((snapshot) => [snapshot.appId, snapshot] as const),
	);
	const plans = snapshots.map((snapshot) => {
		const plan = planCanonicalAppMigration(snapshot);
		if (plan.findings.length !== 0) {
			throw new Error(
				`Frozen repair canonical candidate has ${plan.findings.length} finding(s).`,
			);
		}
		return plan;
	});
	const candidates = plans.flatMap((plan) => [
		{
			id: `repair_app.case_types:${canonicalIdentityDigest(plan.appId)}`,
			candidate_text:
				plan.caseTypes === null ? null : JSON.stringify(plan.caseTypes),
		},
		...plan.rows.map((row) => ({
			id: `repair_entity.data:${canonicalIdentityDigest([
				plan.appId,
				row.uuid,
			])}`,
			candidate_text: JSON.stringify(row.data),
		})),
	]);
	const canonical = candidates.length
		? await sql<{ id: string; source_text: string | null }>`
				SELECT id, candidate_text::jsonb::text AS source_text
				FROM jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb)
					AS value(id text, candidate_text text)
				ORDER BY convert_to(id, 'UTF8')
			`.execute(tx)
		: { rows: [] };
	const verified = await verifyFrozenJsonCarriers(
		tx,
		canonical.rows.map((row) => ({
			id: row.id,
			sourceText: row.source_text,
		})),
	);
	const projectRows =
		snapshots.length === 0
			? { rows: [] as Array<{ id: string; project_id: string | null }> }
			: await sql<{ id: string; project_id: string | null }>`
					SELECT id, project_id
					FROM apps
					WHERE id = ANY(${snapshots.map((snapshot) => snapshot.appId)})
					ORDER BY convert_to(id, 'UTF8')
				`.execute(tx);
	if (projectRows.rows.length !== snapshots.length) {
		throw new Error("Frozen repair canonical candidates lost an app row.");
	}
	const projectByApp = new Map(
		projectRows.rows.map((row) => [row.id, row.project_id] as const),
	);
	const lookupContextByProject = new Map<
		string,
		FrozenLookupValidationContext
	>();
	for (const plan of plans) {
		const snapshot = snapshotByApp.get(plan.appId);
		if (snapshot === undefined) {
			throw new Error("Frozen repair canonical candidate lost its source.");
		}
		const projectId = projectByApp.get(plan.appId);
		if (projectId === undefined || projectId === null || projectId === "") {
			throw new Error(
				"Frozen repair canonical candidate has no exact Project lookup scope.",
			);
		}
		let lookupContext = lookupContextByProject.get(projectId);
		if (lookupContext === undefined) {
			lookupContext = await readFrozenProjectLookupContext(tx, projectId);
			lookupContextByProject.set(projectId, lookupContext);
		}
		decodeFrozenStoredApp(
			{
				id: snapshot.appId,
				appName: snapshot.appName,
				connectType: snapshot.connectType,
				caseTypes: requiredCarrier(
					verified,
					`repair_app.case_types:${canonicalIdentityDigest(plan.appId)}`,
				),
				logo: snapshot.logo,
				mutationSeq: snapshot.mutationSeq,
			},
			plan.rows.map((row) => ({
				appId: row.appId,
				uuid: row.uuid,
				kind: row.kind,
				parentUuid: row.parentUuid,
				ordinal: row.ordinal,
				data: requiredCarrier(
					verified,
					`repair_entity.data:${canonicalIdentityDigest([
						plan.appId,
						row.uuid,
					])}`,
				),
			})),
			lookupContext,
		);
	}
}

function materializeNonNullRepairJson<T>(
	carrier: FrozenVerifiedJson,
	family: string,
): T {
	const value = materializeRepairJson<T>(carrier, family);
	if (value === null) {
		throw new Error(`Frozen repair ${family} carrier is SQL NULL.`);
	}
	return value;
}

export async function loadCanonicalIdentityRepairSnapshotsInTransaction<DB>(
	tx: DbTx<DB>,
): Promise<FrozenVerifiedRepairSnapshot[]> {
	const apps = await sql<{
		id: string;
		app_name: string;
		connect_type: string | null;
		case_types_text: string | null;
		logo: string | null;
		mutation_seq: string;
	}>`
		SELECT id, app_name, connect_type,
		       case_types::text AS case_types_text,
		       logo::text AS logo, mutation_seq::text AS mutation_seq
		FROM apps
		ORDER BY convert_to(id, 'UTF8')
	`.execute(tx);
	const entityRows = await sql<{
		app_id: string;
		uuid: string;
		kind: string;
		parent_uuid: string | null;
		ordinal: number;
		data_text: string;
	}>`
		SELECT app_id, uuid::text AS uuid, kind,
		       parent_uuid::text AS parent_uuid, ordinal,
		       data::text AS data_text
		FROM blueprint_entities
		ORDER BY
			convert_to(app_id, 'UTF8'),
			convert_to(kind, 'UTF8'),
			convert_to(parent_uuid::text, 'UTF8') NULLS FIRST,
			ordinal,
			convert_to(uuid::text, 'UTF8')
	`.execute(tx);
	const appEntries = apps.rows.map((_, index) => ({
		id: `apps.case_types[${index}]`,
		sourceText: apps.rows[index]?.case_types_text ?? null,
	}));
	const entityEntries = entityRows.rows.map((row, index) => ({
		id: `blueprint_entities.data[${index}]`,
		sourceText: row.data_text,
	}));
	const verified = await verifyFrozenJsonCarriers(tx, [
		...appEntries,
		...entityEntries,
	]);
	const byApp = new Map<string, LegacyEntityRow[]>();
	for (const [index, row] of entityRows.rows.entries()) {
		const values = byApp.get(row.app_id) ?? [];
		values.push({
			appId: row.app_id,
			uuid: row.uuid,
			kind: entityKind(row.kind),
			parentUuid: row.parent_uuid,
			ordinal: row.ordinal,
			data: materializeNonNullRepairJson<Record<string, unknown>>(
				requiredCarrier(verified, entityEntries[index]?.id ?? ""),
				"repair_entity",
			),
		});
		byApp.set(row.app_id, values);
	}
	return apps.rows.map((app, index) =>
		verifiedRepairSnapshot({
			appId: app.id,
			appName: app.app_name,
			connectType: app.connect_type,
			caseTypes: materializeRepairJson(
				requiredCarrier(verified, appEntries[index]?.id ?? ""),
				"repair_app",
				true,
			),
			logo: app.logo,
			mutationSeq: app.mutation_seq,
			rows: byApp.get(app.id) ?? [],
		}),
	);
}

async function assertStoredRepairSnapshotsExact<DB>(
	tx: DbTx<DB>,
	snapshots: readonly LegacyAppSnapshot[],
): Promise<void> {
	const expectedApps = snapshots.map((snapshot) => ({
		id: snapshot.appId,
		app_name: snapshot.appName,
		connect_type: snapshot.connectType,
		case_types: snapshot.caseTypes,
		logo: snapshot.logo,
		mutation_seq: String(snapshot.mutationSeq),
	}));
	const expectedEntities = snapshots.flatMap((snapshot) =>
		snapshot.rows.map((row) => ({
			app_id: snapshot.appId,
			uuid: row.uuid,
			kind: row.kind,
			parent_uuid: row.parentUuid,
			ordinal: row.ordinal,
			data: row.data,
		})),
	);
	const proof = await sql<{
		app_count: string;
		matched_apps: string;
		entity_count: string;
		matched_entities: string;
	}>`
		WITH expected_app AS (
			SELECT *
			FROM jsonb_to_recordset(${JSON.stringify(expectedApps)}::jsonb)
				AS value(
					id text,
					app_name text,
					connect_type text,
					case_types jsonb,
					logo text,
					mutation_seq bigint
				)
		), expected_entity AS (
			SELECT *
			FROM jsonb_to_recordset(${JSON.stringify(expectedEntities)}::jsonb)
				AS value(
					app_id text,
					uuid text,
					kind text,
					parent_uuid text,
					ordinal integer,
					data jsonb
				)
		)
		SELECT
			(SELECT count(*)::text FROM apps) AS app_count,
			(
				SELECT count(*)::text
				FROM apps
				JOIN expected_app ON expected_app.id = apps.id
				WHERE apps.app_name = expected_app.app_name
				  AND apps.connect_type IS NOT DISTINCT FROM expected_app.connect_type
				  AND apps.case_types::text
						IS NOT DISTINCT FROM expected_app.case_types::text
				  AND apps.logo::text IS NOT DISTINCT FROM expected_app.logo
				  AND apps.mutation_seq = expected_app.mutation_seq
			) AS matched_apps,
			(SELECT count(*)::text FROM blueprint_entities) AS entity_count,
			(
				SELECT count(*)::text
				FROM blueprint_entities
				JOIN expected_entity
				  ON expected_entity.app_id = blueprint_entities.app_id
				 AND expected_entity.uuid = blueprint_entities.uuid::text
				WHERE blueprint_entities.kind = expected_entity.kind
				  AND blueprint_entities.parent_uuid::text
						IS NOT DISTINCT FROM expected_entity.parent_uuid
				  AND blueprint_entities.ordinal = expected_entity.ordinal
				  AND blueprint_entities.data::text = expected_entity.data::text
			) AS matched_entities
	`.execute(tx);
	const row = proof.rows[0];
	if (
		row?.app_count !== String(expectedApps.length) ||
		row.matched_apps !== row.app_count ||
		row.entity_count !== String(expectedEntities.length) ||
		row.matched_entities !== row.entity_count
	) {
		throw new Error(
			"Canonical identity repair database rows differ from the exact candidate.",
		);
	}
}

/**
 * Capture the lease/stream state for the repair proof.
 *
 * It does NOT require those counters to be zero. Live leases, unterminated
 * stream chunks, and presence rows are operational leftovers, not integrity
 * facts — the occurrence plan already disposes of the chunk, presence, and
 * thread-stream tables as `delete-operational`. Demanding they be zero first
 * proves only that nobody was mid-request, and the only way to arrange that is
 * to take the service down.
 *
 * What actually protects this transaction is the `SHARE ROW EXCLUSIVE` lock
 * over every occurrence table plus `SELECT ... FOR UPDATE` over `apps`. A
 * concurrent writer blocks on that lock or fails against it; a request already
 * in flight against the old shape may error. That is the accepted cost, and it
 * is cheaper than a maintenance window plus the scaffolding to orchestrate one.
 */
async function captureRepairLeaseState<DB>(
	tx: DbTx<DB>,
): Promise<FrozenCutoverLeaseState> {
	return await captureFrozenCutoverLeaseState(tx);
}

function frozenThreadAttachmentAt(
	messages: unknown,
	messageIndex: number,
	attachmentIndex: number,
): unknown {
	if (!Array.isArray(messages)) return undefined;
	const message = messages[messageIndex];
	if (
		message === null ||
		typeof message !== "object" ||
		Array.isArray(message)
	) {
		return undefined;
	}
	const metadata = (message as Record<string, unknown>).metadata;
	if (
		metadata === null ||
		typeof metadata !== "object" ||
		Array.isArray(metadata)
	) {
		return undefined;
	}
	const attachments = (metadata as Record<string, unknown>).attachments;
	return Array.isArray(attachments) ? attachments[attachmentIndex] : undefined;
}

export function removeFrozenThreadAttachmentTargets(
	messages: unknown,
	repair: FrozenThreadAttachmentRepair,
): unknown {
	const inventory = frozenThreadAttachmentInventory(messages);
	if (
		!inventory.shapeExact ||
		inventory.occurrences.length !== repair.targets.length
	) {
		throw new Error(
			`Frozen thread attachment source ${canonicalIdentityDigest(repair.threadId)} has an unexpected strict attachment inventory.`,
		);
	}
	const targetKeys = new Set<string>();
	for (const target of repair.targets) {
		const key = `${target.messageIndex}\u0000${target.attachmentIndex}`;
		if (targetKeys.has(key)) {
			throw new Error(
				"Frozen thread attachment manifest has a duplicate path.",
			);
		}
		targetKeys.add(key);
		const value = frozenThreadAttachmentAt(
			messages,
			target.messageIndex,
			target.attachmentIndex,
		) as { readonly assetId?: unknown; readonly kind?: unknown } | undefined;
		// Identity here is the coordinate plus the two fields the repair acts on.
		// Every other byte is already covered: the caller proves
		// `sourceMessagesDigest` across the whole column BEFORE calling this, and
		// that digest pins every attachment byte in it. The per-target SQL digest
		// is a second cover, but it runs AFTER this function, so it is not what
		// makes this check safe — the column digest is. Holding the attachment
		// body here would mean keeping real customer filenames and document
		// summaries in source to re-derive a check the column digest already
		// makes.
		if (
			value === undefined ||
			value.assetId !== target.assetId ||
			value.kind !== target.attachmentKind
		) {
			throw new Error(
				`Frozen thread attachment ${canonicalIdentityDigest([
					repair.threadId,
					target.messageIndex,
					target.attachmentIndex,
				])} changed.`,
			);
		}
	}
	const result = JSON.parse(JSON.stringify(messages)) as unknown;
	for (const target of [...repair.targets].sort(
		(left, right) =>
			right.messageIndex - left.messageIndex ||
			right.attachmentIndex - left.attachmentIndex,
	)) {
		const message = (result as unknown[])[target.messageIndex] as Record<
			string,
			unknown
		>;
		const metadata = message.metadata as Record<string, unknown>;
		const attachments = metadata.attachments as unknown[];
		attachments.splice(target.attachmentIndex, 1);
	}
	const resultInventory = frozenThreadAttachmentInventory(result);
	if (!resultInventory.shapeExact || resultInventory.occurrences.length !== 0) {
		throw new Error(
			"Frozen thread attachment repair did not produce the exact empty strict inventory.",
		);
	}
	return result;
}

interface FrozenThreadRepairRow {
	readonly app_id: string;
	readonly project_id: string | null;
	readonly app_row_digest: string;
	readonly thread_id: string;
	readonly messages_text: string;
	readonly messages_digest: string;
	readonly thread_row_digest: string;
}

async function readFrozenThreadRepairRows<DB>(
	tx: DbTx<DB>,
	lock: boolean,
): Promise<readonly FrozenThreadRepairRow[]> {
	const manifest = FROZEN_THREAD_ATTACHMENT_REPAIRS.map((repair) => ({
		app_id: repair.appId,
		thread_id: repair.threadId,
	}));
	return (
		await sql<FrozenThreadRepairRow>`
			WITH expected AS (
				SELECT *
				FROM jsonb_to_recordset(${JSON.stringify(manifest)}::jsonb)
					AS value(app_id text, thread_id text)
			)
			SELECT
				app.id AS app_id,
				app.project_id,
				encode(
					sha256(convert_to(to_jsonb(app)::text, 'UTF8')),
					'hex'
				) AS app_row_digest,
				thread_row.thread_id,
				thread_row.messages::text AS messages_text,
				encode(
					sha256(convert_to(thread_row.messages::text, 'UTF8')),
					'hex'
				) AS messages_digest,
				encode(
					sha256(convert_to(to_jsonb(thread_row)::text, 'UTF8')),
					'hex'
				) AS thread_row_digest
			FROM expected
			JOIN public.apps AS app ON app.id = expected.app_id
			JOIN public.threads AS thread_row
			  ON thread_row.app_id = expected.app_id
			 AND thread_row.thread_id = expected.thread_id
			ORDER BY
				convert_to(app.id, 'UTF8'),
				convert_to(thread_row.thread_id, 'UTF8')
			${lock ? sql`FOR UPDATE OF app, thread_row` : sql``}
		`.execute(tx)
	).rows;
}

export type FrozenThreadAttachmentRepairState =
	| "pristine"
	| "applied"
	| "drift";

async function inspectFrozenThreadAttachmentRepairState<DB>(
	tx: DbTx<DB>,
): Promise<FrozenThreadAttachmentRepairState> {
	const rows = await readFrozenThreadRepairRows(tx, false);
	if (rows.length !== FROZEN_THREAD_ATTACHMENT_REPAIRS.length) return "drift";
	const byKey = new Map(
		rows.map((row) => [`${row.app_id}\u0000${row.thread_id}`, row] as const),
	);
	let source = 0;
	let result = 0;
	for (const repair of FROZEN_THREAD_ATTACHMENT_REPAIRS) {
		const row = byKey.get(`${repair.appId}\u0000${repair.threadId}`);
		if (row === undefined || row.project_id !== repair.appProjectId) {
			return "drift";
		}
		if (
			row.messages_digest === repair.sourceMessagesDigest &&
			row.thread_row_digest === repair.sourceRowDigest
		) {
			source++;
		} else if (
			row.messages_digest === repair.resultMessagesDigest &&
			row.thread_row_digest === repair.resultRowDigest
		) {
			result++;
		} else {
			return "drift";
		}
	}
	if (source === FROZEN_THREAD_ATTACHMENT_REPAIRS.length) return "pristine";
	if (result === FROZEN_THREAD_ATTACHMENT_REPAIRS.length) return "applied";
	return "drift";
}

async function applyFrozenThreadAttachmentRepairs<DB>(
	tx: DbTx<DB>,
): Promise<number> {
	const rows = await readFrozenThreadRepairRows(tx, true);
	if (rows.length !== FROZEN_THREAD_ATTACHMENT_REPAIRS.length) {
		throw new Error(
			"Frozen thread attachment repair did not find every exact source row.",
		);
	}
	const byKey = new Map(
		rows.map((row) => [`${row.app_id}\u0000${row.thread_id}`, row] as const),
	);
	// Only the four coordinates cross into SQL: the recordset below declares
	// exactly those columns, and every disposition check reads the manifest
	// directly rather than this payload.
	const targets = FROZEN_THREAD_ATTACHMENT_REPAIRS.flatMap((repair) =>
		repair.targets.map((target) => ({
			app_id: repair.appId,
			thread_id: repair.threadId,
			message_index: target.messageIndex,
			attachment_index: target.attachmentIndex,
		})),
	);
	// Sourced from the manifest, NOT from `targets`. The asset lookup below keys
	// on these ids, and an empty array would make every `missing` disposition
	// pass for the wrong reason — `asset === undefined` is that check's success
	// condition, so a lookup that matched nothing would silently confirm all
	// eleven of them.
	const assetIds = FROZEN_THREAD_ATTACHMENT_REPAIRS.flatMap((repair) =>
		repair.targets.map((target) => target.assetId),
	);
	const attachmentRows = await sql<{
		app_id: string;
		thread_id: string;
		message_index: number;
		attachment_index: number;
		attachment_digest: string | null;
	}>`
		WITH expected AS (
			SELECT *
			FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb)
				AS value(
					app_id text,
					thread_id text,
					message_index integer,
					attachment_index integer
				)
		)
		SELECT
			expected.app_id,
			expected.thread_id,
			expected.message_index,
			expected.attachment_index,
			-- The digest is the whole proof; the attachment body itself is never
			-- selected, so customer document text does not leave PostgreSQL.
			encode(
				sha256(
					convert_to(
						(
							thread_row.messages #> ARRAY[
								expected.message_index::text,
								'metadata',
								'attachments',
								expected.attachment_index::text
							]
						)::text,
						'UTF8'
					)
				),
				'hex'
			) AS attachment_digest
		FROM expected
		JOIN public.threads AS thread_row
		  ON thread_row.app_id = expected.app_id
		 AND thread_row.thread_id = expected.thread_id
		ORDER BY
			convert_to(expected.app_id, 'UTF8'),
			convert_to(expected.thread_id, 'UTF8'),
			expected.message_index,
			expected.attachment_index
	`.execute(tx);
	if (attachmentRows.rows.length !== targets.length) {
		throw new Error(
			"Frozen thread attachment repair target cardinality changed.",
		);
	}
	const attachmentByKey = new Map(
		attachmentRows.rows.map(
			(row) =>
				[
					`${row.app_id}\u0000${row.thread_id}\u0000${row.message_index}\u0000${row.attachment_index}`,
					row,
				] as const,
		),
	);
	const assetRows = await sql<{
		id: string;
		project_id: string;
		kind: string;
		row_digest: string;
	}>`
		SELECT
			id::text AS id,
			project_id,
			kind,
			encode(
				sha256(convert_to(to_jsonb(media_assets)::text, 'UTF8')),
				'hex'
			) AS row_digest
		FROM public.media_assets
		WHERE id::text = ANY(${assetIds})
		ORDER BY convert_to(id::text, 'UTF8')
	`.execute(tx);
	const assetById = new Map(
		assetRows.rows.map((row) => [row.id, row] as const),
	);

	for (const repair of FROZEN_THREAD_ATTACHMENT_REPAIRS) {
		const row = byKey.get(`${repair.appId}\u0000${repair.threadId}`);
		if (
			row === undefined ||
			row.project_id !== repair.appProjectId ||
			row.app_row_digest !== repair.appRowDigest ||
			row.messages_digest !== repair.sourceMessagesDigest ||
			row.thread_row_digest !== repair.sourceRowDigest
		) {
			throw new Error(
				`Frozen thread attachment source ${canonicalIdentityDigest(repair.threadId)} changed.`,
			);
		}
		const messages = parseFrozenExactJson(row.messages_text);
		const result = removeFrozenThreadAttachmentTargets(messages, repair);
		for (const target of repair.targets) {
			const targetRow = attachmentByKey.get(
				`${repair.appId}\u0000${repair.threadId}\u0000${target.messageIndex}\u0000${target.attachmentIndex}`,
			);
			if (targetRow?.attachment_digest !== target.attachmentDigest) {
				throw new Error(
					`Frozen thread attachment ${canonicalIdentityDigest([
						repair.threadId,
						target.messageIndex,
						target.attachmentIndex,
					])} bytes changed.`,
				);
			}
			const asset = assetById.get(target.assetId);

			if (
				(target.assetDisposition === "missing" && asset !== undefined) ||
				(target.assetDisposition === "foreign-project" &&
					(asset === undefined ||
						asset.project_id !== target.assetProjectId ||
						asset.project_id === repair.appProjectId ||
						asset.kind !== target.attachmentKind ||
						asset.row_digest !== target.assetRowDigest))
			) {
				throw new Error(
					`Frozen thread attachment asset ${canonicalIdentityDigest(target.assetId)} disposition changed.`,
				);
			}
		}
		const update = await sql`
			UPDATE public.threads
			SET messages = ${JSON.stringify(result)}::jsonb
			WHERE app_id = ${repair.appId}
			  AND thread_id = ${repair.threadId}
		`.execute(tx);
		if (update.numAffectedRows !== EXACT_ONE) {
			throw new Error(
				"Frozen thread attachment repair lost one locked thread row.",
			);
		}
	}
	const resultRows = await readFrozenThreadRepairRows(tx, false);
	const resultByKey = new Map(
		resultRows.map(
			(row) => [`${row.app_id}\u0000${row.thread_id}`, row] as const,
		),
	);
	for (const repair of FROZEN_THREAD_ATTACHMENT_REPAIRS) {
		const row = resultByKey.get(`${repair.appId}\u0000${repair.threadId}`);
		if (
			row?.messages_digest !== repair.resultMessagesDigest ||
			row.thread_row_digest !== repair.resultRowDigest ||
			frozenThreadAttachmentInventory(parseFrozenExactJson(row.messages_text))
				.occurrences.length !== 0
		) {
			throw new Error(
				`Frozen thread attachment result ${canonicalIdentityDigest(repair.threadId)} differs from the reviewed exact bytes.`,
			);
		}
	}
	return targets.length;
}

async function reverseIndexDigest<DB>(
	tx: DbTx<DB>,
	appIds: readonly string[],
): Promise<string> {
	const media = await sql<{ app_id: string; asset_id: string }>`
		SELECT app_id, asset_id
		FROM media_asset_refs
		WHERE app_id = ANY(${appIds})
		ORDER BY app_id, asset_id
	`.execute(tx);
	const tables = await sql<{
		app_id: string;
		project_id: string;
		table_id: string;
	}>`
		SELECT app_id, project_id, table_id
		FROM lookup_table_references
		WHERE app_id = ANY(${appIds})
		ORDER BY app_id, project_id, table_id
	`.execute(tx);
	const columns = await sql<{
		app_id: string;
		project_id: string;
		table_id: string;
		column_id: string;
	}>`
		SELECT app_id, project_id, table_id, column_id
		FROM lookup_column_references
		WHERE app_id = ANY(${appIds})
		ORDER BY app_id, project_id, table_id, column_id
	`.execute(tx);
	return canonicalIdentityDigest({
		media: media.rows,
		tables: tables.rows,
		columns: columns.rows,
	});
}

function digestByApp(
	snapshots: readonly LegacyAppSnapshot[],
): ReadonlyMap<string, string> {
	return new Map(
		snapshots.map((snapshot) => [
			snapshot.appId,
			planCanonicalAppMigration(snapshot).beforeDigest,
		]),
	);
}

interface FrozenRepairStateInspection {
	readonly state: "absent" | "pristine" | "applied" | "drift";
	readonly candidateSnapshots: readonly LegacyAppSnapshot[];
	readonly invalidProjectApps: readonly {
		readonly id: string;
		readonly owner: string;
		readonly project_id: string | null;
	}[];
}

export type FrozenCanonicalRepairBoundaryState =
	| "pre-canonical"
	| "canonical-applied-not-applicable"
	| "drift";

/**
 * The canonical migration closes the repair stage only when both of its
 * independent durable witnesses are exact: one Kysely ledger row and the
 * complete fourteen-object fold family. A direct unledgered migration, a
 * ledger-only state, or any partial/alternate fold family remains drift.
 */
export function classifyFrozenCanonicalRepairBoundary(input: {
	readonly canonicalMigrationLedgerRows: string;
	readonly foldFamilyObjectKeys: readonly string[];
}): FrozenCanonicalRepairBoundaryState {
	const ledgerRows = exactCount(
		input.canonicalMigrationLedgerRows,
		"canonical migration ledger count",
	);
	const foldFamily = classifyFrozenFoldFamily(input.foldFamilyObjectKeys);
	if (ledgerRows === EXACT_ZERO && foldFamily.state === "pristine") {
		return "pre-canonical";
	}
	if (ledgerRows === EXACT_ONE && foldFamily.state === "final") {
		return "canonical-applied-not-applicable";
	}
	return "drift";
}

async function inspectFrozenCanonicalRepairBoundary<DB>(
	tx: DbTx<DB>,
): Promise<FrozenCanonicalRepairBoundaryState> {
	const ledgerRows = (
		await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM public.kysely_migration
			WHERE name = ${CANONICAL_IDENTITY_MIGRATION_LEDGER_NAME}
		`.execute(tx)
	).rows[0]?.count;
	if (ledgerRows === undefined) {
		throw new Error(
			"Canonical identity repair migration ledger evidence is unavailable.",
		);
	}
	const foldFamilyObjectKeys = await readFrozenFoldFamilyObjectKeys(
		tx as unknown as Kysely<unknown>,
	);
	return classifyFrozenCanonicalRepairBoundary({
		canonicalMigrationLedgerRows: ledgerRows,
		foldFamilyObjectKeys,
	});
}

function requirePreCanonicalRepairBoundary(
	state: FrozenCanonicalRepairBoundaryState,
): void {
	if (state === "canonical-applied-not-applicable") {
		throw new Error(
			"Canonical identity repair is no longer applicable: the canonical identity migration is already applied.",
		);
	}
	if (state === "drift") {
		throw new Error(
			[
				"This database is part-way through the canonical identity repair, so it is not safe to start it.",
				"",
				"The repair expects one of three things: every app it changes still in its original shape, every one of them already repaired, or none of them present at all. This database is a mix.",
				"",
				"On a developer machine that usually means a copy of production data sitting alongside local work. Recreate the database and migrate again.",
			].join("\n"),
		);
	}
}

async function inspectFrozenRepairState<DB>(
	tx: DbTx<DB>,
	snapshots: readonly LegacyAppSnapshot[],
): Promise<FrozenRepairStateInspection> {
	const invalidProjectApps = (
		await sql<{ id: string; owner: string; project_id: string | null }>`
			SELECT id, owner, project_id
			FROM apps
			WHERE project_id IS NULL OR btrim(project_id) = ''
			ORDER BY convert_to(id, 'UTF8')
		`.execute(tx)
	).rows;
	let sourceRowsExact = false;
	let sourceCandidate: readonly LegacyAppSnapshot[] = snapshots;
	try {
		const repair = applyFrozenCanonicalIdentityRepair(snapshots);
		sourceRowsExact =
			repair.resultDigest === CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST;
		sourceCandidate = repair.snapshots;
	} catch {
		sourceRowsExact = false;
	}
	const expectedAfter = new Map<string, string>(
		CANONICAL_IDENTITY_AFFECTED_APPS.map(
			([appDigest, , afterDigest]) => [appDigest, afterDigest] as const,
		),
	);
	const snapshotByDigest = new Map(
		snapshots.map(
			(snapshot) =>
				[canonicalIdentityDigest(snapshot.appId), snapshot] as const,
		),
	);
	// Only that each repaired document plans cleanly. It must NOT also demand
	// `beforeDigest === afterDigest`: that says "the canonical migration is a
	// no-op on this document", which is a property of the migrated era asserted
	// inside a pre-migration audit. It is reliably false on real data —
	// `case_property_on` is a live persisted key, and the transform rewrites
	// every field carrying one — so requiring it made the applied-state rerun
	// throw, which is exactly the audit a retried cutover depends on.
	//
	// The `expectedAfter` loop below is what actually proves the applied state,
	// and it compares against a pre-canonical digest, so the two belong to the
	// same era.
	let resultRowsExact =
		invalidProjectApps.length === 0 &&
		snapshots.every(
			(snapshot) => planCanonicalAppMigration(snapshot).findings.length === 0,
		);
	if (resultRowsExact) {
		for (const [appDigest, afterDigest] of expectedAfter) {
			const snapshot = snapshotByDigest.get(appDigest);
			if (
				snapshot === undefined ||
				planCanonicalAppMigration(snapshot).beforeDigest !== afterDigest
			) {
				resultRowsExact = false;
				break;
			}
		}
	}
	const exactProjectOrphan =
		invalidProjectApps.length === 1 &&
		invalidProjectApps[0]?.project_id === null &&
		invalidProjectApps[0]?.owner === "" &&
		canonicalIdentityDigest(invalidProjectApps[0]?.id) ===
			FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST;
	const threadState = await inspectFrozenThreadAttachmentRepairState(tx);
	/* `absent` is a database this repair has no subject in: no app is missing a
	 * Project and none of the manifest's apps are here at all. A fresh developer
	 * or CI database is the ordinary case. Without it, running the repair as part
	 * of the migration would read an empty database as `drift` and refuse — the
	 * repair would only ever be runnable against the one production snapshot it
	 * was cut from, which is the opposite of shipping it in the migration. */
	/* Presence of a SUBJECT, not of data. A developer database has plenty of
	 * apps and none of this repair's apps; keying `absent` on the snapshot count
	 * would have called that drift and refused every database but production. */
	const anyAffectedAppPresent = [...expectedAfter.keys()].some((appDigest) =>
		snapshotByDigest.has(appDigest),
	);
	/* Distinguish "those threads are not in this database" from "they are here
	 * and wrong" — the thread inspection reports both as drift, and only the
	 * first is absence. */
	const anyAffectedThreadPresent =
		(await readFrozenThreadRepairRows(tx, false)).length > 0;
	const state: FrozenRepairStateInspection["state"] =
		invalidProjectApps.length === 0 &&
		!anyAffectedAppPresent &&
		!anyAffectedThreadPresent
			? "absent"
			: exactProjectOrphan && sourceRowsExact && threadState === "pristine"
				? "pristine"
				: invalidProjectApps.length === 0 &&
						resultRowsExact &&
						threadState === "applied"
					? "applied"
					: "drift";
	return {
		state,
		candidateSnapshots:
			state === "pristine"
				? sourceCandidate
				: state === "applied"
					? snapshots
					: [],
		invalidProjectApps,
	};
}

function frozenRawRowsForApp(
	snapshot: FrozenStorageSnapshot,
	table: string,
	appId: string,
): readonly string[] {
	const rowTexts = snapshot[table]?.rowTexts;
	if (rowTexts === undefined) return [];
	return rowTexts.filter((rowText) => {
		const value = parseFrozenExactJson(rowText);
		return (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			(value as Record<string, unknown>).app_id === appId
		);
	});
}

async function createFrozenRepairCutoverPlan<DB>(input: {
	readonly tx: DbTx<DB>;
	readonly apply: boolean;
	readonly state: Exclude<FrozenRepairStateInspection["state"], "absent">;
	readonly snapshots: readonly LegacyAppSnapshot[];
	readonly candidateSnapshots: readonly LegacyAppSnapshot[];
	readonly rawSource: FrozenStorageSnapshot;
	readonly lockRelations: readonly string[];
	readonly leaseState: FrozenCutoverLeaseState;
	readonly casesSchema: "nova_case_runtime" | "public";
}): Promise<FrozenCutoverPlan> {
	const catalog = await captureFrozenCutoverCatalogEvidence(
		input.tx,
		input.casesSchema,
	);
	const projectRows = (
		await sql<{ id: string; project_id: string | null }>`
			SELECT id, project_id
			FROM apps
			ORDER BY convert_to(id, 'UTF8')
		`.execute(input.tx)
	).rows;
	const projectByApp = new Map(
		projectRows.map((row) => [row.id, row.project_id] as const),
	);
	const candidateByApp = new Map(
		input.candidateSnapshots.map(
			(snapshot) => [snapshot.appId, snapshot] as const,
		),
	);
	const affected = new Set<string>(
		CANONICAL_IDENTITY_AFFECTED_APPS.map(([appDigest]) => appDigest),
	);
	const lookupContexts = new Map<string, FrozenCutoverLookupContextEvidence>();
	const apps: FrozenCutoverAppDisposition[] = [];
	const findings: Array<{
		carrierId: string;
		code: string;
		pathDigest: string;
		contentDigest: string;
	}> = [];
	for (const snapshot of input.snapshots) {
		const appDigest = canonicalIdentityDigest(snapshot.appId);
		const projectId = projectByApp.get(snapshot.appId) ?? null;
		let lookupContext: FrozenLookupValidationContext | undefined;
		if (projectId !== null && projectId.trim().length > 0) {
			lookupContext = await readFrozenProjectLookupContext(input.tx, projectId);
			const projectDigest = canonicalIdentityDigest(projectId);
			lookupContexts.set(projectDigest, {
				projectDigest,
				tableCount: lookupContext.definitions.length.toString(),
				columnCount: lookupContext.definitions
					.reduce(
						(total, definition) => total + BigInt(definition.columns.length),
						EXACT_ZERO,
					)
					.toString(),
				contextDigest: canonicalIdentityDigest(lookupContext),
			});
		}
		const sourcePlan = planCanonicalAppMigration(snapshot);
		const candidate = candidateByApp.get(snapshot.appId);
		const candidateDigest =
			candidate === undefined
				? canonicalIdentityDigest("deleted-project-orphan")
				: planCanonicalAppMigration(candidate).beforeDigest;
		for (const finding of sourcePlan.findings) {
			findings.push({
				carrierId: `app:${appDigest}`,
				code: finding.code,
				pathDigest: canonicalIdentityDigest(finding.path),
				contentDigest: finding.digest,
			});
		}
		const referenceIndexDigest = canonicalIdentityDigest({
			media: frozenExactTextSequenceDigest(
				frozenRawRowsForApp(
					input.rawSource,
					"media_asset_refs",
					snapshot.appId,
				),
			),
			tables: frozenExactTextSequenceDigest(
				frozenRawRowsForApp(
					input.rawSource,
					"lookup_table_references",
					snapshot.appId,
				),
			),
			columns: frozenExactTextSequenceDigest(
				frozenRawRowsForApp(
					input.rawSource,
					"lookup_column_references",
					snapshot.appId,
				),
			),
		});
		apps.push({
			appDigest,
			projectDigest:
				projectId === null ? null : canonicalIdentityDigest(projectId),
			sourceDigest: sourcePlan.beforeDigest,
			canonicalDigest: candidateDigest,
			sequence: String(snapshot.mutationSeq),
			disposition:
				appDigest === FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST
					? "delete-project-orphan"
					: input.state === "applied" && affected.has(appDigest)
						? "already-applied"
						: affected.has(appDigest)
							? "repair"
							: "preserve",
			lookupContextDigest:
				lookupContext === undefined
					? null
					: canonicalIdentityDigest(lookupContext),
			referenceIndexDigest,
			schemaDefinitionDigest: frozenExactTextSequenceDigest(
				frozenRawRowsForApp(
					input.rawSource,
					"case_type_schemas",
					snapshot.appId,
				),
			),
			findingsDigest: canonicalIdentityDigest(sourcePlan.findings),
		});
	}
	const rawCarriers = frozenRawCarrierEvidence(input.rawSource);
	const byTable = new Map(
		rawCarriers.map((carrier) => [carrier.table, carrier]),
	);
	const rewriteTables = [
		"apps",
		"blueprint_entities",
		"accepted_mutations",
		"case_type_schemas",
	];
	const rewriteBytes = rewriteTables
		.reduce(
			(total, table) => total + BigInt(byTable.get(table)?.bytes ?? "0"),
			EXACT_ZERO,
		)
		.toString();
	return createFrozenCutoverPlan({
		mode: input.apply ? "repair-apply" : "repair-rehearsal",
		state: input.state,
		lockRelations: input.lockRelations,
		apps,
		rawCarriers,
		leaseState: input.leaseState,
		lookupContexts: [...lookupContexts.values()],
		referenceIndexDigest: canonicalIdentityDigest({
			media: byTable.get("media_asset_refs")?.digest ?? null,
			tables: byTable.get("lookup_table_references")?.digest ?? null,
			columns: byTable.get("lookup_column_references")?.digest ?? null,
		}),
		schemaDefinitionDigest: catalog.schemaDefinitionDigest,
		baselineCatalogDigest: canonicalIdentityDigest({ state: input.state }),
		dependencyCatalogDigest: catalog.dependencyCatalogDigest,
		relationAndIndexAclDigest: catalog.relationAndIndexAclDigest,
		functionCatalogDigest: catalog.functionCatalogDigest,
		capacity: reviewedFrozenCapacity({
			apps: input.snapshots.length.toString(),
			entities: input.snapshots
				.reduce(
					(total, snapshot) => total + BigInt(snapshot.rows.length),
					EXACT_ZERO,
				)
				.toString(),
			sourceBytes: rawCarriers.map((carrier) => carrier.bytes),
			rewriteBytes,
		}),
		findings,
	});
}

export interface CanonicalIdentityFoundationRepairProof {
	readonly affectedApps: number;
	readonly deletedApps: number;
	readonly deletedRows: number;
	readonly removedThreadAttachments: number;
	readonly updatedEntityRows: number;
	readonly updatedCatalogs: number;
	readonly resultDigest: string;
	readonly occurrenceSourceDigest: string;
	readonly occurrenceResultDigest: string;
}

/** The proof for a database this repair has no subject in: it changed nothing,
 *  so every count is zero and no digest is claimed. */
const EMPTY_CANONICAL_IDENTITY_REPAIR_PROOF: CanonicalIdentityFoundationRepairProof =
	{
		affectedApps: 0,
		deletedApps: 0,
		deletedRows: 0,
		removedThreadAttachments: 0,
		updatedEntityRows: 0,
		updatedCatalogs: 0,
		resultDigest: "",
		occurrenceSourceDigest: "",
		occurrenceResultDigest: "",
	};

export interface FrozenCanonicalIdentityRepairReport
	extends CanonicalIdentityFoundationRepairProof {
	readonly mode: "dry-run" | "applied" | "already-applied" | "not-applicable";
	readonly sourceState: "pristine" | "applied" | "absent";
	readonly version: typeof CANONICAL_IDENTITY_REPAIR_VERSION;
	readonly cutoverPlan: FrozenCutoverPlan;
}

class FrozenRepairDryRunRollback extends Error {
	constructor(readonly report: FrozenCanonicalIdentityRepairReport) {
		super("Rollback the verified canonical identity repair rehearsal.");
	}
}

function qualifiedFrozenRepairTable(value: string) {
	const [schema, table, extra] = value.split(".");
	if (schema === undefined || table === undefined || extra !== undefined) {
		throw new Error(
			`Invalid frozen repair table (${canonicalIdentityDigest(value)}).`,
		);
	}
	return sql.id(schema, table);
}

export type CanonicalIdentityRepairFailureStage =
	| "thread-attachments"
	| "rows"
	| "proof";

export interface CanonicalIdentityRepairOptions {
	/** Transaction-atomicity proof hook; production callers omit it. */
	readonly failAfterStage?: CanonicalIdentityRepairFailureStage;
}

function injectReviewedRepairFailure(
	options: CanonicalIdentityRepairOptions,
	stage: CanonicalIdentityRepairFailureStage,
): void {
	if (options.failAfterStage === stage) {
		throw new Error(
			`Injected canonical identity repair failure after ${stage}.`,
		);
	}
}

export async function applyCanonicalIdentityFoundationRepairInTransaction<DB>(
	tx: DbTx<DB>,
	before: readonly FrozenVerifiedRepairSnapshot[],
	options: CanonicalIdentityRepairOptions = {},
): Promise<CanonicalIdentityFoundationRepairProof> {
	await captureRepairLeaseState(tx);
	const storedSource =
		await loadCanonicalIdentityRepairSnapshotsInTransaction(tx);
	await assertStoredRepairSnapshotsExact(tx, before);
	if (
		canonicalIdentityDigest(storedSource) !== canonicalIdentityDigest(before)
	) {
		throw new Error("Canonical identity repair source snapshot set changed.");
	}
	const rawSource = await captureFrozenStorageSnapshot(tx);
	const occurrenceSource = dispatchFrozenStorageOccurrences(rawSource);
	const removedThreadAttachments = await applyFrozenThreadAttachmentRepairs(tx);
	injectReviewedRepairFailure(options, "thread-attachments");
	const invalidProjectApps = await sql<{
		id: string;
		owner: string;
		project_id: string | null;
	}>`
		SELECT id, owner, project_id
		FROM apps
		WHERE project_id IS NULL OR btrim(project_id) = ''
		ORDER BY convert_to(id, 'UTF8')
		FOR UPDATE
	`.execute(tx);
	if (invalidProjectApps.rows.length !== 1) {
		throw new Error(
			"Canonical identity repair requires the one frozen Project orphan.",
		);
	}
	const projectOrphan = invalidProjectApps.rows[0];
	if (
		projectOrphan === undefined ||
		projectOrphan.project_id !== null ||
		projectOrphan.owner !== "" ||
		canonicalIdentityDigest(projectOrphan.id) !==
			FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST
	) {
		throw new Error(
			"Canonical identity repair Project orphan identity drifted.",
		);
	}
	const projectOrphanInventory = await captureFrozenProjectOrphanInventory(
		tx,
		projectOrphan.id,
		projectOrphan.owner,
		projectOrphan.project_id,
	);
	assertFrozenProjectOrphanSummary(
		summarizeFrozenProjectOrphanInventory(
			projectOrphan.id,
			projectOrphanInventory,
		),
	);
	const repair = applyFrozenCanonicalIdentityRepair(before);
	await assertCompleteFrozenRepairSnapshots(tx, repair.snapshots);
	const beforeById = new Map(
		before.map((snapshot) => [snapshot.appId, snapshot]),
	);
	const afterById = new Map(
		repair.snapshots.map((snapshot) => [snapshot.appId, snapshot]),
	);
	const affectedIds = repair.affected.map((entry) => entry.appId);
	const reverseBefore = await reverseIndexDigest(tx, affectedIds);

	const orphanUuids = CANONICAL_IDENTITY_ROW_DELETES.map(([, uuid]) => uuid);
	const attachmentConsumers = (
		await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM form_attachments
			WHERE field_uuid::text = ANY(${orphanUuids})
		`.execute(tx)
	).rows[0];
	if (
		exactCount(attachmentConsumers.count, "attachment count") !== EXACT_ZERO
	) {
		throw new Error(
			"Canonical identity repair blocked: a deleted field gained a form attachment consumer.",
		);
	}

	let updatedCatalogs = 0;
	let updatedEntityRows = 0;
	for (const appId of affectedIds) {
		const oldSnapshot = beforeById.get(appId);
		const newSnapshot = afterById.get(appId);
		if (oldSnapshot === undefined || newSnapshot === undefined) {
			throw new Error("Canonical identity repair lost an affected snapshot.");
		}
		if (
			canonicalIdentityDigest(oldSnapshot.caseTypes) !==
			canonicalIdentityDigest(newSnapshot.caseTypes)
		) {
			const result = await sql`
				UPDATE apps
				SET case_types = ${JSON.stringify(newSnapshot.caseTypes)}::jsonb
				WHERE id = ${appId}
			`.execute(tx);
			if (result.numAffectedRows !== EXACT_ONE) {
				throw new Error("Canonical identity repair lost its app row lock.");
			}
			updatedCatalogs++;
		}
		const oldRows = new Map(oldSnapshot.rows.map((row) => [row.uuid, row]));
		for (const row of newSnapshot.rows) {
			const old = oldRows.get(row.uuid);
			if (
				old !== undefined &&
				canonicalIdentityDigest(old.data) !== canonicalIdentityDigest(row.data)
			) {
				const result = await sql`
					UPDATE blueprint_entities
					SET data = ${JSON.stringify(row.data)}::jsonb
					WHERE app_id = ${appId}
					  AND uuid::text = ${row.uuid}
				`.execute(tx);
				if (result.numAffectedRows !== EXACT_ONE) {
					throw new Error(
						"Canonical identity repair could not update one row.",
					);
				}
				updatedEntityRows++;
			}
		}
	}

	for (const [
		appDigest,
		rowUuid,
		rowDigest,
	] of CANONICAL_IDENTITY_ROW_DELETES) {
		const app = repair.affected.find((entry) => entry.appDigest === appDigest);
		if (app === undefined) {
			throw new Error("Canonical identity repair row-delete app disappeared.");
		}
		const row = beforeById
			.get(app.appId)
			?.rows.find((candidate) => candidate.uuid === rowUuid);
		if (row === undefined || canonicalIdentityDigest(row) !== rowDigest) {
			throw new Error(
				`Canonical identity repair row ${canonicalIdentityDigest(rowUuid)} changed before delete.`,
			);
		}
		const result = await sql`
			DELETE FROM blueprint_entities
			WHERE app_id = ${app.appId}
			  AND uuid::text = ${rowUuid}
		`.execute(tx);
		if (result.numAffectedRows !== EXACT_ONE) {
			throw new Error(
				`Canonical identity repair could not delete row ${canonicalIdentityDigest(rowUuid)}.`,
			);
		}
	}

	const deletedMutationRows = await sql`
		DELETE FROM accepted_mutations
		WHERE app_id = ${projectOrphan.id}
	`.execute(tx);
	if (deletedMutationRows.numAffectedRows !== EXACT_ONE) {
		throw new Error(
			"Canonical identity repair Project orphan mutation horizon drifted.",
		);
	}
	const deletedSchemaRows = await sql`
		DELETE FROM case_type_schemas
		WHERE app_id = ${projectOrphan.id}
	`.execute(tx);
	if (deletedSchemaRows.numAffectedRows !== EXACT_ONE) {
		throw new Error(
			"Canonical identity repair Project orphan case schema drifted.",
		);
	}
	const deletedApp = await sql`
		DELETE FROM apps
		WHERE id = ${projectOrphan.id}
	`.execute(tx);
	if (deletedApp.numAffectedRows !== EXACT_ONE) {
		throw new Error(
			"Canonical identity repair Project orphan app row disappeared.",
		);
	}
	const orphanAfter = await captureFrozenProjectOrphanInventory(
		tx,
		projectOrphan.id,
		projectOrphan.owner,
		projectOrphan.project_id,
	);
	if (
		orphanAfter.appRows.length !== 0 ||
		orphanAfter.tables.some((entry) => entry.rows.length !== 0) ||
		orphanAfter.authCandidates.some((entry) => entry.rows.length !== 0)
	) {
		throw new Error(
			"Canonical identity repair Project orphan dependency survived deletion.",
		);
	}

	const storedResult =
		await loadCanonicalIdentityRepairSnapshotsInTransaction(tx);
	await assertStoredRepairSnapshotsExact(tx, repair.snapshots);
	if (
		canonicalIdentityDigest(storedResult) !==
		canonicalIdentityDigest(repair.snapshots)
	) {
		throw new Error("Canonical identity repair result snapshot set changed.");
	}
	const storedDigests = digestByApp(storedResult);
	for (const repaired of repair.affected) {
		if (storedDigests.get(repaired.appId) !== repaired.afterDigest) {
			throw new Error(
				`Canonical identity repair stored result drifted for ${repaired.appDigest}.`,
			);
		}
	}
	if ((await reverseIndexDigest(tx, affectedIds)) !== reverseBefore) {
		throw new Error("Canonical identity repair changed a reverse index.");
	}
	injectReviewedRepairFailure(options, "rows");
	const rawResult = await captureFrozenStorageSnapshot(tx);
	const occurrenceResult = dispatchFrozenStorageOccurrences(rawResult);
	assertFrozenRepairAllowedDelta(rawSource, rawResult);
	injectReviewedRepairFailure(options, "proof");

	return {
		affectedApps: repair.affected.length,
		deletedApps: repair.deletedApps,
		deletedRows: repair.deletedRows,
		removedThreadAttachments,
		updatedEntityRows,
		updatedCatalogs,
		resultDigest: repair.resultDigest,
		occurrenceSourceDigest: canonicalIdentityDigest(occurrenceSource),
		occurrenceResultDigest: canonicalIdentityDigest(occurrenceResult),
	};
}

/**
 * Own the complete frozen transaction boundary. Operator scripts supply only
 * the database handle and the explicit apply/dry-run decision.
 */
/**
 * The repair body, against a caller-owned transaction.
 *
 * The migration runs this before its own work inside Kysely's migration
 * transaction — one deploy does the repair and the cutover together, so there
 * is no operator step needing write authority the deploy identity already has,
 * and no window in which the repair has landed but the migration has not.
 */
export async function runFrozenCanonicalIdentityRepairInTransaction<DB>(
	tx: DbTx<DB>,
	options: { readonly apply: boolean },
): Promise<FrozenCanonicalIdentityRepairReport> {
	{
		requirePreCanonicalRepairBoundary(
			await inspectFrozenCanonicalRepairBoundary(tx),
		);
		const casesSchema = await resolveFrozenCasesSchema(tx);
		const existingOccurrenceTables = (
			await sql<{ table_name: string }>`
						SELECT class.relname AS table_name
						FROM pg_catalog.pg_class AS class
						JOIN pg_catalog.pg_namespace AS namespace
						  ON namespace.oid = class.relnamespace
						WHERE namespace.nspname = 'public'
						  AND class.relkind IN ('r', 'p')
						  AND class.relname = ANY(
							${sql.val([
								...FROZEN_OCCURRENCE_TABLES,
								...FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
							])}
						  )
						ORDER BY convert_to(class.relname, 'UTF8')
					`.execute(tx)
		).rows.map((row) => row.table_name);
		/* Auth relations are filtered by the same catalog read the
		 * occurrence tables use. This migration runs against databases that
		 * carry the case store without the auth schema, and `LOCK TABLE` on
		 * a relation that does not exist aborts the transaction. Locking
		 * what is present is the requirement; naming what is absent is
		 * not. */
		const presentTables = new Set(existingOccurrenceTables);
		const lockTables = [
			...new Set([
				...FROZEN_OCCURRENCE_TABLES.filter((table) =>
					presentTables.has(table),
				).map((table) => `public.${table}`),
				...FROZEN_PROJECT_ORPHAN_APP_ID_TABLES.map((table) =>
					table === "nova_case_runtime.cases" ? `${casesSchema}.cases` : table,
				),
				...FROZEN_PROJECT_ORPHAN_AUTH_TABLES.filter((table) =>
					presentTables.has(table),
				).map((table) => `public.${table}`),
				"public.kysely_migration",
			]),
		].sort((left, right) =>
			Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
		);
		await sql`
					LOCK TABLE ${sql.join(lockTables.map(qualifiedFrozenRepairTable))}
					IN SHARE ROW EXCLUSIVE MODE
				`.execute(tx);
		await sql`
					SELECT id
					FROM apps
					ORDER BY convert_to(id, 'UTF8')
					FOR UPDATE
				`.execute(tx);
		requirePreCanonicalRepairBoundary(
			await inspectFrozenCanonicalRepairBoundary(tx),
		);
		const leaseState = await captureRepairLeaseState(tx);
		const before = await loadCanonicalIdentityRepairSnapshotsInTransaction(tx);
		const inspection = await inspectFrozenRepairState(tx, before);
		if (inspection.state === "drift") {
			throw new Error(
				[
					"This database is part-way through the canonical identity repair, so it is not safe to start it.",
					"",
					`Apps with no Project: ${inspection.invalidProjectApps.length}. The repair expects either exactly the one it was cut for, or none at all.`,
					"",
					"It also expects every app it changes to be in its original shape, or every one already repaired, or none of them present. On a developer machine a mix usually means a copy of production data sitting alongside local work — recreate the database and migrate again.",
				].join("\n"),
			);
		}
		if (inspection.state === "absent") {
			/* Nothing here to repair. Report it and leave the transaction
			 * untouched so the migration that called us proceeds. */
			const report: FrozenCanonicalIdentityRepairReport = {
				mode: "not-applicable",
				sourceState: "absent",
				version: CANONICAL_IDENTITY_REPAIR_VERSION,
				...EMPTY_CANONICAL_IDENTITY_REPAIR_PROOF,
				cutoverPlan: await createFrozenRepairCutoverPlan({
					tx,
					apply: options.apply,
					state: "pristine",
					snapshots: before,
					candidateSnapshots: inspection.candidateSnapshots,
					rawSource: await captureFrozenStorageSnapshot(tx),
					lockRelations: lockTables,
					leaseState,
					casesSchema,
				}),
			};
			if (!options.apply) throw new FrozenRepairDryRunRollback(report);
			return report;
		}
		const rawSource = await captureFrozenStorageSnapshot(tx);
		const cutoverPlan = await createFrozenRepairCutoverPlan({
			tx,
			apply: options.apply,
			state: inspection.state,
			snapshots: before,
			candidateSnapshots: inspection.candidateSnapshots,
			rawSource,
			lockRelations: lockTables,
			leaseState,
			casesSchema,
		});
		if (inspection.state === "applied") {
			await assertStoredRepairSnapshotsExact(tx, before);
			await assertCompleteFrozenRepairSnapshots(tx, before);
			const occurrence = canonicalIdentityDigest(
				dispatchFrozenStorageOccurrences(rawSource),
			);
			return {
				mode: "already-applied",
				sourceState: "applied",
				version: CANONICAL_IDENTITY_REPAIR_VERSION,
				affectedApps: CANONICAL_IDENTITY_AFFECTED_APPS.length,
				deletedApps: 0,
				deletedRows: 0,
				removedThreadAttachments: 0,
				updatedEntityRows: 0,
				updatedCatalogs: 0,
				resultDigest: CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST,
				occurrenceSourceDigest: occurrence,
				occurrenceResultDigest: occurrence,
				cutoverPlan,
			};
		}
		const proof = await applyCanonicalIdentityFoundationRepairInTransaction(
			tx,
			before,
		);
		if (proof.resultDigest !== CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST) {
			throw new Error("Canonical identity repair manifest result drifted.");
		}
		const report: FrozenCanonicalIdentityRepairReport = {
			mode: options.apply ? "applied" : "dry-run",
			sourceState: "pristine",
			version: CANONICAL_IDENTITY_REPAIR_VERSION,
			...proof,
			cutoverPlan,
		};
		if (!options.apply) throw new FrozenRepairDryRunRollback(report);
		return report;
	}
}

export async function runFrozenCanonicalIdentityRepair<DB>(
	db: Kysely<DB>,
	options: { readonly apply: boolean },
): Promise<FrozenCanonicalIdentityRepairReport> {
	try {
		return await db
			.transaction()
			.setIsolationLevel("serializable")
			.execute(async (tx) => {
				await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
				await sql`SET LOCAL statement_timeout = '960s'`.execute(tx);
				await sql`
					SET LOCAL idle_in_transaction_session_timeout = '990s'
				`.execute(tx);
				return await runFrozenCanonicalIdentityRepairInTransaction(tx, options);
			});
	} catch (error) {
		if (error instanceof FrozenRepairDryRunRollback) return error.report;
		throw error;
	}
}
