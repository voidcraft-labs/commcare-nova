import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { collectThreadAttachments } from "@/lib/chat/threadAttachments";
import type { AppDatabase } from "@/lib/db/pg";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { deepEqual } from "@/lib/doc/deepEqual";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	type LookupReferenceTargetSet,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain/blueprint";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import {
	type AssetKind,
	asMediaAssetId,
	type MediaAssetId,
} from "@/lib/domain/multimedia";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { readAppChangeStreamRowsSince } from "./appChangeStream";
import { commitGuardedBatchInTransaction, loadAppInTransaction } from "./apps";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedEntityRowText,
	safePersistedSequence,
} from "./persistedJson";
import { projectRoleForInTransaction } from "./projectMembership";

interface RuntimeProbeCandidateRow {
	readonly app_id: string;
	readonly project_id: string;
	readonly user_id: string;
	readonly role: string;
}

interface RuntimeProbeAppRow {
	readonly id: string;
}

interface RuntimeProbePersistedAppRow {
	readonly id: string;
	readonly project_id: string;
	readonly mutation_seq: string | number;
	readonly app_name: string;
	readonly connect_type: PersistableDoc["connectType"];
	readonly logo: PersistableDoc["logo"];
	readonly case_types_text: string | null;
	readonly localization_text: string | null;
}

interface RuntimeProbeRollbackVerificationRow {
	readonly mutation_seq: string | number;
	readonly probe_rows: string | number;
}

interface RuntimeProbeProjectForeignKeyRow {
	readonly name: string;
	readonly local_relation: string;
	readonly definition: string;
	readonly deferrable: boolean;
	readonly initially_deferred: boolean;
	readonly validated: boolean;
}

const FINAL_PROJECT_FOREIGN_KEYS = [
	{
		name: "app_change_fold_baselines_project_id_auth_organization_fk",
		local_relation: "app_change_fold_baselines",
		definition:
			"FOREIGN KEY (project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		deferrable: false,
		initially_deferred: false,
		validated: true,
	},
	{
		name: "app_changes_from_project_id_auth_organization_fk",
		local_relation: "app_changes",
		definition:
			"FOREIGN KEY (from_project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		deferrable: false,
		initially_deferred: false,
		validated: true,
	},
	{
		name: "app_changes_to_project_id_auth_organization_fk",
		local_relation: "app_changes",
		definition:
			"FOREIGN KEY (to_project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		deferrable: false,
		initially_deferred: false,
		validated: true,
	},
	{
		name: "apps_project_id_auth_organization_fk",
		local_relation: "apps",
		definition:
			"FOREIGN KEY (project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT",
		deferrable: false,
		initially_deferred: false,
		validated: true,
	},
] as const satisfies readonly RuntimeProbeProjectForeignKeyRow[];

async function assertFinalProjectForeignKeys(
	db: Kysely<AppDatabase>,
): Promise<void> {
	const names = FINAL_PROJECT_FOREIGN_KEYS.map((foreignKey) => foreignKey.name);
	const result = await sql<RuntimeProbeProjectForeignKeyRow>`
		SELECT
			constraint_row.conname AS name,
			relation.relname AS local_relation,
			pg_get_constraintdef(constraint_row.oid, true) AS definition,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.convalidated AS validated
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation
			ON relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS namespace
			ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
			AND constraint_row.contype = 'f'
			AND constraint_row.conname = ANY(${names}::text[])
		ORDER BY constraint_row.conname
	`.execute(db);
	if (!deepEqual(result.rows, FINAL_PROJECT_FOREIGN_KEYS)) {
		throw new Error(
			"The runtime database probe requires the exact four final Project foreign keys.",
		);
	}
}

