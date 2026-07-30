/**
 * Frozen database cutover for canonical authored identity.
 *
 * This module intentionally depends only on the timestamped migration's frozen
 * inventory and pure transform. It does not import the live domain schemas,
 * reducer, or persistence assembler: a later product edit must not change what
 * this historical migration does when a fresh database replays the ledger.
 */

import { type Kysely, sql } from "kysely";
import {
	captureFrozenStorageSnapshot,
	compareFrozenStorageOccurrences,
	dispatchFrozenStorageOccurrences,
} from "./frozenOccurrenceDispatcher";
import {
	FROZEN_ENTITY_OCCURRENCES,
	FROZEN_OCCURRENCE_TABLES,
} from "./frozenOccurrenceManifest";
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
	scanLookupIdentities,
} from "./frozenTransform";

const HORIZON_BATCH_ID = "migration:canonical-identity-foundation";
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
	app_name: string;
	connect_type: string | null;
	case_types: unknown;
	logo: string | null;
	mutation_seq: string | number;
	status: string;
	lock_run_id: string | null;
}

interface StoredEntityRow {
	app_id: string;
	uuid: string;
	kind: string;
	parent_uuid: string | null;
	ordinal: number;
	data: Record<string, unknown>;
}

interface StoredEventRow {
	id: string | number;
	app_id: string;
	run_id: string;
	ts: string | number;
	seq: number;
	source: string;
	kind: string;
	event: Record<string, unknown>;
	event_text: string;
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
}

export interface FrozenAppliedSuffixRow {
	readonly seq: string;
	readonly batch_id: string;
	readonly actor_id: string;
	readonly kind: string;
	readonly mutations: unknown;
}

export interface FrozenAppliedSuffixReplayInput {
	readonly baselineSnapshot: unknown;
	readonly baselineSeq: string;
	readonly expectedHeadSeq: string | number;
	readonly suffix: readonly FrozenAppliedSuffixRow[];
}

export type FrozenAppliedSuffixReplayer = (
	input: FrozenAppliedSuffixReplayInput,
) => { readonly snapshot: unknown };

export type FrozenMigrationFailureStage = "carriers" | "horizon" | "ddl";

