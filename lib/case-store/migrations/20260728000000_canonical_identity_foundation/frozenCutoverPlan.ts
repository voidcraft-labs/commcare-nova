/**
 * One timestamp-frozen evidence authority for the canonical-identity cutover.
 *
 * Advisory scan, locked scan, repair rehearsal/application, and migration all
 * materialize this exact shape. It contains only content-free identities and
 * PostgreSQL-owned raw-row digests; executable code keeps the corresponding
 * exact lookup contexts and candidate snapshots in the same transaction.
 */

import { type Kysely, sql } from "kysely";
import {
	type FrozenStorageSnapshot,
	frozenExactTextSequenceDigest,
	parseFrozenExactJson,
} from "./frozenOccurrenceDispatcher";
import { FROZEN_OCCURRENCE_RELATIONS } from "./frozenOccurrenceManifest";
import {
	CANONICAL_IDENTITY_AFFECTED_APPS,
	CANONICAL_IDENTITY_LABEL_REPAIR,
	CANONICAL_IDENTITY_ROW_DELETES,
	FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST,
	FROZEN_PROJECT_ORPHAN_APP_ID_TABLES,
	FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
	FROZEN_THREAD_ATTACHMENT_REPAIRS,
} from "./frozenRepairManifest";
import { canonicalIdentityDigest } from "./frozenTransform";

export const FROZEN_CUTOVER_LIMITS = Object.freeze({
	apps: "10000",
	entities: "1000000",
	rewriteBytes: "536870912",
	walBytes: "1073741824",
	migrationJobSeconds: "1020",
	lockTimeoutMilliseconds: "15000",
	statementTimeoutMilliseconds: "960000",
	idleTransactionTimeoutMilliseconds: "990000",
});
const FROZEN_APP_CHANGE_FOLD_FUNCTION_NAMES = [
	"nova_admit_app_change_fold_baseline_insert",
	"nova_admit_app_change_insert",
	"nova_app_change_fold_snapshot_digest",
	"nova_current_app_change_fold_snapshot",
	"nova_insert_app_change_genesis_fold_baseline",
	"nova_reject_app_change_fold_baseline_change",
	"nova_require_app_change_fold_baseline",
	"nova_require_app_change_project_move_final",
	"nova_require_app_project_move_change",
] as const;

export type FrozenCutoverExecutionMode =
	| "advisory"
	| "locked"
	| "repair-rehearsal"
	| "repair-apply"
	| "migration";

export type FrozenCutoverState = "pristine" | "applied" | "mixed" | "drift";

export interface FrozenRawCarrierEvidence {
	readonly table: string;
	readonly exists: boolean;
	readonly rows: string;
	readonly bytes: string;
	readonly digest: string;
}

export interface FrozenCutoverAppDisposition {
	readonly appDigest: string;
	readonly projectDigest: string | null;
	readonly sourceDigest: string;
	readonly canonicalDigest: string;
	readonly sequence: string;
	readonly disposition:
		| "rewrite"
		| "preserve"
		| "repair"
		| "delete-project-orphan"
		| "already-applied"
		| "block";
	readonly lookupContextDigest: string | null;
	readonly referenceIndexDigest: string;
	readonly schemaDefinitionDigest: string;
	readonly findingsDigest: string;
}

export interface FrozenCutoverLeaseState {
	readonly appLeaseBlockers: string;
	readonly activeThreadHolders: string;
	readonly unterminatedChunks: string;
	readonly presenceSessions: string;
	readonly settledReservationRemnants: string;
	readonly digest: string;
}

export interface FrozenCutoverLookupContextEvidence {
	readonly projectDigest: string;
	readonly tableCount: string;
	readonly columnCount: string;
	readonly contextDigest: string;
}