async function assertFinalMediaReferenceCatalog(
	db: Kysely<AppDatabase>,
): Promise<void> {
	const catalog = await sql<{
		columns: string[];
		constraints: string[];
		indexes: string[];
		triggers: string[];
		routines: string[];
		asset_target_unique: string | null;
		retired_state: string | null;
	}>`
		SELECT
			ARRAY(
				SELECT attribute.attname || ':' ||
					pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) ||
					':' || attribute.attnotnull::text || ':' ||
					COALESCE(
						pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid),
						'NULL'
					)
				FROM pg_catalog.pg_attribute AS attribute
				LEFT JOIN pg_catalog.pg_attrdef AS default_row
					ON default_row.adrelid = attribute.attrelid
					AND default_row.adnum = attribute.attnum
				WHERE attribute.attrelid = 'public.media_asset_refs'::regclass
					AND attribute.attnum > 0
					AND NOT attribute.attisdropped
				ORDER BY attribute.attnum
			) AS columns,
			ARRAY(
				SELECT constraint_row.conname || ':' ||
					pg_catalog.pg_get_constraintdef(constraint_row.oid, true) || ':' ||
					constraint_row.condeferrable::text || ':' ||
					constraint_row.condeferred::text || ':' ||
					constraint_row.convalidated::text
				FROM pg_catalog.pg_constraint AS constraint_row
				WHERE constraint_row.conrelid =
					'public.media_asset_refs'::regclass
				ORDER BY constraint_row.conname
			) AS constraints,
			ARRAY(
				SELECT index_relation.relname || ':' ||
					pg_catalog.pg_get_indexdef(index_relation.oid, 0, false) || ':' ||
					index_row.indisunique::text || ':' ||
					index_row.indisprimary::text || ':' ||
					index_row.indisvalid::text || ':' ||
					index_row.indisready::text
				FROM pg_catalog.pg_index AS index_row
				JOIN pg_catalog.pg_class AS relation
					ON relation.oid = index_row.indrelid
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = relation.relnamespace
				JOIN pg_catalog.pg_class AS index_relation
					ON index_relation.oid = index_row.indexrelid
				WHERE namespace.nspname = 'public'
					AND (
						relation.relname = 'media_asset_refs'
						OR (
							relation.relname = 'media_assets'
							AND index_relation.relname =
								'media_assets_project_id_id_key'
						)
					)
				ORDER BY index_relation.relname
			) AS indexes,
			ARRAY(
				SELECT pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
				FROM pg_catalog.pg_trigger AS trigger_row
				WHERE trigger_row.tgrelid = 'public.media_asset_refs'::regclass
					AND NOT trigger_row.tgisinternal
				ORDER BY trigger_row.tgname
			) AS triggers,
			ARRAY(
				SELECT namespace.nspname || '.' || routine.proname || '(' ||
					pg_catalog.pg_get_function_identity_arguments(routine.oid) ||
					'):' || routine.prokind::text
				FROM pg_catalog.pg_proc AS routine
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = routine.pronamespace
				WHERE namespace.nspname = 'public'
					AND routine.prokind IN ('f', 'p')
					AND (
						lower(pg_catalog.pg_get_functiondef(routine.oid))
							LIKE '%media_asset_refs%'
						OR EXISTS (
							SELECT 1
							FROM pg_catalog.pg_depend AS dependency
							WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
								AND dependency.objid = routine.oid
								AND dependency.refobjid =
									'public.media_asset_refs'::regclass
						)
					)
				ORDER BY namespace.nspname, routine.proname,
					pg_catalog.pg_get_function_identity_arguments(routine.oid)
			) AS routines,
			pg_catalog.pg_get_constraintdef(
				(
					SELECT oid
					FROM pg_catalog.pg_constraint
					WHERE conname = 'media_assets_project_id_id_key'
						AND conrelid = 'public.media_assets'::regclass
				),
				true
			) AS asset_target_unique,
			pg_catalog.to_regclass(
				'public.media_reference_index_state'
			)::text AS retired_state
	`.execute(db);
	if (
		!deepEqual(catalog.rows[0], {
			columns: [
				"project_id:text:true:NULL",
				"app_id:text:true:NULL",
				"asset_id:uuid:true:NULL",
			],
			constraints: [
				"media_asset_refs_app_id_not_null:NOT NULL app_id:false:false:true",
				"media_asset_refs_asset_id_not_null:NOT NULL asset_id:false:false:true",
				"media_asset_refs_pkey:PRIMARY KEY (project_id, app_id, asset_id):false:false:true",
				"media_asset_refs_project_app_fk:FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE:false:false:true",
				"media_asset_refs_project_asset_fk:FOREIGN KEY (project_id, asset_id) REFERENCES media_assets(project_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT:false:false:true",
				"media_asset_refs_project_id_not_null:NOT NULL project_id:false:false:true",
			],
			indexes: [
				"media_asset_refs_pkey:CREATE UNIQUE INDEX media_asset_refs_pkey ON public.media_asset_refs USING btree (project_id, app_id, asset_id):true:true:true:true",
				"media_asset_refs_project_asset_app_idx:CREATE INDEX media_asset_refs_project_asset_app_idx ON public.media_asset_refs USING btree (project_id, asset_id, app_id):false:false:true:true",
				"media_assets_project_id_id_key:CREATE UNIQUE INDEX media_assets_project_id_id_key ON public.media_assets USING btree (project_id, id):true:false:true:true",
			],
			triggers: [],
			routines: [],
			asset_target_unique: "UNIQUE (project_id, id)",
			retired_state: null,
		})
	) {
		throw new Error(
			`The runtime database probe requires the exact final media-reference catalog: ${JSON.stringify(catalog.rows[0])}.`,
		);
	}
}

