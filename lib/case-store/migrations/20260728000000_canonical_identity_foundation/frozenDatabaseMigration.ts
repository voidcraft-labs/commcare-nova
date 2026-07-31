/**
 * Frozen database cutover for canonical authored identity.
 *
 * This module intentionally depends only on the timestamped migration's frozen
 * inventory and pure transform. It does not import the live domain schemas,
 * reducer, or persistence assembler: a later product edit must not change what
 * this historical migration does when a fresh database replays the ledger.
 */

import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import {
	captureFrozenCutoverCatalogEvidence,
	captureFrozenCutoverLeaseState,
	classifyFrozenMigrationCutoverState,
	createFrozenCutoverPlan,
	type FrozenCutoverAppDisposition,
	type FrozenCutoverCatalogEvidence,
	type FrozenCutoverLeaseState,
	type FrozenCutoverLookupContextEvidence,
	type FrozenCutoverPlan,
	frozenRawCarrierEvidence,
	reviewedFrozenCapacity,
} from "./frozenCutoverPlan";
import {
	type FrozenVerifiedJson,
	frozenJsonSourceBytes,
	verifyFrozenJsonCarriers,
} from "./frozenJsonCarriers";
import { readFrozenProjectLookupContext } from "./frozenLookupContext";
import {
	captureFrozenStorageSnapshot,
	compareFrozenStorageOccurrences,
	dispatchFrozenStorageOccurrences,
	type FrozenStorageSnapshot,
	frozenExactTextSequenceDigest,
	frozenThreadAttachmentInventory,
	parseFrozenExactJson,
	resolveFrozenCasesSchema,
} from "./frozenOccurrenceDispatcher";
import { FROZEN_ENTITY_OCCURRENCES } from "./frozenOccurrenceManifest";
import {
	decodeFrozenStoredApp,
	materializeFrozenBlueprintJson,
} from "./frozenPersistableBlueprintDecoder";
import {
	type FrozenCanonicalAppChangeSuffixRow,
	type FrozenLookupValidationContext,
	replayFrozenCanonicalAppChangeSuffix,
} from "./frozenPersistableBlueprintValidator.generated.mjs";
import {
	classifyFrozenObservedCatalogLifecycle,
	FROZEN_FOLD_FAMILY_OBJECT_KEYS,
	FROZEN_RELATION_CANDIDATE_PHYSICAL_RELATIONS,
} from "./frozenRelationLifecycle";
import {
	CANONICAL_IDENTITY_MIGRATION_VERSION,
	type CanonicalAppPlan,
	canonicalIdentityDigest,
	isCanonicalAuthoredUuid,
	type LegacyAppSnapshot,
	type LegacyEntityKind,
	type LegacyEntityRow,
	legacyOptionUuidV5,
	planCanonicalAppMigration,
	rewriteFrozenCaseTypeSchema,
	scanLookupIdentities,
} from "./frozenTransform";

const HORIZON_BATCH_ID = "fold-baseline:canonical-identity-foundation";
const HORIZON_ACTOR_ID = "system:canonical-identity-foundation";

/**
 * The production advisory scan is far below these limits. They are a hard stop,
 * not a sizing guess: a larger quiescent database must be rehearsed and these
 * reviewed bounds changed before a 1,020-second migration Job is allowed to
 * begin its rewrite.
 */
const MAX_APP_COUNT = 10_000;
const MAX_ENTITY_COUNT = 1_000_000;
const MAX_REWRITE_BYTES = 512 * 1024 * 1024;

const FROZEN_STANDARD_INDEX_PROPERTY_NAMES = [
	"name",
	"date-opened",
	"external-id",
	"case_name",
	"date_opened",
	"external_id",
	"last_modified",
	"owner_id",
	"status",
	"case_id",
	"case_type",
] as const;
const FROZEN_PROPERTY_INDEX_MODES = [
	"fuzzy",
	"int",
	"num",
	"contains",
] as const;