export interface FrozenCutoverPlan {
	readonly version: "20260728000000-canonical-identity-cutover-plan-v1";
	readonly mode: FrozenCutoverExecutionMode;
	readonly state: FrozenCutoverState;
	readonly lockMode: "none" | "SHARE ROW EXCLUSIVE";
	readonly lockRelations: readonly string[];
	readonly apps: readonly FrozenCutoverAppDisposition[];
	readonly rawCarriers: readonly FrozenRawCarrierEvidence[];
	readonly leaseState: FrozenCutoverLeaseState;
	readonly lookupContexts: readonly FrozenCutoverLookupContextEvidence[];
	readonly referenceIndexDigest: string;
	readonly schemaDefinitionDigest: string;
	readonly baselineCatalogDigest: string;
	readonly dependencyCatalogDigest: string;
	readonly relationAndIndexAclDigest: string;
	readonly functionCatalogDigest: string;
	readonly capacity: {
		readonly apps: string;
		readonly entities: string;
		readonly sourceBytes: string;
		readonly rewriteBytes: string;
		readonly walBytes: string;
		readonly withinReviewedBounds: boolean;
	};
	readonly findings: readonly {
		readonly carrierId: string;
		readonly code: string;
		readonly pathDigest: string;
		readonly contentDigest: string;
	}[];
	readonly planDigest: string;
}

export interface FrozenCutoverPlanInput
	extends Omit<FrozenCutoverPlan, "version" | "lockMode" | "planDigest"> {}