export interface RuntimeProbeStoredProjectLookupReference {
	readonly project_id: string;
	readonly table_id: string;
	readonly column_id: string | null;
}

export interface RuntimeProbeAppAudit {
	readonly parsed: boolean;
	readonly gateFindingCount: number;
	readonly localReferenceIndexFindingCount: number;
	readonly projectReferenceIndexFindingCount: number;
	readonly mediaReferenceProjectionFindingCount: number;
}

export interface CanonicalRuntimeDatabaseProbeReport {
	readonly scannedAppCount: number;
	readonly parsedAppCount: number;
	readonly parserFindingCount: number;
	readonly gateFindingCount: number;
	readonly localReferenceIndexFindingCount: number;
	readonly projectReferenceIndexFindingCount: number;
	readonly mediaReferenceProjectionFindingCount: number;
	readonly findingCount: number;
	readonly snapshotDigest: string;
	readonly rollbackVerified: true;
}

export class CanonicalRuntimeDatabaseProbeFindingsError extends Error {
	readonly name = "CanonicalRuntimeDatabaseProbeFindingsError";

	constructor(readonly report: CanonicalRuntimeDatabaseProbeReport) {
		super(
			`The runtime database probe found ${report.findingCount} steady-state finding(s): ${JSON.stringify(report)}.`,
		);
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([left], [right]) => left.localeCompare(right),
	);
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
}