function frozenIndexTag(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function frozenPropertyIndexName(
	appId: string,
	caseType: string,
	property: string,
	mode: (typeof FROZEN_PROPERTY_INDEX_MODES)[number],
): string {
	return `cases_${frozenIndexTag(`${appId} ${caseType}`)}_${frozenIndexTag(property)}_${mode}`;
}

interface FrozenGeneratedIndexRow {
	readonly schema_name: string;
	readonly index_name: string;
	readonly definition: string;
	readonly is_valid: boolean;
}

function frozenStandardPropertyIndexTargets(
	scopes: readonly { readonly app_id: string; readonly case_type: string }[],
): ReadonlyMap<
	string,
	{
		readonly appId: string;
		readonly caseType: string;
		readonly property: string;
	}
> {
	const targetByName = new Map<
		string,
		{
			readonly appId: string;
			readonly caseType: string;
			readonly property: string;
		}
	>();
	for (const scope of scopes) {
		for (const property of FROZEN_STANDARD_INDEX_PROPERTY_NAMES) {
			for (const mode of FROZEN_PROPERTY_INDEX_MODES) {
				const name = frozenPropertyIndexName(
					scope.app_id,
					scope.case_type,
					property,
					mode,
				);
				const prior = targetByName.get(name);
				requireInvariant(
					prior === undefined ||
						(prior.appId === scope.app_id &&
							prior.caseType === scope.case_type &&
							prior.property === property),
					"frozen standard-property index target collision",
				);
				targetByName.set(name, {
					appId: scope.app_id,
					caseType: scope.case_type,
					property,
				});
			}
		}
	}
	return targetByName;
}

async function findFrozenStandardPropertyIndexes(
	db: Kysely<unknown>,
	scopes: readonly { readonly app_id: string; readonly case_type: string }[],
): Promise<readonly FrozenGeneratedIndexRow[]> {
	const casesSchema = await resolveFrozenCasesSchema(db);
	const targetByName = frozenStandardPropertyIndexTargets(scopes);
	if (targetByName.size === 0) return [];
	const found = await sql<FrozenGeneratedIndexRow>`
		SELECT
			index_namespace.nspname AS schema_name,
			index_relation.relname AS index_name,
			pg_get_indexdef(index_relation.oid) AS definition,
			index_catalog.indisvalid AS is_valid
		FROM pg_index AS index_catalog
		JOIN pg_class AS index_relation
		  ON index_relation.oid = index_catalog.indexrelid
		JOIN pg_namespace AS index_namespace
		  ON index_namespace.oid = index_relation.relnamespace
		JOIN pg_class AS table_relation
		  ON table_relation.oid = index_catalog.indrelid
		JOIN pg_namespace AS table_namespace
		  ON table_namespace.oid = table_relation.relnamespace
		WHERE table_relation.relname = 'cases'
		  AND table_namespace.nspname = ${casesSchema}
		  AND index_relation.relname = ANY(${[...targetByName.keys()]})
		ORDER BY index_namespace.nspname, index_relation.relname
	`.execute(db);
	for (const row of found.rows) {
		const target = targetByName.get(row.index_name);
		requireInvariant(
			target !== undefined && row.definition.includes(`'${target.property}'`),
			`generated index ${row.index_name} does not prove its exact standard-property target`,
		);
	}
	return found.rows;
}

async function dropFrozenStandardPropertyIndexes(
	db: Kysely<unknown>,
	scopes: readonly { readonly app_id: string; readonly case_type: string }[],
): Promise<ReadonlySet<string>> {
	const found = await findFrozenStandardPropertyIndexes(db, scopes);
	const dropped = new Set<string>();
	for (const row of found) {
		await sql`DROP INDEX ${sql.id(row.schema_name, row.index_name)}`.execute(
			db,
		);
		dropped.add(`${row.schema_name}\u0000${row.index_name}`);
	}
	const survivors = await findFrozenStandardPropertyIndexes(db, scopes);
	requireInvariant(
		survivors.length === 0,
		"one or more generated standard-property indexes survived deletion",
	);
	return dropped;
}

async function assertNoFrozenStandardPropertyIndexes(
	db: Kysely<unknown>,
): Promise<void> {
	const scopes = await sql<{ app_id: string; case_type: string }>`
		SELECT app_id, case_type
		FROM case_type_schemas
		ORDER BY app_id, case_type
	`.execute(db);
	requireInvariant(
		(await findFrozenStandardPropertyIndexes(db, scopes.rows)).length === 0,
		"the applied state retains a generated standard-property index",
	);
}

function assertFrozenGeneratedIndexResult(
	source: FrozenStorageSnapshot,
	result: FrozenStorageSnapshot,
	dropped: ReadonlySet<string>,
): void {
	const sourceRows = (source.__case_property_indexes?.rows ??
		[]) as readonly FrozenGeneratedIndexRow[];
	const resultRows = (result.__case_property_indexes?.rows ??
		[]) as readonly FrozenGeneratedIndexRow[];
	const expected = sourceRows.filter(
		(row) => !dropped.has(`${row.schema_name}\u0000${row.index_name}`),
	);
	requireInvariant(
		canonicalIdentityDigest(expected) === canonicalIdentityDigest(resultRows),
		"generated case-property indexes differ outside exact standard-property deletions",
	);
}

const SQL_IDENTITY_COLUMNS = [
	["apps", "logo"],
	["blueprint_entities", "uuid"],
	["blueprint_entities", "parent_uuid"],
	["media_assets", "id"],
	["media_upload_aliases", "attempt_asset_id"],
	["media_upload_aliases", "canonical_asset_id"],
	["media_asset_refs", "asset_id"],
	["form_submission_intents", "form_uuid"],
	["form_attachments", "field_uuid"],
] as const;

interface StoredAppRow {
	id: string;
	owner: string;
	project_id: string;
	app_name: string;
	connect_type: string | null;
	case_types: unknown;
	logo: string | null;
	mutation_seq: string | number;
	status: string;
	lock_run_id: string | null;
	run_id: string | null;
}

interface StoredEntityRow {
	app_id: string;
	uuid: string;
	kind: string;
	parent_uuid: string | null;
	ordinal: number;
	data: Record<string, unknown>;
}

interface StoredAppTextRow extends Omit<StoredAppRow, "case_types"> {
	case_types_text: string | null;
}

interface StoredEntityTextRow extends Omit<StoredEntityRow, "data"> {
	data_text: string;
}

interface FrozenCurrentRows {
	readonly apps: readonly StoredAppRow[];
	readonly entities: readonly StoredEntityRow[];
	readonly appJson: ReadonlyMap<string, FrozenVerifiedJson>;
	readonly entityJson: ReadonlyMap<string, FrozenVerifiedJson>;
}

interface FrozenMigrationReport {
	readonly version: string;
	readonly alreadyApplied: boolean;
	readonly apps: number;
	readonly entities: number;
	readonly archivedMutationEvents: number;
	readonly rewriteBytes: number;
	readonly beforeDigest: string;
	readonly afterDigest: string;
	readonly occurrenceSourceDigest: string;
	readonly occurrenceResultDigest: string;
	readonly occurrencePlanDigest: string;
	readonly cutoverPlan: FrozenCutoverPlan;
}

export type FrozenMigrationFailureStage =
	| "canonical-properties"
	| "expressions"
	| "final-shape"
	| "date-post-submit"
	| "events"
	| "operational"
	| "horizon"
	| "ddl"
	| "media-index";

export interface FrozenMigrationOptions {
	/**
	 * Deterministic transaction-atomicity proof hook. Production callers omit
	 * it; integration tests exercise a real late throw after each write stage.
	 */
	readonly failAfterStage?: FrozenMigrationFailureStage;
}

function injectReviewedFailure(
	options: FrozenMigrationOptions,
	stage: FrozenMigrationFailureStage,
): void {
	if (options.failAfterStage === stage) {
		throw new Error(
			`Injected canonical identity migration failure after ${stage}.`,
		);
	}
}

interface FrozenSqlConstraint {
	readonly schema_name: string;
	readonly table_name: string;
	readonly constraint_name: string;
	readonly constraint_type: string;
	readonly definition: string;
	readonly deferrable: boolean;
	readonly initially_deferred: boolean;
	readonly validated: boolean;
	readonly local: boolean;
	readonly touches_target: boolean;
	readonly columns: readonly string[];
	readonly referenced_schema: string | null;
	readonly referenced_table: string | null;
	readonly referenced_columns: readonly string[];
}

interface FrozenSqlIdentitySchema {
	readonly columns: readonly Record<string, unknown>[];
	readonly constraints: readonly FrozenSqlConstraint[];
	readonly indexes: readonly Record<string, unknown>[];
	readonly triggers: readonly Record<string, unknown>[];
	readonly dependency_edges: readonly Record<string, unknown>[];
}

const FROZEN_TEXT_SQL_IDENTITY_STRUCTURAL_DIGEST =
	"f54c9ebd8c38b17082c868d265bd878322ddb6468a09188e53d64063e8017b03";
const FROZEN_UUID_SQL_IDENTITY_CONVERSION_DIGEST =
	"feaae4f6007c3c1f3ed5cdb71ebffaf214867760bf6d98ef41264c883ebac1e0";
const FROZEN_UUID_SQL_IDENTITY_STRUCTURAL_DIGEST =
	"3bb842078df6a916496cd8517720c85e985c7be40a4e0d71d32f11bf2acad4a6";

function frozenSqlIdentityStructuralSchema(
	schema: FrozenSqlIdentitySchema,
): FrozenSqlIdentitySchema {
	return {
		columns: schema.columns.map(
			({
				table_owner: _tableOwner,
				table_acl: _tableAcl,
				column_acl: _columnAcl,
				...column
			}) => column,
		),
		constraints: schema.constraints,
		indexes: schema.indexes.map(({ owner: _owner, ...index }) => index),
		triggers: schema.triggers.map(
			({
				function_owner: _functionOwner,
				function_acl: _functionAcl,
				...trigger
			}) => trigger,
		),
		dependency_edges: schema.dependency_edges,
	};
}

type FrozenJsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredCarrier(
	carriers: ReadonlyMap<string, FrozenVerifiedJson>,
	id: string,
): FrozenVerifiedJson {
	const carrier = carriers.get(id);
	if (carrier === undefined) {
		throw new Error(
			`Frozen JSON carrier ${id} disappeared after verification.`,
		);
	}
	return carrier;
}

function materializeRequiredJson<T>(
	carrier: FrozenVerifiedJson,
	family: string,
): T | null {
	const contextId = `${family}:${carrier.sourceDigest}`;
	if (!/^[a-z][a-z0-9_-]{0,31}:[0-9a-f]{64}$/.test(contextId)) {
		throw new Error(
			`Canonical identity migration constructed an invalid frozen context ${JSON.stringify(contextId)}.`,
		);
	}
	const materialized = materializeFrozenBlueprintJson<T>(carrier, {
		id: contextId,
	});
	return materialized.kind === "sql-null" ? null : materialized.value;
}

function materializeNonNullJson<T>(
	carrier: FrozenVerifiedJson,
	family: string,
): T {
	const value = materializeRequiredJson<T>(carrier, family);
	if (value === null) {
		throw new Error(
			`Canonical identity migration blocked: ${family} carrier is SQL NULL.`,
		);
	}
	return value;
}

async function assertCompleteFrozenPlans(
	db: Kysely<unknown>,
	apps: readonly StoredAppRow[],
	plans: readonly CanonicalAppPlan[],
): Promise<void> {
	const appById = new Map(apps.map((app) => [app.id, app] as const));
	const lookupContextByProject = new Map<
		string,
		FrozenLookupValidationContext
	>();
	const candidates = plans.flatMap((plan) => [
		{
			id: `planned_app.case_types:${canonicalIdentityDigest(plan.appId)}`,
			candidate_text:
				plan.caseTypes === null ? null : JSON.stringify(plan.caseTypes),
		},
		...plan.rows.map((row) => ({
			id: `planned_entity.data:${canonicalIdentityDigest([
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
			`.execute(db)
		: { rows: [] };
	const verified = await verifyFrozenJsonCarriers(
		db,
		canonical.rows.map((row) => ({
			id: row.id,
			sourceText: row.source_text,
		})),
	);
	for (const plan of plans) {
		const app = appById.get(plan.appId);
		if (app === undefined) {
			throw new Error("Frozen complete decoder lost one planned app.");
		}
		let lookupContext = lookupContextByProject.get(app.project_id);
		if (lookupContext === undefined) {
			lookupContext = await readFrozenProjectLookupContext(db, app.project_id);
			lookupContextByProject.set(app.project_id, lookupContext);
		}
		decodeFrozenStoredApp(
			{
				id: app.id,
				appName: app.app_name,
				connectType: app.connect_type,
				caseTypes: requiredCarrier(
					verified,
					`planned_app.case_types:${canonicalIdentityDigest(plan.appId)}`,
				),
				logo: app.logo,
				mutationSeq: app.mutation_seq,
			},
			plan.rows.map((row) => ({
				appId: row.appId,
				uuid: row.uuid,
				kind: row.kind,
				parentUuid: row.parentUuid,
				ordinal: row.ordinal,
				data: requiredCarrier(
					verified,
					`planned_entity.data:${canonicalIdentityDigest([
						plan.appId,
						row.uuid,
					])}`,
				),
			})),
			lookupContext,
		);
	}
}

async function loadFrozenCurrentRows(
	db: Kysely<unknown>,
): Promise<FrozenCurrentRows> {
	const appResult = await sql<StoredAppTextRow>`
		SELECT id, owner, project_id, app_name, connect_type,
		       case_types::text AS case_types_text,
		       logo::text AS logo, mutation_seq, status, lock_run_id, run_id
		FROM apps
		ORDER BY convert_to(id, 'UTF8')
	`.execute(db);
	const entityResult = await sql<StoredEntityTextRow>`
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
	`.execute(db);
	const appEntries = appResult.rows.map((row, index) => ({
		id: `apps.case_types[${index}]`,
		sourceText: row.case_types_text,
	}));
	const entityEntries = entityResult.rows.map((row, index) => ({
		id: `blueprint_entities.data[${index}]`,
		sourceText: row.data_text,
	}));
	const verified = await verifyFrozenJsonCarriers(db, [
		...appEntries,
		...entityEntries,
	]);
	const appJson = new Map<string, FrozenVerifiedJson>();
	const entityJson = new Map<string, FrozenVerifiedJson>();
	const apps = appResult.rows.map((row, index): StoredAppRow => {
		const carrier = requiredCarrier(verified, appEntries[index]?.id ?? "");
		appJson.set(row.id, carrier);
		const { lock_run_id: lockRunId } = row;
		return {
			id: row.id,
			owner: row.owner,
			project_id: row.project_id,
			app_name: row.app_name,
			connect_type: row.connect_type,
			case_types: materializeRequiredJson(carrier, "legacy_app"),
			logo: row.logo,
			mutation_seq: row.mutation_seq,
			status: row.status,
			lock_run_id: lockRunId,
			run_id: row.run_id,
		};
	});
	const entities = entityResult.rows.map((row, index): StoredEntityRow => {
		const carrier = requiredCarrier(verified, entityEntries[index]?.id ?? "");
		entityJson.set(`${row.app_id}\u0000${row.uuid}`, carrier);
		return {
			app_id: row.app_id,
			uuid: row.uuid,
			kind: row.kind,
			parent_uuid: row.parent_uuid,
			ordinal: row.ordinal,
			data: materializeNonNullJson<Record<string, unknown>>(
				carrier,
				"legacy_entity",
			),
		};
	});
	return { apps, entities, appJson, entityJson };
}

function frozenMigrationRowsForApp(
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

async function createFrozenMigrationCutoverPlan(input: {
	readonly tx: Kysely<unknown>;
	readonly state: "pristine" | "applied";
	readonly currentRows: FrozenCurrentRows;
	readonly plans: readonly CanonicalAppPlan[];
	readonly rawSource: FrozenStorageSnapshot;
	readonly lockRelations: readonly string[];
	readonly leaseState: FrozenCutoverLeaseState;
	readonly catalog: FrozenCutoverCatalogEvidence;
	readonly baselineRows: readonly {
		readonly app_id: string;
		readonly seq: string;
		readonly snapshot_digest: string;
	}[];
	readonly rewriteBytes: string;
}): Promise<FrozenCutoverPlan> {
	const planByApp = new Map(
		input.plans.map((plan) => [plan.appId, plan] as const),
	);
	const lookupContexts = new Map<string, FrozenCutoverLookupContextEvidence>();
	const apps: FrozenCutoverAppDisposition[] = [];
	const findings: Array<{
		carrierId: string;
		code: string;
		pathDigest: string;
		contentDigest: string;
	}> = [];
	for (const app of input.currentRows.apps) {
		const plan = planByApp.get(app.id);
		requireInvariant(
			plan !== undefined,
			"the frozen CutoverPlan lost one app candidate",
		);
		const lookupContext = await readFrozenProjectLookupContext(
			input.tx,
			app.project_id,
		);
		const projectDigest = canonicalIdentityDigest(app.project_id);
		lookupContexts.set(projectDigest, {
			projectDigest,
			tableCount: lookupContext.definitions.length.toString(),
			columnCount: lookupContext.definitions
				.reduce(
					(total, definition) => total + BigInt(definition.columns.length),
					BigInt(0),
				)
				.toString(),
			contextDigest: canonicalIdentityDigest(lookupContext),
		});
		const appDigest = canonicalIdentityDigest(app.id);
		for (const finding of plan.findings) {
			findings.push({
				carrierId: `app:${appDigest}`,
				code: finding.code,
				pathDigest: canonicalIdentityDigest(finding.path),
				contentDigest: finding.digest,
			});
		}
		apps.push({
			appDigest,
			projectDigest,
			sourceDigest: plan.beforeDigest,
			canonicalDigest: plan.afterDigest,
			sequence: String(app.mutation_seq),
			disposition:
				input.state === "applied"
					? "already-applied"
					: plan.beforeDigest === plan.afterDigest
						? "preserve"
						: "rewrite",
			lookupContextDigest: canonicalIdentityDigest(lookupContext),
			referenceIndexDigest: canonicalIdentityDigest({
				media: frozenExactTextSequenceDigest(
					frozenMigrationRowsForApp(
						input.rawSource,
						"media_asset_refs",
						app.id,
					),
				),
				tables: frozenExactTextSequenceDigest(
					frozenMigrationRowsForApp(
						input.rawSource,
						"lookup_table_references",
						app.id,
					),
				),
				columns: frozenExactTextSequenceDigest(
					frozenMigrationRowsForApp(
						input.rawSource,
						"lookup_column_references",
						app.id,
					),
				),
			}),
			schemaDefinitionDigest: frozenExactTextSequenceDigest(
				frozenMigrationRowsForApp(input.rawSource, "case_type_schemas", app.id),
			),
			findingsDigest: canonicalIdentityDigest(plan.findings),
		});
	}
	const rawCarriers = frozenRawCarrierEvidence(input.rawSource);
	const byTable = new Map(
		rawCarriers.map((carrier) => [carrier.table, carrier]),
	);
	return createFrozenCutoverPlan({
		mode: "migration",
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
		schemaDefinitionDigest: input.catalog.schemaDefinitionDigest,
		baselineCatalogDigest: canonicalIdentityDigest(
			input.baselineRows.map((row) => ({
				app: canonicalIdentityDigest(row.app_id),
				seq: row.seq,
				snapshotDigest: row.snapshot_digest,
			})),
		),
		dependencyCatalogDigest: input.catalog.dependencyCatalogDigest,
		relationAndIndexAclDigest: input.catalog.relationAndIndexAclDigest,
		functionCatalogDigest: input.catalog.functionCatalogDigest,
		capacity: reviewedFrozenCapacity({
			apps: input.currentRows.apps.length.toString(),
			entities: input.currentRows.entities.length.toString(),
			sourceBytes: rawCarriers.map((carrier) => carrier.bytes),
			rewriteBytes: input.rewriteBytes,
		}),
		findings,
	});
}

const FLAT_COLLECTIONS = [
	["user_property", "userProperties", "userPropertyOrder"],
	["user_type", "userTypes", "userTypeOrder"],
	["persona", "personas", "personaOrder"],
] as const;

function recordFromPairs(
	pairs: Iterable<readonly [string, unknown]>,
): FrozenJsonRecord {
	return Object.fromEntries(pairs);
}

function frozenDeclaredPathValues(
	value: unknown,
	segments: readonly string[],
): readonly unknown[] {
	if (segments.length === 0) return [value];
	const [segment, ...tail] = segments;
	if (
		segment === undefined ||
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return [];
	}
	const array = segment.endsWith("[]");
	const key = array ? segment.slice(0, -2) : segment;
	if (!Object.hasOwn(value, key)) return [];
	const child = (value as Record<string, unknown>)[key];
	if (!array) return frozenDeclaredPathValues(child, tail);
	if (!Array.isArray(child)) return [];
	return child.flatMap((entry) => frozenDeclaredPathValues(entry, tail));
}

export interface FrozenMediaReferenceEdge {
	readonly project_id: string;
	readonly app_id: string;
	readonly asset_id: string;
}

type FrozenAuthoredMediaKind = "image" | "audio" | "video";

interface FrozenAuthoredBlueprintMediaReference
	extends FrozenMediaReferenceEdge {
	readonly expected_kind: FrozenAuthoredMediaKind;
}

interface FrozenStoredMediaIdentity {
	readonly id: string;
	readonly project_id: string;
	readonly status: string;
	readonly kind: string;
}

const FROZEN_MEDIA_BUNDLE_KINDS = ["image", "audio", "video"] as const;
const FROZEN_MEDIA_BUNDLE_KIND_SET = new Set<string>(FROZEN_MEDIA_BUNDLE_KINDS);

function frozenMediaCarrierKind(
	occurrence: (typeof FROZEN_ENTITY_OCCURRENCES)[number],
): FrozenAuthoredMediaKind | "bundle" {
	if (
		occurrence.path === "optionsSource.options[].media" ||
		occurrence.path.endsWith("_media")
	) {
		return "bundle";
	}
	if (occurrence.path.endsWith("audioLabel")) return "audio";
	if (occurrence.path.endsWith("icon") || occurrence.path.endsWith("assetId")) {
		return "image";
	}
	throw new Error(`Unclassified frozen media carrier ${occurrence.id}.`);
}

function frozenAuthoredBlueprintMediaReferences(
	apps: readonly {
		readonly id: string;
		readonly project_id: string;
		readonly logo: unknown;
	}[],
	plans: readonly CanonicalAppPlan[],
): FrozenAuthoredBlueprintMediaReference[] {
	const appById = new Map(apps.map((app) => [app.id, app] as const));
	const byKey = new Map<string, FrozenAuthoredBlueprintMediaReference>();
	const kindByAssetId = new Map<string, FrozenAuthoredMediaKind>();
	const add = (
		app: (typeof apps)[number],
		assetId: unknown,
		expectedKind: FrozenAuthoredMediaKind,
		path: string,
	): void => {
		requireInvariant(
			typeof assetId === "string" && isCanonicalAuthoredUuid(assetId),
			`media carrier ${canonicalIdentityDigest(path)} is not one canonical uploaded-media identity`,
		);
		const priorKind = kindByAssetId.get(assetId);
		requireInvariant(
			priorKind === undefined || priorKind === expectedKind,
			`uploaded-media identity ${canonicalIdentityDigest(assetId)} is authored in conflicting ${priorKind}/${expectedKind} slots`,
		);
		kindByAssetId.set(assetId, expectedKind);
		const reference = {
			project_id: app.project_id,
			app_id: app.id,
			asset_id: assetId,
			expected_kind: expectedKind,
		};
		byKey.set(
			`${reference.project_id}\u0000${reference.app_id}\u0000${reference.asset_id}`,
			reference,
		);
	};
	for (const plan of plans) {
		const app = appById.get(plan.appId);
		requireInvariant(
			app !== undefined &&
				typeof app.project_id === "string" &&
				app.project_id.trim().length > 0,
			`media-reference app ${canonicalIdentityDigest(plan.appId)} has no Project`,
		);
		if (app.logo !== null && app.logo !== undefined) {
			add(app, app.logo, "image", `apps.${plan.appId}.logo`);
		}
		for (const row of plan.rows) {
			for (const occurrence of FROZEN_ENTITY_OCCURRENCES) {
				if (occurrence.entity !== row.kind || occurrence.surface !== "media") {
					continue;
				}
				for (const value of frozenDeclaredPathValues(
					row.data,
					occurrence.path.split("."),
				)) {
					const carrierKind = frozenMediaCarrierKind(occurrence);
					const path = `${row.kind}.${row.uuid}.${occurrence.path}`;
					if (carrierKind === "bundle") {
						requireInvariant(
							value !== null &&
								typeof value === "object" &&
								!Array.isArray(value),
							`media bundle ${canonicalIdentityDigest(path)} is not one exact object`,
						);
						const bundle = value as Record<string, unknown>;
						requireInvariant(
							Object.keys(bundle).every((key) =>
								FROZEN_MEDIA_BUNDLE_KIND_SET.has(key),
							),
							`media bundle ${canonicalIdentityDigest(path)} has an unknown slot`,
						);
						for (const expectedKind of FROZEN_MEDIA_BUNDLE_KINDS) {
							if (!Object.hasOwn(bundle, expectedKind)) continue;
							add(
								app,
								bundle[expectedKind],
								expectedKind,
								`${path}.${expectedKind}`,
							);
						}
						continue;
					}
					if (
						carrierKind === "image" &&
						typeof value === "string" &&
						!isCanonicalAuthoredUuid(value)
					) {
						// The frozen complete-Blueprint validator has already proved
						// this is a catalog-closed built-in menu icon. Built-ins have
						// no media_assets row and therefore no reverse-index edge.
						continue;
					}
					add(app, value, carrierKind, path);
				}
			}
		}
	}
	return [...byKey.values()].sort(
		(left, right) =>
			Buffer.compare(
				Buffer.from(left.project_id, "utf8"),
				Buffer.from(right.project_id, "utf8"),
			) ||
			Buffer.compare(
				Buffer.from(left.app_id, "utf8"),
				Buffer.from(right.app_id, "utf8"),
			) ||
			Buffer.compare(
				Buffer.from(left.asset_id, "utf8"),
				Buffer.from(right.asset_id, "utf8"),
			) ||
			Buffer.compare(
				Buffer.from(left.expected_kind, "utf8"),
				Buffer.from(right.expected_kind, "utf8"),
			),
	);
}

export function frozenBlueprintMediaReferenceEdges(
	apps: readonly {
		readonly id: string;
		readonly project_id: string;
		readonly logo: unknown;
	}[],
	plans: readonly CanonicalAppPlan[],
	mediaRows: readonly FrozenStoredMediaIdentity[],
): readonly FrozenMediaReferenceEdge[] {
	const mediaById = new Map(mediaRows.map((row) => [row.id, row] as const));
	return frozenAuthoredBlueprintMediaReferences(apps, plans).map(
		({ expected_kind: expectedKind, ...edge }) => {
			const asset = mediaById.get(edge.asset_id);
			requireInvariant(
				asset?.project_id === edge.project_id &&
					asset.status === "ready" &&
					asset.kind === expectedKind,
				`blueprint media reference ${canonicalIdentityDigest({
					...edge,
					expectedKind,
				})} is not one ready same-Project uploaded-media reference of the exact authored slot kind`,
			);
			return edge;
		},
	);
}

export function frozenPersistableSnapshot(
	app: Pick<
		StoredAppRow,
		"id" | "app_name" | "connect_type" | "case_types" | "logo"
	>,
	plan: CanonicalAppPlan,
): FrozenJsonRecord {
	const byOrdinal = (left: LegacyEntityRow, right: LegacyEntityRow) =>
		left.ordinal - right.ordinal ||
		Buffer.compare(
			Buffer.from(left.uuid, "utf8"),
			Buffer.from(right.uuid, "utf8"),
		);
	const modules = plan.rows
		.filter((row) => row.kind === "module")
		.sort(byOrdinal);
	const forms = plan.rows.filter((row) => row.kind === "form");
	const fields = plan.rows.filter((row) => row.kind === "field");

	const moduleRecord = recordFromPairs(
		modules.map((row) => [row.uuid, row.data] as const),
	);
	const formRecord = recordFromPairs(
		forms.map((row) => [row.uuid, row.data] as const),
	);
	const fieldRecord = recordFromPairs(
		fields.map((row) => [row.uuid, row.data] as const),
	);
	const formOrder: FrozenJsonRecord = {};
	for (const module of modules) {
		formOrder[module.uuid] = forms
			.filter((row) => row.parentUuid === module.uuid)
			.sort(byOrdinal)
			.map((row) => row.uuid);
	}
	const fieldOrder: FrozenJsonRecord = {};
	for (const parent of [
		...forms,
		...fields.filter(
			(row) => row.data.kind === "group" || row.data.kind === "repeat",
		),
	]) {
		fieldOrder[parent.uuid] = fields
			.filter((row) => row.parentUuid === parent.uuid)
			.sort(byOrdinal)
			.map((row) => row.uuid);
	}

	const snapshot: FrozenJsonRecord = {
		appId: app.id,
		appName: app.app_name,
		connectType: app.connect_type,
		caseTypes: plan.caseTypes,
		modules: moduleRecord,
		forms: formRecord,
		fields: fieldRecord,
		moduleOrder: modules.map((row) => row.uuid),
		formOrder,
		fieldOrder,
	};
	if (app.logo !== null) snapshot.logo = app.logo;
	for (const [kind, recordSlot, orderSlot] of FLAT_COLLECTIONS) {
		const rows = plan.rows.filter((row) => row.kind === kind).sort(byOrdinal);
		if (rows.length === 0) continue;
		snapshot[recordSlot] = recordFromPairs(
			rows.map((row) => [row.uuid, row.data] as const),
		);
		snapshot[orderSlot] = rows.map((row) => row.uuid);
	}
	return snapshot;
}

interface FrozenFoldBaselineColumn {
	readonly column_name: string;
	readonly data_type: string;
	readonly not_null: boolean;
	readonly default_expression: string | null;
}

interface FrozenFoldBaselineConstraint {
	readonly constraint_name: string;
	readonly constraint_type: string;
	readonly definition: string;
	readonly deferrable: boolean;
	readonly initially_deferred: boolean;
	readonly validated: boolean;
	readonly columns: readonly string[];
	readonly referenced_schema: string | null;
	readonly referenced_table: string | null;
	readonly referenced_columns: readonly string[];
}

interface FrozenFoldBaselineIndex {
	readonly index_name: string;
	readonly definition: string;
	readonly primary: boolean;
	readonly unique: boolean;
	readonly valid: boolean;
	readonly ready: boolean;
	readonly owner_name: string;
	readonly acl: readonly unknown[];
}

interface FrozenFoldBaselineTrigger {
	readonly table_name: string;
	readonly trigger_name: string;
	readonly definition: string;
	readonly enabled: string;
	readonly function_name: string;
}

interface FrozenFoldBaselineRoutine {
	readonly name: string;
	readonly identity_arguments: string;
	readonly result_type: string;
	readonly language_name: string;
	readonly volatility: string;
	readonly strict: boolean;
	readonly security_definer: boolean;
	readonly leakproof: boolean;
	readonly parallel: string;
	readonly config: readonly string[];
	readonly owner_name: string;
	readonly acl: readonly {
		readonly grantor: string;
		readonly grantee: string;
		readonly privilege: string;
		readonly grantable: boolean;
	}[];
	readonly source_digest: string;
}

const FOLD_BASELINE_ROUTINE_NAMES = [
	"nova_app_change_fold_snapshot_digest",
	"nova_current_app_change_fold_snapshot",
	"nova_reject_app_change_fold_baseline_change",
	"nova_admit_app_change_fold_baseline_insert",
	"nova_require_app_change_fold_baseline",
	"nova_insert_app_change_genesis_fold_baseline",
	"nova_admit_app_change_insert",
	"nova_require_app_change_project_move_final",
	"nova_require_app_project_move_change",
] as const;

export async function readFrozenFoldFamilyObjectKeys(
	db: Kysely<unknown>,
): Promise<readonly string[]> {
	const result = await sql<{ object_key: string }>`
		SELECT object_key
		FROM (
			SELECT
				'relation:' || namespace.nspname || ':' || relation.relname
					AS object_key
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			WHERE relation.relname IN (
				'app_changes',
				'app_changes_pkey',
				'app_changes_app_id_batch_id_key',
				'app_change_fold_baselines',
				'app_change_fold_baselines_pkey'
			)

			UNION ALL

			SELECT
				'constraint:' || namespace.nspname || ':' || constraint_row.conname
					AS object_key
			FROM pg_constraint AS constraint_row
			JOIN pg_class AS relation
			  ON relation.oid = constraint_row.conrelid
			JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			WHERE constraint_row.conname IN (
				'app_changes_app_id_fkey',
				'app_changes_pkey',
				'app_changes_app_id_batch_id_key',
				'app_changes_project_move_scope_check',
				'app_change_fold_baselines_pkey',
				'app_change_fold_baselines_change_fkey',
				'app_change_fold_baselines_snapshot_digest_check',
				'app_change_fold_baselines_project_id_nonblank_check'
			)

			UNION ALL

			SELECT
				'trigger:' || namespace.nspname || ':' || trigger_row.tgname
					AS object_key
			FROM pg_trigger AS trigger_row
			JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
			JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			WHERE NOT trigger_row.tgisinternal
			  AND trigger_row.tgname IN (
					'app_change_fold_baselines_immutable',
					'app_change_fold_baselines_admit_insert',
					'app_changes_fold_baseline_required',
					'app_changes_admit_insert',
					'app_changes_project_move_final_required',
					'apps_project_move_app_change_required'
			  )

			UNION ALL

			SELECT
				'routine:' || namespace.nspname || ':' ||
				function_row.proname || '(' ||
				pg_get_function_identity_arguments(function_row.oid) || ')'
					AS object_key
			FROM pg_proc AS function_row
			JOIN pg_namespace AS namespace
			  ON namespace.oid = function_row.pronamespace
			WHERE function_row.proname = ANY(${FOLD_BASELINE_ROUTINE_NAMES})
		) AS named_object
		ORDER BY convert_to(object_key, 'UTF8')
	`.execute(db);
	return result.rows.map((row) => row.object_key);
}

export type FrozenFoldBaselineSecurityExpectation =
	| {
			readonly phase: "migration";
	  }
	| {
			readonly phase: "deployed";
			readonly migrationRole: string;
			readonly runtimeRole: string;
			readonly auditRole: string;
	  };

function sortFrozenAcl<
	T extends {
		readonly grantee: string;
		readonly privilege: string;
		readonly grantable: boolean;
	},
>(rows: readonly T[]): readonly T[] {
	return [...rows].sort(
		(left, right) =>
			Buffer.compare(
				Buffer.from(left.grantee, "utf8"),
				Buffer.from(right.grantee, "utf8"),
			) ||
			Buffer.compare(
				Buffer.from(left.privilege, "utf8"),
				Buffer.from(right.privilege, "utf8"),
			) ||
			Number(left.grantable) - Number(right.grantable),
	);
}

export async function assertFrozenFoldBaselineCatalog(
	db: Kysely<unknown>,
	security: FrozenFoldBaselineSecurityExpectation = { phase: "migration" },
): Promise<void> {
	const relation = await sql<{
		schema_name: string;
		relation_name: string;
		relation_kind: string;
		persistence: string;
		access_method: string;
		replica_identity: string;
		row_security: boolean;
		force_row_security: boolean;
		owner_name: string;
		acl: readonly {
			readonly grantor: string;
			readonly grantee: string;
			readonly privilege: string;
			readonly grantable: boolean;
		}[];
	}>`
		SELECT
			namespace.nspname AS schema_name,
			relation.relname AS relation_name,
			relation.relkind::text AS relation_kind,
			relation.relpersistence::text AS persistence,
			access_method.amname AS access_method,
			relation.relreplident::text AS replica_identity,
			relation.relrowsecurity AS row_security,
			relation.relforcerowsecurity AS force_row_security,
			pg_get_userbyid(relation.relowner) AS owner_name,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'grantor', pg_get_userbyid(privilege.grantor),
							'grantee',
								CASE
									WHEN privilege.grantee = 0 THEN 'PUBLIC'
									ELSE pg_get_userbyid(privilege.grantee)
								END,
							'privilege', privilege.privilege_type,
							'grantable', privilege.is_grantable
						)
						ORDER BY
							convert_to(
								CASE
									WHEN privilege.grantee = 0 THEN 'PUBLIC'
									ELSE pg_get_userbyid(privilege.grantee)
								END,
								'UTF8'
							),
							convert_to(privilege.privilege_type, 'UTF8'),
							privilege.is_grantable
					)
					FROM aclexplode(
						COALESCE(
							relation.relacl,
							acldefault('r', relation.relowner)
						)
					) AS privilege
				),
				'[]'::jsonb
			) AS acl
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_am AS access_method ON access_method.oid = relation.relam
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'app_change_fold_baselines'
	`.execute(db);
	const currentUser = (
		await sql<{ name: string }>`SELECT current_user AS name`.execute(db)
	).rows[0]?.name;
	requireInvariant(
		typeof currentUser === "string" && currentUser.length > 0,
		"current database owner identity is unavailable",
	);
	const expectedOwner =
		security.phase === "migration" ? currentUser : security.migrationRole;
	const ownerTableAcl = [
		"DELETE",
		"INSERT",
		"MAINTAIN",
		"REFERENCES",
		"SELECT",
		"TRIGGER",
		"TRUNCATE",
		"UPDATE",
	].map((privilege) => ({
		grantor: expectedOwner,
		grantee: expectedOwner,
		privilege,
		grantable: false,
	}));
	const expectedTableAcl = sortFrozenAcl([
		...ownerTableAcl,
		...(security.phase === "deployed"
			? [
					{
						grantor: expectedOwner,
						grantee: security.auditRole,
						privilege: "SELECT",
						grantable: false,
					},
					{
						grantor: expectedOwner,
						grantee: security.runtimeRole,
						privilege: "SELECT",
						grantable: false,
					},
				]
			: []),
	]);
	requireInvariant(
		canonicalIdentityDigest(relation.rows) ===
			canonicalIdentityDigest([
				{
					schema_name: "public",
					relation_name: "app_change_fold_baselines",
					relation_kind: "r",
					persistence: "p",
					access_method: "heap",
					replica_identity: "d",
					row_security: false,
					force_row_security: false,
					owner_name: expectedOwner,
					acl: expectedTableAcl,
				},
			]),
		"app_change_fold_baselines relation differs from the exact final catalog",
	);

	const columns = await sql<FrozenFoldBaselineColumn>`
		SELECT
			attribute.attname AS column_name,
			format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
			attribute.attnotnull AS not_null,
			pg_get_expr(default_value.adbin, default_value.adrelid)
				AS default_expression
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		JOIN pg_attribute AS attribute
		  ON attribute.attrelid = relation.oid
		 AND attribute.attnum > 0
		 AND NOT attribute.attisdropped
		LEFT JOIN pg_attrdef AS default_value
		  ON default_value.adrelid = relation.oid
		 AND default_value.adnum = attribute.attnum
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'app_change_fold_baselines'
		ORDER BY attribute.attnum
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(columns.rows) ===
			canonicalIdentityDigest([
				{
					column_name: "app_id",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "seq",
					data_type: "bigint",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "project_id",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "snapshot",
					data_type: "jsonb",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "snapshot_digest",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "created_at",
					data_type: "timestamp(3) with time zone",
					not_null: true,
					default_expression: "now()",
				},
			]),
		"app_change_fold_baselines columns differ from the exact final catalog",
	);

	const constraints = await sql<FrozenFoldBaselineConstraint>`
		SELECT
			constraint_row.conname AS constraint_name,
			constraint_row.contype::text AS constraint_type,
			pg_get_constraintdef(constraint_row.oid, false) AS definition,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.convalidated AS validated,
			to_jsonb(COALESCE(
				ARRAY(
					SELECT attribute.attname
					FROM unnest(COALESCE(constraint_row.conkey, '{}'::smallint[]))
						WITH ORDINALITY key(attnum, ordinal)
					JOIN pg_attribute AS attribute
					  ON attribute.attrelid = constraint_row.conrelid
					 AND attribute.attnum = key.attnum
					ORDER BY key.ordinal
				),
				'{}'::text[]
			)) AS columns,
			referenced_namespace.nspname AS referenced_schema,
			referenced_relation.relname AS referenced_table,
			to_jsonb(COALESCE(
				ARRAY(
					SELECT attribute.attname
					FROM unnest(COALESCE(constraint_row.confkey, '{}'::smallint[]))
						WITH ORDINALITY key(attnum, ordinal)
					JOIN pg_attribute AS attribute
					  ON attribute.attrelid = constraint_row.confrelid
					 AND attribute.attnum = key.attnum
					ORDER BY key.ordinal
				),
				'{}'::text[]
			)) AS referenced_columns
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		LEFT JOIN pg_class AS referenced_relation
		  ON referenced_relation.oid = constraint_row.confrelid
		LEFT JOIN pg_namespace AS referenced_namespace
		  ON referenced_namespace.oid = referenced_relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'app_change_fold_baselines'
		  -- PostgreSQL 18 mirrors column NOT NULL state into pg_constraint.
		  -- Column exactness is asserted above; this closure owns the three
		  -- table-level key/check constraints.
		  AND constraint_row.contype NOT IN ('n', 't')
		ORDER BY constraint_row.conname
	`.execute(db);
	requireInvariant(
		constraints.rows.length === 4,
		"app_change_fold_baselines must have exactly four constraints",
	);
	const constraintByName = new Map(
		constraints.rows.map((row) => [row.constraint_name, row] as const),
	);
	const primary = constraintByName.get("app_change_fold_baselines_pkey");
	requireInvariant(
		primary?.constraint_type === "p" &&
			primary.definition === "PRIMARY KEY (app_id, seq)" &&
			!primary.deferrable &&
			!primary.initially_deferred &&
			primary.validated &&
			canonicalIdentityDigest(primary.columns) ===
				canonicalIdentityDigest(["app_id", "seq"]) &&
			primary.referenced_table === null &&
			primary.referenced_schema === null &&
			primary.referenced_columns.length === 0,
		"app_change_fold_baselines primary key differs from the exact final catalog",
	);
	const foreign = constraintByName.get("app_change_fold_baselines_change_fkey");
	requireInvariant(
		foreign?.constraint_type === "f" &&
			foreign.definition ===
				"FOREIGN KEY (app_id, seq) REFERENCES app_changes(app_id, seq) ON DELETE CASCADE" &&
			!foreign.deferrable &&
			!foreign.initially_deferred &&
			foreign.validated &&
			canonicalIdentityDigest(foreign.columns) ===
				canonicalIdentityDigest(["app_id", "seq"]) &&
			foreign.referenced_schema === "public" &&
			foreign.referenced_table === "app_changes" &&
			canonicalIdentityDigest(foreign.referenced_columns) ===
				canonicalIdentityDigest(["app_id", "seq"]),
		"app_change_fold_baselines foreign key differs from the exact final catalog",
	);
	const digestCheck = constraintByName.get(
		"app_change_fold_baselines_snapshot_digest_check",
	);
	requireInvariant(
		digestCheck?.constraint_type === "c" &&
			digestCheck.definition ===
				"CHECK ((snapshot_digest ~ '^[0-9a-f]{64}$'::text))" &&
			!digestCheck.deferrable &&
			!digestCheck.initially_deferred &&
			digestCheck.validated &&
			digestCheck.columns.length === 1 &&
			digestCheck.columns[0] === "snapshot_digest" &&
			digestCheck.referenced_schema === null &&
			digestCheck.referenced_table === null &&
			digestCheck.referenced_columns.length === 0,
		"app_change_fold_baselines digest check differs from the exact final catalog",
	);
	const projectCheck = constraintByName.get(
		"app_change_fold_baselines_project_id_nonblank_check",
	);
	requireInvariant(
		projectCheck?.constraint_type === "c" &&
			projectCheck.definition === "CHECK ((btrim(project_id) <> ''::text))" &&
			!projectCheck.deferrable &&
			!projectCheck.initially_deferred &&
			projectCheck.validated &&
			projectCheck.columns.length === 1 &&
			projectCheck.columns[0] === "project_id" &&
			projectCheck.referenced_schema === null &&
			projectCheck.referenced_table === null &&
			projectCheck.referenced_columns.length === 0,
		"app_change_fold_baselines Project check differs from the exact final catalog",
	);

	const indexes = await sql<FrozenFoldBaselineIndex>`
		SELECT
			index_relation.relname AS index_name,
			pg_get_indexdef(index_relation.oid, 0, false) AS definition,
			index_row.indisprimary AS primary,
			index_row.indisunique AS unique,
			index_row.indisvalid AS valid,
			index_row.indisready AS ready,
			pg_get_userbyid(index_relation.relowner) AS owner_name,
			COALESCE(to_jsonb(index_relation.relacl), '[]'::jsonb) AS acl
		FROM pg_index AS index_row
		JOIN pg_class AS relation ON relation.oid = index_row.indrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'app_change_fold_baselines'
		ORDER BY index_relation.relname
	`.execute(db);
	requireInvariant(
		indexes.rows.length === 1 &&
			indexes.rows[0]?.index_name === "app_change_fold_baselines_pkey" &&
			indexes.rows[0]?.definition ===
				"CREATE UNIQUE INDEX app_change_fold_baselines_pkey ON public.app_change_fold_baselines USING btree (app_id, seq)" &&
			indexes.rows[0]?.primary === true &&
			indexes.rows[0]?.unique === true &&
			indexes.rows[0]?.valid === true &&
			indexes.rows[0]?.ready === true &&
			indexes.rows[0]?.owner_name === expectedOwner &&
			indexes.rows[0]?.acl.length === 0,
		"app_change_fold_baselines indexes differ from the exact final catalog",
	);

	const changeColumns = await sql<FrozenFoldBaselineColumn>`
		SELECT
			attribute.attname AS column_name,
			format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
			attribute.attnotnull AS not_null,
			pg_get_expr(default_value.adbin, default_value.adrelid)
				AS default_expression
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		JOIN pg_attribute AS attribute
		  ON attribute.attrelid = relation.oid
		 AND attribute.attnum > 0
		 AND NOT attribute.attisdropped
		LEFT JOIN pg_attrdef AS default_value
		  ON default_value.adrelid = relation.oid
		 AND default_value.adnum = attribute.attnum
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'app_changes'
		ORDER BY attribute.attnum
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(changeColumns.rows) ===
			canonicalIdentityDigest([
				{
					column_name: "app_id",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "seq",
					data_type: "bigint",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "batch_id",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "run_id",
					data_type: "text",
					not_null: false,
					default_expression: null,
				},
				{
					column_name: "actor_id",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "kind",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "mutations",
					data_type: "jsonb",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "ts",
					data_type: "timestamp(3) with time zone",
					not_null: true,
					default_expression: "now()",
				},
				{
					column_name: "from_project_id",
					data_type: "text",
					not_null: false,
					default_expression: null,
				},
				{
					column_name: "to_project_id",
					data_type: "text",
					not_null: false,
					default_expression: null,
				},
			]),
		"app_changes columns differ from the exact final catalog",
	);

	const changeConstraints = await sql<{
		constraint_name: string;
		definition: string;
		deferrable: boolean;
		initially_deferred: boolean;
		validated: boolean;
	}>`
		SELECT
			constraint_row.conname AS constraint_name,
			pg_get_constraintdef(constraint_row.oid, false) AS definition,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.convalidated AS validated
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'app_changes'
		  AND constraint_row.contype NOT IN ('n', 't')
		ORDER BY constraint_row.conname
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(changeConstraints.rows) ===
			canonicalIdentityDigest([
				{
					constraint_name: "app_changes_app_id_batch_id_key",
					definition: "UNIQUE (app_id, batch_id)",
					deferrable: false,
					initially_deferred: false,
					validated: true,
				},
				{
					constraint_name: "app_changes_app_id_fkey",
					definition:
						"FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE",
					deferrable: false,
					initially_deferred: false,
					validated: true,
				},
				{
					constraint_name: "app_changes_pkey",
					definition: "PRIMARY KEY (app_id, seq)",
					deferrable: false,
					initially_deferred: false,
					validated: true,
				},
				{
					constraint_name: "app_changes_project_move_scope_check",
					definition:
						"CHECK ((((kind = 'project-move'::text) AND (from_project_id IS NOT NULL) AND (btrim(from_project_id) <> ''::text) AND (to_project_id IS NOT NULL) AND (btrim(to_project_id) <> ''::text) AND (from_project_id <> to_project_id)) OR ((kind <> 'project-move'::text) AND (from_project_id IS NULL) AND (to_project_id IS NULL))))",
					deferrable: false,
					initially_deferred: false,
					validated: true,
				},
			]),
		"app_changes constraints differ from the exact final catalog",
	);

	const changeIndexes = await sql<FrozenFoldBaselineIndex>`
		SELECT
			index_relation.relname AS index_name,
			pg_get_indexdef(index_relation.oid, 0, false) AS definition,
			index_row.indisprimary AS primary,
			index_row.indisunique AS unique,
			index_row.indisvalid AS valid,
			index_row.indisready AS ready,
			pg_get_userbyid(index_relation.relowner) AS owner_name,
			COALESCE(to_jsonb(index_relation.relacl), '[]'::jsonb) AS acl
		FROM pg_index AS index_row
		JOIN pg_class AS relation ON relation.oid = index_row.indrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'app_changes'
		ORDER BY index_relation.relname
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(changeIndexes.rows) ===
			canonicalIdentityDigest([
				{
					index_name: "app_changes_app_id_batch_id_key",
					definition:
						"CREATE UNIQUE INDEX app_changes_app_id_batch_id_key ON public.app_changes USING btree (app_id, batch_id)",
					primary: false,
					unique: true,
					valid: true,
					ready: true,
					owner_name: expectedOwner,
					acl: [],
				},
				{
					index_name: "app_changes_pkey",
					definition:
						"CREATE UNIQUE INDEX app_changes_pkey ON public.app_changes USING btree (app_id, seq)",
					primary: true,
					unique: true,
					valid: true,
					ready: true,
					owner_name: expectedOwner,
					acl: [],
				},
			]),
		"app_changes indexes differ from the exact final catalog",
	);

	const triggers = await sql<FrozenFoldBaselineTrigger>`
		SELECT
			relation.relname AS table_name,
			trigger_row.tgname AS trigger_name,
			pg_get_triggerdef(trigger_row.oid, false) AS definition,
			trigger_row.tgenabled::text AS enabled,
			function_row.proname AS function_name
		FROM pg_trigger AS trigger_row
		JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
		WHERE namespace.nspname = 'public'
		  AND NOT trigger_row.tgisinternal
		  AND (
				relation.relname IN ('app_change_fold_baselines', 'app_changes', 'apps')
				AND trigger_row.tgname IN (
					'app_change_fold_baselines_immutable',
					'app_change_fold_baselines_admit_insert',
					'app_changes_fold_baseline_required',
					'app_changes_admit_insert',
					'app_changes_project_move_final_required',
					'apps_project_move_app_change_required'
				)
		  )
		ORDER BY relation.relname, trigger_row.tgname
	`.execute(db);
	requireInvariant(
		triggers.rows.length === 6,
		"app-change admission must have exactly six public triggers",
	);
	const triggerByName = new Map(
		triggers.rows.map((row) => [row.trigger_name, row] as const),
	);
	const immutable = triggerByName.get("app_change_fold_baselines_immutable");
	requireInvariant(
		immutable?.table_name === "app_change_fold_baselines" &&
			immutable.enabled === "O" &&
			immutable.function_name ===
				"nova_reject_app_change_fold_baseline_change" &&
			immutable.definition ===
				"CREATE TRIGGER app_change_fold_baselines_immutable BEFORE DELETE OR UPDATE ON public.app_change_fold_baselines FOR EACH ROW EXECUTE FUNCTION nova_reject_app_change_fold_baseline_change()",
		"app_change_fold_baselines immutable trigger differs from the exact final catalog",
	);
	const admission = triggerByName.get("app_change_fold_baselines_admit_insert");
	requireInvariant(
		admission?.table_name === "app_change_fold_baselines" &&
			admission.enabled === "O" &&
			admission.function_name ===
				"nova_admit_app_change_fold_baseline_insert" &&
			admission.definition ===
				"CREATE TRIGGER app_change_fold_baselines_admit_insert BEFORE INSERT ON public.app_change_fold_baselines FOR EACH ROW EXECUTE FUNCTION nova_admit_app_change_fold_baseline_insert()",
		"app_change_fold_baselines admission trigger differs from the exact final catalog",
	);
	const completeness = triggerByName.get("app_changes_fold_baseline_required");
	requireInvariant(
		completeness?.table_name === "app_changes" &&
			completeness.enabled === "O" &&
			completeness.function_name === "nova_require_app_change_fold_baseline" &&
			completeness.definition ===
				"CREATE CONSTRAINT TRIGGER app_changes_fold_baseline_required AFTER INSERT OR DELETE OR UPDATE ON public.app_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nova_require_app_change_fold_baseline()",
		"app_changes baseline-completeness trigger differs from the exact final catalog",
	);
	const changeAdmission = triggerByName.get("app_changes_admit_insert");
	requireInvariant(
		changeAdmission?.table_name === "app_changes" &&
			changeAdmission.enabled === "O" &&
			changeAdmission.function_name === "nova_admit_app_change_insert" &&
			changeAdmission.definition ===
				"CREATE TRIGGER app_changes_admit_insert BEFORE INSERT ON public.app_changes FOR EACH ROW EXECUTE FUNCTION nova_admit_app_change_insert()",
		"app_changes insertion trigger differs from the exact final catalog",
	);
	const moveFinal = triggerByName.get(
		"app_changes_project_move_final_required",
	);
	requireInvariant(
		moveFinal?.table_name === "app_changes" &&
			moveFinal.enabled === "O" &&
			moveFinal.function_name ===
				"nova_require_app_change_project_move_final" &&
			moveFinal.definition ===
				"CREATE CONSTRAINT TRIGGER app_changes_project_move_final_required AFTER INSERT OR DELETE OR UPDATE ON public.app_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nova_require_app_change_project_move_final()",
		"app_changes deferred Project-move trigger differs from the exact final catalog",
	);
	const appMove = triggerByName.get("apps_project_move_app_change_required");
	requireInvariant(
		appMove?.table_name === "apps" &&
			appMove.enabled === "O" &&
			appMove.function_name === "nova_require_app_project_move_change" &&
			appMove.definition ===
				"CREATE CONSTRAINT TRIGGER apps_project_move_app_change_required AFTER UPDATE OF project_id ON public.apps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nova_require_app_project_move_change()",
		"apps deferred Project-move trigger differs from the exact final catalog",
	);

	const routines = await sql<FrozenFoldBaselineRoutine>`
		SELECT
			function_row.proname AS name,
			pg_get_function_identity_arguments(function_row.oid)
				AS identity_arguments,
			pg_get_function_result(function_row.oid) AS result_type,
			language_row.lanname AS language_name,
			function_row.provolatile::text AS volatility,
			function_row.proisstrict AS strict,
			function_row.prosecdef AS security_definer,
			function_row.proleakproof AS leakproof,
			function_row.proparallel::text AS parallel,
			to_jsonb(COALESCE(function_row.proconfig, '{}'::text[])) AS config,
			pg_get_userbyid(function_row.proowner) AS owner_name,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'grantor', pg_get_userbyid(privilege.grantor),
							'grantee',
								CASE
									WHEN privilege.grantee = 0 THEN 'PUBLIC'
									ELSE pg_get_userbyid(privilege.grantee)
								END,
							'privilege', privilege.privilege_type,
							'grantable', privilege.is_grantable
						)
						ORDER BY
							convert_to(
								CASE
									WHEN privilege.grantee = 0 THEN 'PUBLIC'
									ELSE pg_get_userbyid(privilege.grantee)
								END,
								'UTF8'
							),
							convert_to(privilege.privilege_type, 'UTF8'),
							privilege.is_grantable
					)
					FROM aclexplode(
						COALESCE(
							function_row.proacl,
							acldefault('f', function_row.proowner)
						)
					) AS privilege
				),
				'[]'::jsonb
			) AS acl,
			encode(
				sha256(convert_to(function_row.prosrc, 'UTF8')),
				'hex'
			) AS source_digest
		FROM pg_proc AS function_row
		JOIN pg_namespace AS namespace ON namespace.oid = function_row.pronamespace
		JOIN pg_language AS language_row
		  ON language_row.oid = function_row.prolang
		WHERE namespace.nspname = 'public'
		  AND function_row.proname = ANY(${FOLD_BASELINE_ROUTINE_NAMES})
		ORDER BY function_row.proname, identity_arguments
	`.execute(db);
	const routineAcl = (runtime: boolean) =>
		sortFrozenAcl([
			{
				grantor: expectedOwner,
				grantee: expectedOwner,
				privilege: "EXECUTE",
				grantable: false,
			},
			...(security.phase === "deployed" && runtime
				? [
						{
							grantor: expectedOwner,
							grantee: security.runtimeRole,
							privilege: "EXECUTE",
							grantable: false,
						},
					]
				: []),
		]);
	const expectedRoutines = [
		{
			name: "nova_admit_app_change_fold_baseline_insert",
			identity_arguments: "",
			result_type: "trigger",
			language_name: "plpgsql",
			volatility: "v",
			strict: false,
			security_definer: false,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"0af0fa2300a8d50bfeeb60be188c4ae05ac752bb2e13ad60864cba173605641e",
		},
		{
			name: "nova_current_app_change_fold_snapshot",
			identity_arguments: "text",
			result_type: "jsonb",
			language_name: "sql",
			volatility: "s",
			strict: true,
			security_definer: false,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"6ab0a83f2a984254575f6929180ed473d105c291ba06a5da6cbdabea874fba5b",
		},
		{
			name: "nova_insert_app_change_genesis_fold_baseline",
			identity_arguments: "text",
			result_type: "void",
			language_name: "plpgsql",
			volatility: "v",
			strict: true,
			security_definer: true,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(true),
			source_digest:
				"154a1b384cc2d156a96cb90cc999e5e4fb77c11dbf647243243d6bb81cb7b790",
		},
		{
			name: "nova_app_change_fold_snapshot_digest",
			identity_arguments: "jsonb",
			result_type: "text",
			language_name: "sql",
			volatility: "i",
			strict: true,
			security_definer: false,
			leakproof: false,
			parallel: "s",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"75624053d07546d83827b0f873549428120f4375492ef31d6c5b5bacbb635c87",
		},
		{
			name: "nova_reject_app_change_fold_baseline_change",
			identity_arguments: "",
			result_type: "trigger",
			language_name: "plpgsql",
			volatility: "v",
			strict: false,
			security_definer: false,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"f18cccbf4e27cc0ed6a1482ce7b66e6432f4ff3a9c6395e83d24f10437644227",
		},
		{
			name: "nova_require_app_change_fold_baseline",
			identity_arguments: "",
			result_type: "trigger",
			language_name: "plpgsql",
			volatility: "v",
			strict: false,
			security_definer: false,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"bc093a28ac813d66ea1e1e720312b0d146da1766f0cdc96789ccf24c0ee04296",
		},
		{
			name: "nova_admit_app_change_insert",
			identity_arguments: "",
			result_type: "trigger",
			language_name: "plpgsql",
			volatility: "v",
			strict: false,
			security_definer: false,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"2b788dfe5c22ec373b37620a4aa4765b74e64fcc8230e84c98bec3ae09edda7d",
		},
		{
			name: "nova_require_app_change_project_move_final",
			identity_arguments: "",
			result_type: "trigger",
			language_name: "plpgsql",
			volatility: "v",
			strict: false,
			security_definer: false,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"ad8a128fc1d91c806fab133b8501816012b00c951ac54d9f7aa07381f77a4e18",
		},
		{
			name: "nova_require_app_project_move_change",
			identity_arguments: "",
			result_type: "trigger",
			language_name: "plpgsql",
			volatility: "v",
			strict: false,
			security_definer: false,
			leakproof: false,
			parallel: "u",
			config: ["search_path=pg_catalog"],
			owner_name: expectedOwner,
			acl: routineAcl(false),
			source_digest:
				"7c85c0ae71a41a0fc9b7af311c26fbc7b10f490797ad8bad09dc796368eb106e",
		},
	] satisfies readonly FrozenFoldBaselineRoutine[];
	requireInvariant(
		canonicalIdentityDigest(routines.rows) ===
			canonicalIdentityDigest(
				[...expectedRoutines].sort((left, right) =>
					left.name.localeCompare(right.name),
				),
			),
		"fold baseline routines differ from the exact security catalog",
	);
}

async function createFoldBaselineDdl(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE accepted_mutations RENAME TO app_changes;
		ALTER TABLE app_changes
			RENAME CONSTRAINT accepted_mutations_app_id_fkey
			TO app_changes_app_id_fkey;
		ALTER TABLE app_changes
			RENAME CONSTRAINT accepted_mutations_pkey
			TO app_changes_pkey;
		ALTER TABLE app_changes
			RENAME CONSTRAINT accepted_mutations_app_id_batch_id_key
			TO app_changes_app_id_batch_id_key;
		ALTER TABLE app_changes
			ADD COLUMN from_project_id text,
			ADD COLUMN to_project_id text,
			ADD CONSTRAINT app_changes_project_move_scope_check
			CHECK (
				(
					kind = 'project-move'
					AND from_project_id IS NOT NULL
					AND btrim(from_project_id) <> ''
					AND to_project_id IS NOT NULL
					AND btrim(to_project_id) <> ''
					AND from_project_id <> to_project_id
				)
				OR
				(
					kind <> 'project-move'
					AND from_project_id IS NULL
					AND to_project_id IS NULL
				)
			);

		CREATE TABLE mutation_fold_baselines (
			app_id text NOT NULL,
			seq bigint NOT NULL,
			project_id text NOT NULL,
			snapshot jsonb NOT NULL,
			snapshot_digest text NOT NULL
				CONSTRAINT mutation_fold_baselines_snapshot_digest_check
				CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
			CONSTRAINT mutation_fold_baselines_project_id_nonblank_check
				CHECK (btrim(project_id) <> ''),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (app_id, seq),
			CONSTRAINT mutation_fold_baselines_change_fkey
				FOREIGN KEY (app_id, seq)
				REFERENCES app_changes(app_id, seq)
				ON DELETE CASCADE
		);
		ALTER TABLE mutation_fold_baselines
			RENAME TO app_change_fold_baselines;
		ALTER TABLE app_change_fold_baselines
			RENAME CONSTRAINT mutation_fold_baselines_pkey
			TO app_change_fold_baselines_pkey;
		ALTER TABLE app_change_fold_baselines
			RENAME CONSTRAINT mutation_fold_baselines_change_fkey
			TO app_change_fold_baselines_change_fkey;
		ALTER TABLE app_change_fold_baselines
			RENAME CONSTRAINT mutation_fold_baselines_snapshot_digest_check
			TO app_change_fold_baselines_snapshot_digest_check;
		ALTER TABLE app_change_fold_baselines
			RENAME CONSTRAINT mutation_fold_baselines_project_id_nonblank_check
			TO app_change_fold_baselines_project_id_nonblank_check;

		CREATE FUNCTION nova_app_change_fold_snapshot_digest(jsonb)
		RETURNS text
		LANGUAGE sql
		IMMUTABLE
		STRICT
		PARALLEL SAFE
		SET search_path = pg_catalog
		AS $function$
			SELECT encode(sha256(convert_to($1::text, 'UTF8')), 'hex')
		$function$;

		CREATE FUNCTION nova_current_app_change_fold_snapshot(text)
		RETURNS jsonb
		LANGUAGE sql
		STABLE
		STRICT
		PARALLEL UNSAFE
		SET search_path = pg_catalog
		AS $function$
			WITH entity AS MATERIALIZED (
				SELECT
					row.uuid::text AS uuid,
					row.kind,
					row.parent_uuid::text AS parent_uuid,
					row.ordinal,
					row.data
				FROM public.blueprint_entities AS row
				WHERE row.app_id = $1
			),
			module AS (
				SELECT * FROM entity WHERE kind = 'module'
			),
			form AS (
				SELECT * FROM entity WHERE kind = 'form'
			),
			field AS (
				SELECT * FROM entity WHERE kind = 'field'
			),
			field_parent AS (
				SELECT uuid, ordinal
				FROM form
				UNION ALL
				SELECT uuid, ordinal
				FROM field
				WHERE data ->> 'kind' IN ('group', 'repeat')
			)
			SELECT
				jsonb_build_object(
					'appId', app.id,
					'appName', app.app_name,
					'connectType', app.connect_type,
					'caseTypes', app.case_types,
					'modules', COALESCE(
						(
							SELECT jsonb_object_agg(uuid, data ORDER BY ordinal, uuid)
							FROM module
						),
						'{}'::jsonb
					),
					'forms', COALESCE(
						(
							SELECT jsonb_object_agg(uuid, data ORDER BY ordinal, uuid)
							FROM form
						),
						'{}'::jsonb
					),
					'fields', COALESCE(
						(
							SELECT jsonb_object_agg(uuid, data ORDER BY ordinal, uuid)
							FROM field
						),
						'{}'::jsonb
					),
					'moduleOrder', COALESCE(
						(
							SELECT jsonb_agg(uuid ORDER BY ordinal, uuid)
							FROM module
						),
						'[]'::jsonb
					),
					'formOrder', COALESCE(
						(
							SELECT jsonb_object_agg(
								parent.uuid,
								COALESCE(
									(
										SELECT jsonb_agg(child.uuid ORDER BY child.ordinal, child.uuid)
										FROM form AS child
										WHERE child.parent_uuid = parent.uuid
									),
									'[]'::jsonb
								)
								ORDER BY parent.ordinal, parent.uuid
							)
							FROM module AS parent
						),
						'{}'::jsonb
					),
					'fieldOrder', COALESCE(
						(
							SELECT jsonb_object_agg(
								parent.uuid,
								COALESCE(
									(
										SELECT jsonb_agg(child.uuid ORDER BY child.ordinal, child.uuid)
										FROM field AS child
										WHERE child.parent_uuid = parent.uuid
									),
									'[]'::jsonb
								)
								ORDER BY parent.ordinal, parent.uuid
							)
							FROM field_parent AS parent
						),
						'{}'::jsonb
					)
				)
				|| CASE
					WHEN app.logo IS NULL THEN '{}'::jsonb
					ELSE jsonb_build_object('logo', app.logo::text)
				END
				|| CASE
					WHEN EXISTS (SELECT 1 FROM entity WHERE kind = 'user_property')
					THEN jsonb_build_object(
						'userProperties',
						(
							SELECT jsonb_object_agg(uuid, data ORDER BY ordinal, uuid)
							FROM entity
							WHERE kind = 'user_property'
						),
						'userPropertyOrder',
						(
							SELECT jsonb_agg(uuid ORDER BY ordinal, uuid)
							FROM entity
							WHERE kind = 'user_property'
						)
					)
					ELSE '{}'::jsonb
				END
				|| CASE
					WHEN EXISTS (SELECT 1 FROM entity WHERE kind = 'user_type')
					THEN jsonb_build_object(
						'userTypes',
						(
							SELECT jsonb_object_agg(uuid, data ORDER BY ordinal, uuid)
							FROM entity
							WHERE kind = 'user_type'
						),
						'userTypeOrder',
						(
							SELECT jsonb_agg(uuid ORDER BY ordinal, uuid)
							FROM entity
							WHERE kind = 'user_type'
						)
					)
					ELSE '{}'::jsonb
				END
				|| CASE
					WHEN EXISTS (SELECT 1 FROM entity WHERE kind = 'persona')
					THEN jsonb_build_object(
						'personas',
						(
							SELECT jsonb_object_agg(uuid, data ORDER BY ordinal, uuid)
							FROM entity
							WHERE kind = 'persona'
						),
						'personaOrder',
						(
							SELECT jsonb_agg(uuid ORDER BY ordinal, uuid)
							FROM entity
							WHERE kind = 'persona'
						)
					)
					ELSE '{}'::jsonb
				END
			FROM public.apps AS app
			WHERE app.id = $1
		$function$;

		CREATE FUNCTION nova_reject_app_change_fold_baseline_change()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		BEGIN
			RAISE EXCEPTION 'app_change_fold_baselines rows are immutable';
		END
		$function$;

		CREATE FUNCTION nova_admit_app_change_fold_baseline_insert()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			current_transaction xid;
			expected_snapshot jsonb;
		BEGIN
			-- xmin is a 32-bit xid while pg_current_xact_id() is the
			-- epoch-aware xid8. Compare the exact current low 32 bits instead of
			-- their text renderings so admission remains correct across xid wrap.
			current_transaction := (
				mod(
					pg_current_xact_id()::text::numeric,
					4294967296::numeric
				)::bigint::text
			)::xid;
			expected_snapshot :=
				public.nova_current_app_change_fold_snapshot(NEW.app_id);
			IF expected_snapshot IS NULL
				OR NEW.snapshot::text IS DISTINCT FROM expected_snapshot::text
			THEN
				RAISE EXCEPTION
					'app_change_fold_baselines insert snapshot does not equal current app state';
			END IF;
			IF NEW.snapshot_digest IS DISTINCT FROM
				public.nova_app_change_fold_snapshot_digest(NEW.snapshot)
			THEN
				RAISE EXCEPTION
					'app_change_fold_baselines insert digest does not match snapshot';
			END IF;
			IF NOT EXISTS (
				SELECT 1
				FROM public.app_changes AS marker
				JOIN public.apps AS app ON app.id = marker.app_id
				WHERE marker.app_id = NEW.app_id
					AND marker.seq = NEW.seq
					AND marker.kind = 'fold-baseline'
					AND marker.mutations = '[]'::jsonb
					AND marker.from_project_id IS NULL
					AND marker.to_project_id IS NULL
					AND app.mutation_seq = NEW.seq
					AND app.project_id = NEW.project_id
					AND marker.xmin = current_transaction
					AND app.xmin = current_transaction
					AND NOT EXISTS (
						SELECT 1
						FROM public.blueprint_entities AS entity
						WHERE entity.app_id = NEW.app_id
							AND entity.xmin <> current_transaction
					)
					AND (
						(
							marker.batch_id = 'fold-baseline:canonical-identity-foundation'
							AND marker.actor_id = 'system:canonical-identity-foundation'
							AND marker.run_id IS NULL
						)
						OR
						(
							NEW.seq = 1
							AND marker.batch_id = 'genesis:' || marker.app_id
							AND marker.actor_id = app.owner
							AND marker.run_id = app.run_id
						)
					)
			) THEN
				RAISE EXCEPTION 'app_change_fold_baselines insert requires an exact horizon or genesis marker';
			END IF;
			RETURN NEW;
		END
		$function$;

		CREATE FUNCTION nova_require_app_change_fold_baseline()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			app_owner text;
			app_run_id text;
		BEGIN
			IF TG_OP <> 'INSERT'
				AND EXISTS (
					SELECT 1
					FROM public.app_change_fold_baselines AS baseline
					WHERE baseline.app_id = OLD.app_id
						AND baseline.seq = OLD.seq
				)
			THEN
				RAISE EXCEPTION
					'app change fold markers are immutable';
			END IF;
			IF TG_OP = 'DELETE' THEN
				RETURN OLD;
			END IF;
			SELECT app.owner, app.run_id
			INTO app_owner, app_run_id
			FROM public.apps AS app
			WHERE app.id = NEW.app_id;
			IF NEW.kind = 'fold-baseline' THEN
				IF NOT (
					NEW.mutations = '[]'::jsonb
					AND NEW.from_project_id IS NULL
					AND NEW.to_project_id IS NULL
					AND (
					(
						NEW.batch_id = 'fold-baseline:canonical-identity-foundation'
						AND NEW.actor_id = 'system:canonical-identity-foundation'
						AND NEW.run_id IS NULL
					)
					OR
					(
						NEW.seq = 1
						AND NEW.batch_id = 'genesis:' || NEW.app_id
						AND NEW.actor_id = app_owner
						AND NEW.run_id IS NOT DISTINCT FROM app_run_id
					)
					)
				)
				THEN
					RAISE EXCEPTION
						'only an exact fold marker may carry an empty app-change batch';
				END IF;
				IF NOT EXISTS (
					SELECT 1
					FROM public.app_change_fold_baselines AS baseline
					WHERE baseline.app_id = NEW.app_id
						AND baseline.seq = NEW.seq
				)
				THEN
					RAISE EXCEPTION
						'exact horizon and genesis markers require a fold baseline';
				END IF;
			END IF;
			RETURN NEW;
		END
		$function$;

		CREATE FUNCTION nova_admit_app_change_insert()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			current_project_id text;
			current_head bigint;
		BEGIN
			IF NEW.kind NOT IN (
				'autosave',
				'mcp',
				'chat',
				'blueprint-migration',
				'fold-baseline',
				'project-move'
			) THEN
				RAISE EXCEPTION 'app_changes insert has an unsupported kind';
			END IF;
			IF btrim(NEW.batch_id) = ''
				OR btrim(NEW.actor_id) = ''
				OR (NEW.run_id IS NOT NULL AND btrim(NEW.run_id) = '')
			THEN
				RAISE EXCEPTION 'app_changes insert has a blank envelope identity';
			END IF;
			IF NEW.kind = 'fold-baseline' THEN
				IF NEW.mutations <> '[]'::jsonb THEN
					RAISE EXCEPTION 'fold-baseline app changes must be empty';
				END IF;
				RETURN NEW;
			END IF;
			IF NEW.kind = 'project-move' THEN
				SELECT app.project_id, app.mutation_seq
				INTO current_project_id, current_head
				FROM public.apps AS app
				WHERE app.id = NEW.app_id
				FOR UPDATE;
				IF NOT FOUND
					OR current_project_id IS DISTINCT FROM NEW.from_project_id
					OR NEW.seq IS DISTINCT FROM current_head + 1
				THEN
					RAISE EXCEPTION
						'project-move app change does not start at the locked app Project/head';
				END IF;
				RETURN NEW;
			END IF;
			IF NEW.mutations = '[]'::jsonb THEN
				RAISE EXCEPTION
					'non-move non-baseline app changes must contain mutations';
			END IF;
			RETURN NEW;
		END
		$function$;

		CREATE FUNCTION nova_require_app_change_project_move_final()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			change_row record;
		BEGIN
			change_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
			IF change_row.kind <> 'project-move' THEN
				RETURN change_row;
			END IF;
			IF NOT EXISTS (
				SELECT 1
				FROM public.app_changes AS persisted
				JOIN public.apps AS app ON app.id = persisted.app_id
				WHERE persisted.app_id = change_row.app_id
					AND persisted.seq = change_row.seq
					AND persisted.kind = 'project-move'
					AND persisted.from_project_id = change_row.from_project_id
					AND persisted.to_project_id = change_row.to_project_id
					AND app.project_id = persisted.to_project_id
					AND app.mutation_seq = persisted.seq
			) THEN
				RAISE EXCEPTION
					'project-move app change does not equal the final app Project/head';
			END IF;
			RETURN change_row;
		END
		$function$;

		CREATE FUNCTION nova_require_app_project_move_change()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		BEGIN
			IF OLD.project_id IS NOT DISTINCT FROM NEW.project_id THEN
				RETURN NEW;
			END IF;
			IF NOT EXISTS (
				SELECT 1
				FROM public.app_changes AS change_row
				WHERE change_row.app_id = NEW.id
					AND change_row.seq = NEW.mutation_seq
					AND change_row.seq = OLD.mutation_seq + 1
					AND change_row.kind = 'project-move'
					AND change_row.from_project_id = OLD.project_id
					AND change_row.to_project_id = NEW.project_id
			) THEN
				RAISE EXCEPTION
					'app Project update has no exact same-sequence project-move app change';
			END IF;
			RETURN NEW;
		END
		$function$;

		CREATE FUNCTION nova_insert_app_change_genesis_fold_baseline(text)
		RETURNS void
		LANGUAGE plpgsql
		SECURITY DEFINER
		VOLATILE
		STRICT
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			app_seq bigint;
			app_snapshot jsonb;
		BEGIN
			SELECT
				app.mutation_seq,
				public.nova_current_app_change_fold_snapshot(app.id)
			INTO app_seq, app_snapshot
			FROM public.apps AS app
			WHERE app.id = $1;
			IF app_seq IS DISTINCT FROM 1 OR app_snapshot IS NULL THEN
				RAISE EXCEPTION
					'genesis fold baseline requires the current sequence-one app';
			END IF;
			INSERT INTO public.app_change_fold_baselines
				(app_id, seq, project_id, snapshot, snapshot_digest)
			VALUES (
				$1,
				1,
				(SELECT project_id FROM public.apps WHERE id = $1),
				app_snapshot,
				public.nova_app_change_fold_snapshot_digest(app_snapshot)
			);
		END
		$function$;

		CREATE TRIGGER app_change_fold_baselines_immutable
			BEFORE UPDATE OR DELETE ON app_change_fold_baselines
			FOR EACH ROW
			EXECUTE FUNCTION nova_reject_app_change_fold_baseline_change();

		CREATE TRIGGER app_change_fold_baselines_admit_insert
			BEFORE INSERT ON app_change_fold_baselines
			FOR EACH ROW
			EXECUTE FUNCTION nova_admit_app_change_fold_baseline_insert();

		CREATE CONSTRAINT TRIGGER app_changes_fold_baseline_required
			AFTER INSERT OR UPDATE OR DELETE ON app_changes
			DEFERRABLE INITIALLY DEFERRED
			FOR EACH ROW
			EXECUTE FUNCTION nova_require_app_change_fold_baseline();

		CREATE TRIGGER app_changes_admit_insert
			BEFORE INSERT ON app_changes
			FOR EACH ROW
			EXECUTE FUNCTION nova_admit_app_change_insert();

		CREATE CONSTRAINT TRIGGER app_changes_project_move_final_required
			AFTER INSERT OR UPDATE OR DELETE ON app_changes
			DEFERRABLE INITIALLY DEFERRED
			FOR EACH ROW
			EXECUTE FUNCTION nova_require_app_change_project_move_final();

		CREATE CONSTRAINT TRIGGER apps_project_move_app_change_required
			AFTER UPDATE OF project_id ON apps
			DEFERRABLE INITIALLY DEFERRED
			FOR EACH ROW
			EXECUTE FUNCTION nova_require_app_project_move_change();

		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_app_change_fold_snapshot_digest(jsonb)
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_current_app_change_fold_snapshot(text)
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_reject_app_change_fold_baseline_change()
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_admit_app_change_fold_baseline_insert()
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_require_app_change_fold_baseline()
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_insert_app_change_genesis_fold_baseline(text)
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_admit_app_change_insert()
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_require_app_change_project_move_final()
			FROM PUBLIC;
		REVOKE ALL PRIVILEGES
			ON FUNCTION nova_require_app_project_move_change()
			FROM PUBLIC;
	`.execute(db);
	await assertFrozenFoldBaselineCatalog(db);
}

function requireInvariant(
	condition: unknown,
	message: string,
): asserts condition {
	if (!condition) {
		throw new Error(
			`Canonical identity migration blocked: ${message} [${CANONICAL_IDENTITY_MIGRATION_VERSION}]`,
		);
	}
}

export const APPS_PROJECT_NONBLANK_CHECK = "apps_project_id_nonblank_check";
export const CASES_PROJECT_NONBLANK_CHECK = "cases_project_id_nonblank_check";
export const CASES_PROJECT_APP_TENANT_FOREIGN_KEY =
	"cases_project_app_tenant_fk";
export const CASES_PROJECT_APP_TENANT_FOREIGN_KEY_DEFINITION =
	"FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED";

interface FrozenProjectTenancyCatalog {
	readonly apps_not_null: boolean;
	readonly cases_not_null: boolean;
	readonly apps_check_definition: string | null;
	readonly apps_check_validated: boolean | null;
	readonly cases_check_definition: string | null;
	readonly cases_check_validated: boolean | null;
	readonly cases_fk_definition: string | null;
	readonly cases_fk_validated: boolean | null;
	readonly cases_fk_deferrable: boolean | null;
	readonly cases_fk_initially_deferred: boolean | null;
	readonly cases_fk_update_action: string | null;
	readonly cases_fk_delete_action: string | null;
	readonly touching_constraints: readonly FrozenProjectTenancyConstraint[];
	readonly touching_indexes: readonly FrozenProjectTenancyIndex[];
}

interface FrozenProjectTenancyConstraint {
	readonly name: string;
	readonly constraint_type: string;
	readonly local_schema: string;
	readonly local_relation: string;
	readonly local_columns: readonly string[];
	readonly referenced_schema: string | null;
	readonly referenced_relation: string | null;
	readonly referenced_columns: readonly string[];
	readonly update_action: string | null;
	readonly delete_action: string | null;
	readonly deferrable: boolean;
	readonly initially_deferred: boolean;
	readonly validated: boolean;
	readonly definition: string;
}

interface FrozenProjectTenancyIndex {
	readonly name: string;
	readonly local_schema: string;
	readonly local_relation: string;
	readonly access_method: string;
	readonly unique: boolean;
	readonly primary: boolean;
	readonly valid: boolean;
	readonly ready: boolean;
	readonly live: boolean;
	readonly definition: string;
}

async function captureFrozenProjectTenancyCatalog(
	db: Kysely<unknown>,
	casesSchema: "nova_case_runtime" | "public",
): Promise<FrozenProjectTenancyCatalog> {
	const result = await sql<
		Omit<
			FrozenProjectTenancyCatalog,
			"touching_constraints" | "touching_indexes"
		>
	>`
		SELECT
			apps_project.attnotnull AS apps_not_null,
			cases_project.attnotnull AS cases_not_null,
			pg_get_constraintdef(apps_check.oid, true)
				AS apps_check_definition,
			apps_check.convalidated AS apps_check_validated,
			pg_get_constraintdef(cases_check.oid, true)
				AS cases_check_definition,
			cases_check.convalidated AS cases_check_validated,
			pg_get_constraintdef(cases_fk.oid, true)
				AS cases_fk_definition,
			cases_fk.convalidated AS cases_fk_validated,
			cases_fk.condeferrable AS cases_fk_deferrable,
			cases_fk.condeferred AS cases_fk_initially_deferred,
			cases_fk.confupdtype AS cases_fk_update_action,
			cases_fk.confdeltype AS cases_fk_delete_action
		FROM pg_class AS apps_relation
		JOIN pg_namespace AS apps_namespace
		  ON apps_namespace.oid = apps_relation.relnamespace
		JOIN pg_attribute AS apps_project
		  ON apps_project.attrelid = apps_relation.oid
		 AND apps_project.attname = 'project_id'
		 AND NOT apps_project.attisdropped
		JOIN pg_class AS cases_relation
		  ON cases_relation.relname = 'cases'
		JOIN pg_namespace AS cases_namespace
		  ON cases_namespace.oid = cases_relation.relnamespace
		 AND cases_namespace.nspname = ${casesSchema}
		JOIN pg_attribute AS cases_project
		  ON cases_project.attrelid = cases_relation.oid
		 AND cases_project.attname = 'project_id'
		 AND NOT cases_project.attisdropped
		LEFT JOIN pg_constraint AS apps_check
		  ON apps_check.conrelid = apps_relation.oid
		 AND apps_check.conname = ${APPS_PROJECT_NONBLANK_CHECK}
		LEFT JOIN pg_constraint AS cases_check
		  ON cases_check.conrelid = cases_relation.oid
		 AND cases_check.conname = ${CASES_PROJECT_NONBLANK_CHECK}
		LEFT JOIN pg_constraint AS cases_fk
		  ON cases_fk.conrelid = cases_relation.oid
		 AND cases_fk.conname = ${CASES_PROJECT_APP_TENANT_FOREIGN_KEY}
		WHERE apps_namespace.nspname = 'public'
		  AND apps_relation.relname = 'apps'
	`.execute(db);
	const row = result.rows[0];
	requireInvariant(
		row !== undefined,
		"apps.project_id or nova_case_runtime.cases.project_id is absent",
	);
	const constraints = await sql<FrozenProjectTenancyConstraint>`
		WITH target AS (
			SELECT
				relation.oid AS relation_id,
				namespace.nspname AS schema_name,
				relation.relname AS relation_name,
				attribute.attnum AS column_number
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace
			  ON namespace.oid = relation.relnamespace
			JOIN pg_attribute AS attribute
			  ON attribute.attrelid = relation.oid
			 AND attribute.attname = 'project_id'
			 AND attribute.attnum > 0
			 AND NOT attribute.attisdropped
			WHERE
				(namespace.nspname = 'public' AND relation.relname = 'apps')
				OR (
					namespace.nspname = ${casesSchema}
					AND relation.relname = 'cases'
				)
		)
		SELECT
			constraint_row.conname AS name,
			constraint_row.contype::text AS constraint_type,
			local_namespace.nspname AS local_schema,
			local_relation.relname AS local_relation,
			COALESCE(
				ARRAY(
					SELECT local_attribute.attname::text
					FROM unnest(COALESCE(
						constraint_row.conkey,
						'{}'::smallint[]
					)) WITH ORDINALITY AS local_key(attnum, position)
					JOIN pg_attribute AS local_attribute
					  ON local_attribute.attrelid = constraint_row.conrelid
					 AND local_attribute.attnum = local_key.attnum
					ORDER BY local_key.position
				),
				ARRAY[]::text[]
			) AS local_columns,
			referenced_namespace.nspname AS referenced_schema,
			referenced_relation.relname AS referenced_relation,
			CASE
				WHEN constraint_row.contype = 'f' THEN ARRAY(
					SELECT referenced_attribute.attname::text
					FROM unnest(COALESCE(
						constraint_row.confkey,
						'{}'::smallint[]
					)) WITH ORDINALITY AS referenced_key(attnum, position)
					JOIN pg_attribute AS referenced_attribute
					  ON referenced_attribute.attrelid = constraint_row.confrelid
					 AND referenced_attribute.attnum = referenced_key.attnum
					ORDER BY referenced_key.position
				)
				ELSE ARRAY[]::text[]
			END AS referenced_columns,
			CASE
				WHEN constraint_row.contype = 'f'
				THEN constraint_row.confupdtype::text
			END AS update_action,
			CASE
				WHEN constraint_row.contype = 'f'
				THEN constraint_row.confdeltype::text
			END AS delete_action,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.convalidated AS validated,
			pg_get_constraintdef(constraint_row.oid, true) AS definition
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS local_relation
		  ON local_relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS local_namespace
		  ON local_namespace.oid = local_relation.relnamespace
		LEFT JOIN pg_class AS referenced_relation
		  ON referenced_relation.oid = constraint_row.confrelid
		LEFT JOIN pg_namespace AS referenced_namespace
		  ON referenced_namespace.oid = referenced_relation.relnamespace
		WHERE EXISTS (
			SELECT 1
			FROM target
			WHERE (
				constraint_row.conrelid = target.relation_id
				AND target.column_number = ANY(COALESCE(
					constraint_row.conkey,
					'{}'::smallint[]
				))
			) OR (
				constraint_row.confrelid = target.relation_id
				AND target.column_number = ANY(COALESCE(
					constraint_row.confkey,
					'{}'::smallint[]
				))
			)
		)
		ORDER BY
			convert_to(constraint_row.conname, 'UTF8'),
			constraint_row.oid
	`.execute(db);
	const indexes = await sql<FrozenProjectTenancyIndex>`
		WITH target AS (
			SELECT
				relation.oid AS relation_id,
				namespace.nspname AS schema_name,
				relation.relname AS relation_name,
				attribute.attnum AS column_number
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace
			  ON namespace.oid = relation.relnamespace
			JOIN pg_attribute AS attribute
			  ON attribute.attrelid = relation.oid
			 AND attribute.attname = 'project_id'
			 AND attribute.attnum > 0
			 AND NOT attribute.attisdropped
			WHERE
				(namespace.nspname = 'public' AND relation.relname = 'apps')
				OR (
					namespace.nspname = ${casesSchema}
					AND relation.relname = 'cases'
				)
		)
		SELECT
			index_relation.relname AS name,
			target.schema_name AS local_schema,
			target.relation_name AS local_relation,
			access_method.amname AS access_method,
			index_row.indisunique AS unique,
			index_row.indisprimary AS primary,
			index_row.indisvalid AS valid,
			index_row.indisready AS ready,
			index_row.indislive AS live,
			pg_get_indexdef(index_row.indexrelid) AS definition
		FROM target
		JOIN pg_index AS index_row
		  ON index_row.indrelid = target.relation_id
		JOIN pg_class AS index_relation
		  ON index_relation.oid = index_row.indexrelid
		JOIN pg_am AS access_method
		  ON access_method.oid = index_relation.relam
		WHERE
			target.column_number = ANY(index_row.indkey::smallint[])
			OR EXISTS (
				SELECT 1
				FROM pg_depend AS dependency
				WHERE dependency.classid = 'pg_class'::regclass
				  AND dependency.objid = index_row.indexrelid
				  AND dependency.refclassid = 'pg_class'::regclass
				  AND dependency.refobjid = target.relation_id
				  AND dependency.refobjsubid = target.column_number
			)
		ORDER BY
			convert_to(index_relation.relname, 'UTF8'),
			index_row.indexrelid
	`.execute(db);
	return {
		...row,
		touching_constraints: constraints.rows,
		touching_indexes: indexes.rows,
	};
}

async function assertFrozenProjectTenancyRows(
	db: Kysely<unknown>,
	casesSchema: "nova_case_runtime" | "public",
): Promise<void> {
	const invalid = await sql<{
		invalid_apps: string;
		invalid_cases: string;
		auth_table_exists: boolean;
	}>`
		SELECT
			(
				SELECT count(*)::text
				FROM public.apps
				WHERE project_id IS NULL OR btrim(project_id) = ''
			) AS invalid_apps,
			(
				SELECT count(*)::text
				FROM ${sql.id(casesSchema, "cases")} AS case_row
				LEFT JOIN public.apps AS app ON app.id = case_row.app_id
				WHERE case_row.project_id IS NULL
				   OR btrim(case_row.project_id) = ''
				   OR app.id IS NULL
				   OR app.project_id IS NULL
				   OR btrim(app.project_id) = ''
				   OR case_row.project_id <> app.project_id
			) AS invalid_cases,
			to_regclass('public.auth_organization') IS NOT NULL
				AS auth_table_exists
	`.execute(db);
	const row = invalid.rows[0];
	requireInvariant(
		row?.invalid_apps === "0",
		"an app has no canonical Project",
	);
	requireInvariant(
		row.invalid_cases === "0",
		"a case row disagrees with its app's Project",
	);
	const missingProjectTargets = row.auth_table_exists
		? await sql<{ count: string }>`
				SELECT count(*)::text AS count
				FROM public.apps AS app
				WHERE NOT EXISTS (
					SELECT 1
					FROM public.auth_organization AS project
					WHERE project.id = app.project_id
				)
			`.execute(db)
		: await sql<{ count: string }>`
				SELECT count(*)::text AS count FROM public.apps
			`.execute(db);
	requireInvariant(
		missingProjectTargets.rows[0]?.count === "0",
		row.auth_table_exists
			? "an app Project does not resolve to a Better Auth organization"
			: "apps exist before the Better Auth organization table",
	);
}

async function assertFrozenAppChangeProjectRows(
	db: Kysely<unknown>,
): Promise<void> {
	const authCatalog = await sql<{
		exists: boolean;
		column_type: string | null;
		not_null: boolean | null;
		default_expression: string | null;
		primary_definition: string | null;
	}>`
		SELECT
			to_regclass('public.auth_organization') IS NOT NULL AS exists,
			format_type(id_column.atttypid, id_column.atttypmod) AS column_type,
			id_column.attnotnull AS not_null,
			pg_get_expr(default_value.adbin, default_value.adrelid)
				AS default_expression,
			pg_get_constraintdef(primary_key.oid, false) AS primary_definition
		FROM (SELECT 1) AS singleton
		LEFT JOIN pg_class AS relation
		  ON relation.oid = to_regclass('public.auth_organization')
		LEFT JOIN pg_attribute AS id_column
		  ON id_column.attrelid = relation.oid
		 AND id_column.attname = 'id'
		 AND id_column.attnum > 0
		 AND NOT id_column.attisdropped
		LEFT JOIN pg_attrdef AS default_value
		  ON default_value.adrelid = relation.oid
		 AND default_value.adnum = id_column.attnum
		LEFT JOIN pg_constraint AS primary_key
		  ON primary_key.conrelid = relation.oid
		 AND primary_key.contype = 'p'
	`.execute(db);
	const catalog = authCatalog.rows[0];
	requireInvariant(
		catalog !== undefined,
		"Better Auth Project catalog evidence is unavailable",
	);
	if (!catalog.exists) {
		const counts = await sql<{
			apps: string;
			changes: string;
			baselines: string;
		}>`
			SELECT
				(SELECT count(*)::text FROM public.apps) AS apps,
				(SELECT count(*)::text FROM public.app_changes) AS changes,
				(
					SELECT count(*)::text
					FROM public.app_change_fold_baselines
				) AS baselines
		`.execute(db);
		const row = counts.rows[0];
		requireInvariant(
			row?.apps === "0" && row.changes === "0" && row.baselines === "0",
			"Project-bearing app-change relations are nonempty before Better Auth Projects exist",
		);
		return;
	}
	requireInvariant(
		catalog.column_type === "text" &&
			catalog.not_null === true &&
			catalog.default_expression === null &&
			catalog.primary_definition === "PRIMARY KEY (id)",
		"Better Auth Project identity is not the exact authoritative text key",
	);
	const unresolved = await sql<{ count: string }>`
		SELECT count(*)::text AS count
		FROM (
			SELECT app.project_id
			FROM public.apps AS app
			WHERE NOT EXISTS (
				SELECT 1
				FROM public.auth_organization AS project
				WHERE project.id = app.project_id
			)
			UNION ALL
			SELECT baseline.project_id
			FROM public.app_change_fold_baselines AS baseline
			WHERE NOT EXISTS (
				SELECT 1
				FROM public.auth_organization AS project
				WHERE project.id = baseline.project_id
			)
			UNION ALL
			SELECT change_row.from_project_id
			FROM public.app_changes AS change_row
			WHERE change_row.from_project_id IS NOT NULL
			  AND NOT EXISTS (
					SELECT 1
					FROM public.auth_organization AS project
					WHERE project.id = change_row.from_project_id
			  )
			UNION ALL
			SELECT change_row.to_project_id
			FROM public.app_changes AS change_row
			WHERE change_row.to_project_id IS NOT NULL
			  AND NOT EXISTS (
					SELECT 1
					FROM public.auth_organization AS project
					WHERE project.id = change_row.to_project_id
			  )
		) AS missing
	`.execute(db);
	requireInvariant(
		unresolved.rows[0]?.count === "0",
		"an app-change Project identity does not resolve to Better Auth",
	);
}

function frozenProjectConstraint(
	value: FrozenProjectTenancyConstraint,
): FrozenProjectTenancyConstraint {
	return value;
}

function expectedFrozenProjectConstraints(
	casesSchema: "nova_case_runtime" | "public",
	expected: "legacy" | "final",
): readonly FrozenProjectTenancyConstraint[] {
	const rows: FrozenProjectTenancyConstraint[] = [
		frozenProjectConstraint({
			name: "apps_project_id_id_key",
			constraint_type: "u",
			local_schema: "public",
			local_relation: "apps",
			local_columns: ["project_id", "id"],
			referenced_schema: null,
			referenced_relation: null,
			referenced_columns: [],
			update_action: null,
			delete_action: null,
			deferrable: false,
			initially_deferred: false,
			validated: true,
			definition: "UNIQUE (project_id, id)",
		}),
		frozenProjectConstraint({
			name: "lookup_table_references_app_fk",
			constraint_type: "f",
			local_schema: "public",
			local_relation: "lookup_table_references",
			local_columns: ["project_id", "app_id"],
			referenced_schema: "public",
			referenced_relation: "apps",
			referenced_columns: ["project_id", "id"],
			update_action: "r",
			delete_action: "c",
			deferrable: false,
			initially_deferred: false,
			validated: true,
			definition:
				"FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE",
		}),
	];
	if (expected === "final") {
		rows.push(
			frozenProjectConstraint({
				name: APPS_PROJECT_NONBLANK_CHECK,
				constraint_type: "c",
				local_schema: "public",
				local_relation: "apps",
				local_columns: ["project_id"],
				referenced_schema: null,
				referenced_relation: null,
				referenced_columns: [],
				update_action: null,
				delete_action: null,
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: "CHECK (btrim(project_id) <> ''::text)",
			}),
			frozenProjectConstraint({
				name: "apps_project_id_not_null",
				constraint_type: "n",
				local_schema: "public",
				local_relation: "apps",
				local_columns: ["project_id"],
				referenced_schema: null,
				referenced_relation: null,
				referenced_columns: [],
				update_action: null,
				delete_action: null,
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: "NOT NULL project_id",
			}),
			frozenProjectConstraint({
				name: CASES_PROJECT_APP_TENANT_FOREIGN_KEY,
				constraint_type: "f",
				local_schema: casesSchema,
				local_relation: "cases",
				local_columns: ["project_id", "app_id"],
				referenced_schema: "public",
				referenced_relation: "apps",
				referenced_columns: ["project_id", "id"],
				update_action: "a",
				delete_action: "r",
				deferrable: true,
				initially_deferred: true,
				validated: true,
				definition: CASES_PROJECT_APP_TENANT_FOREIGN_KEY_DEFINITION,
			}),
			frozenProjectConstraint({
				name: CASES_PROJECT_NONBLANK_CHECK,
				constraint_type: "c",
				local_schema: casesSchema,
				local_relation: "cases",
				local_columns: ["project_id"],
				referenced_schema: null,
				referenced_relation: null,
				referenced_columns: [],
				update_action: null,
				delete_action: null,
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: "CHECK (btrim(project_id) <> ''::text)",
			}),
			frozenProjectConstraint({
				name: "cases_project_id_not_null",
				constraint_type: "n",
				local_schema: casesSchema,
				local_relation: "cases",
				local_columns: ["project_id"],
				referenced_schema: null,
				referenced_relation: null,
				referenced_columns: [],
				update_action: null,
				delete_action: null,
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: "NOT NULL project_id",
			}),
			frozenProjectConstraint({
				name: MEDIA_ASSET_REFS_PROJECT_APP_FOREIGN_KEY,
				constraint_type: "f",
				local_schema: "public",
				local_relation: "media_asset_refs",
				local_columns: ["project_id", "app_id"],
				referenced_schema: "public",
				referenced_relation: "apps",
				referenced_columns: ["project_id", "id"],
				update_action: "r",
				delete_action: "c",
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition:
					"FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE",
			}),
		);
	}
	return rows.sort((left, right) =>
		Buffer.compare(
			Buffer.from(left.name, "utf8"),
			Buffer.from(right.name, "utf8"),
		),
	);
}

const EXPECTED_FROZEN_PROJECT_INDEXES = [
	{
		name: "apps_project_deleted",
		local_schema: "public",
		local_relation: "apps",
		access_method: "btree",
		unique: false,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		definition:
			"CREATE INDEX apps_project_deleted ON public.apps USING btree (project_id, deleted_at DESC, id) WHERE (deleted_at IS NOT NULL)",
	},
	{
		name: "apps_project_id_id_key",
		local_schema: "public",
		local_relation: "apps",
		access_method: "btree",
		unique: true,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		definition:
			"CREATE UNIQUE INDEX apps_project_id_id_key ON public.apps USING btree (project_id, id)",
	},
	{
		name: "apps_project_live_name",
		local_schema: "public",
		local_relation: "apps",
		access_method: "btree",
		unique: false,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		definition:
			"CREATE INDEX apps_project_live_name ON public.apps USING btree (project_id, app_name_lower, id) WHERE (deleted_at IS NULL)",
	},
	{
		name: "apps_project_live_updated",
		local_schema: "public",
		local_relation: "apps",
		access_method: "btree",
		unique: false,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		definition:
			"CREATE INDEX apps_project_live_updated ON public.apps USING btree (project_id, updated_at DESC, id) WHERE (deleted_at IS NULL)",
	},
] as const satisfies readonly FrozenProjectTenancyIndex[];

function assertFrozenProjectTenancyCatalog(
	catalog: FrozenProjectTenancyCatalog,
	casesSchema: "nova_case_runtime" | "public",
	expected: "legacy" | "final",
): void {
	requireInvariant(
		canonicalIdentityDigest(catalog.touching_constraints) ===
			canonicalIdentityDigest(
				expectedFrozenProjectConstraints(casesSchema, expected),
			) &&
			canonicalIdentityDigest(catalog.touching_indexes) ===
				canonicalIdentityDigest(EXPECTED_FROZEN_PROJECT_INDEXES),
		"Project tenancy touching constraint or index catalog differs from the exact expected shape",
	);
	if (expected === "legacy") {
		requireInvariant(
			catalog.apps_not_null === false &&
				catalog.cases_not_null === false &&
				catalog.apps_check_definition === null &&
				catalog.cases_check_definition === null &&
				catalog.cases_fk_definition === null,
			"Project tenancy catalog is partial or differs from the exact legacy shape",
		);
		return;
	}
	requireInvariant(
		catalog.apps_not_null === true &&
			catalog.cases_not_null === true &&
			catalog.apps_check_definition ===
				"CHECK (btrim(project_id) <> ''::text)" &&
			catalog.apps_check_validated === true &&
			catalog.cases_check_definition ===
				"CHECK (btrim(project_id) <> ''::text)" &&
			catalog.cases_check_validated === true &&
			catalog.cases_fk_definition ===
				CASES_PROJECT_APP_TENANT_FOREIGN_KEY_DEFINITION &&
			catalog.cases_fk_validated === true &&
			catalog.cases_fk_deferrable === true &&
			catalog.cases_fk_initially_deferred === true &&
			catalog.cases_fk_update_action === "a" &&
			catalog.cases_fk_delete_action === "r",
		"Project tenancy catalog differs from the exact final shape",
	);
}

async function installFrozenProjectTenancyDdl(
	db: Kysely<unknown>,
	casesSchema: "nova_case_runtime" | "public",
): Promise<void> {
	await sql`
		ALTER TABLE public.apps
			ALTER COLUMN project_id SET NOT NULL,
			ADD CONSTRAINT ${sql.id(APPS_PROJECT_NONBLANK_CHECK)}
				CHECK (btrim(project_id) <> '');
		ALTER TABLE ${sql.id(casesSchema, "cases")}
			ALTER COLUMN project_id SET NOT NULL,
			ADD CONSTRAINT ${sql.id(CASES_PROJECT_NONBLANK_CHECK)}
				CHECK (btrim(project_id) <> ''),
			ADD CONSTRAINT ${sql.id(CASES_PROJECT_APP_TENANT_FOREIGN_KEY)}
				FOREIGN KEY (project_id, app_id)
				REFERENCES public.apps (project_id, id)
				ON UPDATE NO ACTION
				ON DELETE RESTRICT
				DEFERRABLE INITIALLY DEFERRED
	`.execute(db);
}

export const MEDIA_ASSETS_PROJECT_ID_ID_KEY = "media_assets_project_id_id_key";
export const MEDIA_ASSET_REFS_PROJECT_APP_FOREIGN_KEY =
	"media_asset_refs_project_app_fk";
export const MEDIA_ASSET_REFS_PROJECT_ASSET_FOREIGN_KEY =
	"media_asset_refs_project_asset_fk";
export const MEDIA_ASSET_REFS_PROJECT_ASSET_APP_INDEX =
	"media_asset_refs_project_asset_app_idx";

async function installFrozenMediaReferenceDdl(
	db: Kysely<unknown>,
	edges: readonly FrozenMediaReferenceEdge[],
): Promise<void> {
	await sql`
		DROP TABLE public.media_asset_refs;
		ALTER TABLE public.media_assets
			ADD CONSTRAINT ${sql.id(MEDIA_ASSETS_PROJECT_ID_ID_KEY)}
			UNIQUE (project_id, id);
		CREATE TABLE public.media_asset_refs (
			project_id text NOT NULL,
			app_id text NOT NULL,
			asset_id uuid NOT NULL,
			CONSTRAINT media_asset_refs_pkey
				PRIMARY KEY (project_id, app_id, asset_id),
			CONSTRAINT ${sql.id(MEDIA_ASSET_REFS_PROJECT_APP_FOREIGN_KEY)}
				FOREIGN KEY (project_id, app_id)
				REFERENCES public.apps (project_id, id)
				ON UPDATE RESTRICT
				ON DELETE CASCADE,
			CONSTRAINT ${sql.id(MEDIA_ASSET_REFS_PROJECT_ASSET_FOREIGN_KEY)}
				FOREIGN KEY (project_id, asset_id)
				REFERENCES public.media_assets (project_id, id)
				ON UPDATE RESTRICT
				ON DELETE RESTRICT
		);
		CREATE INDEX ${sql.id(MEDIA_ASSET_REFS_PROJECT_ASSET_APP_INDEX)}
			ON public.media_asset_refs (project_id, asset_id, app_id);
		DROP TABLE public.media_reference_index_state
	`.execute(db);
	if (edges.length > 0) {
		await sql`
			INSERT INTO public.media_asset_refs (project_id, app_id, asset_id)
			SELECT project_id, app_id, asset_id::uuid
			FROM jsonb_to_recordset(${JSON.stringify(edges)}::jsonb)
				AS edge(project_id text, app_id text, asset_id text)
			ORDER BY project_id, app_id, asset_id
		`.execute(db);
	}
}

export async function frozenExpectedMediaReferenceEdges(
	db: Kysely<unknown>,
	apps: readonly {
		readonly id: string;
		readonly project_id: string;
		readonly logo: unknown;
	}[],
	plans: readonly CanonicalAppPlan[],
): Promise<readonly FrozenMediaReferenceEdge[]> {
	const mediaRows = await sql<{
		id: string;
		project_id: string;
		status: string;
		kind: string;
	}>`
		SELECT id::text AS id, project_id, status, kind
		FROM public.media_assets
		ORDER BY convert_to(id::text, 'UTF8')
	`.execute(db);
	const mediaById = new Map(
		mediaRows.rows.map((row) => [row.id, row] as const),
	);
	const edges = new Map(
		frozenBlueprintMediaReferenceEdges(apps, plans, mediaRows.rows).map(
			(edge) => [
				`${edge.project_id}\u0000${edge.app_id}\u0000${edge.asset_id}`,
				edge,
			],
		),
	);

	const threadRows = await sql<{
		app_id: string;
		thread_id: string;
		project_id: string;
		messages: unknown;
	}>`
		SELECT
			thread_row.app_id,
			thread_row.thread_id,
			app.project_id,
			thread_row.messages
		FROM public.threads AS thread_row
		JOIN public.apps AS app ON app.id = thread_row.app_id
		ORDER BY
			convert_to(thread_row.app_id, 'UTF8'),
			convert_to(thread_row.thread_id, 'UTF8')
	`.execute(db);
	for (const row of threadRows.rows) {
		const threadPath = `threads.${canonicalIdentityDigest([
			row.app_id,
			row.thread_id,
		])}.messages`;
		const inventory = frozenThreadAttachmentInventory(row.messages);
		requireInvariant(
			inventory.shapeExact,
			`${threadPath} has malformed canonical attachment metadata`,
		);
		for (const occurrence of inventory.occurrences) {
			const asset =
				occurrence.assetId === null
					? undefined
					: mediaById.get(occurrence.assetId);
			requireInvariant(
				occurrence.exact &&
					isCanonicalAuthoredUuid(occurrence.assetId) &&
					asset?.project_id === row.project_id &&
					asset.status === "ready" &&
					asset.kind === occurrence.kind,
				`${threadPath}[${occurrence.messageIndex}].metadata.attachments[${occurrence.attachmentIndex}] is not one ready same-Project uploaded-media reference`,
			);
			if (occurrence.assetId !== null) {
				const edge = {
					project_id: row.project_id,
					app_id: row.app_id,
					asset_id: occurrence.assetId,
				};
				edges.set(
					`${edge.project_id}\u0000${edge.app_id}\u0000${edge.asset_id}`,
					edge,
				);
			}
		}
	}
	return [...edges.values()].sort(
		(left, right) =>
			Buffer.compare(
				Buffer.from(left.project_id, "utf8"),
				Buffer.from(right.project_id, "utf8"),
			) ||
			Buffer.compare(
				Buffer.from(left.app_id, "utf8"),
				Buffer.from(right.app_id, "utf8"),
			) ||
			Buffer.compare(
				Buffer.from(left.asset_id, "utf8"),
				Buffer.from(right.asset_id, "utf8"),
			),
	);
}

export async function assertFrozenMediaReferenceRows(
	db: Kysely<unknown>,
	expected: readonly FrozenMediaReferenceEdge[],
): Promise<void> {
	const actual = await sql<FrozenMediaReferenceEdge>`
		SELECT project_id, app_id, asset_id::text AS asset_id
		FROM public.media_asset_refs
		ORDER BY
			convert_to(project_id, 'UTF8'),
			convert_to(app_id, 'UTF8'),
			convert_to(asset_id::text, 'UTF8')
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(actual.rows) === canonicalIdentityDigest(expected),
		"media_asset_refs differs from the exact authored Blueprint and canonical thread-attachment edge set",
	);
	const invalidStatus = await sql<{ count: string }>`
		SELECT count(*)::text AS count
		FROM public.media_asset_refs AS reference
		JOIN public.media_assets AS asset
		  ON asset.project_id = reference.project_id
		 AND asset.id = reference.asset_id
		WHERE asset.status <> 'ready'
	`.execute(db);
	requireInvariant(
		invalidStatus.rows[0]?.count === "0",
		"media_asset_refs contains a non-ready asset",
	);
}

export async function assertFrozenMediaReferenceCatalog(
	db: Kysely<unknown>,
	security: FrozenFoldBaselineSecurityExpectation = { phase: "migration" },
): Promise<void> {
	const currentUser = (
		await sql<{ name: string }>`SELECT current_user AS name`.execute(db)
	).rows[0]?.name;
	requireInvariant(
		typeof currentUser === "string" && currentUser.length > 0,
		"current database owner identity is unavailable",
	);
	const expectedOwner =
		security.phase === "migration" ? currentUser : security.migrationRole;
	const ownerAcl = [
		"DELETE",
		"INSERT",
		"MAINTAIN",
		"REFERENCES",
		"SELECT",
		"TRIGGER",
		"TRUNCATE",
		"UPDATE",
	].map((privilege) => ({
		grantor: expectedOwner,
		grantee: expectedOwner,
		privilege,
		grantable: false,
	}));
	const expectedAcl = sortFrozenAcl([
		...ownerAcl,
		...(security.phase === "deployed"
			? [
					{
						grantor: expectedOwner,
						grantee: security.runtimeRole,
						privilege: "SELECT",
						grantable: false,
					},
					{
						grantor: expectedOwner,
						grantee: security.runtimeRole,
						privilege: "INSERT",
						grantable: false,
					},
					{
						grantor: expectedOwner,
						grantee: security.runtimeRole,
						privilege: "DELETE",
						grantable: false,
					},
					{
						grantor: expectedOwner,
						grantee: security.auditRole,
						privilege: "SELECT",
						grantable: false,
					},
				]
			: []),
	]);
	const relation = await sql<{
		relation_name: string;
		owner_name: string;
		acl: readonly {
			readonly grantor: string;
			readonly grantee: string;
			readonly privilege: string;
			readonly grantable: boolean;
		}[];
	}>`
		SELECT
			relation.relname AS relation_name,
			pg_get_userbyid(relation.relowner) AS owner_name,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'grantor', pg_get_userbyid(privilege.grantor),
							'grantee',
								CASE
									WHEN privilege.grantee = 0 THEN 'PUBLIC'
									ELSE pg_get_userbyid(privilege.grantee)
								END,
							'privilege', privilege.privilege_type,
							'grantable', privilege.is_grantable
						)
						ORDER BY
							convert_to(
								CASE
									WHEN privilege.grantee = 0 THEN 'PUBLIC'
									ELSE pg_get_userbyid(privilege.grantee)
								END,
								'UTF8'
							),
							convert_to(privilege.privilege_type, 'UTF8'),
							privilege.is_grantable
					)
					FROM aclexplode(
						COALESCE(
							relation.relacl,
							acldefault('r', relation.relowner)
						)
					) AS privilege
				),
				'[]'::jsonb
			) AS acl
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'media_asset_refs'
		  AND relation.relkind = 'r'
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(relation.rows) ===
			canonicalIdentityDigest([
				{
					relation_name: "media_asset_refs",
					owner_name: expectedOwner,
					acl: expectedAcl,
				},
			]),
		"media_asset_refs relation differs from the exact final catalog",
	);

	const columns = await sql<FrozenFoldBaselineColumn>`
		SELECT
			attribute.attname AS column_name,
			format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
			attribute.attnotnull AS not_null,
			pg_get_expr(default_value.adbin, default_value.adrelid)
				AS default_expression
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_attribute AS attribute
		  ON attribute.attrelid = relation.oid
		 AND attribute.attnum > 0
		 AND NOT attribute.attisdropped
		LEFT JOIN pg_attrdef AS default_value
		  ON default_value.adrelid = relation.oid
		 AND default_value.adnum = attribute.attnum
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'media_asset_refs'
		ORDER BY attribute.attnum
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(columns.rows) ===
			canonicalIdentityDigest([
				{
					column_name: "project_id",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "app_id",
					data_type: "text",
					not_null: true,
					default_expression: null,
				},
				{
					column_name: "asset_id",
					data_type: "uuid",
					not_null: true,
					default_expression: null,
				},
			]),
		"media_asset_refs columns differ from the exact final catalog",
	);

	const constraints = await sql<{
		constraint_name: string;
		definition: string;
		validated: boolean;
		deferrable: boolean;
		initially_deferred: boolean;
		update_action: string;
		delete_action: string;
	}>`
		SELECT
			constraint_row.conname AS constraint_name,
			pg_get_constraintdef(constraint_row.oid, true) AS definition,
			constraint_row.convalidated AS validated,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.confupdtype::text AS update_action,
			constraint_row.confdeltype::text AS delete_action
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND (
				(relation.relname = 'media_asset_refs'
				 AND constraint_row.contype NOT IN ('n', 't'))
				OR (
					relation.relname = 'media_assets'
					AND constraint_row.conname = ${MEDIA_ASSETS_PROJECT_ID_ID_KEY}
				)
		  )
		ORDER BY constraint_row.conname
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(constraints.rows) ===
			canonicalIdentityDigest(
				[
					{
						constraint_name: "media_asset_refs_pkey",
						definition: "PRIMARY KEY (project_id, app_id, asset_id)",
						validated: true,
						deferrable: false,
						initially_deferred: false,
						update_action: " ",
						delete_action: " ",
					},
					{
						constraint_name: MEDIA_ASSET_REFS_PROJECT_APP_FOREIGN_KEY,
						definition:
							"FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE",
						validated: true,
						deferrable: false,
						initially_deferred: false,
						update_action: "r",
						delete_action: "c",
					},
					{
						constraint_name: MEDIA_ASSET_REFS_PROJECT_ASSET_FOREIGN_KEY,
						definition:
							"FOREIGN KEY (project_id, asset_id) REFERENCES media_assets(project_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
						validated: true,
						deferrable: false,
						initially_deferred: false,
						update_action: "r",
						delete_action: "r",
					},
					{
						constraint_name: MEDIA_ASSETS_PROJECT_ID_ID_KEY,
						definition: "UNIQUE (project_id, id)",
						validated: true,
						deferrable: false,
						initially_deferred: false,
						update_action: " ",
						delete_action: " ",
					},
				].sort((left, right) =>
					left.constraint_name.localeCompare(right.constraint_name),
				),
			),
		"media reference constraints differ from the exact final catalog",
	);

	const indexes = await sql<{
		index_name: string;
		definition: string;
		unique: boolean;
		primary: boolean;
		valid: boolean;
		ready: boolean;
	}>`
		SELECT
			index_relation.relname AS index_name,
			pg_get_indexdef(index_relation.oid, 0, false) AS definition,
			index_row.indisunique AS unique,
			index_row.indisprimary AS primary,
			index_row.indisvalid AS valid,
			index_row.indisready AS ready
		FROM pg_index AS index_row
		JOIN pg_class AS relation ON relation.oid = index_row.indrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
		WHERE namespace.nspname = 'public'
		  AND (
				relation.relname = 'media_asset_refs'
				OR (
					relation.relname = 'media_assets'
					AND index_relation.relname = ${MEDIA_ASSETS_PROJECT_ID_ID_KEY}
				)
		  )
		ORDER BY index_relation.relname
	`.execute(db);
	requireInvariant(
		canonicalIdentityDigest(indexes.rows) ===
			canonicalIdentityDigest(
				[
					{
						index_name: "media_asset_refs_pkey",
						definition:
							"CREATE UNIQUE INDEX media_asset_refs_pkey ON public.media_asset_refs USING btree (project_id, app_id, asset_id)",
						unique: true,
						primary: true,
						valid: true,
						ready: true,
					},
					{
						index_name: MEDIA_ASSET_REFS_PROJECT_ASSET_APP_INDEX,
						definition:
							"CREATE INDEX media_asset_refs_project_asset_app_idx ON public.media_asset_refs USING btree (project_id, asset_id, app_id)",
						unique: false,
						primary: false,
						valid: true,
						ready: true,
					},
					{
						index_name: MEDIA_ASSETS_PROJECT_ID_ID_KEY,
						definition:
							"CREATE UNIQUE INDEX media_assets_project_id_id_key ON public.media_assets USING btree (project_id, id)",
						unique: true,
						primary: false,
						valid: true,
						ready: true,
					},
				].sort((left, right) =>
					left.index_name.localeCompare(right.index_name),
				),
			),
		"media reference indexes differ from the exact final catalog",
	);

	const retired = await sql<{ relation_name: string | null }>`
		SELECT to_regclass('public.media_reference_index_state')::text
			AS relation_name
	`.execute(db);
	requireInvariant(
		retired.rows[0]?.relation_name === null,
		"media_reference_index_state survived the exact final cutover",
	);
}

function walkPath(
	value: unknown,
	segments: readonly string[],
	visit: (value: unknown) => void,
): void {
	if (segments.length === 0) {
		visit(value);
		return;
	}
	const [head, ...tail] = segments;
	if (head === undefined) return;
	const array = head.endsWith("[]");
	const key = array ? head.slice(0, -2) : head;
	if (!isRecord(value)) return;
	const child = value[key];
	if (array) {
		if (!Array.isArray(child)) return;
		for (const entry of child) walkPath(entry, tail, visit);
		return;
	}
	walkPath(child, tail, visit);
}

function collectAuthoredIdentities(
	rows: readonly LegacyEntityRow[],
): Set<string> {
	const identities = new Set<string>();
	for (const row of rows) {
		if (isCanonicalAuthoredUuid(row.uuid)) identities.add(row.uuid);
		for (const occurrence of FROZEN_ENTITY_OCCURRENCES) {
			if (
				occurrence.entity !== row.kind ||
				occurrence.surface !== "identity" ||
				occurrence.path === "uuid"
			) {
				continue;
			}
			walkPath(row.data, occurrence.path.split("."), (value) => {
				if (isCanonicalAuthoredUuid(value)) identities.add(value);
			});
		}
	}
	return identities;
}

function legacyOptionTargets(rows: readonly LegacyEntityRow[]): string[] {
	const targets: string[] = [];
	for (const row of rows) {
		if (row.kind !== "field") continue;
		const source = isRecord(row.data.optionsSource)
			? row.data.optionsSource
			: undefined;
		const options =
			source?.kind === "inline" && Array.isArray(source.options)
				? source.options
				: Array.isArray(row.data.options)
					? row.data.options
					: [];
		for (const [index, value] of options.entries()) {
			if (!isRecord(value)) continue;
			const legacy = `${row.uuid}-opt-${index}`;
			if (value.uuid === legacy) targets.push(legacyOptionUuidV5(legacy));
		}
	}
	return targets;
}

async function sqlColumnTypes(
	db: Kysely<unknown>,
): Promise<Map<string, string>> {
	const rows = await sql<{
		table_name: string;
		column_name: string;
		data_type: string;
	}>`
		SELECT table_name, column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND (table_name, column_name) IN (
			  ${sql.join(
					SQL_IDENTITY_COLUMNS.map(
						([table, column]) => sql`(${table}, ${column})`,
					),
				)}
		  )
		ORDER BY table_name, column_name
	`.execute(db);
	return new Map(
		rows.rows.map((row) => [
			`${row.table_name}.${row.column_name}`,
			row.data_type,
		]),
	);
}

function assertSqlIdentitySchema(
	types: ReadonlyMap<string, string>,
	expected: "text" | "uuid",
): void {
	for (const [table, column] of SQL_IDENTITY_COLUMNS) {
		requireInvariant(
			types.get(`${table}.${column}`) === expected,
			`${table}.${column} must be ${expected} before this phase`,
		);
	}
}

const sqlIdentityTargetValues = sql.join(
	SQL_IDENTITY_COLUMNS.map(
		([table, column]) => sql`(${table}::text, ${column}::text)`,
	),
);

/**
 * Freeze a catalog-derived dependency closure around every semantic SQL
 * identity column. The snapshot deliberately captures a superset of direct
 * dependents (all constraints, indexes, and non-internal triggers on a target
 * relation, plus foreign keys that point at one) so an unanticipated object can
 * never disappear merely because its dependency spelling differs.
 *
 * OIDs are excluded: dropping and recreating a foreign key necessarily assigns
 * new catalog identities. Stable schema/table/object names, exact definitions,
 * ownership, ACLs, affected columns, flags, and non-internal pg_depend
 * descriptions are the comparison surface.
 */
async function captureSqlIdentitySchema(
	db: Kysely<unknown>,
): Promise<FrozenSqlIdentitySchema> {
	const columns = await sql<Record<string, unknown>>`
		WITH target_names(table_name, column_name) AS (
			VALUES ${sqlIdentityTargetValues}
		)
		SELECT
			n.nspname AS schema_name,
			c.relname AS table_name,
			a.attname AS column_name,
			format_type(a.atttypid, a.atttypmod) AS data_type,
			a.attnotnull AS not_null,
			pg_get_expr(ad.adbin, ad.adrelid) AS default_expression,
			pg_get_userbyid(c.relowner) AS table_owner,
			COALESCE(to_jsonb(c.relacl), '[]'::jsonb) AS table_acl,
			COALESCE(to_jsonb(a.attacl), '[]'::jsonb) AS column_acl
		FROM target_names target
		JOIN pg_namespace n ON n.nspname = 'public'
		JOIN pg_class c
		  ON c.relnamespace = n.oid
		 AND c.relname = target.table_name
		 AND c.relkind IN ('r', 'p')
		JOIN pg_attribute a
		  ON a.attrelid = c.oid
		 AND a.attname = target.column_name
		 AND a.attnum > 0
		 AND NOT a.attisdropped
		LEFT JOIN pg_attrdef ad
		  ON ad.adrelid = a.attrelid
		 AND ad.adnum = a.attnum
		ORDER BY n.nspname, c.relname, a.attname
	`.execute(db);

	requireInvariant(
		columns.rows.length === SQL_IDENTITY_COLUMNS.length,
		"every SQL identity column must exist exactly once",
	);

	const constraints = await sql<FrozenSqlConstraint>`
		WITH target_names(table_name, column_name) AS (
			VALUES ${sqlIdentityTargetValues}
		),
		targets AS (
			SELECT c.oid AS relid, a.attnum
			FROM target_names target
			JOIN pg_namespace n ON n.nspname = 'public'
			JOIN pg_class c
			  ON c.relnamespace = n.oid
			 AND c.relname = target.table_name
			JOIN pg_attribute a
			  ON a.attrelid = c.oid
			 AND a.attname = target.column_name
			 AND a.attnum > 0
			 AND NOT a.attisdropped
		)
		SELECT
			n.nspname AS schema_name,
			rel.relname AS table_name,
			con.conname AS constraint_name,
			con.contype::text AS constraint_type,
			pg_get_constraintdef(con.oid, false) AS definition,
			con.condeferrable AS deferrable,
			con.condeferred AS initially_deferred,
			con.convalidated AS validated,
			con.conislocal AS local,
			(
				EXISTS (
					SELECT 1
					FROM unnest(COALESCE(con.conkey, '{}'::smallint[])) key(attnum)
					JOIN targets target
					  ON target.relid = con.conrelid
					 AND target.attnum = key.attnum
				)
				OR EXISTS (
					SELECT 1
					FROM unnest(COALESCE(con.confkey, '{}'::smallint[])) key(attnum)
					JOIN targets target
					  ON target.relid = con.confrelid
					 AND target.attnum = key.attnum
				)
			) AS touches_target,
			COALESCE(
				ARRAY(
					SELECT attribute.attname
					FROM unnest(COALESCE(con.conkey, '{}'::smallint[]))
						WITH ORDINALITY key(attnum, ordinal)
					JOIN pg_attribute attribute
					  ON attribute.attrelid = con.conrelid
					 AND attribute.attnum = key.attnum
					ORDER BY key.ordinal
				),
				'{}'::text[]
			) AS columns,
			referenced_namespace.nspname AS referenced_schema,
			referenced_relation.relname AS referenced_table,
			COALESCE(
				ARRAY(
					SELECT attribute.attname
					FROM unnest(COALESCE(con.confkey, '{}'::smallint[]))
						WITH ORDINALITY key(attnum, ordinal)
					JOIN pg_attribute attribute
					  ON attribute.attrelid = con.confrelid
					 AND attribute.attnum = key.attnum
					ORDER BY key.ordinal
				),
				'{}'::text[]
			) AS referenced_columns
		FROM pg_constraint con
		JOIN pg_class rel ON rel.oid = con.conrelid
		JOIN pg_namespace n ON n.oid = rel.relnamespace
		LEFT JOIN pg_class referenced_relation
		  ON referenced_relation.oid = con.confrelid
		LEFT JOIN pg_namespace referenced_namespace
		  ON referenced_namespace.oid = referenced_relation.relnamespace
		WHERE con.conrelid IN (SELECT relid FROM targets)
		   OR con.confrelid IN (SELECT relid FROM targets)
		ORDER BY n.nspname, rel.relname, con.conname
	`.execute(db);

	const indexes = await sql<Record<string, unknown>>`
		WITH target_names(table_name, column_name) AS (
			VALUES ${sqlIdentityTargetValues}
		),
		target_relations AS (
			SELECT DISTINCT c.oid AS relid
			FROM target_names target
			JOIN pg_namespace n ON n.nspname = 'public'
			JOIN pg_class c
			  ON c.relnamespace = n.oid
			 AND c.relname = target.table_name
		)
		SELECT
			n.nspname AS schema_name,
			table_relation.relname AS table_name,
			index_relation.relname AS index_name,
			pg_get_indexdef(index_relation.oid, 0, false) AS definition,
			index_info.indisprimary AS primary,
			index_info.indisunique AS unique,
			index_info.indisvalid AS valid,
			index_info.indisready AS ready,
			pg_get_expr(index_info.indpred, index_info.indrelid) AS predicate,
			pg_get_expr(index_info.indexprs, index_info.indrelid) AS expressions,
			pg_get_userbyid(index_relation.relowner) AS owner
		FROM pg_index index_info
		JOIN target_relations target
		  ON target.relid = index_info.indrelid
		JOIN pg_class table_relation
		  ON table_relation.oid = index_info.indrelid
		JOIN pg_class index_relation
		  ON index_relation.oid = index_info.indexrelid
		JOIN pg_namespace n
		  ON n.oid = table_relation.relnamespace
		ORDER BY n.nspname, table_relation.relname, index_relation.relname
	`.execute(db);

	const triggers = await sql<Record<string, unknown>>`
		WITH target_names(table_name, column_name) AS (
			VALUES ${sqlIdentityTargetValues}
		),
		target_relations AS (
			SELECT DISTINCT c.oid AS relid
			FROM target_names target
			JOIN pg_namespace n ON n.nspname = 'public'
			JOIN pg_class c
			  ON c.relnamespace = n.oid
			 AND c.relname = target.table_name
		)
		SELECT
			n.nspname AS schema_name,
			relation.relname AS table_name,
			trigger.tgname AS trigger_name,
			pg_get_triggerdef(trigger.oid, false) AS definition,
			trigger.tgenabled::text AS enabled,
			function_namespace.nspname AS function_schema,
			function.proname AS function_name,
			pg_get_function_identity_arguments(function.oid) AS function_arguments,
			pg_get_userbyid(function.proowner) AS function_owner,
			COALESCE(to_jsonb(function.proacl), '[]'::jsonb) AS function_acl
		FROM pg_trigger trigger
		JOIN target_relations target ON target.relid = trigger.tgrelid
		JOIN pg_class relation ON relation.oid = trigger.tgrelid
		JOIN pg_namespace n ON n.oid = relation.relnamespace
		JOIN pg_proc function ON function.oid = trigger.tgfoid
		JOIN pg_namespace function_namespace
		  ON function_namespace.oid = function.pronamespace
		WHERE NOT trigger.tgisinternal
		ORDER BY n.nspname, relation.relname, trigger.tgname
	`.execute(db);

	const dependencyEdges = await sql<Record<string, unknown>>`
		WITH RECURSIVE target_names(table_name, column_name) AS (
			VALUES ${sqlIdentityTargetValues}
		),
		targets AS (
			SELECT c.oid AS relid, a.attnum
			FROM target_names target
			JOIN pg_namespace n ON n.nspname = 'public'
			JOIN pg_class c
			  ON c.relnamespace = n.oid
			 AND c.relname = target.table_name
			JOIN pg_attribute a
			  ON a.attrelid = c.oid
			 AND a.attname = target.column_name
			 AND a.attnum > 0
			 AND NOT a.attisdropped
		),
		closure(classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype) AS (
			SELECT
				dependency.classid,
				dependency.objid,
				dependency.objsubid,
				dependency.refclassid,
				dependency.refobjid,
				dependency.refobjsubid,
				dependency.deptype
			FROM pg_depend dependency
			JOIN targets target
			  ON dependency.refclassid = 'pg_class'::regclass
			 AND dependency.refobjid = target.relid
			 AND dependency.refobjsubid = target.attnum
			UNION
			SELECT
				dependency.classid,
				dependency.objid,
				dependency.objsubid,
				dependency.refclassid,
				dependency.refobjid,
				dependency.refobjsubid,
				dependency.deptype
			FROM pg_depend dependency
			JOIN closure parent
			  ON dependency.refclassid = parent.classid
			 AND dependency.refobjid = parent.objid
			 AND (
					parent.objsubid = 0
					OR dependency.refobjsubid = parent.objsubid
					OR dependency.refobjsubid = 0
			 )
		)
		SELECT DISTINCT
			classid::regclass::text AS dependent_catalog,
			pg_describe_object(classid, objid, objsubid) AS dependent,
			refclassid::regclass::text AS referenced_catalog,
			pg_describe_object(refclassid, refobjid, refobjsubid) AS referenced,
			deptype::text AS dependency_type
		FROM closure
		WHERE NOT (
			classid = 'pg_trigger'::regclass
			AND EXISTS (
				SELECT 1
				FROM pg_trigger trigger
				WHERE trigger.oid = closure.objid
				  AND trigger.tgisinternal
			)
		)
		ORDER BY
			dependent_catalog,
			dependent,
			referenced_catalog,
			referenced,
			dependency_type
	`.execute(db);

	return {
		columns: columns.rows,
		constraints: constraints.rows,
		indexes: indexes.rows,
		triggers: triggers.rows,
		dependency_edges: dependencyEdges.rows,
	};
}

export async function readFrozenSqlIdentityStructuralDigest(
	db: Kysely<unknown>,
): Promise<string> {
	return frozenSqlIdentityStructuralDigest(await captureSqlIdentitySchema(db));
}

function frozenSqlIdentityStructuralDigest(
	schema: FrozenSqlIdentitySchema,
): string {
	return canonicalIdentityDigest(frozenSqlIdentityStructuralSchema(schema));
}

export async function assertFrozenSqlIdentityStructuralCatalog(
	db: Kysely<unknown>,
	expected: "text" | "uuid",
): Promise<void> {
	const actual = await readFrozenSqlIdentityStructuralDigest(db);
	const expectedDigest =
		expected === "text"
			? FROZEN_TEXT_SQL_IDENTITY_STRUCTURAL_DIGEST
			: FROZEN_UUID_SQL_IDENTITY_STRUCTURAL_DIGEST;
	requireInvariant(
		actual === expectedDigest,
		`the ${expected} SQL identity dependency closure differs from the frozen exact catalog (${actual})`,
	);
}

function expectedUuidSqlIdentitySchema(
	source: FrozenSqlIdentitySchema,
): FrozenSqlIdentitySchema {
	return {
		...source,
		columns: source.columns.map((column) => ({
			...column,
			data_type: "uuid",
		})),
	};
}

function schemaQualifiedName(schemaName: string, objectName: string) {
	return sql.id(schemaName, objectName);
}

async function convertSqlIdentityColumns(db: Kysely<unknown>): Promise<void> {
	const source = await captureSqlIdentitySchema(db);
	const observedTextStructuralDigest =
		frozenSqlIdentityStructuralDigest(source);
	requireInvariant(
		observedTextStructuralDigest === FROZEN_TEXT_SQL_IDENTITY_STRUCTURAL_DIGEST,
		`the text SQL identity dependency closure differs from the frozen exact catalog (${observedTextStructuralDigest})`,
	);
	const sourceDigest = canonicalIdentityDigest(source);
	const expected = expectedUuidSqlIdentitySchema(source);
	const expectedDigest = canonicalIdentityDigest(expected);
	requireInvariant(
		sourceDigest !== expectedDigest,
		"SQL identity source and UUID target catalog digests must differ",
	);

	const blockingForeignKeys = source.constraints.filter(
		(constraint) =>
			constraint.constraint_type === "f" && constraint.touches_target,
	);
	for (const constraint of blockingForeignKeys) {
		await sql`
			ALTER TABLE ${schemaQualifiedName(
				constraint.schema_name,
				constraint.table_name,
			)}
			DROP CONSTRAINT ${sql.id(constraint.constraint_name)}
		`.execute(db);
	}

	await sql`
		ALTER TABLE apps
			ALTER COLUMN logo TYPE uuid USING logo::uuid;
		ALTER TABLE blueprint_entities
			ALTER COLUMN uuid TYPE uuid USING uuid::uuid,
			ALTER COLUMN parent_uuid TYPE uuid USING parent_uuid::uuid;
		ALTER TABLE media_assets
			ALTER COLUMN id TYPE uuid USING id::uuid;
		ALTER TABLE media_upload_aliases
			ALTER COLUMN attempt_asset_id TYPE uuid USING attempt_asset_id::uuid,
			ALTER COLUMN canonical_asset_id TYPE uuid USING canonical_asset_id::uuid;
		ALTER TABLE media_asset_refs
			ALTER COLUMN asset_id TYPE uuid USING asset_id::uuid;
		ALTER TABLE form_submission_intents
			ALTER COLUMN form_uuid TYPE uuid USING form_uuid::uuid;
		ALTER TABLE form_attachments
			ALTER COLUMN field_uuid TYPE uuid USING field_uuid::uuid
	`.execute(db);

	for (const constraint of blockingForeignKeys) {
		await sql`
			ALTER TABLE ${schemaQualifiedName(
				constraint.schema_name,
				constraint.table_name,
			)}
			ADD CONSTRAINT ${sql.id(constraint.constraint_name)}
			${sql.raw(constraint.definition)}
		`.execute(db);
	}

	const actual = await captureSqlIdentitySchema(db);
	requireInvariant(
		canonicalIdentityDigest(actual) === expectedDigest,
		"SQL identity dependency closure changed outside the exact UUID type conversion",
	);
	requireInvariant(
		frozenSqlIdentityStructuralDigest(actual) ===
			FROZEN_UUID_SQL_IDENTITY_CONVERSION_DIGEST,
		`the immediate UUID SQL identity dependency closure differs from the frozen exact conversion catalog (${frozenSqlIdentityStructuralDigest(actual)} != ${FROZEN_UUID_SQL_IDENTITY_CONVERSION_DIGEST})`,
	);
}

async function appliedForEveryApp(db: Kysely<unknown>): Promise<boolean> {
	const row = await sql<{
		apps: string;
		baseline_apps: string;
		horizons: string;
		baselines: string;
	}>`
		SELECT
			(SELECT count(*)::text FROM apps) AS apps,
			(
				SELECT count(DISTINCT baseline.app_id)::text
				FROM app_change_fold_baselines AS baseline
			) AS baseline_apps,
			(
				SELECT count(*)::text
				FROM app_changes AS marker
				JOIN app_change_fold_baselines AS baseline
				  ON baseline.app_id = marker.app_id
				 AND baseline.seq = marker.seq
			) AS horizons,
			(SELECT count(*)::text FROM app_change_fold_baselines) AS baselines
	`.execute(db);
	const counts = row.rows[0];
	return (
		counts !== undefined &&
		counts.apps === counts.baseline_apps &&
		counts.horizons === counts.baselines &&
		BigInt(counts.baselines) >= BigInt(counts.apps)
	);
}

async function assertAlreadyAppliedState(db: Kysely<unknown>): Promise<void> {
	requireInvariant(
		await appliedForEveryApp(db),
		"every app must have at least one exact immutable fold baseline",
	);
	const currentRows = await loadFrozenCurrentRows(db);
	const baselineResult = await sql<{
		app_id: string;
		seq: string;
		project_id: string;
		snapshot_text: string;
		snapshot_digest: string;
		computed_snapshot_digest: string;
		current_snapshot_digest: string;
		batch_id: string;
		run_id: string | null;
		actor_id: string;
		kind: string;
		mutations_text: string;
		marker_empty: boolean;
		from_project_id: string | null;
		to_project_id: string | null;
	}>`
		SELECT baseline.app_id, baseline.seq::text, baseline.project_id,
		       baseline.snapshot::text AS snapshot_text,
		       baseline.snapshot_digest,
		       nova_app_change_fold_snapshot_digest(baseline.snapshot)
		         AS computed_snapshot_digest,
		       nova_app_change_fold_snapshot_digest(
		         nova_current_app_change_fold_snapshot(baseline.app_id)
		       ) AS current_snapshot_digest,
		       marker.batch_id, marker.run_id,
		       marker.actor_id, marker.kind,
		       marker.mutations::text AS mutations_text,
		       marker.mutations = '[]'::jsonb AS marker_empty,
		       marker.from_project_id,
		       marker.to_project_id
		FROM app_change_fold_baselines AS baseline
		JOIN app_changes AS marker
		  ON marker.app_id = baseline.app_id
		 AND marker.seq = baseline.seq
		ORDER BY baseline.app_id, baseline.seq
	`.execute(db);
	const suffixResult = await sql<
		Omit<FrozenCanonicalAppChangeSuffixRow, "mutationsText"> & {
			app_id: string;
			mutations_text: string;
			from_project_id: string | null;
			to_project_id: string | null;
		}
	>`
		WITH greatest_baseline AS (
			SELECT DISTINCT ON (baseline.app_id)
				baseline.app_id,
				baseline.seq
			FROM app_change_fold_baselines AS baseline
			ORDER BY baseline.app_id, baseline.seq DESC
		)
		SELECT mutation.app_id, mutation.seq::text, mutation.batch_id,
		       mutation.run_id, mutation.actor_id, mutation.kind,
		       mutation.mutations::text AS mutations_text,
		       mutation.from_project_id,
		       mutation.to_project_id
		FROM app_changes AS mutation
		JOIN greatest_baseline AS baseline
		  ON baseline.app_id = mutation.app_id
		 AND mutation.seq > baseline.seq
		ORDER BY mutation.app_id, mutation.seq
	`.execute(db);
	const baselineEntries = baselineResult.rows.map((row, index) => ({
		id: `app_change_fold_baselines.snapshot[${index}]`,
		sourceText: row.snapshot_text,
	}));
	const verifiedFoldJson = await verifyFrozenJsonCarriers(db, baselineEntries);
	const baselines = baselineResult.rows.map((row, index) => ({
		...row,
		snapshotCarrier: requiredCarrier(
			verifiedFoldJson,
			baselineEntries[index]?.id ?? "",
		),
	}));
	const baselineByApp = new Map(
		baselines.map((row) => [row.app_id, row] as const),
	);
	const appById = new Map(
		currentRows.apps.map((app) => [app.id, app] as const),
	);
	for (const baseline of baselines) {
		const app = appById.get(baseline.app_id);
		requireInvariant(
			app !== undefined,
			`fold baseline ${canonicalIdentityDigest(
				`${baseline.app_id}\u0000${baseline.seq}`,
			)} has no app`,
		);
		const exactHorizon =
			baseline.batch_id === HORIZON_BATCH_ID &&
			baseline.run_id === null &&
			baseline.actor_id === HORIZON_ACTOR_ID;
		const exactGenesis =
			baseline.seq === "1" &&
			baseline.batch_id === `genesis:${app.id}` &&
			baseline.actor_id === app.owner &&
			baseline.run_id === app.run_id;
		requireInvariant(
			(exactHorizon || exactGenesis) &&
				baseline.kind === "fold-baseline" &&
				baseline.marker_empty &&
				baseline.from_project_id === null &&
				baseline.to_project_id === null,
			`fold baseline ${canonicalIdentityDigest(
				`${baseline.app_id}\u0000${baseline.seq}`,
			)} has a malformed marker`,
		);
		requireInvariant(
			baseline.snapshot_digest === baseline.computed_snapshot_digest,
			`fold baseline ${canonicalIdentityDigest(
				`${baseline.app_id}\u0000${baseline.seq}`,
			)} digest drifted`,
		);
		materializeNonNullJson(baseline.snapshotCarrier, "fold_baseline");
	}
	const suffixByApp = new Map<string, FrozenCanonicalAppChangeSuffixRow[]>();
	for (const row of suffixResult.rows) {
		const suffix = suffixByApp.get(row.app_id) ?? [];
		suffix.push({
			seq: row.seq,
			batch_id: row.batch_id,
			run_id: row.run_id,
			actor_id: row.actor_id,
			kind: row.kind,
			from_project_id: row.from_project_id,
			to_project_id: row.to_project_id,
			mutationsText: row.mutations_text,
		});
		suffixByApp.set(row.app_id, suffix);
	}
	const rowsByApp = new Map<string, LegacyEntityRow[]>();
	for (const row of currentRows.entities) {
		const rows = rowsByApp.get(row.app_id) ?? [];
		rows.push({
			appId: row.app_id,
			uuid: row.uuid,
			kind: row.kind as LegacyEntityKind,
			parentUuid: row.parent_uuid,
			ordinal: row.ordinal,
			data: row.data,
		});
		rowsByApp.set(row.app_id, rows);
	}
	const lookupContextByProject = new Map<
		string,
		FrozenLookupValidationContext
	>();
	const appliedPlans: CanonicalAppPlan[] = [];
	for (const app of currentRows.apps) {
		let lookupContext = lookupContextByProject.get(app.project_id);
		if (lookupContext === undefined) {
			lookupContext = await readFrozenProjectLookupContext(db, app.project_id);
			lookupContextByProject.set(app.project_id, lookupContext);
		}
		const baseline = baselineByApp.get(app.id);
		requireInvariant(
			baseline !== undefined,
			`app ${canonicalIdentityDigest(app.id)} has no fold baseline`,
		);
		const plan = planCanonicalAppMigration({
			appId: app.id,
			appName: app.app_name,
			connectType: app.connect_type,
			caseTypes: app.case_types,
			logo: app.logo,
			mutationSeq: app.mutation_seq,
			rows: rowsByApp.get(app.id) ?? [],
		});
		appliedPlans.push(plan);
		requireInvariant(
			plan.findings.length === 0 && plan.beforeDigest === plan.afterDigest,
			`app ${canonicalIdentityDigest(app.id)} is not canonical after the cutover`,
		);
		decodeFrozenStoredApp(
			{
				id: app.id,
				appName: app.app_name,
				connectType: app.connect_type,
				caseTypes: requiredCarrier(currentRows.appJson, app.id),
				logo: app.logo,
				mutationSeq: app.mutation_seq,
			},
			(rowsByApp.get(app.id) ?? []).map((row) => ({
				appId: row.appId,
				uuid: row.uuid,
				kind: row.kind,
				parentUuid: row.parentUuid,
				ordinal: row.ordinal,
				data: requiredCarrier(
					currentRows.entityJson,
					`${row.appId}\u0000${row.uuid}`,
				),
			})),
			lookupContext,
		);
		const expectedSnapshot = frozenPersistableSnapshot(app, plan);
		const expectedDigest = (
			await sql<{ digest: string }>`
				SELECT nova_app_change_fold_snapshot_digest(
					${JSON.stringify(expectedSnapshot)}::jsonb
				) AS digest
			`.execute(db)
		).rows[0]?.digest;
		requireInvariant(
			expectedDigest === baseline.current_snapshot_digest,
			`app ${canonicalIdentityDigest(app.id)} current rows do not equal the frozen assembled snapshot`,
		);
		const suffix = suffixByApp.get(app.id) ?? [];
		if (suffix.length === 0) {
			requireInvariant(
				String(app.mutation_seq) === baseline.seq &&
					baseline.snapshot_digest === baseline.current_snapshot_digest,
				`app ${canonicalIdentityDigest(app.id)} baseline does not equal its current no-suffix snapshot`,
			);
			continue;
		}
		const replayed = replayFrozenCanonicalAppChangeSuffix({
			baselineSnapshotText: baseline.snapshot_text,
			baselineSeq: baseline.seq,
			baselineProjectId: baseline.project_id,
			expectedHeadSeq: app.mutation_seq,
			expectedFinalProjectId: app.project_id,
			suffix,
			finalLookupContext: lookupContext,
		});
		const replayedDigest = (
			await sql<{ digest: string }>`
				SELECT nova_app_change_fold_snapshot_digest(
					${JSON.stringify(replayed.snapshot)}::jsonb
				) AS digest
			`.execute(db)
		).rows[0]?.digest;
		requireInvariant(
			replayedDigest === baseline.current_snapshot_digest,
			`app ${canonicalIdentityDigest(app.id)} app-change suffix replay does not equal current state`,
		);
	}
	const expectedMediaEdges = await frozenExpectedMediaReferenceEdges(
		db,
		currentRows.apps,
		appliedPlans,
	);
	await assertFrozenMediaReferenceCatalog(db);
	await assertFrozenMediaReferenceRows(db, expectedMediaEdges);
}

export async function runFrozenCanonicalIdentityMigration(
	db: Kysely<unknown>,
	options: FrozenMigrationOptions = {},
): Promise<FrozenMigrationReport> {
	// Kysely's Migrator invokes each `up` inside one transaction already.
	// Starting another transaction from that Transaction handle is forbidden;
	// the complete deterministic table lock below supplies the immutable
	// authoritative snapshot after Kysely has touched its migration ledger.
	const tx = db;
	await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
	await sql`SET LOCAL statement_timeout = '960s'`.execute(tx);
	await sql`
		SET LOCAL idle_in_transaction_session_timeout = '990s'
	`.execute(tx);
	const casesSchema = await resolveFrozenCasesSchema(tx);
	const baselineObjectKeys = await readFrozenFoldFamilyObjectKeys(tx);
	const lifecycleTableNames = [
		...new Set(
			FROZEN_RELATION_CANDIDATE_PHYSICAL_RELATIONS.map(
				(relation) => relation.table,
			),
		),
	];
	const appCountBeforeLock = (
		await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM public.apps
		`.execute(tx)
	).rows[0]?.count;
	requireInvariant(
		appCountBeforeLock !== undefined,
		"the frozen relation lifecycle could not count apps",
	);
	const observedRelations = await sql<{
		schema_name: string;
		table_name: string;
	}>`
		SELECT namespace.nspname AS schema_name, relation.relname AS table_name
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE relation.relkind IN ('r', 'p')
		  AND relation.relname = ANY(${sql.val(lifecycleTableNames)})
		ORDER BY
			convert_to(namespace.nspname, 'UTF8'),
			convert_to(relation.relname, 'UTF8')
	`.execute(tx);
	const catalogLifecycle = classifyFrozenObservedCatalogLifecycle({
		purpose: "migration-or-scan",
		appCount: appCountBeforeLock,
		observedRelations: observedRelations.rows.map((row) => ({
			schema: row.schema_name,
			table: row.table_name,
		})),
		observedFoldObjectKeys: baselineObjectKeys,
	});
	requireInvariant(
		catalogLifecycle.state === "pristine" || catalogLifecycle.state === "final",
		[
			"the frozen relation/object lifecycle is drifted",
			`missing=${catalogLifecycle.relations.missingRelations.join(",")}`,
			`unexpected=${catalogLifecycle.relations.unexpectedRelations.join(",")}`,
			`duplicate=${catalogLifecycle.relations.duplicateRelations.join(",")}`,
			`fold-missing=${catalogLifecycle.foldFamily.missingObjects.join(",")}`,
			`fold-unexpected=${catalogLifecycle.foldFamily.unexpectedObjects.join(",")}`,
		].join("; "),
	);
	const existingRelations = catalogLifecycle.relations.lockableRelations.map(
		(relation) => ({
			schema_name: relation.schema,
			table_name: relation.table,
		}),
	);
	const existingRelationKeys = new Set(
		existingRelations.map((row) => `${row.schema_name}\u0000${row.table_name}`),
	);
	// One deterministic lock statement, projected from the frozen
	// occurrence manifest. SHARE ROW EXCLUSIVE blocks every application
	// writer before the authoritative scan; later ALTERs promote their
	// own tables to ACCESS EXCLUSIVE within this same transaction.
	await sql`
				LOCK TABLE ${sql.join(
					existingRelations.map((relation) =>
						sql.id(relation.schema_name, relation.table_name),
					),
				)} IN SHARE ROW EXCLUSIVE MODE
			`.execute(tx);

	const lockRelations = existingRelations.map(
		(relation) => `${relation.schema_name}.${relation.table_name}`,
	);
	const catalogEvidence = await captureFrozenCutoverCatalogEvidence(
		tx,
		casesSchema,
	);
	const leaseState = await captureFrozenCutoverLeaseState(tx);
	const rawCutoverSource = await captureFrozenStorageSnapshot(tx);
	const initialTypes = await sqlColumnTypes(tx);
	const initialProjectTenancy = await captureFrozenProjectTenancyCatalog(
		tx,
		casesSchema,
	);
	const typeSet = new Set(initialTypes.values());
	requireInvariant(
		typeSet.size === 1 && (typeSet.has("text") || typeSet.has("uuid")),
		"the authored-identity SQL columns are in a partial or unexpected schema state",
	);
	const currentRows = await loadFrozenCurrentRows(tx);
	const baselineRows = existingRelationKeys.has(
		`public\u0000app_change_fold_baselines`,
	)
		? (
				await sql<{
					app_id: string;
					seq: string;
					snapshot_digest: string;
				}>`
					SELECT app_id, seq::text, snapshot_digest
					FROM app_change_fold_baselines
					ORDER BY convert_to(app_id, 'UTF8'), seq
				`.execute(tx)
			).rows
		: [];
	const cutoverState = classifyFrozenMigrationCutoverState({
		identitySqlType: typeSet.has("text")
			? "text"
			: typeSet.has("uuid")
				? "uuid"
				: "other",
		baselineCatalog:
			baselineObjectKeys.length === 0
				? "absent"
				: canonicalIdentityDigest(baselineObjectKeys) ===
						canonicalIdentityDigest(FROZEN_FOLD_FAMILY_OBJECT_KEYS)
					? "exact"
					: "partial-or-drift",
		appCount: currentRows.apps.length.toString(),
		baselineAppCount: new Set(
			baselineRows.map((row) => row.app_id),
		).size.toString(),
		baselineCount: baselineRows.length.toString(),
	});
	requireInvariant(
		cutoverState === "pristine" || cutoverState === "applied",
		"the canonical identity cutover is in a mixed or drifted state",
	);
	if (typeSet.has("uuid")) {
		requireInvariant(
			cutoverState === "applied",
			"the UUID SQL state does not have the exact applied CutoverPlan",
		);
		requireInvariant(
			canonicalIdentityDigest(baselineObjectKeys) ===
				canonicalIdentityDigest(FROZEN_FOLD_FAMILY_OBJECT_KEYS),
			"the applied fold-baseline catalog is absent, partial, duplicated, or in the wrong schema",
		);
		await assertFrozenFoldBaselineCatalog(tx);
		assertSqlIdentitySchema(initialTypes, "uuid");
		await assertFrozenSqlIdentityStructuralCatalog(tx, "uuid");
		assertFrozenProjectTenancyCatalog(
			initialProjectTenancy,
			casesSchema,
			"final",
		);
		await assertFrozenProjectTenancyRows(tx, casesSchema);
		await assertFrozenAppChangeProjectRows(tx);
		await assertAlreadyAppliedState(tx);
		await assertNoFrozenStandardPropertyIndexes(tx);
		const rowsByApp = new Map<string, LegacyEntityRow[]>();
		for (const row of currentRows.entities) {
			const rows = rowsByApp.get(row.app_id) ?? [];
			rows.push({
				appId: row.app_id,
				uuid: row.uuid,
				kind: row.kind as LegacyEntityKind,
				parentUuid: row.parent_uuid,
				ordinal: row.ordinal,
				data: row.data,
			});
			rowsByApp.set(row.app_id, rows);
		}
		const appliedPlans = currentRows.apps.map((app) =>
			planCanonicalAppMigration({
				appId: app.id,
				appName: app.app_name,
				connectType: app.connect_type,
				caseTypes: app.case_types,
				logo: app.logo,
				mutationSeq: app.mutation_seq,
				rows: rowsByApp.get(app.id) ?? [],
			}),
		);
		const cutoverPlan = await createFrozenMigrationCutoverPlan({
			tx,
			state: "applied",
			currentRows,
			plans: appliedPlans,
			rawSource: rawCutoverSource,
			lockRelations,
			leaseState,
			catalog: catalogEvidence,
			baselineRows,
			rewriteBytes: "0",
		});
		const observedOccurrences =
			dispatchFrozenStorageOccurrences(rawCutoverSource);
		const observedBlocker = observedOccurrences.find(
			(entry) => entry.disposition === "block-current" && entry.rowCount > 0,
		);
		requireInvariant(
			observedBlocker === undefined,
			`the applied frozen occurrence audit has block-current rows at ${observedBlocker?.id ?? "unknown"}`,
		);
		const observedDigest = canonicalIdentityDigest(observedOccurrences);
		return {
			version: CANONICAL_IDENTITY_MIGRATION_VERSION,
			alreadyApplied: true,
			apps: 0,
			entities: 0,
			archivedMutationEvents: 0,
			rewriteBytes: 0,
			beforeDigest: canonicalIdentityDigest("already-applied"),
			afterDigest: canonicalIdentityDigest("already-applied"),
			occurrenceSourceDigest: observedDigest,
			occurrenceResultDigest: observedDigest,
			occurrencePlanDigest: canonicalIdentityDigest(observedOccurrences),
			cutoverPlan,
		};
	}
	requireInvariant(
		baselineObjectKeys.length === 0,
		"the legacy prestate contains a partial or unexpected fold-baseline catalog",
	);
	requireInvariant(
		cutoverState === "pristine",
		"the text SQL state does not have the exact pristine CutoverPlan",
	);
	assertSqlIdentitySchema(initialTypes, "text");
	assertFrozenProjectTenancyCatalog(
		initialProjectTenancy,
		casesSchema,
		"legacy",
	);
	await assertFrozenProjectTenancyRows(tx, casesSchema);
	const occurrenceSource = rawCutoverSource;
	const sourceProjections = dispatchFrozenStorageOccurrences(occurrenceSource);
	const sourceBlockers = sourceProjections.filter(
		(entry) => entry.disposition === "block-current" && entry.rowCount > 0,
	);
	requireInvariant(
		sourceBlockers.length === 0,
		`the frozen occurrence scan has block-current rows at ${sourceBlockers[0]?.id ?? "unknown"}`,
	);

	/* Lease, thread-holder, stream-chunk, and presence counts are recorded in
	 * the report but are deliberately NOT invariants. They describe who happened
	 * to be mid-request, not whether the data is transformable, and the only way
	 * to drive them to zero is to take the service down first. The complete
	 * table lock this transaction already holds is the real protection: a
	 * concurrent writer blocks on it or fails against it. An in-flight request
	 * against the old shape may error, which is cheaper than the machinery a
	 * maintenance window would need. `block-current` rows above remain a hard
	 * stop, because those are data this migration genuinely cannot transform. */

	requireInvariant(
		currentRows.apps.length <= MAX_APP_COUNT,
		`app count exceeds the reviewed capacity bound of ${MAX_APP_COUNT}`,
	);
	requireInvariant(
		currentRows.entities.length <= MAX_ENTITY_COUNT,
		`entity count exceeds the reviewed capacity bound of ${MAX_ENTITY_COUNT}`,
	);

	const rowsByApp = new Map<string, LegacyEntityRow[]>();
	for (const row of currentRows.entities) {
		const rows = rowsByApp.get(row.app_id) ?? [];
		rows.push({
			appId: row.app_id,
			uuid: row.uuid,
			kind: row.kind as LegacyEntityKind,
			parentUuid: row.parent_uuid,
			ordinal: row.ordinal,
			data: row.data,
		});
		rowsByApp.set(row.app_id, rows);
	}

	const plans: CanonicalAppPlan[] = [];
	for (const app of currentRows.apps) {
		const snapshot: LegacyAppSnapshot = {
			appId: app.id,
			appName: app.app_name,
			connectType: app.connect_type,
			caseTypes: app.case_types,
			logo: app.logo,
			mutationSeq: app.mutation_seq,
			rows: rowsByApp.get(app.id) ?? [],
		};
		const plan = planCanonicalAppMigration(snapshot);
		requireInvariant(
			plan.findings.length === 0,
			`app ${canonicalIdentityDigest(app.id)} has ${plan.findings.length} blocking frozen-scan finding(s); first path ${plan.findings[0]?.path ?? "unknown"}`,
		);
		plans.push(plan);
	}
	await assertCompleteFrozenPlans(tx, currentRows.apps, plans);
	const caseTypeSchemaTextRows = await sql<{
		app_id: string;
		case_type: string;
		schema_text: string;
	}>`
		SELECT app_id, case_type, schema::text AS schema_text
		FROM case_type_schemas
		ORDER BY app_id, case_type
	`.execute(tx);
	const caseTypeSchemaEntries = caseTypeSchemaTextRows.rows.map(
		(row, index) => ({
			id: `case_type_schemas.schema[${index}]`,
			sourceText: row.schema_text,
		}),
	);
	const verifiedCaseTypeSchemas = await verifyFrozenJsonCarriers(
		tx,
		caseTypeSchemaEntries,
	);
	const caseTypeSchemaRows = caseTypeSchemaTextRows.rows.map((row, index) => ({
		app_id: row.app_id,
		case_type: row.case_type,
		schema: materializeNonNullJson(
			requiredCarrier(
				verifiedCaseTypeSchemas,
				caseTypeSchemaEntries[index]?.id ?? "",
			),
			"case_type_schema",
		),
	}));
	const caseTypeSchemaPayload = caseTypeSchemaRows.map((row) => {
		const path = `case_type_schemas.${canonicalIdentityDigest([
			row.app_id,
			row.case_type,
		])}.schema`;
		const plan = plans.find((candidate) => candidate.appId === row.app_id);
		const canonicalCaseType = Array.isArray(plan?.caseTypes)
			? plan.caseTypes.find(
					(candidate) =>
						isRecord(candidate) && candidate.name === row.case_type,
				)
			: undefined;
		const rewrite = rewriteFrozenCaseTypeSchema(
			row.schema,
			canonicalCaseType,
			path,
		);
		requireInvariant(
			rewrite.findings.length === 0,
			`${path} has ${rewrite.findings.length} blocking standard-property finding(s)`,
		);
		return {
			app_id: row.app_id,
			case_type: row.case_type,
			schema: rewrite.schema,
		};
	});

	const lookupTables = await sql<{
		project_id: string;
		id: string;
	}>`SELECT project_id, id FROM lookup_tables ORDER BY project_id, id`.execute(
		tx,
	);
	const lookupColumns = await sql<{
		project_id: string;
		table_id: string;
		id: string;
	}>`
				SELECT project_id, table_id, id
				FROM lookup_columns
				ORDER BY project_id, table_id, id
			`.execute(tx);
	const lookupRows = await sql<{
		project_id: string;
		table_id: string;
		id: string;
		values_text: string;
	}>`
				SELECT project_id, table_id, id, values::text AS values_text
				FROM lookup_rows
				ORDER BY project_id, table_id, id
			`.execute(tx);
	const lookupValueEntries = lookupRows.rows.map((row) => ({
		id: `lookup_rows.values:${canonicalIdentityDigest([
			row.project_id,
			row.table_id,
			row.id,
		])}`,
		sourceText: row.values_text,
	}));
	const verifiedLookupValues = await verifyFrozenJsonCarriers(
		tx,
		lookupValueEntries,
	);
	const lookupFindings = scanLookupIdentities({
		tables: lookupTables.rows.map((row) => ({
			projectId: row.project_id,
			id: row.id,
		})),
		columns: lookupColumns.rows.map((row) => ({
			projectId: row.project_id,
			tableId: row.table_id,
			id: row.id,
		})),
		rows: lookupRows.rows.map((row, index) => ({
			projectId: row.project_id,
			tableId: row.table_id,
			id: row.id,
			values: materializeNonNullJson(
				requiredCarrier(
					verifiedLookupValues,
					lookupValueEntries[index]?.id ?? "",
				),
				"lookup_values",
			),
		})),
	});
	requireInvariant(
		lookupFindings.length === 0,
		`lookup identity scan has ${lookupFindings.length} blocking finding(s)`,
	);

	const mediaRows = await sql<{
		id: string;
		project_id: string;
		status: string;
	}>`
				SELECT id, project_id, status FROM media_assets ORDER BY id
	`.execute(tx);
	const mediaIds = new Set(mediaRows.rows.map((row) => row.id));
	for (const id of mediaIds) {
		requireInvariant(
			isCanonicalAuthoredUuid(id),
			`media asset ${canonicalIdentityDigest(id)} is not a canonical authored UUID`,
		);
	}

	// The UUIDv5 projection is globally injective for the exact legacy
	// names and may not land on any authored identity in any app, media
	// row, or lookup object.
	const existingIdentities = new Set<string>(mediaIds);
	for (const row of lookupTables.rows) existingIdentities.add(row.id);
	for (const row of lookupColumns.rows) existingIdentities.add(row.id);
	for (const row of lookupRows.rows) existingIdentities.add(row.id);
	for (const rows of rowsByApp.values()) {
		for (const id of collectAuthoredIdentities(rows)) {
			existingIdentities.add(id);
		}
	}
	const mappedTargets = plans.flatMap((plan) =>
		legacyOptionTargets(rowsByApp.get(plan.appId) ?? []),
	);
	requireInvariant(
		new Set(mappedTargets).size === mappedTargets.length,
		"two legacy option identities map to the same UUIDv5 target",
	);
	for (const target of mappedTargets) {
		requireInvariant(
			!existingIdentities.has(target),
			`legacy option UUIDv5 target ${canonicalIdentityDigest(target)} collides with an authored identity`,
		);
	}

	const formIdsByApp = new Map<string, Set<string>>();
	const fieldIdsByApp = new Map<string, Set<string>>();
	const operationIdsByApp = new Map<string, Set<string>>();
	for (const plan of plans) {
		const forms = new Set<string>();
		const fields = new Set<string>();
		const operations = new Set<string>();
		for (const row of plan.rows) {
			if (row.kind === "form") {
				forms.add(row.uuid);
				const values = Array.isArray(row.data.caseOperations)
					? row.data.caseOperations
					: [];
				for (const operation of values) {
					if (isRecord(operation) && isCanonicalAuthoredUuid(operation.uuid)) {
						operations.add(operation.uuid);
					}
				}
			}
			if (row.kind === "field") fields.add(row.uuid);
		}
		formIdsByApp.set(plan.appId, forms);
		fieldIdsByApp.set(plan.appId, fields);
		operationIdsByApp.set(plan.appId, operations);
	}

	const intentRows = await sql<{
		app_id: string;
		project_id: string;
		created_by: string;
		entry_key: string;
		form_uuid: string;
		result_text: string | null;
		result_shape_exact: boolean;
		operation_index: string | null;
		operation_uuid: string | null;
	}>`
				SELECT
					intent.app_id,
					intent.project_id,
					intent.created_by,
					intent.entry_key,
					intent.form_uuid::text AS form_uuid,
					intent.result::text AS result_text,
					(
						intent.result IS NULL
						OR (
							jsonb_typeof(intent.result) = 'object'
							AND (
								NOT (intent.result ? 'operations')
								OR jsonb_typeof(intent.result -> 'operations') = 'array'
							)
						)
					) AS result_shape_exact,
					(operation.ordinality - 1)::text AS operation_index,
					operation.value ->> 'operationUuid' AS operation_uuid
				FROM form_submission_intents AS intent
				LEFT JOIN LATERAL jsonb_array_elements(
					CASE
						WHEN jsonb_typeof(intent.result -> 'operations') = 'array'
						THEN intent.result -> 'operations'
						ELSE '[]'::jsonb
					END
				) WITH ORDINALITY AS operation(value, ordinality) ON TRUE
				ORDER BY
					intent.app_id,
					intent.project_id,
					intent.created_by,
					intent.entry_key,
					operation.ordinality
			`.execute(tx);
	for (const row of intentRows.rows) {
		const path = `form_submission_intents.${canonicalIdentityDigest([
			row.app_id,
			row.project_id,
			row.created_by,
			row.entry_key,
		])}`;
		requireInvariant(
			isCanonicalAuthoredUuid(row.form_uuid) &&
				(formIdsByApp.get(row.app_id)?.has(row.form_uuid) ?? false),
			`${path}.form_uuid is not a current form in that app`,
		);
		requireInvariant(
			row.result_shape_exact,
			`${path}.result has an invalid operation envelope`,
		);
		if (row.operation_index !== null) {
			requireInvariant(
				isCanonicalAuthoredUuid(row.operation_uuid) &&
					(operationIdsByApp.get(row.app_id)?.has(row.operation_uuid) ?? false),
				`${path}.result.operations[${row.operation_index}].operationUuid is not a current operation in that app`,
			);
		}
	}

	const attachmentRows = await sql<{
		attachment_id: string;
		app_id: string;
		field_uuid: string;
	}>`
				SELECT attachment_id, app_id, field_uuid
				FROM form_attachments
				ORDER BY attachment_id
			`.execute(tx);
	for (const row of attachmentRows.rows) {
		requireInvariant(
			isCanonicalAuthoredUuid(row.field_uuid) &&
				(fieldIdsByApp.get(row.app_id)?.has(row.field_uuid) ?? false),
			`form_attachments.${canonicalIdentityDigest(row.attachment_id)}.field_uuid is not a current field in that app`,
		);
	}

	const expectedMediaEdges = await frozenExpectedMediaReferenceEdges(
		tx,
		currentRows.apps,
		plans,
	);

	const eventRows = await sql<{
		id: string;
		kind: string;
		event_text: string;
		envelope_exact: boolean;
		attachment_shape_exact: boolean;
	}>`
				SELECT
					id::text AS id,
					kind,
					event::text AS event_text,
					(
						event -> 'runId' = to_jsonb(run_id)
						AND event -> 'ts' = to_jsonb(ts)
						AND event -> 'seq' = to_jsonb(seq)
						AND event -> 'source' = to_jsonb(source)
						AND event -> 'kind' = to_jsonb(kind)
					) AS envelope_exact,
					(
						kind <> 'conversation'
						OR event #>> '{payload,type}' <> 'user-message'
						OR NOT (event -> 'payload' ? 'attachments')
						OR jsonb_typeof(event -> 'payload' -> 'attachments') = 'array'
					) AS attachment_shape_exact
				FROM events
				ORDER BY id
			`.execute(tx);
	const eventAttachmentRows = await sql<{
		id: string;
		attachment_index: string;
		asset_id: string | null;
	}>`
				SELECT
					event_row.id::text AS id,
					(attachment.ordinality - 1)::text AS attachment_index,
					attachment.value ->> 'assetId' AS asset_id
				FROM events AS event_row
				CROSS JOIN LATERAL jsonb_array_elements(
					CASE
						WHEN event_row.kind = 'conversation'
							AND event_row.event #>> '{payload,type}' = 'user-message'
							AND jsonb_typeof(
								event_row.event -> 'payload' -> 'attachments'
							) = 'array'
						THEN event_row.event -> 'payload' -> 'attachments'
						ELSE '[]'::jsonb
					END
				) WITH ORDINALITY AS attachment(value, ordinality)
				ORDER BY event_row.id, attachment.ordinality
			`.execute(tx);
	const archivedBefore = new Map<string, string>();
	for (const row of eventRows.rows) {
		const eventDigest = canonicalIdentityDigest(row.id);
		requireInvariant(
			row.envelope_exact,
			`events.${eventDigest} columns disagree with its stored envelope`,
		);
		requireInvariant(
			row.kind === "mutation" ||
				row.kind === "conversation" ||
				row.kind === "archived-mutation",
			`events.${eventDigest} has an unsupported event family`,
		);
		requireInvariant(
			row.attachment_shape_exact,
			`events.${eventDigest}.event.payload.attachments is malformed`,
		);
		if (row.kind === "mutation") {
			archivedBefore.set(String(row.id), row.event_text);
		}
	}
	for (const row of eventAttachmentRows.rows) {
		requireInvariant(
			isCanonicalAuthoredUuid(row.asset_id),
			`events.${canonicalIdentityDigest(row.id)}.event.payload.attachments[${row.attachment_index}].assetId is not a canonical immutable audit UUID`,
		);
	}

	const rewriteBytes =
		currentRows.apps.reduce(
			(total, row) =>
				total +
				frozenJsonSourceBytes(requiredCarrier(currentRows.appJson, row.id)),
			0,
		) +
		currentRows.entities.reduce(
			(total, row) =>
				total +
				frozenJsonSourceBytes(
					requiredCarrier(
						currentRows.entityJson,
						`${row.app_id}\u0000${row.uuid}`,
					),
				),
			0,
		) +
		[...archivedBefore.values()].reduce(
			(total, value) => total + Buffer.byteLength(value, "utf8"),
			0,
		) +
		caseTypeSchemaEntries.reduce(
			(total, entry) =>
				total +
				frozenJsonSourceBytes(
					requiredCarrier(verifiedCaseTypeSchemas, entry.id),
				),
			0,
		) +
		intentRows.rows.reduce(
			(total, row) =>
				total +
				(row.operation_index !== null && row.operation_index !== "0"
					? 0
					: row.result_text === null
						? 0
						: Buffer.byteLength(row.result_text, "utf8")),
			0,
		);
	requireInvariant(
		rewriteBytes <= MAX_REWRITE_BYTES,
		`planned rewrite bytes exceed the reviewed ${MAX_REWRITE_BYTES}-byte capacity bound`,
	);
	const cutoverPlan = await createFrozenMigrationCutoverPlan({
		tx,
		state: "pristine",
		currentRows,
		plans,
		rawSource: rawCutoverSource,
		lockRelations,
		leaseState,
		catalog: catalogEvidence,
		baselineRows,
		rewriteBytes: rewriteBytes.toString(),
	});

	const acceptedBefore = await sql<{
		app_id: string;
		seq: string;
		row_text: string;
	}>`
				SELECT app_id, seq::text, to_jsonb(accepted_mutations)::text AS row_text
				FROM accepted_mutations
				ORDER BY app_id, seq
			`.execute(tx);
	// This is deliberately the first schema/data write. Every legacy carrier,
	// complete candidate, capacity bound, and pristine prestate has already
	// passed its read-only frozen audit. Plain CREATE makes any catalog race or
	// unclassified object fail instead of healing or replacing it.
	await createFoldBaselineDdl(tx);

	const appPayload = plans.map((plan) => ({
		id: plan.appId,
		case_types: plan.caseTypes,
	}));
	if (appPayload.length > 0) {
		await sql`
					WITH incoming AS (
						SELECT *
						FROM jsonb_to_recordset(${JSON.stringify(appPayload)}::jsonb)
							AS value(id text, case_types jsonb)
					)
					UPDATE apps
					SET case_types = incoming.case_types
					FROM incoming
					WHERE apps.id = incoming.id
				`.execute(tx);
	}

	const entityPayload = plans.flatMap((plan) =>
		plan.rows.map((row) => ({
			app_id: plan.appId,
			uuid: row.uuid,
			data: row.data,
		})),
	);
	if (entityPayload.length > 0) {
		await sql`
					WITH incoming AS (
						SELECT *
						FROM jsonb_to_recordset(${JSON.stringify(entityPayload)}::jsonb)
							AS value(app_id text, uuid text, data jsonb)
					)
					UPDATE blueprint_entities
					SET data = incoming.data
					FROM incoming
					WHERE blueprint_entities.app_id = incoming.app_id
					  AND blueprint_entities.uuid = incoming.uuid
				`.execute(tx);
	}
	if (caseTypeSchemaPayload.length > 0) {
		await sql`
			WITH incoming AS (
				SELECT *
				FROM jsonb_to_recordset(${JSON.stringify(caseTypeSchemaPayload)}::jsonb)
					AS value(app_id text, case_type text, schema jsonb)
			)
			UPDATE case_type_schemas
			SET schema = incoming.schema
			FROM incoming
			WHERE case_type_schemas.app_id = incoming.app_id
			  AND case_type_schemas.case_type = incoming.case_type
		`.execute(tx);
	}
	const droppedStandardPropertyIndexes =
		await dropFrozenStandardPropertyIndexes(tx, caseTypeSchemaRows);
	injectReviewedFailure(options, "canonical-properties");
	injectReviewedFailure(options, "expressions");
	injectReviewedFailure(options, "final-shape");
	injectReviewedFailure(options, "date-post-submit");

	await sql`
				UPDATE events
				SET
					kind = 'archived-mutation',
					event = jsonb_build_object(
						'kind', 'archived-mutation',
						'runId', event -> 'runId',
						'ts', event -> 'ts',
						'seq', event -> 'seq',
						'source', event -> 'source',
						'archived', event
					)
				WHERE kind = 'mutation'
			`.execute(tx);
	injectReviewedFailure(options, "events");

	await sql`
				UPDATE threads
				SET active_stream_id = NULL, active_holder_nonce = NULL
				WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL;
				DELETE FROM chat_stream_chunks;
				DELETE FROM presence
			`.execute(tx);
	injectReviewedFailure(options, "operational");

	const baselinePayload = plans.map((plan) => {
		const app = currentRows.apps.find((row) => row.id === plan.appId);
		requireInvariant(
			app !== undefined,
			`planned app ${canonicalIdentityDigest(plan.appId)} disappeared`,
		);
		return {
			app_id: plan.appId,
			seq: String(BigInt(app.mutation_seq) + BigInt(1)),
		};
	});
	await sql`
				WITH appended AS (
					INSERT INTO app_changes
						(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
					SELECT
						id,
						mutation_seq + 1,
						${HORIZON_BATCH_ID},
						NULL,
						${HORIZON_ACTOR_ID},
						'fold-baseline',
						'[]'::jsonb
					FROM apps
					RETURNING app_id, seq
				)
				UPDATE apps
				SET mutation_seq = appended.seq
				FROM appended
				WHERE apps.id = appended.app_id
			`.execute(tx);
	if (baselinePayload.length > 0) {
		await sql`
			WITH incoming AS (
				SELECT *
				FROM jsonb_to_recordset(${JSON.stringify(baselinePayload)}::jsonb)
					AS value(
						app_id text,
						seq bigint
					)
			)
			INSERT INTO app_change_fold_baselines
				(app_id, seq, project_id, snapshot, snapshot_digest)
			SELECT
				app_id,
				seq,
				(
					SELECT project_id
					FROM apps
					WHERE apps.id = incoming.app_id
				),
				nova_current_app_change_fold_snapshot(app_id),
				nova_app_change_fold_snapshot_digest(
					nova_current_app_change_fold_snapshot(app_id)
				)
			FROM incoming
			ORDER BY app_id
		`.execute(tx);
	}
	injectReviewedFailure(options, "horizon");

	await convertSqlIdentityColumns(tx);
	assertSqlIdentitySchema(await sqlColumnTypes(tx), "uuid");
	await installFrozenProjectTenancyDdl(tx, casesSchema);
	await assertFrozenProjectTenancyRows(tx, casesSchema);
	await assertFrozenAppChangeProjectRows(tx);
	injectReviewedFailure(options, "ddl");
	await installFrozenMediaReferenceDdl(tx, expectedMediaEdges);
	assertFrozenProjectTenancyCatalog(
		await captureFrozenProjectTenancyCatalog(tx, casesSchema),
		casesSchema,
		"final",
	);
	await assertFrozenMediaReferenceCatalog(tx);
	await assertFrozenMediaReferenceRows(tx, expectedMediaEdges);
	await assertFrozenSqlIdentityStructuralCatalog(tx, "uuid");
	injectReviewedFailure(options, "media-index");

	const archivedAfter = await sql<{
		id: string | number;
		archived_text: string;
	}>`
				SELECT id, (event -> 'archived')::text AS archived_text
				FROM events
				WHERE kind = 'archived-mutation'
				ORDER BY id
			`.execute(tx);
	requireInvariant(
		archivedAfter.rows.length === archivedBefore.size,
		"archived mutation-event cardinality changed",
	);
	for (const row of archivedAfter.rows) {
		requireInvariant(
			archivedBefore.get(String(row.id)) === row.archived_text,
			`events.${row.id} did not preserve its nested canonical jsonb::text`,
		);
	}

	const oldAcceptedAfter = await sql<{
		app_id: string;
		seq: string;
		row_text: string;
	}>`
				SELECT
					current.app_id,
					current.seq::text,
					(
						to_jsonb(current)
							- 'from_project_id'
							- 'to_project_id'
					)::text AS row_text
				FROM app_changes current
				JOIN jsonb_to_recordset(${JSON.stringify(
					currentRows.apps.map((row) => ({
						app_id: row.id,
						mutation_seq: String(row.mutation_seq),
					})),
				)}::jsonb)
					AS prior(app_id text, mutation_seq bigint)
				  ON prior.app_id = current.app_id
				 AND current.seq <= prior.mutation_seq
				ORDER BY current.app_id, current.seq
			`.execute(tx);
	requireInvariant(
		canonicalIdentityDigest(oldAcceptedAfter.rows) ===
			canonicalIdentityDigest(acceptedBefore.rows),
		"one or more pre-horizon accepted-mutation rows changed",
	);
	requireInvariant(
		await appliedForEveryApp(tx),
		"the canonical fold horizon and baseline were not appended exactly once per app",
	);

	const operational = await sql<{
		chunks: string;
		presence: string;
		active_streams: string;
	}>`
				SELECT
					(SELECT count(*)::text FROM chat_stream_chunks) AS chunks,
					(SELECT count(*)::text FROM presence) AS presence,
					(
						SELECT count(*)::text
						FROM threads
						WHERE active_stream_id IS NOT NULL
						   OR active_holder_nonce IS NOT NULL
					) AS active_streams
			`.execute(tx);
	requireInvariant(
		operational.rows[0]?.chunks === "0" &&
			operational.rows[0]?.presence === "0" &&
			operational.rows[0]?.active_streams === "0",
		"ephemeral stream or presence state survived the cutover",
	);

	const expectedPostApps = plans.map((plan) => ({
		id: plan.appId,
		case_types: plan.caseTypes,
		mutation_seq: String(
			BigInt(
				currentRows.apps.find((row) => row.id === plan.appId)?.mutation_seq ??
					0,
			) + BigInt(1),
		),
	}));
	const expectedPostEntities = plans.flatMap((plan) =>
		plan.rows.map((row) => ({
			app_id: plan.appId,
			uuid: row.uuid,
			kind: row.kind,
			parent_uuid: row.parentUuid,
			ordinal: row.ordinal,
			data: row.data,
		})),
	);
	const postProof = await sql<{
		app_count: string;
		matched_apps: string;
		entity_count: string;
		matched_entities: string;
	}>`
		WITH expected_app AS (
			SELECT *
			FROM jsonb_to_recordset(${JSON.stringify(expectedPostApps)}::jsonb)
				AS value(id text, case_types jsonb, mutation_seq bigint)
		), expected_entity AS (
			SELECT *
			FROM jsonb_to_recordset(${JSON.stringify(expectedPostEntities)}::jsonb)
				AS value(
					app_id text,
					uuid uuid,
					kind text,
					parent_uuid uuid,
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
				WHERE apps.mutation_seq = expected_app.mutation_seq
				  AND apps.case_types::text = expected_app.case_types::text
			) AS matched_apps,
			(SELECT count(*)::text FROM blueprint_entities) AS entity_count,
			(
				SELECT count(*)::text
				FROM blueprint_entities
				JOIN expected_entity
				  ON expected_entity.app_id = blueprint_entities.app_id
				 AND expected_entity.uuid = blueprint_entities.uuid
				WHERE blueprint_entities.kind = expected_entity.kind
				  AND blueprint_entities.parent_uuid
						IS NOT DISTINCT FROM expected_entity.parent_uuid
				  AND blueprint_entities.ordinal = expected_entity.ordinal
				  AND blueprint_entities.data::text = expected_entity.data::text
			) AS matched_entities
	`.execute(tx);
	const proof = postProof.rows[0];
	requireInvariant(
		proof?.app_count === String(expectedPostApps.length) &&
			proof.matched_apps === proof.app_count &&
			proof.entity_count === String(expectedPostEntities.length) &&
			proof.matched_entities === proof.entity_count,
		"stored current snapshots or heads differ from the frozen migration plan",
	);
	const postCaseTypeSchemaProof = await sql<{
		actual_count: string;
		matched_count: string;
	}>`
		WITH expected AS (
			SELECT *
			FROM jsonb_to_recordset(${JSON.stringify(caseTypeSchemaPayload)}::jsonb)
				AS value(app_id text, case_type text, schema jsonb)
		)
		SELECT
			(SELECT count(*)::text FROM case_type_schemas) AS actual_count,
			(
				SELECT count(*)::text
				FROM case_type_schemas
				JOIN expected
				  ON expected.app_id = case_type_schemas.app_id
				 AND expected.case_type = case_type_schemas.case_type
				WHERE case_type_schemas.schema::text = expected.schema::text
			) AS matched_count
	`.execute(tx);
	requireInvariant(
		postCaseTypeSchemaProof.rows[0]?.actual_count ===
			String(caseTypeSchemaPayload.length) &&
			postCaseTypeSchemaProof.rows[0]?.matched_count ===
				postCaseTypeSchemaProof.rows[0]?.actual_count,
		"materialized case schemas differ from the canonical Blueprint rebuild",
	);
	await assertAlreadyAppliedState(tx);
	await assertNoFrozenStandardPropertyIndexes(tx);

	const occurrenceResult = await captureFrozenStorageSnapshot(tx);
	assertFrozenGeneratedIndexResult(
		occurrenceSource,
		occurrenceResult,
		droppedStandardPropertyIndexes,
	);
	const occurrencePlan = compareFrozenStorageOccurrences(
		occurrenceSource,
		occurrenceResult,
	);

	return {
		version: CANONICAL_IDENTITY_MIGRATION_VERSION,
		alreadyApplied: false,
		apps: plans.length,
		entities: entityPayload.length,
		archivedMutationEvents: archivedBefore.size,
		rewriteBytes,
		beforeDigest: occurrencePlan.sourceDigest,
		afterDigest: occurrencePlan.resultDigest,
		occurrenceSourceDigest: occurrencePlan.sourceDigest,
		occurrenceResultDigest: occurrencePlan.resultDigest,
		occurrencePlanDigest: occurrencePlan.planDigest,
		cutoverPlan,
	};
}