export interface FrozenCutoverCatalogEvidence {
	readonly dependencyCatalogDigest: string;
	readonly schemaDefinitionDigest: string;
	readonly relationAndIndexAclDigest: string;
	readonly functionCatalogDigest: string;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const EXACT_ZERO = BigInt(0);
const EXACT_TWO = BigInt(2);

function exactNonnegative(value: string, label: string): bigint {
	if (!DECIMAL.test(value)) {
		throw new Error(`Frozen cutover ${label} is not an exact decimal count.`);
	}
	return BigInt(value);
}

function exactAdd(values: readonly string[], label: string): string {
	return values
		.reduce(
			(total, value) => total + exactNonnegative(value, label),
			EXACT_ZERO,
		)
		.toString();
}

/**
 * The one lease/stream inventory used by every locked cutover surface. The
 * digest is over PostgreSQL's exact JSONB text projection of every app lease
 * field, ordered by the app identity's UTF-8 bytes.
 */
export async function captureFrozenCutoverLeaseState<DB>(
	db: Kysely<DB>,
): Promise<FrozenCutoverLeaseState> {
	const leaseRows = await sql<{ lease_text: string }>`
		SELECT jsonb_build_object(
			'id', id,
			'status', status,
			'awaiting_input', awaiting_input,
			'run_id', run_id,
			'res_period', res_period,
			'res_reserved', res_reserved,
			'res_settled', res_settled,
			'res_user_id', res_user_id,
			'res_run_id', res_run_id,
			'lock_run_id', lock_run_id,
			'lock_actor_user_id', lock_actor_user_id,
			'lock_expire_at', lock_expire_at,
			'run_holder_nonce', run_holder_nonce,
			'updated_at', updated_at
		)::text AS lease_text
		FROM apps
		ORDER BY convert_to(id, 'UTF8')
	`.execute(db);
	const counts = (
		await sql<{
			app_lease_blockers: string;
			active_thread_holders: string;
			unterminated_chunks: string;
			presence_sessions: string;
			settled_reservation_remnants: string;
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
				) AS app_lease_blockers,
				(
					SELECT count(*)::text
					FROM threads
					WHERE active_stream_id IS NOT NULL
					   OR active_holder_nonce IS NOT NULL
				) AS active_thread_holders,
				(
					SELECT count(*)::text
					FROM chat_stream_chunks
					WHERE terminal IS NOT TRUE
				) AS unterminated_chunks,
				(SELECT count(*)::text FROM presence) AS presence_sessions,
				(
					SELECT count(*)::text
					FROM apps
					WHERE res_settled IS TRUE
					  AND res_period IS NOT NULL
				) AS settled_reservation_remnants
		`.execute(db)
	).rows[0];
	if (counts === undefined) {
		throw new Error("Frozen cutover lease inventory is unavailable.");
	}
	for (const [label, value] of Object.entries(counts)) {
		exactNonnegative(value, label);
	}
	return Object.freeze({
		appLeaseBlockers: counts.app_lease_blockers,
		activeThreadHolders: counts.active_thread_holders,
		unterminatedChunks: counts.unterminated_chunks,
		presenceSessions: counts.presence_sessions,
		settledReservationRemnants: counts.settled_reservation_remnants,
		digest: frozenExactTextSequenceDigest(
			leaseRows.rows.map((row) => row.lease_text),
		),
	});
}

/**
 * Catalog closure starts at `public.apps` itself, follows incoming FK and
 * `pg_depend` edges recursively, and rejects any dependent heap relation that
 * the frozen occurrence inventory does not own. The evidence also captures
 * complete relation/index ACL and fold-routine bodies, owners, ACLs, grants,
 * and fixed search paths.
 */
export async function captureFrozenCutoverCatalogEvidence<DB>(
	db: Kysely<DB>,
	casesSchema: "nova_case_runtime" | "public",
): Promise<FrozenCutoverCatalogEvidence> {
	const allowedRelations = new Set(
		FROZEN_OCCURRENCE_RELATIONS.map(
			(relation) =>
				`${relation.table === "cases" ? casesSchema : relation.schema}.${relation.table}`,
		),
	);
	allowedRelations.add("public.apps");
	for (const qualified of FROZEN_PROJECT_ORPHAN_APP_ID_TABLES) {
		allowedRelations.add(
			qualified === "nova_case_runtime.cases"
				? `${casesSchema}.cases`
				: qualified,
		);
	}
	for (const table of FROZEN_PROJECT_ORPHAN_AUTH_TABLES) {
		allowedRelations.add(`public.${table}`);
	}
	const ownedRelationsJson = JSON.stringify(
		[...allowedRelations].map((qualified) => {
			const [schema_name, relation_name] = qualified.split(".");
			return { schema_name, relation_name };
		}),
	);
	const dependencies = await sql<{
		dependent_catalog: string;
		dependent_identity: string;
		dependent_relation: string | null;
	}>`
		WITH RECURSIVE dependency AS (
			SELECT
				'pg_class'::regclass::oid AS classid,
				apps.oid AS objid,
				0::integer AS objsubid
			FROM pg_catalog.pg_class AS apps
			JOIN pg_catalog.pg_namespace AS namespace
			  ON namespace.oid = apps.relnamespace
			WHERE namespace.nspname = 'public'
			  AND apps.relname = 'apps'
			UNION
			SELECT
				child.classid,
				child.objid,
				child.objsubid
			FROM dependency
			JOIN pg_catalog.pg_depend AS child
			  ON child.refclassid = dependency.classid
			 AND child.refobjid = dependency.objid
			 AND (
					dependency.objsubid = 0
					OR child.refobjsubid = dependency.objsubid
			 )
		), projected AS (
			SELECT DISTINCT
				dependency.classid::regclass::text AS dependent_catalog,
				pg_catalog.pg_describe_object(
					dependency.classid,
					dependency.objid,
					dependency.objsubid
				) AS dependent_identity,
				CASE
					WHEN dependency.classid = 'pg_class'::regclass
					 AND relation.relkind IN ('r', 'p')
					THEN relation_namespace.nspname || '.' || relation.relname
					WHEN dependency.classid = 'pg_constraint'::regclass
					THEN constraint_namespace.nspname || '.' || constraint_relation.relname
					WHEN dependency.classid = 'pg_trigger'::regclass
					THEN trigger_namespace.nspname || '.' || trigger_relation.relname
					ELSE NULL
				END AS dependent_relation
			FROM dependency
			LEFT JOIN pg_catalog.pg_class AS relation
			  ON dependency.classid = 'pg_class'::regclass
			 AND relation.oid = dependency.objid
			LEFT JOIN pg_catalog.pg_namespace AS relation_namespace
			  ON relation_namespace.oid = relation.relnamespace
			LEFT JOIN pg_catalog.pg_constraint AS constraint_row
			  ON dependency.classid = 'pg_constraint'::regclass
			 AND constraint_row.oid = dependency.objid
			LEFT JOIN pg_catalog.pg_class AS constraint_relation
			  ON constraint_relation.oid = constraint_row.conrelid
			LEFT JOIN pg_catalog.pg_namespace AS constraint_namespace
			  ON constraint_namespace.oid = constraint_relation.relnamespace
			LEFT JOIN pg_catalog.pg_trigger AS trigger_row
			  ON dependency.classid = 'pg_trigger'::regclass
			 AND trigger_row.oid = dependency.objid
			LEFT JOIN pg_catalog.pg_class AS trigger_relation
			  ON trigger_relation.oid = trigger_row.tgrelid
			LEFT JOIN pg_catalog.pg_namespace AS trigger_namespace
			  ON trigger_namespace.oid = trigger_relation.relnamespace
		)
		SELECT *
		FROM projected
		ORDER BY
			convert_to(dependent_catalog, 'UTF8'),
			convert_to(dependent_identity, 'UTF8')
	`.execute(db);
	const incomingForeignKeys = await sql<{
		constraint_schema: string;
		constraint_name: string;
		source_relation: string;
		definition: string;
		validated: boolean;
		deferrable: boolean;
		initially_deferred: boolean;
	}>`
		SELECT
			constraint_namespace.nspname AS constraint_schema,
			constraint_row.conname AS constraint_name,
			source_namespace.nspname || '.' || source_relation.relname
				AS source_relation,
			pg_get_constraintdef(constraint_row.oid, true) AS definition,
			constraint_row.convalidated AS validated,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred
		FROM pg_catalog.pg_constraint AS constraint_row
		JOIN pg_catalog.pg_class AS source_relation
		  ON source_relation.oid = constraint_row.conrelid
		JOIN pg_catalog.pg_namespace AS source_namespace
		  ON source_namespace.oid = source_relation.relnamespace
		JOIN pg_catalog.pg_namespace AS constraint_namespace
		  ON constraint_namespace.oid = constraint_row.connamespace
		WHERE constraint_row.contype = 'f'
		  AND constraint_row.confrelid = 'public.apps'::regclass
		ORDER BY
			convert_to(source_namespace.nspname, 'UTF8'),
			convert_to(source_relation.relname, 'UTF8'),
			convert_to(constraint_row.conname, 'UTF8')
	`.execute(db);
	const unexpectedRelation = [
		...dependencies.rows.flatMap((row) =>
			row.dependent_relation === null ? [] : [row.dependent_relation],
		),
		...incomingForeignKeys.rows.map((row) => row.source_relation),
	].find((relation) => !allowedRelations.has(relation));
	if (unexpectedRelation !== undefined) {
		throw new Error(
			"Frozen cutover discovered an unowned apps dependency relation.",
		);
	}
	const relationCatalog = await sql<{
		schema_name: string;
		relation_name: string;
		relation_kind: string;
		owner_name: string;
		relation_acl: string;
		row_security: boolean;
		force_row_security: boolean;
		index_definition: string | null;
		index_acl: string | null;
	}>`
		WITH owned_relation(schema_name, relation_name) AS (
			SELECT *
			FROM jsonb_to_recordset(
				${ownedRelationsJson}::jsonb
			) AS value(schema_name text, relation_name text)
		)
		SELECT
			namespace.nspname AS schema_name,
			relation.relname AS relation_name,
			relation.relkind::text AS relation_kind,
			owner_role.rolname AS owner_name,
			COALESCE(to_jsonb(relation.relacl)::text, 'null') AS relation_acl,
			relation.relrowsecurity AS row_security,
			relation.relforcerowsecurity AS force_row_security,
			pg_get_indexdef(index_relation.oid) AS index_definition,
			COALESCE(to_jsonb(index_relation.relacl)::text, 'null') AS index_acl
		FROM owned_relation
		JOIN pg_catalog.pg_namespace AS namespace
		  ON namespace.nspname = owned_relation.schema_name
		JOIN pg_catalog.pg_class AS relation
		  ON relation.relnamespace = namespace.oid
		 AND relation.relname = owned_relation.relation_name
		JOIN pg_catalog.pg_roles AS owner_role
		  ON owner_role.oid = relation.relowner
		LEFT JOIN pg_catalog.pg_index AS index_catalog
		  ON index_catalog.indrelid = relation.oid
		LEFT JOIN pg_catalog.pg_class AS index_relation
		  ON index_relation.oid = index_catalog.indexrelid
		ORDER BY
			convert_to(namespace.nspname, 'UTF8'),
			convert_to(relation.relname, 'UTF8'),
			convert_to(COALESCE(index_relation.relname, ''), 'UTF8')
	`.execute(db);
	const schemaObjects = await sql<{
		object_kind: string;
		schema_name: string;
		relation_name: string;
		object_name: string;
		definition: string;
	}>`
		WITH owned_relation(schema_name, relation_name) AS (
			SELECT *
			FROM jsonb_to_recordset(${ownedRelationsJson}::jsonb)
				AS value(schema_name text, relation_name text)
		), relation_oid AS (
			SELECT
				namespace.nspname AS schema_name,
				relation.relname AS relation_name,
				relation.oid
			FROM owned_relation
			JOIN pg_catalog.pg_namespace AS namespace
			  ON namespace.nspname = owned_relation.schema_name
			JOIN pg_catalog.pg_class AS relation
			  ON relation.relnamespace = namespace.oid
			 AND relation.relname = owned_relation.relation_name
		), schema_object AS (
			SELECT
				'column'::text AS object_kind,
				relation_oid.schema_name,
				relation_oid.relation_name,
				attribute.attnum::text AS object_name,
				jsonb_build_object(
					'name', attribute.attname,
					'type', pg_catalog.format_type(
						attribute.atttypid,
						attribute.atttypmod
					),
					'not_null', attribute.attnotnull,
					'identity', attribute.attidentity,
					'generated', attribute.attgenerated,
					'default', pg_catalog.pg_get_expr(
						attribute_default.adbin,
						attribute_default.adrelid
					),
					'collation', collation_row.collname
				)::text AS definition
			FROM relation_oid
			JOIN pg_catalog.pg_attribute AS attribute
			  ON attribute.attrelid = relation_oid.oid
			 AND attribute.attnum > 0
			 AND NOT attribute.attisdropped
			LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
			  ON attribute_default.adrelid = attribute.attrelid
			 AND attribute_default.adnum = attribute.attnum
			LEFT JOIN pg_catalog.pg_collation AS collation_row
			  ON collation_row.oid = attribute.attcollation
			UNION ALL
			SELECT
				'constraint',
				relation_oid.schema_name,
				relation_oid.relation_name,
				constraint_row.conname,
				jsonb_build_object(
					'definition', pg_catalog.pg_get_constraintdef(
						constraint_row.oid,
						true
					),
					'type', constraint_row.contype,
					'validated', constraint_row.convalidated,
					'deferrable', constraint_row.condeferrable,
					'initially_deferred', constraint_row.condeferred,
					'local', constraint_row.conislocal
				)::text
			FROM relation_oid
			JOIN pg_catalog.pg_constraint AS constraint_row
			  ON constraint_row.conrelid = relation_oid.oid
			UNION ALL
			SELECT
				'trigger',
				relation_oid.schema_name,
				relation_oid.relation_name,
				trigger_row.tgname,
				jsonb_build_object(
					'definition', pg_catalog.pg_get_triggerdef(
						trigger_row.oid,
						true
					),
					'enabled', trigger_row.tgenabled,
					'function', trigger_row.tgfoid::regprocedure::text
				)::text
			FROM relation_oid
			JOIN pg_catalog.pg_trigger AS trigger_row
			  ON trigger_row.tgrelid = relation_oid.oid
			 AND NOT trigger_row.tgisinternal
		)
		SELECT *
		FROM schema_object
		ORDER BY
			convert_to(schema_name, 'UTF8'),
			convert_to(relation_name, 'UTF8'),
			convert_to(object_kind, 'UTF8'),
			convert_to(object_name, 'UTF8')
	`.execute(db);
	const functionCatalog = await sql<{
		signature: string;
		body: string;
		owner_name: string;
		function_acl: string;
		search_path: string;
	}>`
		SELECT
			function_row.oid::regprocedure::text AS signature,
			pg_get_functiondef(function_row.oid) AS body,
			owner_role.rolname AS owner_name,
			COALESCE(to_jsonb(function_row.proacl)::text, 'null') AS function_acl,
			COALESCE(to_jsonb(function_row.proconfig)::text, 'null') AS search_path
		FROM pg_catalog.pg_proc AS function_row
		JOIN pg_catalog.pg_namespace AS namespace
		  ON namespace.oid = function_row.pronamespace
		JOIN pg_catalog.pg_roles AS owner_role
		  ON owner_role.oid = function_row.proowner
		WHERE namespace.nspname = 'public'
		  AND function_row.proname = ANY(
				${sql.val([...FROZEN_APP_CHANGE_FOLD_FUNCTION_NAMES])}
		  )
		ORDER BY convert_to(function_row.oid::regprocedure::text, 'UTF8')
	`.execute(db);
	const tenancyConstraints = await sql<{
		relation_name: string;
		constraint_name: string;
		definition: string;
		owner_name: string;
	}>`
		SELECT
			namespace.nspname || '.' || relation.relname AS relation_name,
			constraint_row.conname AS constraint_name,
			pg_get_constraintdef(constraint_row.oid, true) AS definition,
			owner_role.rolname AS owner_name
		FROM pg_catalog.pg_constraint AS constraint_row
		JOIN pg_catalog.pg_class AS relation
		  ON relation.oid = constraint_row.conrelid
		JOIN pg_catalog.pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		JOIN pg_catalog.pg_roles AS owner_role
		  ON owner_role.oid = relation.relowner
		WHERE (
				namespace.nspname = 'public'
				AND relation.relname = 'apps'
				AND pg_get_constraintdef(constraint_row.oid, true) LIKE '%project_id%'
			)
			OR (
				namespace.nspname = ${casesSchema}
				AND relation.relname = 'cases'
				AND pg_get_constraintdef(constraint_row.oid, true) LIKE '%project_id%'
			)
		ORDER BY
			convert_to(namespace.nspname, 'UTF8'),
			convert_to(relation.relname, 'UTF8'),
			convert_to(constraint_row.conname, 'UTF8')
	`.execute(db);
	return {
		dependencyCatalogDigest: canonicalIdentityDigest({
			dependencies: dependencies.rows,
			incomingForeignKeys: incomingForeignKeys.rows,
		}),
		schemaDefinitionDigest: canonicalIdentityDigest({
			incomingForeignKeys: incomingForeignKeys.rows,
			schemaObjects: schemaObjects.rows,
			tenancyConstraints: tenancyConstraints.rows,
		}),
		relationAndIndexAclDigest: canonicalIdentityDigest(relationCatalog.rows),
		functionCatalogDigest: canonicalIdentityDigest(functionCatalog.rows),
	};
}

function rawCarrierEvidence(
	table: string,
	entry: FrozenStorageSnapshot[string],
): FrozenRawCarrierEvidence {
	const rowTexts = entry.rowTexts;
	if (entry.exists && rowTexts === undefined) {
		throw new Error(
			`Frozen cutover raw carrier ${table} has no PostgreSQL row text.`,
		);
	}
	const texts = rowTexts ?? [];
	return {
		table,
		exists: entry.exists,
		rows: texts.length.toString(),
		bytes: texts
			.reduce(
				(total, value) => total + BigInt(Buffer.byteLength(value, "utf8")),
				EXACT_ZERO,
			)
			.toString(),
		digest: frozenExactTextSequenceDigest(texts),
	};
}

export function frozenRawCarrierEvidence(
	snapshot: FrozenStorageSnapshot,
): readonly FrozenRawCarrierEvidence[] {
	return Object.entries(snapshot)
		.filter(([table, entry]) => !table.startsWith("__") && entry !== undefined)
		.sort(([left], [right]) =>
			Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
		)
		.map(([table, entry]) => rawCarrierEvidence(table, entry));
}

export function classifyFrozenMigrationCutoverState(input: {
	readonly identitySqlType: "text" | "uuid" | "mixed" | "other";
	readonly baselineCatalog: "absent" | "exact" | "partial-or-drift";
	readonly appCount: string;
	readonly baselineAppCount: string;
	readonly baselineCount: string;
}): FrozenCutoverState {
	const apps = exactNonnegative(input.appCount, "app count");
	const baselineApps = exactNonnegative(
		input.baselineAppCount,
		"baseline app count",
	);
	const baselines = exactNonnegative(input.baselineCount, "baseline count");
	if (
		input.identitySqlType === "text" &&
		input.baselineCatalog === "absent" &&
		baselineApps === EXACT_ZERO &&
		baselines === EXACT_ZERO
	) {
		return "pristine";
	}
	if (
		input.identitySqlType === "uuid" &&
		input.baselineCatalog === "exact" &&
		baselineApps === apps &&
		baselines >= apps
	) {
		return "applied";
	}
	if (
		input.identitySqlType === "mixed" ||
		(input.identitySqlType === "text" &&
			(baselineApps > EXACT_ZERO || baselines > EXACT_ZERO)) ||
		(input.identitySqlType === "uuid" &&
			(baselineApps > EXACT_ZERO || baselines > EXACT_ZERO) &&
			baselineApps < apps)
	) {
		return "mixed";
	}
	return "drift";
}

export function createFrozenCutoverPlan(
	input: FrozenCutoverPlanInput,
): FrozenCutoverPlan {
	const locked = input.mode !== "advisory";
	if (locked && input.lockRelations.length === 0) {
		throw new Error("Frozen cutover locked plan has no relation inventory.");
	}
	/* The lease counters are recorded in the plan, never required to be zero.
	 * They say who happened to be mid-request, which the table locks this
	 * transaction already holds make irrelevant — a concurrent writer blocks on
	 * those or fails against them. Requiring zero would mean requiring an
	 * outage: `unterminatedChunks` counts every non-final chat chunk within its
	 * 24-hour retention, so any chat run that day would block the deploy, and
	 * `presenceSessions` counts every open builder tab. They are still parsed
	 * here so a malformed counter is caught rather than carried into the plan. */
	for (const [value, label] of [
		[input.leaseState.appLeaseBlockers, "app lease blockers"],
		[input.leaseState.activeThreadHolders, "thread holders"],
		[input.leaseState.unterminatedChunks, "unterminated chunks"],
		[input.leaseState.presenceSessions, "presence sessions"],
	] as const) {
		exactNonnegative(value, label);
	}
	const projectDigests = input.lookupContexts.map(
		(context) => context.projectDigest,
	);
	if (new Set(projectDigests).size !== projectDigests.length) {
		throw new Error("Frozen cutover lookup context inventory is duplicated.");
	}
	const appDigests = input.apps.map((app) => app.appDigest);
	if (new Set(appDigests).size !== appDigests.length) {
		throw new Error("Frozen cutover app disposition inventory is duplicated.");
	}
	const withinReviewedBounds =
		exactNonnegative(input.capacity.apps, "capacity apps") <=
			exactNonnegative(FROZEN_CUTOVER_LIMITS.apps, "app bound") &&
		exactNonnegative(input.capacity.entities, "capacity entities") <=
			exactNonnegative(FROZEN_CUTOVER_LIMITS.entities, "entity bound") &&
		exactNonnegative(input.capacity.rewriteBytes, "rewrite bytes") <=
			exactNonnegative(FROZEN_CUTOVER_LIMITS.rewriteBytes, "rewrite bound") &&
		exactNonnegative(input.capacity.walBytes, "WAL bytes") <=
			exactNonnegative(FROZEN_CUTOVER_LIMITS.walBytes, "WAL bound");
	if (!withinReviewedBounds) {
		throw new Error("Frozen cutover exceeds a reviewed capacity bound.");
	}
	const core = {
		version: "20260728000000-canonical-identity-cutover-plan-v1" as const,
		...input,
		lockMode: locked ? ("SHARE ROW EXCLUSIVE" as const) : ("none" as const),
		capacity: { ...input.capacity, withinReviewedBounds },
	};
	return Object.freeze({
		...core,
		planDigest: canonicalIdentityDigest(core),
	});
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function tableTexts(
	snapshot: FrozenStorageSnapshot,
	table: string,
): readonly string[] {
	const entry = snapshot[table];
	if (entry === undefined || !entry.exists || entry.rowTexts === undefined) {
		throw new Error(`Frozen repair raw table ${table} is unavailable.`);
	}
	return entry.rowTexts;
}

function withoutRows(
	rows: readonly string[],
	allowed: (row: Record<string, unknown>) => boolean,
): readonly string[] {
	return rows.filter((rowText) => {
		const parsed = record(parseFrozenExactJson(rowText));
		if (parsed === undefined) {
			throw new Error("Frozen repair raw row is not a JSON object.");
		}
		return !allowed(parsed);
	});
}

function exactTextSetEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

/**
 * Dedicated repair delta comparator. The caller separately proves the exact
 * allowed rows' source/result digests; this function proves everything outside
 * those rows stayed as PostgreSQL emitted it, including all lookup rows.
 */
export function assertFrozenRepairAllowedDelta(
	source: FrozenStorageSnapshot,
	result: FrozenStorageSnapshot,
): void {
	const affectedAppDigests = new Set<string>(
		CANONICAL_IDENTITY_AFFECTED_APPS.map(([appDigest]) => appDigest),
	);
	const allowedAppDigests = new Set([
		...affectedAppDigests,
		FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST,
	]);
	const deletedEntityKeys = new Set(
		CANONICAL_IDENTITY_ROW_DELETES.map(
			([appDigest, uuid]) => `${appDigest}\u0000${uuid}`,
		),
	);
	const changedEntityKeys = new Set([
		...deletedEntityKeys,
		`${CANONICAL_IDENTITY_LABEL_REPAIR.appDigest}\u0000${CANONICAL_IDENTITY_LABEL_REPAIR.fieldUuid}`,
	]);
	const compareFiltered = (
		table: string,
		allowed: (row: Record<string, unknown>) => boolean,
	): void => {
		if (
			!exactTextSetEqual(
				withoutRows(tableTexts(source, table), allowed),
				withoutRows(tableTexts(result, table), allowed),
			)
		) {
			throw new Error(
				`Frozen repair changed an unapproved complete row in ${table}.`,
			);
		}
	};
	compareFiltered("apps", (row) => {
		const id = typeof row.id === "string" ? row.id : "";
		return allowedAppDigests.has(canonicalIdentityDigest(id));
	});
	compareFiltered("blueprint_entities", (row) => {
		const appId = typeof row.app_id === "string" ? row.app_id : "";
		const uuid = typeof row.uuid === "string" ? row.uuid : "";
		return changedEntityKeys.has(
			`${canonicalIdentityDigest(appId)}\u0000${uuid}`,
		);
	});
	compareFiltered("app_changes", (row) => {
		const appId = typeof row.app_id === "string" ? row.app_id : "";
		return (
			canonicalIdentityDigest(appId) === FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST
		);
	});
	compareFiltered("case_type_schemas", (row) => {
		const appId = typeof row.app_id === "string" ? row.app_id : "";
		return (
			canonicalIdentityDigest(appId) === FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST
		);
	});
	const repairedThreads = new Set(
		FROZEN_THREAD_ATTACHMENT_REPAIRS.map(
			(repair) => `${repair.appId}\u0000${repair.threadId}`,
		),
	);
	if (source.threads?.exists || result.threads?.exists) {
		compareFiltered("threads", (row) => {
			const appId = typeof row.app_id === "string" ? row.app_id : "";
			const threadId = typeof row.thread_id === "string" ? row.thread_id : "";
			return repairedThreads.has(`${appId}\u0000${threadId}`);
		});
	}
	for (const [table, entry] of Object.entries(source)) {
		if (
			table.startsWith("__") ||
			[
				"apps",
				"blueprint_entities",
				"app_changes",
				"case_type_schemas",
				"threads",
			].includes(table)
		) {
			continue;
		}
		const resultEntry = result[table];
		if (
			resultEntry === undefined ||
			entry.exists !== resultEntry.exists ||
			!exactTextSetEqual(entry.rowTexts ?? [], resultEntry.rowTexts ?? [])
		) {
			throw new Error(
				`Frozen repair changed unapproved PostgreSQL row bytes in ${table}.`,
			);
		}
	}
	const lookupSource = rawCarrierEvidence(
		"lookup_rows",
		source.lookup_rows ?? { exists: false, rows: [] },
	);
	const lookupResult = rawCarrierEvidence(
		"lookup_rows",
		result.lookup_rows ?? { exists: false, rows: [] },
	);
	if (
		lookupSource.digest !== lookupResult.digest ||
		lookupSource.rows !== lookupResult.rows ||
		lookupSource.bytes !== lookupResult.bytes
	) {
		throw new Error("Frozen repair must preserve the whole lookup_rows table.");
	}
}

export function reviewedFrozenCapacity(input: {
	readonly apps: string;
	readonly entities: string;
	readonly sourceBytes: readonly string[];
	readonly rewriteBytes: string;
}): FrozenCutoverPlan["capacity"] {
	const sourceBytes = exactAdd(input.sourceBytes, "source bytes");
	const rewrite = exactNonnegative(input.rewriteBytes, "rewrite bytes");
	return {
		apps: input.apps,
		entities: input.entities,
		sourceBytes,
		rewriteBytes: rewrite.toString(),
		walBytes: (rewrite * EXACT_TWO).toString(),
		withinReviewedBounds: false,
	};
}