export interface FrozenMigrationOptions {
	/**
	 * The one steady-state mutation fold authority. Required only when a direct
	 * already-applied audit finds accepted rows after the immutable baseline.
	 * The first-run legacy migration never calls it.
	 */
	readonly replayAppliedSuffix?: FrozenAppliedSuffixReplayer;
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

type FrozenJsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function frozenPersistableSnapshot(
	app: Pick<
		StoredAppRow,
		"id" | "app_name" | "connect_type" | "case_types" | "logo"
	>,
	plan: CanonicalAppPlan,
): FrozenJsonRecord {
	const byOrdinal = (left: LegacyEntityRow, right: LegacyEntityRow) =>
		left.ordinal - right.ordinal || left.uuid.localeCompare(right.uuid);
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

async function createFoldBaselineDdl(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS mutation_fold_baselines (
			app_id text NOT NULL,
			seq bigint NOT NULL,
			snapshot jsonb NOT NULL,
			snapshot_digest text NOT NULL
				CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (app_id, seq),
			CONSTRAINT mutation_fold_baselines_mutation_fkey
				FOREIGN KEY (app_id, seq)
				REFERENCES accepted_mutations(app_id, seq)
				ON DELETE CASCADE
		);

		CREATE OR REPLACE FUNCTION nova_reject_mutation_fold_baseline_change()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $function$
		BEGIN
			RAISE EXCEPTION 'mutation_fold_baselines rows are immutable';
		END
		$function$;

		CREATE OR REPLACE FUNCTION nova_admit_mutation_fold_baseline_insert()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $function$
		BEGIN
			IF NOT EXISTS (
				SELECT 1
				FROM accepted_mutations AS marker
				JOIN apps AS app ON app.id = marker.app_id
				WHERE marker.app_id = NEW.app_id
					AND marker.seq = NEW.seq
					AND marker.kind = 'migration'
					AND marker.mutations = '[]'::jsonb
					AND app.mutation_seq = NEW.seq
					AND (
						(
							marker.batch_id = 'migration:canonical-identity-foundation'
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
				RAISE EXCEPTION 'mutation_fold_baselines insert requires an exact horizon or genesis marker';
			END IF;
			RETURN NEW;
		END
		$function$;

		DROP TRIGGER IF EXISTS mutation_fold_baselines_immutable
			ON mutation_fold_baselines;
		CREATE TRIGGER mutation_fold_baselines_immutable
			BEFORE UPDATE OR DELETE ON mutation_fold_baselines
			FOR EACH ROW
			EXECUTE FUNCTION nova_reject_mutation_fold_baseline_change();

		DROP TRIGGER IF EXISTS mutation_fold_baselines_admit_insert
			ON mutation_fold_baselines;
		CREATE TRIGGER mutation_fold_baselines_admit_insert
			BEFORE INSERT ON mutation_fold_baselines
			FOR EACH ROW
			EXECUTE FUNCTION nova_admit_mutation_fold_baseline_insert();
	`.execute(db);
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

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function eventEnvelopeIsExact(row: StoredEventRow): boolean {
	return (
		row.event.runId === row.run_id &&
		String(row.event.ts) === String(row.ts) &&
		row.event.seq === row.seq &&
		row.event.source === row.source &&
		row.event.kind === row.kind
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

function validateTypedAttachments(
	value: unknown,
	path: string,
	mediaIds: ReadonlySet<string>,
): void {
	if (Array.isArray(value)) {
		value.forEach((child, index) => {
			validateTypedAttachments(child, `${path}[${index}]`, mediaIds);
		});
		return;
	}
	if (!isRecord(value)) return;
	const metadata = value.metadata;
	if (isRecord(metadata) && Array.isArray(metadata.attachments)) {
		metadata.attachments.forEach((attachment, index) => {
			requireInvariant(
				isRecord(attachment) &&
					isCanonicalAuthoredUuid(attachment.assetId) &&
					mediaIds.has(attachment.assetId),
				`${path}.metadata.attachments[${index}].assetId is not one stored uploaded-media identity`,
			);
		});
	}
	for (const [key, child] of Object.entries(value)) {
		validateTypedAttachments(child, `${path}.${key}`, mediaIds);
	}
}

function assertCurrentEventAttachments(
	row: StoredEventRow,
	mediaIds: ReadonlySet<string>,
): void {
	if (row.kind !== "conversation") return;
	const payload = row.event.payload;
	if (!isRecord(payload) || payload.type !== "user-message") return;
	if (payload.attachments === undefined) return;
	requireInvariant(
		Array.isArray(payload.attachments),
		`events.${row.id}.event.payload.attachments is malformed`,
	);
	payload.attachments.forEach((attachment, index) => {
		requireInvariant(
			isRecord(attachment) &&
				isCanonicalAuthoredUuid(attachment.assetId) &&
				mediaIds.has(attachment.assetId),
			`events.${row.id}.event.payload.attachments[${index}].assetId is not one stored uploaded-media identity`,
		);
	});
}

function assertIntentOperations(
	result: unknown,
	path: string,
	operationIds: ReadonlySet<string>,
): void {
	if (result === null) return;
	requireInvariant(isRecord(result), `${path}.result is not an object`);
	if (result.operations === undefined) return;
	requireInvariant(
		Array.isArray(result.operations),
		`${path}.result.operations is not an array`,
	);
	result.operations.forEach((operation, index) => {
		requireInvariant(
			isRecord(operation) &&
				isCanonicalAuthoredUuid(operation.operationUuid) &&
				operationIds.has(operation.operationUuid),
			`${path}.result.operations[${index}].operationUuid is not a current operation in that app`,
		);
	});
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
}

async function appliedForEveryApp(db: Kysely<unknown>): Promise<boolean> {
	const row = await sql<{ apps: string; horizons: string; baselines: string }>`
		SELECT
			(SELECT count(*)::text FROM apps) AS apps,
			(
				SELECT count(*)::text
				FROM accepted_mutations
				WHERE batch_id = ${HORIZON_BATCH_ID}
			) AS horizons,
			(SELECT count(*)::text FROM mutation_fold_baselines) AS baselines
	`.execute(db);
	const counts = row.rows[0];
	return (
		counts !== undefined &&
		counts.apps === counts.horizons &&
		counts.apps === counts.baselines
	);
}

function planDigest(plans: readonly CanonicalAppPlan[]): string {
	return canonicalIdentityDigest(
		plans.map((plan) => ({
			app: canonicalIdentityDigest(plan.appId),
			before: plan.beforeDigest,
			after: plan.afterDigest,
			rewrites: plan.rewrites,
		})),
	);
}

async function assertAlreadyAppliedState(
	db: Kysely<unknown>,
	options: FrozenMigrationOptions,
): Promise<void> {
	requireInvariant(
		await appliedForEveryApp(db),
		"the exact one-baseline-per-app applied state is absent",
	);
	const appResult = await sql<StoredAppRow>`
		SELECT id, app_name, connect_type, case_types, logo, mutation_seq,
		       status, lock_run_id
		FROM apps
		ORDER BY id
	`.execute(db);
	const entityResult = await sql<StoredEntityRow>`
		SELECT app_id, uuid::text AS uuid, kind, parent_uuid::text AS parent_uuid,
		       ordinal, data
		FROM blueprint_entities
		ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid
	`.execute(db);
	const baselineResult = await sql<{
		app_id: string;
		seq: string;
		snapshot: FrozenJsonRecord;
		snapshot_digest: string;
		batch_id: string;
		run_id: string | null;
		actor_id: string;
		kind: string;
		mutations: unknown;
	}>`
		SELECT baseline.app_id, baseline.seq::text, baseline.snapshot,
		       baseline.snapshot_digest, marker.batch_id, marker.run_id,
		       marker.actor_id, marker.kind, marker.mutations
		FROM mutation_fold_baselines AS baseline
		JOIN accepted_mutations AS marker
		  ON marker.app_id = baseline.app_id
		 AND marker.seq = baseline.seq
		ORDER BY baseline.app_id, baseline.seq
	`.execute(db);
	const baselineByApp = new Map(
		baselineResult.rows.map((row) => [row.app_id, row] as const),
	);
	const suffixResult = await sql<FrozenAppliedSuffixRow & { app_id: string }>`
		SELECT mutation.app_id, mutation.seq::text, mutation.batch_id,
		       mutation.actor_id, mutation.kind, mutation.mutations
		FROM accepted_mutations AS mutation
		JOIN mutation_fold_baselines AS baseline
		  ON baseline.app_id = mutation.app_id
		 AND mutation.seq > baseline.seq
		ORDER BY mutation.app_id, mutation.seq
	`.execute(db);
	const suffixByApp = new Map<string, FrozenAppliedSuffixRow[]>();
	for (const row of suffixResult.rows) {
		const suffix = suffixByApp.get(row.app_id) ?? [];
		suffix.push({
			seq: row.seq,
			batch_id: row.batch_id,
			actor_id: row.actor_id,
			kind: row.kind,
			mutations: row.mutations,
		});
		suffixByApp.set(row.app_id, suffix);
	}
	const rowsByApp = new Map<string, LegacyEntityRow[]>();
	for (const row of entityResult.rows) {
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
	for (const app of appResult.rows) {
		const baseline = baselineByApp.get(app.id);
		requireInvariant(
			baseline !== undefined,
			`app ${canonicalIdentityDigest(app.id)} has no fold baseline`,
		);
		requireInvariant(
			baseline.batch_id === HORIZON_BATCH_ID &&
				baseline.run_id === null &&
				baseline.actor_id === HORIZON_ACTOR_ID &&
				baseline.kind === "migration" &&
				Array.isArray(baseline.mutations) &&
				baseline.mutations.length === 0,
			`app ${canonicalIdentityDigest(app.id)} has a malformed fold marker`,
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
		requireInvariant(
			plan.findings.length === 0 && plan.beforeDigest === plan.afterDigest,
			`app ${canonicalIdentityDigest(app.id)} is not canonical after the cutover`,
		);
		const expectedSnapshot = frozenPersistableSnapshot(app, plan);
		const expectedDigest = canonicalIdentityDigest(expectedSnapshot);
		requireInvariant(
			canonicalIdentityDigest(baseline.snapshot) === baseline.snapshot_digest,
			`app ${canonicalIdentityDigest(app.id)} baseline digest drifted`,
		);
		const suffix = suffixByApp.get(app.id) ?? [];
		if (suffix.length === 0) {
			requireInvariant(
				String(app.mutation_seq) === baseline.seq &&
					baseline.snapshot_digest === expectedDigest,
				`app ${canonicalIdentityDigest(app.id)} baseline does not equal its current no-suffix snapshot`,
			);
			continue;
		}
		requireInvariant(
			options.replayAppliedSuffix !== undefined,
			`app ${canonicalIdentityDigest(app.id)} has a post-baseline suffix but no canonical replay authority`,
		);
		const replayed = options.replayAppliedSuffix({
			baselineSnapshot: baseline.snapshot,
			baselineSeq: baseline.seq,
			expectedHeadSeq: app.mutation_seq,
			suffix,
		});
		requireInvariant(
			canonicalIdentityDigest(replayed.snapshot) === expectedDigest,
			`app ${canonicalIdentityDigest(app.id)} post-baseline replay does not equal current state`,
		);
	}
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
	await createFoldBaselineDdl(tx);
	// One deterministic lock statement, projected from the frozen
	// occurrence manifest. SHARE ROW EXCLUSIVE blocks every application
	// writer before the authoritative scan; later ALTERs promote their
	// own tables to ACCESS EXCLUSIVE within this same transaction.
	await sql`
				LOCK TABLE ${sql.join(
					FROZEN_OCCURRENCE_TABLES.map((table) => sql.table(table)),
				)} IN SHARE ROW EXCLUSIVE MODE
			`.execute(tx);

	const initialTypes = await sqlColumnTypes(tx);
	const typeSet = new Set(initialTypes.values());
	requireInvariant(
		typeSet.size === 1 && (typeSet.has("text") || typeSet.has("uuid")),
		"the authored-identity SQL columns are in a partial or unexpected schema state",
	);
	if (typeSet.has("uuid")) {
		assertSqlIdentitySchema(initialTypes, "uuid");
		await assertAlreadyAppliedState(tx, options);
		const observedOccurrences = dispatchFrozenStorageOccurrences(
			await captureFrozenStorageSnapshot(tx),
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
		};
	}
	assertSqlIdentitySchema(initialTypes, "text");
	const occurrenceSource = await captureFrozenStorageSnapshot(tx);

	const active = await sql<{
		lease_blockers: string;
		active_streams: string;
		unterminated_chunks: string;
	}>`
				SELECT
					(
						SELECT count(*)::text
						FROM apps
						WHERE
							status = 'generating'
							OR awaiting_input
							OR lock_run_id IS NOT NULL
							OR lock_actor_user_id IS NOT NULL
							OR lock_expire_at IS NOT NULL
							OR NOT (
								(
									res_period IS NULL
									AND res_reserved IS NULL
									AND res_settled IS NULL
									AND res_user_id IS NULL
									AND res_run_id IS NULL
								)
								OR (
									res_period IS NOT NULL
									AND res_reserved IS NOT NULL
									AND res_settled IS TRUE
									AND res_user_id IS NOT NULL
								)
							)
					) AS lease_blockers,
					(
						SELECT count(*)::text
						FROM threads
						WHERE active_stream_id IS NOT NULL
						   OR active_holder_nonce IS NOT NULL
					) AS active_streams,
					(
						SELECT count(*)::text
						FROM chat_stream_chunks
						WHERE terminal IS NOT TRUE
					) AS unterminated_chunks
			`.execute(tx);
	requireInvariant(
		active.rows[0]?.lease_blockers === "0",
		"one or more app lease/reservation rows are present or corrupt",
	);
	requireInvariant(
		active.rows[0]?.active_streams === "0",
		"one or more thread stream holders remain live",
	);
	requireInvariant(
		active.rows[0]?.unterminated_chunks === "0",
		"one or more unterminated stream chunks remain",
	);

	const appResult = await sql<StoredAppRow>`
				SELECT id, app_name, connect_type, case_types, logo, mutation_seq,
				       status, lock_run_id
				FROM apps
				ORDER BY id
			`.execute(tx);
	const entityResult = await sql<StoredEntityRow>`
				SELECT app_id, uuid, kind, parent_uuid, ordinal, data
				FROM blueprint_entities
				ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid
			`.execute(tx);
	requireInvariant(
		appResult.rows.length <= MAX_APP_COUNT,
		`app count exceeds the reviewed capacity bound of ${MAX_APP_COUNT}`,
	);
	requireInvariant(
		entityResult.rows.length <= MAX_ENTITY_COUNT,
		`entity count exceeds the reviewed capacity bound of ${MAX_ENTITY_COUNT}`,
	);

	const rowsByApp = new Map<string, LegacyEntityRow[]>();
	for (const row of entityResult.rows) {
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
	for (const app of appResult.rows) {
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
		values: Record<string, unknown>;
	}>`
				SELECT project_id, table_id, id, values
				FROM lookup_rows
				ORDER BY project_id, table_id, id
			`.execute(tx);
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
		rows: lookupRows.rows.map((row) => ({
			projectId: row.project_id,
			tableId: row.table_id,
			id: row.id,
			values: row.values,
		})),
	});
	requireInvariant(
		lookupFindings.length === 0,
		`lookup identity scan has ${lookupFindings.length} blocking finding(s)`,
	);

	const mediaRows = await sql<{ id: string }>`
				SELECT id FROM media_assets ORDER BY id
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
		result: unknown;
	}>`
				SELECT app_id, project_id, created_by, entry_key, form_uuid, result
				FROM form_submission_intents
				ORDER BY app_id, project_id, created_by, entry_key
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
		assertIntentOperations(
			row.result,
			path,
			operationIdsByApp.get(row.app_id) ?? new Set(),
		);
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

	const threadRows = await sql<{
		app_id: string;
		thread_id: string;
		messages: unknown;
	}>`
				SELECT app_id, thread_id, messages
				FROM threads
				ORDER BY app_id, thread_id
			`.execute(tx);
	for (const row of threadRows.rows) {
		validateTypedAttachments(
			row.messages,
			`threads.${canonicalIdentityDigest([
				row.app_id,
				row.thread_id,
			])}.messages`,
			mediaIds,
		);
	}

	const eventRows = await sql<StoredEventRow>`
				SELECT id, app_id, run_id, ts, seq, source, kind, event,
				       event::text AS event_text
				FROM events
				ORDER BY id
			`.execute(tx);
	const archivedBefore = new Map<string, string>();
	for (const row of eventRows.rows) {
		requireInvariant(
			eventEnvelopeIsExact(row),
			`events.${row.id} columns disagree with its stored envelope`,
		);
		requireInvariant(
			row.kind === "mutation" ||
				row.kind === "conversation" ||
				row.kind === "archived-mutation",
			`events.${row.id} has an unsupported event family`,
		);
		assertCurrentEventAttachments(row, mediaIds);
		if (row.kind === "mutation") {
			archivedBefore.set(String(row.id), row.event_text);
		}
	}

	const rewriteBytes =
		appResult.rows.reduce(
			(total, row) => total + jsonBytes(row.case_types),
			0,
		) +
		entityResult.rows.reduce((total, row) => total + jsonBytes(row.data), 0) +
		[...archivedBefore.values()].reduce(
			(total, value) => total + Buffer.byteLength(value, "utf8"),
			0,
		) +
		lookupRows.rows.reduce((total, row) => total + jsonBytes(row.values), 0) +
		intentRows.rows.reduce((total, row) => total + jsonBytes(row.result), 0);
	requireInvariant(
		rewriteBytes <= MAX_REWRITE_BYTES,
		`planned rewrite bytes exceed the reviewed ${MAX_REWRITE_BYTES}-byte capacity bound`,
	);

	const acceptedBefore = await sql<{
		app_id: string;
		seq: string;
		row_text: string;
	}>`
				SELECT app_id, seq::text, to_jsonb(accepted_mutations)::text AS row_text
				FROM accepted_mutations
				ORDER BY app_id, seq
			`.execute(tx);
	const beforeDigest = canonicalIdentityDigest({
		plans: planDigest(plans),
		accepted: acceptedBefore.rows,
		events: eventRows.rows.map((row) => ({
			id: String(row.id),
			event: row.event_text,
		})),
		lookupRows: lookupRows.rows,
		threads: threadRows.rows.map((row) => [
			canonicalIdentityDigest([row.app_id, row.thread_id]),
			canonicalIdentityDigest(row.messages),
		]),
	});

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

	// Strictly parsed above. The identity-keyed object is already
	// canonical, so its only valid rewrite is itself.
	await sql`UPDATE lookup_rows SET values = values`.execute(tx);
	await sql`
				UPDATE threads
				SET active_stream_id = NULL, active_holder_nonce = NULL
				WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL;
				DELETE FROM chat_stream_chunks;
				DELETE FROM presence
			`.execute(tx);
	injectReviewedFailure(options, "carriers");

	const baselinePayload = plans.map((plan) => {
		const app = appResult.rows.find((row) => row.id === plan.appId);
		requireInvariant(
			app !== undefined,
			`planned app ${canonicalIdentityDigest(plan.appId)} disappeared`,
		);
		const snapshot = frozenPersistableSnapshot(app, plan);
		return {
			app_id: plan.appId,
			seq: String(BigInt(app.mutation_seq) + BigInt(1)),
			snapshot,
			snapshot_digest: canonicalIdentityDigest(snapshot),
		};
	});
	await sql`
				WITH appended AS (
					INSERT INTO accepted_mutations
						(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
					SELECT
						id,
						mutation_seq + 1,
						${HORIZON_BATCH_ID},
						NULL,
						${HORIZON_ACTOR_ID},
						'migration',
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
						seq bigint,
						snapshot jsonb,
						snapshot_digest text
					)
			)
			INSERT INTO mutation_fold_baselines
				(app_id, seq, snapshot, snapshot_digest)
			SELECT app_id, seq, snapshot, snapshot_digest
			FROM incoming
			ORDER BY app_id
		`.execute(tx);
	}
	injectReviewedFailure(options, "horizon");

	await convertSqlIdentityColumns(tx);
	assertSqlIdentitySchema(await sqlColumnTypes(tx), "uuid");
	injectReviewedFailure(options, "ddl");

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
				SELECT current.app_id, current.seq::text, to_jsonb(current)::text AS row_text
				FROM accepted_mutations current
				JOIN jsonb_to_recordset(${JSON.stringify(
					appResult.rows.map((row) => ({
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

	const postApps = await sql<{
		id: string;
		case_types: unknown;
		mutation_seq: string;
	}>`
				SELECT id, case_types, mutation_seq::text
				FROM apps
				ORDER BY id
			`.execute(tx);
	const postEntities = await sql<{
		app_id: string;
		uuid: string;
		kind: string;
		parent_uuid: string | null;
		ordinal: number;
		data: Record<string, unknown>;
	}>`
				SELECT app_id, uuid::text AS uuid, kind, parent_uuid::text AS parent_uuid,
				       ordinal, data
				FROM blueprint_entities
				ORDER BY app_id, kind, parent_uuid NULLS FIRST, ordinal, uuid
			`.execute(tx);
	const expectedPost = canonicalIdentityDigest({
		apps: plans.map((plan) => ({
			id: plan.appId,
			case_types: plan.caseTypes,
			mutation_seq: String(
				BigInt(
					appResult.rows.find((row) => row.id === plan.appId)?.mutation_seq ??
						0,
				) + BigInt(1),
			),
		})),
		entities: plans.flatMap((plan) =>
			plan.rows.map((row) => ({
				app_id: plan.appId,
				uuid: row.uuid,
				kind: row.kind,
				parent_uuid: row.parentUuid,
				ordinal: row.ordinal,
				data: row.data,
			})),
		),
	});
	const actualPost = canonicalIdentityDigest({
		apps: postApps.rows,
		entities: postEntities.rows,
	});
	requireInvariant(
		actualPost === expectedPost,
		"stored current snapshots or heads differ from the frozen migration plan",
	);
	await assertAlreadyAppliedState(tx, options);

	const afterDigest = canonicalIdentityDigest({
		current: actualPost,
		archived: archivedAfter.rows.map((row) => [
			String(row.id),
			row.archived_text,
		]),
		oldAccepted: oldAcceptedAfter.rows,
		baselines: baselinePayload.map((row) => ({
			app_id: row.app_id,
			seq: row.seq,
			snapshot_digest: row.snapshot_digest,
		})),
		horizon: HORIZON_BATCH_ID,
	});
	const occurrencePlan = compareFrozenStorageOccurrences(
		occurrenceSource,
		await captureFrozenStorageSnapshot(tx),
	);

	return {
		version: CANONICAL_IDENTITY_MIGRATION_VERSION,
		alreadyApplied: false,
		apps: plans.length,
		entities: entityPayload.length,
		archivedMutationEvents: archivedBefore.size,
		rewriteBytes,
		beforeDigest,
		afterDigest,
		occurrenceSourceDigest: occurrencePlan.sourceDigest,
		occurrenceResultDigest: occurrencePlan.resultDigest,
		occurrencePlanDigest: occurrencePlan.planDigest,
	};
}