function nonnegativeFindingCount(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a nonnegative safe integer.`);
	}
	return value;
}

/**
 * Aggregate one outcome per selected app row. There is deliberately no page,
 * sampling, or candidate cap: callers prove `audits.length === selected row
 * count` before this report can exist.
 */
export function summarizeRuntimeProbeAppAudits(
	scannedAppCount: number,
	audits: readonly RuntimeProbeAppAudit[],
): Omit<
	CanonicalRuntimeDatabaseProbeReport,
	"snapshotDigest" | "rollbackVerified"
> {
	if (
		!Number.isSafeInteger(scannedAppCount) ||
		scannedAppCount < 0 ||
		audits.length !== scannedAppCount
	) {
		throw new Error(
			"The runtime database probe must report exactly one audit for every selected app.",
		);
	}
	const parsedAppCount = audits.filter((audit) => audit.parsed).length;
	const parserFindingCount = scannedAppCount - parsedAppCount;
	const gateFindingCount = audits.reduce(
		(sum, audit) =>
			sum +
			nonnegativeFindingCount(audit.gateFindingCount, "gate finding count"),
		0,
	);
	const localReferenceIndexFindingCount = audits.reduce(
		(sum, audit) =>
			sum +
			nonnegativeFindingCount(
				audit.localReferenceIndexFindingCount,
				"local reference-index finding count",
			),
		0,
	);
	const projectReferenceIndexFindingCount = audits.reduce(
		(sum, audit) =>
			sum +
			nonnegativeFindingCount(
				audit.projectReferenceIndexFindingCount,
				"Project reference-index finding count",
			),
		0,
	);
	const mediaReferenceProjectionFindingCount = audits.reduce(
		(sum, audit) =>
			sum +
			nonnegativeFindingCount(
				audit.mediaReferenceProjectionFindingCount,
				"media reference projection finding count",
			),
		0,
	);
	return {
		scannedAppCount,
		parsedAppCount,
		parserFindingCount,
		gateFindingCount,
		localReferenceIndexFindingCount,
		projectReferenceIndexFindingCount,
		mediaReferenceProjectionFindingCount,
		findingCount:
			parserFindingCount +
			gateFindingCount +
			localReferenceIndexFindingCount +
			projectReferenceIndexFindingCount +
			mediaReferenceProjectionFindingCount,
	};
}

export function chooseRuntimeProbeCandidate(
	rows: readonly RuntimeProbeCandidateRow[],
): RuntimeProbeCandidateRow {
	const candidate = rows.find((row) => roleAllowsApp(row.role, "edit"));
	if (candidate === undefined) {
		throw new Error(
			"The runtime database probe requires an existing editable Project app membership.",
		);
	}
	return candidate;
}

function expectedProjectLookupReferences(
	projectId: string,
	targets: LookupReferenceTargetSet,
): readonly RuntimeProbeStoredProjectLookupReference[] {
	return [
		...targets.tableIds.map((tableId) => ({
			project_id: projectId,
			table_id: tableId,
			column_id: null,
		})),
		...targets.columnTargets.map(({ tableId, columnId }) => ({
			project_id: projectId,
			table_id: tableId,
			column_id: columnId,
		})),
	].sort(
		(left, right) =>
			left.table_id.localeCompare(right.table_id) ||
			(left.column_id ?? "").localeCompare(right.column_id ?? "") ||
			left.project_id.localeCompare(right.project_id),
	);
}

async function readStoredProjectLookupReferences(
	tx: Kysely<AppDatabase>,
	appId: string,
): Promise<readonly RuntimeProbeStoredProjectLookupReference[]> {
	const result = await sql<RuntimeProbeStoredProjectLookupReference>`
		SELECT project_id, table_id::text AS table_id, NULL::text AS column_id
		FROM lookup_table_references
		WHERE app_id = ${appId}
		UNION ALL
		SELECT project_id, table_id::text AS table_id, column_id::text AS column_id
		FROM lookup_column_references
		WHERE app_id = ${appId}
		ORDER BY table_id, column_id NULLS FIRST, project_id
	`.execute(tx);
	return result.rows;
}

async function auditRuntimeMediaReferenceProjection(
	tx: Kysely<AppDatabase>,
	args: { appId: string; projectId: string; doc: BlueprintDoc },
): Promise<number> {
	try {
		/* The projection is SPLIT by carrier family: `media_asset_refs` holds
		 * exactly the Blueprint-AUTHORED references, and each thread's
		 * conversation attachments hold exactly that thread's
		 * `thread_media_refs` rows. Each family re-derives independently; a
		 * thread attachment must never appear in the app-wide family. */
		const requirements: Array<{
			assetId: MediaAssetId;
			expectedKind: AssetKind;
		}> = [...walkAuthoredAssetRefs(args.doc)]
			.filter((ref) => !isBuiltinIconRef(ref.assetId))
			.map((ref) => ({
				assetId: asMediaAssetId(ref.assetId),
				expectedKind: ref.slotKind,
			}));
		const expectedAssetIds = [
			...new Set(requirements.map((requirement) => requirement.assetId)),
		].sort();
		const stored = await tx
			.selectFrom("media_asset_refs")
			.select(["project_id", "app_id", "asset_id"])
			.where("app_id", "=", args.appId)
			.orderBy("project_id")
			.orderBy("app_id")
			.orderBy("asset_id")
			.execute();
		if (
			!deepEqual(
				stored,
				expectedAssetIds.map((assetId) => ({
					project_id: args.projectId,
					app_id: args.appId,
					asset_id: assetId,
				})),
			)
		) {
			return 1;
		}
		const threads = await tx
			.selectFrom("threads")
			.select(["thread_id", "messages"])
			.where("app_id", "=", args.appId)
			.orderBy("thread_id")
			.execute();
		for (const thread of threads) {
			const attachments = collectThreadAttachments(thread.messages);
			for (const attachment of attachments) {
				requirements.push({
					assetId: attachment.assetId,
					expectedKind: attachment.kind,
				});
			}
			const expectedThreadAssetIds = [
				...new Set(attachments.map((attachment) => attachment.assetId)),
			].sort();
			const storedThreadRefs = await tx
				.selectFrom("thread_media_refs")
				.select(["project_id", "asset_id"])
				.where("thread_id", "=", thread.thread_id)
				.orderBy("asset_id")
				.execute();
			if (
				!deepEqual(
					storedThreadRefs,
					expectedThreadAssetIds.map((assetId) => ({
						project_id: args.projectId,
						asset_id: assetId,
					})),
				)
			) {
				return 1;
			}
		}
		const requiredAssetIds = [
			...new Set(requirements.map((requirement) => requirement.assetId)),
		].sort();
		if (requiredAssetIds.length === 0) return 0;
		const assets = await tx
			.selectFrom("media_assets")
			.select(["id", "project_id", "status", "kind"])
			.where("id", "in", requiredAssetIds)
			.execute();
		const byId = new Map(assets.map((asset) => [asset.id, asset]));
		return requirements.every((requirement) => {
			const asset = byId.get(requirement.assetId);
			return (
				asset?.project_id === args.projectId &&
				asset.status === "ready" &&
				asset.kind === requirement.expectedKind
			);
		})
			? 0
			: 1;
	} catch {
		return 1;
	}
}

export function auditRuntimeProbeParsedBlueprint(args: {
	readonly doc: BlueprintDoc;
	readonly appName: string;
	readonly projectId: string;
	readonly lookupContext: LookupValidationContext;
	readonly storedProjectLookupReferences: readonly RuntimeProbeStoredProjectLookupReference[];
	readonly mediaReferenceProjectionFindingCount: number;
}): RuntimeProbeAppAudit {
	const absoluteVerdict = mutationCommitVerdict(
		args.doc,
		[],
		args.lookupContext,
	);
	const mutationVerdict = mutationCommitVerdict(
		args.doc,
		admitMutationBatch([{ kind: "setAppName", name: args.appName }]),
		args.lookupContext,
	);
	const targets = extractLookupReferenceTargets(args.doc);
	return {
		parsed: true,
		gateFindingCount: absoluteVerdict.ok ? 0 : absoluteVerdict.findings.length,
		localReferenceIndexFindingCount:
			mutationVerdict.nextDoc.refIndex !== undefined &&
			deepEqual(
				mutationVerdict.nextDoc.refIndex,
				buildReferenceIndex(mutationVerdict.nextDoc),
			)
				? 0
				: 1,
		projectReferenceIndexFindingCount: deepEqual(
			args.storedProjectLookupReferences,
			expectedProjectLookupReferences(args.projectId, targets),
		)
			? 0
			: 1,
		mediaReferenceProjectionFindingCount:
			args.mediaReferenceProjectionFindingCount,
	};
}

async function readRuntimeProbeCarriers(
	tx: Kysely<AppDatabase>,
	appId: string,
): Promise<{
	readonly projectId: string;
	readonly mutationSeq: string | number;
	readonly appName: string;
	readonly connectType: PersistableDoc["connectType"];
	readonly logo: PersistableDoc["logo"];
	readonly caseTypesText: string | null;
	readonly localizationText: string | null;
	readonly entities: readonly PersistedEntityRowText[];
}> {
	const root = (await tx
		.selectFrom("apps")
		.select([
			"id",
			"project_id",
			"mutation_seq",
			"app_name",
			"connect_type",
			"logo",
		])
		.select(
			sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("apps.localization")}::text`.as(
				"localization_text",
			),
		)
		.where("id", "=", appId)
		.forShare()
		.executeTakeFirst()) as RuntimeProbePersistedAppRow | undefined;
	if (root === undefined) {
		throw new Error(
			"The runtime database probe lost an app inside its transaction.",
		);
	}
	const entities = await tx
		.selectFrom("blueprint_entities")
		.select(["uuid", "kind", "parent_uuid", "ordinal"])
		.select(
			sql<string>`${sql.ref("blueprint_entities.data")}::text`.as("data_text"),
		)
		.where("app_id", "=", appId)
		.execute();
	return {
		projectId: root.project_id,
		mutationSeq: root.mutation_seq,
		appName: root.app_name,
		connectType: root.connect_type,
		logo: root.logo,
		caseTypesText: root.case_types_text,
		localizationText: root.localization_text,
		entities: entities.map((entity) => ({
			...entity,
			parent_uuid: entity.parent_uuid ?? null,
		})) as PersistedEntityRowText[],
	};
}

function decodeRuntimeProbeCarriers(
	appId: string,
	carriers: Awaited<ReturnType<typeof readRuntimeProbeCarriers>>,
): PersistableDoc {
	return assemblePersistedBlueprintJsonText(
		appId,
		{
			app_name: carriers.appName,
			connect_type: carriers.connectType,
			case_types_text: carriers.caseTypesText,
			localization_text: carriers.localizationText,
			logo: carriers.logo ?? null,
		},
		carriers.entities,
	);
}

class IntentionalRuntimeProbeRollback extends Error {}

/**
 * Prove the post-migration serving identity against the exact production read
 * and write paths without committing probe data.
 *
 * The migration connection SET ROLEs inside one transaction, selects every
 * app without a limit, strictly loads every persisted carrier, reruns the
 * complete absolute gate, proves incremental-vs-rebuilt local reference-index
 * equality, and proves the Project-scoped lookup edge rows equal the complete
 * structural target set. It then authorizes an existing editable member and
 * drives one real guarded write. The sentinel rollback must remove both the
 * stream latch and app-row sequence advance.
 */
export async function runCanonicalRuntimeDatabaseProbe(
	database: Kysely<unknown>,
	runtimeRole: string,
): Promise<CanonicalRuntimeDatabaseProbeReport> {
	const db = database as unknown as Kysely<AppDatabase>;
	const batchId = randomUUID();
	let report:
		| (CanonicalRuntimeDatabaseProbeReport & {
				readonly candidateAppId: string;
				readonly candidateBaseSeq: number;
		  })
		| undefined;
	const rollback = new IntentionalRuntimeProbeRollback(
		"intentional runtime database probe rollback",
	);

	try {
		await db.transaction().execute(async (tx) => {
			await sql`SET LOCAL ROLE ${sql.id(runtimeRole)}`.execute(tx);
			await assertFinalProjectForeignKeys(tx);
			await assertFinalMediaReferenceCatalog(tx);

			const appRows = await tx
				.selectFrom("apps")
				.select("id")
				.orderBy("id")
				.execute();
			const audits: RuntimeProbeAppAudit[] = [];
			const digest = createHash("sha256");
			const gateCleanAppIds = new Set<string>();

			for (const row of appRows as RuntimeProbeAppRow[]) {
				const carriers = await readRuntimeProbeCarriers(tx, row.id);
				let blueprint: ReturnType<typeof decodeRuntimeProbeCarriers>;
				try {
					blueprint = decodeRuntimeProbeCarriers(row.id, carriers);
				} catch (error) {
					audits.push({
						parsed: false,
						gateFindingCount: 0,
						localReferenceIndexFindingCount: 0,
						projectReferenceIndexFindingCount: 0,
						mediaReferenceProjectionFindingCount: 0,
					});
					digest.update(
						canonicalJson([
							row.id,
							"parse-failed",
							error instanceof Error ? error.name : "unknown",
						]),
					);
					continue;
				}
				const mutationSeq = safePersistedSequence(
					carriers.mutationSeq,
					`apps.mutation_seq for runtime probe app ${row.id}`,
				);
				const doc = hydratePersistedBlueprint(blueprint);
				const targets = extractLookupReferenceTargets(doc);
				const definitionSnapshot = await readLookupDefinitionsInTransaction(
					tx,
					carriers.projectId,
					targets.tableIds,
				);
				const lookupContext: LookupValidationContext = {
					kind: "available",
					...definitionSnapshot,
				};
				const storedTargets = await readStoredProjectLookupReferences(
					tx,
					row.id,
				);
				const mediaReferenceProjectionFindingCount =
					await auditRuntimeMediaReferenceProjection(tx, {
						appId: row.id,
						projectId: carriers.projectId,
						doc,
					});
				const audit = auditRuntimeProbeParsedBlueprint({
					doc,
					appName: blueprint.appName,
					projectId: carriers.projectId,
					lookupContext,
					storedProjectLookupReferences: storedTargets,
					mediaReferenceProjectionFindingCount,
				});
				if (audit.gateFindingCount === 0) gateCleanAppIds.add(row.id);
				audits.push(audit);
				digest.update(
					canonicalJson([
						row.id,
						mutationSeq,
						carriers.projectId,
						blueprint,
						audit.gateFindingCount,
						audit.localReferenceIndexFindingCount,
						audit.projectReferenceIndexFindingCount,
						audit.mediaReferenceProjectionFindingCount,
					]),
				);
			}

			const candidates = await sql<RuntimeProbeCandidateRow>`
				SELECT
					app.id AS app_id,
					app.project_id AS project_id,
					member."userId" AS user_id,
					member.role
				FROM apps AS app
				JOIN auth_member AS member
					ON member."organizationId" = app.project_id
				WHERE app.deleted_at IS NULL
				ORDER BY app.id, member."userId"
			`.execute(tx);
			const candidate = chooseRuntimeProbeCandidate(
				candidates.rows.filter((row) => gateCleanAppIds.has(row.app_id)),
			);
			const role = await projectRoleForInTransaction(
				tx,
				candidate.user_id,
				candidate.project_id,
			);
			if (role === null || !roleAllowsApp(role, "edit")) {
				throw new Error(
					"The runtime database probe candidate lost edit authority.",
				);
			}
			const app = await loadAppInTransaction(tx, candidate.app_id);
			if (app === null || app.project_id !== candidate.project_id) {
				throw new Error(
					"The runtime database probe candidate app changed tenancy.",
				);
			}

			const write = await commitGuardedBatchInTransaction(tx, {
				appId: candidate.app_id,
				expectedProjectId: candidate.project_id,
				batchId,
				mutations: admitMutationBatch([
					{ kind: "setAppName", name: `Runtime probe ${batchId}` },
				]),
				actorUserId: candidate.user_id,
				kind: "autosave",
			});
			if (write.deduped || write.seq !== app.mutation_seq + 1) {
				throw new Error(
					"The runtime database probe did not exercise one fresh guarded write.",
				);
			}
			const streamRows = await readAppChangeStreamRowsSince(
				tx,
				candidate.app_id,
				app.mutation_seq,
			);
			const streamRow = streamRows[0];
			if (
				streamRows.length !== 1 ||
				streamRow === undefined ||
				(streamRow.seq !== write.seq && streamRow.seq !== String(write.seq)) ||
				streamRow.baseline_seq !== null
			) {
				throw new Error(
					"The runtime database probe did not read exactly its fresh app-change stream row.",
				);
			}

			const summary = summarizeRuntimeProbeAppAudits(appRows.length, audits);
			report = {
				...summary,
				snapshotDigest: digest.digest("hex"),
				rollbackVerified: true,
				candidateAppId: candidate.app_id,
				candidateBaseSeq: app.mutation_seq,
			};
			throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	}

	if (report === undefined) {
		throw new Error("The runtime database probe did not reach its rollback.");
	}
	const verification = await sql<RuntimeProbeRollbackVerificationRow>`
		SELECT
			app.mutation_seq,
			(
				SELECT count(*)
				FROM app_changes
				WHERE app_id = ${report.candidateAppId}
					AND batch_id = ${batchId}
			) AS probe_rows
		FROM apps AS app
		WHERE app.id = ${report.candidateAppId}
	`.execute(db);
	const row = verification.rows[0];
	if (
		row === undefined ||
		safePersistedSequence(
			row.mutation_seq,
			`apps.mutation_seq for app ${report.candidateAppId}`,
		) !== report.candidateBaseSeq ||
		Number(row.probe_rows) !== 0
	) {
		throw new Error(
			"The runtime database probe rollback left a mutation sequence or stream row behind.",
		);
	}

	const publicReport: CanonicalRuntimeDatabaseProbeReport = {
		scannedAppCount: report.scannedAppCount,
		parsedAppCount: report.parsedAppCount,
		parserFindingCount: report.parserFindingCount,
		gateFindingCount: report.gateFindingCount,
		localReferenceIndexFindingCount: report.localReferenceIndexFindingCount,
		projectReferenceIndexFindingCount: report.projectReferenceIndexFindingCount,
		mediaReferenceProjectionFindingCount:
			report.mediaReferenceProjectionFindingCount,
		findingCount: report.findingCount,
		snapshotDigest: report.snapshotDigest,
		rollbackVerified: true,
	};
	if (publicReport.findingCount > 0) {
		throw new CanonicalRuntimeDatabaseProbeFindingsError(publicReport);
	}
	return publicReport;
}
