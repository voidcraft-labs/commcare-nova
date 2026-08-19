// lib/case-store/postgres/store.ts
//
// `PostgresCaseStore` — the only implementation of the `CaseStore`
// interface. Wraps the `Kysely<Database>` instance, threading the
// AST→Kysely predicate / expression / relation-path compilers into
// the live runtime.
//
// Architectural contract:
//
//   - **Structural tenant scoping.** Every tenant-bound read/write
//     adds `WHERE project_id = <bound>` to the underlying query and
//     stamps `owner_id = <owner>` (the CommCare case-owner, a separate
//     axis — not the tenant filter) on every insert; the JOIN-side
//     `project_id` filter on every joined `cases` row inside relation
//     walks lives at the compiler stack (`compileRelationPath`).
//     Cross-Project reads are structurally impossible. The per-row
//     SCHEMA migrations are the deliberate exception — their case-row work is
//     app-scoped (`(app_id, case_type)`, no tenant filter) so a schema change
//     migrates every member's rows. Their actor-free store nevertheless starts
//     every write with `apps FOR SHARE`, binding it to one current Project-move
//     winner for the transaction.
//   - **API-trust-boundary validation.** Writes validate the
//     candidate `properties` payload against the case-type's JSON
//     Schema (the row in `case_type_schemas`) via `ajv` BEFORE the
//     write reaches Postgres. The schema row is fetched on demand
//     and the compiled validator is cached per
//     `(appId, caseType, schemaContent)`. There is no in-database
//     trigger and no `pg_jsonschema` dependency.
//   - **`applySchemaChange` is two phases.** Phase A is one Kysely
//     transaction: UPSERT `case_type_schemas` + run the optional
//     per-row migration (`rename` / `retype` / `narrow-options`).
//     Phase B runs after Phase A commits and emits the per-property
//     expression-index `CREATE INDEX CONCURRENTLY` /
//     `DROP INDEX CONCURRENTLY` diff. Phase B cannot share Phase A's
//     transaction — non-CONCURRENTLY index builds heap-scan with
//     `SnapshotAny` semantics that include the dead tuples a retype's
//     quarantine inserts + deletes left in the same transaction;
//     CONCURRENTLY index builds reject any outer transaction.
//
// Identifier validation runs synchronously at the top of
// `applySchemaChange` before Phase A opens. A throw leaves
// `case_type_schemas` untouched — the database never holds a
// schema row whose properties cannot all be indexed.

import { isDeepStrictEqual } from "node:util";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
	type Insertable,
	type InsertObject,
	type Kysely,
	type RawBuilder,
	type Selectable,
	sql,
	type Transaction,
} from "kysely";
import { v7 as uuidv7 } from "uuid";
import type {
	CaseProperty,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import {
	CASE_SCALAR_PROPERTY_NAMES,
	casePropertyDataTypes,
	prepareCaseScalarTextValue,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import {
	compilerBugMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import {
	type CaseTypeJsonSchema,
	caseTypeToJsonSchema,
	schemaForDataType,
} from "@/lib/domain/predicate/jsonSchema";
import type { RelationPath } from "@/lib/domain/predicate/types";
import { proseText } from "@/lib/domain/prose";
import {
	storageDatetimeValue,
	storageTimeValue,
} from "@/lib/domain/temporalValues";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	AutomationHostAmbiguityError,
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	ParkedValueNotFoundError,
	SchemaChangePhaseBError,
	SchemaNotSyncedError,
} from "../errors";
import type { SampleCaseGenerator } from "../sample/generator";
import {
	buildRestoreScope,
	compileExpression,
	compilePredicate,
	compileRelationPath,
	expressionContextFor,
	POSTGRES_CAST_FOR_DATA_TYPE,
	type PredicateCompileContext,
	type RestoreScopeQuery,
} from "../sql";
import type {
	CaseIndicesTable,
	Database,
	JsonObject,
	JsonValue,
	ParkedCaseValuesTable,
} from "../sql/database";
import { RESERVED_SCALAR_COLUMN_BY_PROPERTY } from "../sql/dataTypeTokens";
import type {
	ApplyCasePropertyRenameArgs,
	ApplyCaseTypeSchemaRetirementArgs,
	ApplySchemaChangeArgs,
	CalculatedColumn,
	CalculatedValue,
	CaseInsert,
	CaseRow,
	CaseRowWithCalculated,
	CaseStore,
	CaseUpdate,
	CaseUpdateArgs,
	ConversionImpact,
	CountArgs,
	GenerateSampleDataArgs,
	GroupedQueryArgs,
	GroupedQueryResult,
	MigrationReport,
	ParkedValueEntry,
	PreparedCasePropertyRenamePhaseB,
	PreparedCaseTypeSchemaRetirementPhaseB,
	PreparedSchemaChangePhaseB,
	QueryArgs,
	ResetSampleDataArgs,
	RestoreScope,
	SchemaChangeKind,
} from "../store";
import { CasePropertyRenameStorageConflictError } from "../store";
import type {
	ApplySubmissionArgs,
	SubmissionEnvelopeResult,
} from "../submission";
import {
	caseSchemaIndexLockScope,
	indexScopeTag,
	propertyIndexTag,
} from "./indexIdentity";
import { retireCaseTypeSchemasPhaseA } from "./schemaRetirement";
import {
	executeSubmissionEnvelope,
	type SubmissionEnvelopeHost,
} from "./submissionEnvelope";
import {
	completeSubmissionReceipt,
	prepareSubmissionReceipt,
} from "./submissionReceipt";
import { ajvErrorToCaseFailure } from "./validationFailure";

export { indexScopeTag, propertyIndexTag } from "./indexIdentity";

/**
 * Construction arguments. Production callers go through
 * `withProjectContext(projectId, actorUserId, ownerId)` (tenant-bound) or
 * `withSchemaContext()` (schema-only); tests construct directly with a
 * per-test isolated Kysely instance and either the heuristic generator
 * or a stub.
 *
 * `projectId` / `actorUserId` are `null` for a schema-only store
 * (`withSchemaContext`): schema operations are actor-free and app-scoped,
 * while their injected authorization fence locks the live app and observes
 * its current Project inside each write transaction. Every tenant-bound read/write reads
 * them through `requireProjectId()` / `requireActorUserId()`, which
 * throw if reached on a schema-only store — unreachable in practice
 * because `withSchemaContext` returns the narrow `SchemaCaseStore`
 * type that exposes no such method.
 */
export interface PostgresCaseStoreArgs {
	projectId: string | null;
	actorUserId: string | null;
	/**
	 * The CommCare worker whose `owner_id` new rows carry and whose identity
	 * `acting-user` resolves to. Distinct from `actorUserId`, which is the
	 * Nova member and the ONLY thing that authorizes: previewing as a persona
	 * runs as that persona while the signed-in member still authorizes.
	 * Explicit at every construction site so adding a second identity can
	 * never silently inherit the authorizing member.
	 */
	ownerId: string | null;
	db: Kysely<Database>;
	sampleGenerator: SampleCaseGenerator;
	/**
	 * Production-only fresh authorization fence for actor case mutations. It
	 * runs as the first operation in the SAME transaction as the case write;
	 * direct package tests may omit it because they exercise storage mechanics
	 * without app-state/auth tables.
	 */
	authorizeMutation?: (
		tx: Transaction<Database>,
		args: {
			readonly appId: string;
			readonly projectId: string;
			readonly actorUserId: string;
		},
	) => Promise<{ readonly appMutationSeq: number }>;
	/**
	 * Production-only app-placement fence for actor-free schema mutations. It
	 * runs first in the schema/data transaction and holds `apps FOR SHARE` so a
	 * Project move cannot straddle the write. Direct storage tests may omit it.
	 */
	authorizeSchemaMutation?: (
		tx: Transaction<Database>,
		args: { readonly appId: string },
	) => Promise<void>;
}

/**
 * One ajv instance per `PostgresCaseStore`. Reusing one across
 * compilations lets ajv's internal schema cache amortize keyword
 * resolution. `Ajv2020` matches `caseTypeToJsonSchema`'s draft
 * level; `addFormats` wires the temporal `format` handlers (without
 * it the formats are unrecognized and the schema silently passes
 * any string); `strict: false` admits the schema generator's loose
 * extra keywords.
 */
function buildAjv(): Ajv2020 {
	const ajv = new Ajv2020({ strict: false });
	addFormats(ajv);
	return ajv;
}

function assertNullableNonblankIdentity(
	value: string | null,
	label: string,
): void {
	if (value === null) return;
	if (typeof value === "string" && value.trim().length > 0) return;
	throw new Error(`${label} identity must be a nonblank string or null.`);
}

/**
 * Cached compiled-validator entry. Cache lookups compare against
 * the JSON-stringified schema content so a `case_type_schemas` row
 * update invalidates the cached validator without manual eviction.
 */
interface ValidatorCacheEntry {
	schemaJson: string;
	validate: ValidateFunction<unknown>;
	/** Property keys the schema declares — the merged-update strip's allowlist. */
	declared: ReadonlySet<string>;
}

/** HQ resolves `parent/...` through every live `parent` identifier, regardless
 * of child/extension relationship. `host/...` resolves only the first live
 * extension. Nova gives that otherwise storage-order-dependent choice a stable
 * order: the canonical `parent` extension first, then identifier and target. */
function automationRelationIndexFilter(args: {
	readonly scope: "parent" | "host";
	readonly caseAlias: string;
	readonly indexAlias: string;
	readonly firstHostAlias: string;
}) {
	if (args.scope === "parent") {
		return sql<boolean>`${sql.ref(`${args.indexAlias}.identifier`)} = 'parent'`;
	}
	return sql<boolean>`(
		${sql.ref(`${args.indexAlias}.identifier`)},
		${sql.ref(`${args.indexAlias}.ancestor_id`)}
	) = (
		select
			${sql.ref(`${args.firstHostAlias}.identifier`)},
			${sql.ref(`${args.firstHostAlias}.ancestor_id`)}
		from case_indices as ${sql.ref(args.firstHostAlias)}
		where ${sql.ref(`${args.firstHostAlias}.case_id`)} = ${sql.ref(`${args.caseAlias}.case_id`)}
			and ${sql.ref(`${args.firstHostAlias}.relationship`)} = 'extension'
			and ${sql.ref(`${args.firstHostAlias}.depth`)} = 1
		order by
			case when ${sql.ref(`${args.firstHostAlias}.identifier`)} = 'parent' then 0 else 1 end,
			${sql.ref(`${args.firstHostAlias}.identifier`)} asc,
			${sql.ref(`${args.firstHostAlias}.ancestor_id`)} asc
		limit 1
	)`;
}

/** Python's `str.strip()` whitespace repertoire, which HQ uses for
 * HAS_VALUE / HAS_NO_VALUE. PostgreSQL's locale-dependent `[[:space:]]`
 * disagrees for characters including NBSP, OGHAM SPACE MARK, FIGURE SPACE,
 * NARROW NO-BREAK SPACE, and the U+001C..U+001F separators. An explicit trim
 * set keeps Preview independent of the database locale and Python-equivalent. */
const PYTHON_STRIP_WHITESPACE = String.fromCodePoint(
	0x0009,
	0x000a,
	0x000b,
	0x000c,
	0x000d,
	0x001c,
	0x001d,
	0x001e,
	0x001f,
	0x0020,
	0x0085,
	0x00a0,
	0x1680,
	0x2000,
	0x2001,
	0x2002,
	0x2003,
	0x2004,
	0x2005,
	0x2006,
	0x2007,
	0x2008,
	0x2009,
	0x200a,
	0x2028,
	0x2029,
	0x202f,
	0x205f,
	0x3000,
);

function automationStringHasValue(
	value: RawBuilder<string | null>,
): RawBuilder<boolean> {
	return sql<boolean>`btrim(coalesce(${value}, ''), ${PYTHON_STRIP_WHITESPACE}) <> ''`;
}

/**
 * Lower the admitted shared regex subset to PostgreSQL ARE while preserving
 * Python `re.match`'s default newline behavior. PostgreSQL's default `.` also
 * consumes newlines, while its newline-sensitive modes change negated classes
 * and anchor semantics that Python leaves alone. Rewrite only the two tokens
 * whose defaults differ instead: `.` excludes LF, and `$` also succeeds just
 * before one final LF. Escaped tokens and tokens inside character classes stay
 * literal. The domain validator has already admitted the authored pattern.
 */
function postgresAutomationRegex(pattern: string): string {
	let escaped = false;
	let inClass = false;
	let lowered = "";
	for (const character of pattern) {
		if (escaped) {
			lowered += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			lowered += character;
			escaped = true;
			continue;
		}
		if (character === "[" && !inClass) {
			inClass = true;
			lowered += character;
			continue;
		}
		if (character === "]" && inClass) {
			inClass = false;
			lowered += character;
			continue;
		}
		if (!inClass && character === ".") {
			lowered += "[^\\x0A]";
			continue;
		}
		if (!inClass && character === "$") {
			lowered += "(?=\\x0A?\\Z)";
			continue;
		}
		lowered += character;
	}
	return `(?cs)\\A(?:${lowered})`;
}

/** HQ's day-offset criteria compare calendar dates, not instants. Dynamic
 * date/datetime values are schema-canonical ISO strings, so taking the leading
 * date component preserves an explicit offset's authored calendar day instead
 * of routing it through the Postgres session timezone. Standard timestamps are
 * stored in UTC and are truncated there, matching HQ's model datetime. */
function automationCriterionDateForAlias(alias: string, property: string) {
	const scalar = RESERVED_SCALAR_COLUMN_BY_PROPERTY.get(property);
	if (scalar !== undefined) {
		return sql<Date | null>`timezone('UTC', ${sql.ref(`${alias}.${scalar.column}`)})::date`;
	}
	const storedJson = sql<unknown | null>`${sql.ref(
		`${alias}.properties`,
	)} -> ${property}`;
	const storedText = sql<string | null>`${sql.ref(
		`${alias}.properties`,
	)} ->> ${property}`;
	return sql<Date | null>`case
		when jsonb_typeof(${storedJson}) = 'string'
			then substring(${storedText} from 1 for 10)::date
		else null
	end`;
}

function automationDateCriterionClause(criterion: {
	readonly property: string;
	readonly days: number;
	readonly matchType:
		| "date-days-before"
		| "date-days-lte"
		| "date-days-gt"
		| "date-days";
	readonly scope: "case" | "parent" | "host";
}) {
	const comparisonForAlias = (alias: string) => {
		const storedDate = automationCriterionDateForAlias(
			alias,
			criterion.property,
		);
		const today = sql<Date>`timezone('UTC', now())::date`;
		const threshold = sql<Date>`${storedDate} + ${criterion.days}::integer`;
		switch (criterion.matchType) {
			case "date-days-before":
				return sql<boolean>`${today} < ${threshold}`;
			case "date-days-lte":
				return sql<boolean>`${today} <= ${threshold}`;
			case "date-days-gt":
				return sql<boolean>`${today} > ${threshold}`;
			case "date-days":
				return sql<boolean>`${today} >= ${threshold}`;
		}
	};
	if (criterion.scope === "case") return comparisonForAlias("c");
	const relatedComparison = comparisonForAlias("automation_date_related");
	return sql<boolean>`exists (
		select 1
		from case_indices as automation_date_index
		join cases as automation_date_related
			on automation_date_related.case_id = automation_date_index.ancestor_id
			and automation_date_related.app_id = c.app_id
			and automation_date_related.project_id = c.project_id
		where automation_date_index.case_id = c.case_id
			and ${automationRelationIndexFilter({
				scope: criterion.scope,
				caseAlias: "c",
				indexAlias: "automation_date_index",
				firstHostAlias: "automation_date_first_host",
			})}
			and automation_date_index.depth = 1
			and ${relatedComparison}
	)`;
}

/** The Postgres-backed implementation of `CaseStore`. */
/**
 * Window columns the grouped read materializes and then strips.
 *
 * They ride the same `__nova_` namespace the calculated-column prefix
 * uses, for the same reason: a `cases` column can never collide with
 * one, so the partition between "a case's data" and "this query's
 * bookkeeping" is structural rather than a naming convention somebody
 * has to remember.
 */
const GROUP_KEY_ALIAS = "__nova_group_key";
const ROW_ORDINAL_ALIAS = "__nova_row_ordinal";
const GROUP_FIRST_ALIAS = "__nova_group_first";
const GROUP_ORDINAL_ALIAS = "__nova_group_ordinal";
const TOTAL_GROUPS_ALIAS = "__nova_total_groups";
const TOTAL_ROWS_ALIAS = "__nova_total_rows";
const GROUPED_ROW_ALIASES = [
	GROUP_KEY_ALIAS,
	ROW_ORDINAL_ALIAS,
	GROUP_FIRST_ALIAS,
	GROUP_ORDINAL_ALIAS,
	TOTAL_GROUPS_ALIAS,
	TOTAL_ROWS_ALIAS,
] as const;

export class PostgresCaseStore implements CaseStore {
	/**
	 * Bound Project (tenant) for every read/write, or `null` for a
	 * schema-only store (`withSchemaContext`). `null` only on a store
	 * whose typed surface is `SchemaCaseStore`, so a tenant-bound method
	 * never observes it — `requireProjectId()` guards regardless.
	 */
	private readonly projectId: string | null;
	/**
	 * The Nova member acting on this store, or `null` on a schema-only one.
	 * AUTHORIZATION ONLY — every fresh-authorization fence keys on it, so it
	 * must always be a real account and must never be a value the blueprint
	 * can choose.
	 */
	private readonly actorUserId: string | null;
	/**
	 * The CommCare worker: stamped as `owner_id` (the case-owner) on every
	 * inserted case and resolved for `acting-user`. Not a tenant boundary —
	 * the reserved axis future location-based access carves on — which is
	 * exactly why it may be a persona while `actorUserId` stays the member.
	 */
	private readonly ownerId: string | null;
	private readonly db: Kysely<Database>;
	private readonly ajv: Ajv2020;
	private readonly validatorCache: Map<string, ValidatorCacheEntry>;
	private readonly sampleGenerator: SampleCaseGenerator;
	private readonly authorizeMutationCallback:
		| NonNullable<PostgresCaseStoreArgs["authorizeMutation"]>
		| undefined;
	private readonly authorizeSchemaMutationCallback:
		| NonNullable<PostgresCaseStoreArgs["authorizeSchemaMutation"]>
		| undefined;

	constructor(args: PostgresCaseStoreArgs) {
		assertNullableNonblankIdentity(args.projectId, "Project");
		assertNullableNonblankIdentity(args.actorUserId, "actor");
		assertNullableNonblankIdentity(args.ownerId, "owner");
		this.projectId = args.projectId;
		this.actorUserId = args.actorUserId;
		this.ownerId = args.ownerId;
		this.db = args.db;
		this.ajv = buildAjv();
		this.validatorCache = new Map();
		this.sampleGenerator = args.sampleGenerator;
		this.authorizeMutationCallback = args.authorizeMutation;
		this.authorizeSchemaMutationCallback = args.authorizeSchemaMutation;
	}

	/** Hold the live app's placement stable for one actor-free schema write. */
	private async authorizeSchemaMutation(
		trx: Transaction<Database>,
		appId: string,
	): Promise<void> {
		await this.authorizeSchemaMutationCallback?.(trx, { appId });
	}

	/**
	 * Re-prove the actor's edit capability and the app's Project placement on
	 * the caller's write transaction. The callback owns the cross-store app +
	 * membership locks; keeping this seam injected leaves the case-store's
	 * direct test constructor independent of app-state fixtures.
	 */
	private async authorizeMutation(
		trx: Transaction<Database>,
		appId: string,
	): Promise<{ readonly appMutationSeq: number } | undefined> {
		if (this.authorizeMutationCallback === undefined) return undefined;
		return await this.authorizeMutationCallback(trx, {
			appId,
			projectId: this.requireProjectId(),
			actorUserId: this.requireActorUserId(),
		});
	}

	/** Acquire every schema lock an operation needs in deterministic order. */
	private async lockValidators(
		trx: Transaction<Database>,
		appId: string,
		caseTypes: Iterable<string>,
	): Promise<ReadonlyMap<string, ValidatorCacheEntry>> {
		const validators = new Map<string, ValidatorCacheEntry>();
		for (const caseType of [...new Set(caseTypes)].sort()) {
			validators.set(caseType, await this.getValidator(appId, caseType, trx));
		}
		return validators;
	}

	/**
	 * The bound Project id for a tenant-scoped read/write. Throws if
	 * reached on a schema-only store (`withSchemaContext`, `projectId =
	 * null`) — unreachable in practice because that factory returns the
	 * narrow `SchemaCaseStore` type, which exposes no tenant-bound
	 * method. The throw is the structural backstop a direct
	 * `PostgresCaseStore` misuse (a test, a future call site) would hit.
	 */
	private requireProjectId(): string {
		if (this.projectId === null) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.requireProjectId",
					invariant:
						"a tenant-scoped read/write ran on a schema-only store (no bound Project)",
					detail:
						"This store was built by `withSchemaContext()` for app-scoped schema operations and carries no Project. A tenant-bound method (query / count / insert / update / close / traverse / generate / reset) requires one. Hint: build the store with `withProjectContext(projectId, actorUserId, ownerId)` for read/write work.",
				}),
			);
		}
		return this.projectId;
	}

	/**
	 * The Nova member every authorization fence keys on. Throws on a
	 * schema-only store — same structural backstop as
	 * {@link requireProjectId}.
	 */
	private requireActorUserId(): string {
		if (this.actorUserId === null) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.requireActorUserId",
					invariant:
						"a tenant-bound write ran on a schema-only store (no bound actor to authorize against)",
					detail:
						"This store was built by `withSchemaContext()` and carries no actor. Every case write authorizes against the acting Nova member. Hint: build the store with `withProjectContext(projectId, actorUserId, ownerId)`.",
				}),
			);
		}
		return this.actorUserId;
	}

	/**
	 * The CommCare worker id to stamp as a new case's `owner_id`. Throws on
	 * a schema-only store — the insert paths are tenant-bound.
	 */
	private requireOwnerId(): string {
		if (this.ownerId === null) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.requireOwnerId",
					invariant:
						"an insert ran on a schema-only store (no bound worker for `owner_id`)",
					detail:
						"This store was built by `withSchemaContext()` and carries no worker. An insert stamps `owner_id` (the CommCare case-owner) from the bound worker. Hint: build the store with `withProjectContext(projectId, actorUserId, ownerId)`.",
				}),
			);
		}
		return this.ownerId;
	}

	/**
	 * Serialize operations that create, replace, or change cases within one app
	 * + Project. `case_indices` cannot use a conventional FK because it also
	 * models CommCare relationship semantics, so reset and every relationship-
	 * capable writer take the same transaction-level advisory lock even when one
	 * particular row is parentless. Writes for unrelated apps/Projects remain
	 * concurrent.
	 */
	private async lockRelationshipWrites(
		trx: Transaction<Database>,
		appId: string,
	): Promise<void> {
		const scope = `nova:case-relationships:${this.requireProjectId()}:${appId}`;
		await sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0::bigint))`.execute(
			trx,
		);
	}

	/** Validate a relationship target after acquiring the shared lock. */
	private async assertParentExists(
		trx: Transaction<Database>,
		args: { appId: string; parentCaseId: string },
	): Promise<void> {
		const parent = await trx
			.selectFrom("cases as parent")
			.select("parent.case_id")
			.where("parent.app_id", "=", args.appId)
			.where("parent.case_id", "=", args.parentCaseId)
			.where("parent.project_id", "=", this.requireProjectId())
			.executeTakeFirst();
		if (parent === undefined) throw new CaseNotFoundError(args.parentCaseId);
	}

	/**
	 * The half of a case-list read that grouping and the ordinary page
	 * share: tenant scope, the hold exclusion, every calculated-column
	 * projection, and the authored predicate — everything except how the
	 * rows are ordered and windowed.
	 *
	 * It is one method rather than two similar ones because the tenant
	 * filter and the hold exclusion are the two things a new read surface
	 * must never re-derive. `queryGrouped` wraps the builder this returns
	 * in window functions; `query` orders and paginates it directly.
	 */
	private buildCaseSelect(args: QueryArgs) {
		const calculated: ReadonlyArray<CalculatedColumn> = args.calculated ?? [];

		// The restore closure, when the caller is standing at a device. It rides
		// the predicate context so relation walks apply it per hop too — a list
		// filtered by "households with an open member" must count only members
		// the worker's device holds.
		const restore = this.buildRestoreScopeFor(args.appId, args.restoreScope);
		const ctx = this.buildPredicateContext({
			// The PLAIN handle, deliberately. `restore.creator` carries the
			// `WITH` clause into every query built from it, and the compile
			// stack builds subqueries — a relation walk's leaf, a `count`'s
			// scalar select. Each would then re-declare and recompute the whole
			// closure, and inside a `UNION` branch it is not even legal SQL.
			// Only the outermost statement below attaches the CTEs; the
			// membership reference is visible throughout it.
			db: this.db,
			appId: args.appId,
			caseType: args.caseType,
			schemas: args.caseTypeSchemas ?? new Map(),
			lookupTableSchemas: args.lookupTableSchemas,
			bindings: args.bindings ?? {},
			restore,
		});
		const exprCtx = expressionContextFor(ctx);

		// Calculated-column aliases are EMITTED with a fixed prefix so
		// they cannot collide with any `cases` column the
		// `selectAll("c")` projection emits. Without the prefix, a
		// caller supplying a uuid string that matches a reserved
		// column name (`case_name`, `case_id`, `case_type`,
		// `owner_id`, `project_id`, `status`, `app_id`, `opened_on`,
		// `closed_on`, `modified_on`, `parent_case_id`, `properties`) would
		// silently corrupt the row's actual scalar value: Postgres
		// allows duplicate output names; pg-driver's row-object
		// deserializer keeps the LAST occurrence (the calculated
		// expression's value); the reshape's `delete cleaned[uuid]`
		// then wipes the original column. Real data loss in one
		// composition mistake.
		//
		// The prefix sits below the wire — consumers receive the
		// column's `uuid` verbatim on `row.calculated[uuid]`. A
		// pinned contract test in
		// `lib/case-store/__tests__/storeContract.ts` exercises every
		// reserved column name as a calculated uuid to confirm the
		// row's scalar survives unaltered.
		//
		// `__nova_calc__` is sufficiently improbable as a `cases`
		// column name that the prefix-protected partition stays
		// structurally collision-free regardless of future schema
		// additions. The double-underscore on each side mirrors
		// Python's name-mangling convention — visually flags
		// "internal infrastructure, do not collide."
		const ALIAS_PREFIX = "__nova_calc__";
		const aliasFor = (uuid: string) => `${ALIAS_PREFIX}${uuid}`;

		// Belt-and-suspenders uuid validation. Two failure shapes a
		// programmatic caller (fixtures, SA tools, future composers)
		// could produce that Postgres would silently corrupt:
		//
		//   1. **Empty-string uuid.** Postgres rejects an empty-string
		//      identifier in the SELECT alias; without this guard the
		//      failure mode is a wrapped invariant message at run time.
		//   2. **63-byte alias overflow.** Postgres SILENTLY truncates
		//      identifiers longer than 63 bytes (`NAMEDATALEN - 1`).
		//      The wire alias `__nova_calc__<uuid>` (13 bytes of
		//      prefix) gets truncated; the downstream
		//      `Object.hasOwn(row, alias)` lookup uses the FULL pre-
		//      truncation alias and misses, falling through to `null`.
		//      Net effect: a calculated value whose uuid pushes the
		//      alias over the cap silently emits as `null` for every
		//      row. Two uuids matching in the truncation prefix
		//      collide on the same alias. Mirrors the `indexName`
		//      defense at the bottom of this file — same Postgres
		//      invariant, same throw-with-compiler-bug-shape response.
		//
		// Reject early with the canonical compiler-bug shape so the
		// caller surfaces the contract violation instead of a silent
		// null-row or a wrapped pg parser error.
		for (const column of calculated) {
			if (column.uuid === "") {
				throw new Error(
					compilerBugMessage({
						where: "case-store.PostgresCaseStore.query",
						invariant: "a calculated column carried an empty-string uuid",
						detail:
							"Calculated columns project as SELECT aliases; Postgres rejects an empty alias and the row partition step relies on a non-empty key. Hint: Zod-parse the case-list config at the request boundary to catch the violation before it reaches the SQL layer.",
					}),
				);
			}
			const alias = aliasFor(column.uuid);
			if (Buffer.byteLength(alias, "utf8") > 63) {
				throw new Error(
					compilerBugMessage({
						where: "case-store.PostgresCaseStore.query",
						invariant: `composed calculated alias \`${alias}\` exceeds Postgres' 63-byte identifier cap (\`NAMEDATALEN - 1\`)`,
						detail:
							"Postgres silently truncates identifiers at 63 bytes. The downstream row-partition step uses the FULL pre-truncation alias to read each calculated value; a truncated wire-side alias would miss the lookup and the projection would silently emit `null` for every row. Two uuids matching in the truncation prefix would collide on the same alias. Hint: the alias is `__nova_calc__<uuid>`, so the uuid itself must be ≤ 50 bytes.",
					}),
				);
			}
		}

		// Outer query owns the tenant filter — `compileRelationPath`
		// only enforces it on JOIN-ed cases inside relation walks.
		// `selectAll("c")` first so every `cases` column lands; the
		// per-calculated-column projection chains via `select(...)`
		// under prefixed aliases.
		let qb = (restore?.creator ?? this.db)
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where("c.project_id", "=", this.requireProjectId());
		// The RESTORE: what this worker's device would hold. Sits beside the
		// tenant filter rather than inside the closure so pagination, sorting,
		// the authored predicate, and the hold all see the same restricted
		// population — a scope applied anywhere else would let `count` and
		// `query` disagree.
		if (restore !== undefined) {
			qb = restore.restrict(qb, "c");
		}
		// The HOLD: a case with an active (undismissed) kept value is
		// out of every read unless the caller opts in — the running app
		// never sees a case whose data is waiting on review. Dismissal
		// is the release valve, so archived entries hold nothing.
		if (args.includeHeld !== true) {
			qb = qb.where(({ not, exists, selectFrom }) =>
				not(
					exists(
						selectFrom("parked_case_values as held")
							.select("held.id")
							.whereRef("held.case_id", "=", "c.case_id")
							.where("held.dismissed_at", "is", null),
					),
				),
			);
		}

		// Project each calculated column under its prefixed alias.
		for (const column of calculated) {
			const expr = compileExpression(column.expression, exprCtx);
			qb = qb.select(expr.as(aliasFor(column.uuid)));
		}

		if (args.predicate !== undefined) {
			qb = qb.where(compilePredicate(args.predicate, ctx));
		}

		// Materialize the alias allowlist once outside the row loop so
		// the per-row partition is O(rows × calc-cols) rather than
		// O(rows × all-keys × calc-cols). Each entry pairs the wire
		// alias (`__nova_calc__<uuid>`) with the consumer-facing key
		// (the column's `uuid`) so the loop body needs no extra
		// string ops per row.
		const calcAliases = calculated.map((c) => ({
			alias: aliasFor(c.uuid),
			uuid: c.uuid,
		}));

		return { qb, exprCtx, calcAliases };
	}

	async query(args: QueryArgs): Promise<CaseRowWithCalculated[]> {
		const { qb: base, exprCtx, calcAliases } = this.buildCaseSelect(args);
		let qb = base;

		// Sort keys compile through `compileExpression` against the
		// thunk-wired context — `expressionContextFor` handles the
		// cycle break for the predicate-bearing arms (`if.cond`,
		// `count.where`).
		if (args.sort !== undefined) {
			for (const key of args.sort) {
				const expr = compileExpression(key.expression, exprCtx);
				qb = qb.orderBy(expr, key.direction);
			}
		} else {
			// The durable default ordering fact: creation time, then the
			// id purely as a deterministic total-order key. Authored
			// opaque ids carry no timestamp, so heap order and id order
			// are both wrong as an "insertion order" claim.
			qb = qb.orderBy("c.opened_on", "asc").orderBy("c.case_id", "asc");
		}

		if (args.limit !== undefined) {
			qb = qb.limit(args.limit);
		}
		if (args.offset !== undefined) {
			qb = qb.offset(args.offset);
		}

		// `qb.execute()` returns row objects carrying both the
		// `selectAll("c")` columns AND the per-calculated-column
		// PREFIXED aliases at the top level. Reshape each row into
		// `CaseRow & { calculated }` by reading each prefixed alias
		// into the calculated map under the column's uuid, then
		// stripping the prefixed slot from the row's top-level shape.
		// The cases-side scalar columns flow through untouched
		// because the prefix puts the calculated slots in a disjoint
		// keyspace.
		const rows = (await qb.execute()) as Array<
			CaseRow & Record<string, unknown>
		>;

		return rows.map((row) => this.shapeCaseRow(row, calcAliases));
	}

	/**
	 * Turn one raw result row into the `CaseRow & { calculated }` shape
	 * every consumer reads.
	 *
	 * Two keyspaces get stripped: the bound tenant's `project_id`, which
	 * `selectAll("c")` materializes but the `CaseRow` contract does not
	 * carry, and every `__nova_calc__<uuid>` alias, whose value moves into
	 * `calculated` under the column's own uuid. `extraAliases` covers the
	 * grouped read's window columns, which exist for exactly as long as it
	 * takes to rebuild the groups.
	 *
	 * Postgres returns calculated-column NULL as JS `null`; the
	 * `CalculatedValue` union admits it. Non-null typed values come back
	 * per pg's per-OID deserializer:
	 *   - text -> string
	 *   - integer -> number
	 *   - numeric -> string (arbitrary-precision decimal)
	 *   - boolean -> boolean
	 *   - date / timestamptz -> Date object (NOT ISO string)
	 *   - jsonb -> object / array
	 * The contract test for the date arm at
	 * `lib/case-store/__tests__/storeContract.ts` pins the Date shape; the
	 * renderer in `DisplayPreview.tsx` discriminates on `instanceof Date`
	 * to format the temporal value without `JSON.stringify`'s quoted-ISO
	 * output.
	 */
	private shapeCaseRow(
		row: Record<string, unknown>,
		calcAliases: ReadonlyArray<{ alias: string; uuid: string }>,
		extraAliases: readonly string[] = [],
	): CaseRowWithCalculated {
		const calculatedMap: Record<string, CalculatedValue> = {};
		for (const { alias, uuid } of calcAliases) {
			// `Object.hasOwn` guards against the rare case where Postgres
			// elides the alias from the row; the explicit guard keeps the
			// map clean of `undefined`-typed slots. A missing alias is
			// treated as null, which is what the interface JSDoc already
			// promises for an expression evaluating to SQL NULL.
			calculatedMap[uuid] = Object.hasOwn(row, alias)
				? (row[alias] as CalculatedValue)
				: null;
		}
		const cleaned = stripTenantKey(row) as Record<string, unknown>;
		for (const { alias } of calcAliases) delete cleaned[alias];
		for (const alias of extraAliases) delete cleaned[alias];
		return {
			...(cleaned as unknown as CaseRow),
			calculated: calculatedMap,
		};
	}

	async queryGrouped(args: GroupedQueryArgs): Promise<GroupedQueryResult> {
		const { qb: base, exprCtx, calcAliases } = this.buildCaseSelect(args);

		// The group key, as the device computes it. `string(./index/<id>)`
		// takes the FIRST node of a node-set, and Nova's writers keep one
		// target per `(case_id, identifier)` — `submissionEnvelope.ts`
		// deletes by that exact pair before inserting, and the parent-edge
		// re-derivation does the same — so the ordering here is
		// determinism insurance rather than a real fan-out. It is spelled
		// out anyway, for the same reason `automationRelationIndexFilter`
		// spells out its own tie-break: a storage-order-dependent answer
		// is one that changes under VACUUM.
		//
		// `coalesce(…, '')` is not a null-safety flourish. It IS the
		// empty-key contract: a case with no such index evaluates to the
		// empty string on device and clusters with every other such case
		// into one group.
		const groupKey = sql<string>`coalesce((select grouping_index.ancestor_id from case_indices as grouping_index where grouping_index.case_id = c.case_id and grouping_index.identifier = ${args.indexIdentifier} and grouping_index.depth = 1 order by grouping_index.ancestor_id limit 1), '')`;

		// The user's sort, as a window ORDER BY. `row_number()` is
		// evaluated after WHERE, so this ordinal is the position the row
		// holds in the fully filtered, fully sorted list — the exact input
		// `groupEntities` clusters over. The ungrouped default is repeated
		// rather than shared with `query` because the two express it in
		// different syntax (an `orderBy` chain there, a window clause
		// here); `__tests__` pin that they agree.
		const orderBy =
			args.sort === undefined || args.sort.length === 0
				? [sql`c.opened_on asc`, sql`c.case_id asc`]
				: args.sort.map(
						(key) =>
							sql`${compileExpression(key.expression, exprCtx)} ${key.direction === "desc" ? sql`desc` : sql`asc`}`,
					);
		const rowOrdinal = sql<number>`row_number() over (order by ${sql.join(orderBy, sql`, `)})`;

		const matched = base
			.select(groupKey.as(GROUP_KEY_ALIAS))
			.select(rowOrdinal.as(ROW_ORDINAL_ALIAS));

		// One statement, four window levels:
		//
		//   clustered — each row learns its group's first-appearance
		//               ordinal (`min(row ordinal) over (partition by key)`).
		//   ordinal   — groups are dense-ranked on that, which IS the
		//               first-appearance ordinal `groupEntities` assigns.
		//   totals    — the denominators, computed BEFORE the page filter,
		//               because a window function in the final SELECT runs
		//               after WHERE and would count only the page.
		//
		// `max(group ordinal)` is the group count precisely because the
		// rank is dense; Postgres has no `count(distinct …) over ()`.
		const paged = await sql<Record<string, unknown>>`
			with matched as (${matched}),
			clustered as (
				select *, min(${sql.ref(ROW_ORDINAL_ALIAS)}) over (partition by ${sql.ref(GROUP_KEY_ALIAS)}) as ${sql.ref(GROUP_FIRST_ALIAS)}
				from matched
			),
			ordinal as (
				select *, dense_rank() over (order by ${sql.ref(GROUP_FIRST_ALIAS)}) as ${sql.ref(GROUP_ORDINAL_ALIAS)}
				from clustered
			),
			totals as (
				select *,
					max(${sql.ref(GROUP_ORDINAL_ALIAS)}) over () as ${sql.ref(TOTAL_GROUPS_ALIAS)},
					count(*) over () as ${sql.ref(TOTAL_ROWS_ALIAS)}
				from ordinal
			)
			select * from totals
			where ${sql.ref(GROUP_ORDINAL_ALIAS)} > ${args.groupOffset}
				and ${sql.ref(GROUP_ORDINAL_ALIAS)} <= ${args.groupOffset + args.groupLimit}
			order by ${sql.ref(GROUP_FIRST_ALIAS)}, ${sql.ref(ROW_ORDINAL_ALIAS)}
		`.execute(this.db);

		const rows = paged.rows;
		if (rows.length === 0) {
			// An empty page says nothing about the totals, so ask for them
			// only when there is nothing to read them off. This is the one
			// branch that costs a second statement, and it is the branch
			// where correctness is cheapest: a page past the end still has
			// to report how many groups there really are so the pager can
			// walk back.
			const empty = await sql<{
				total_groups: string | number | null;
				total_rows: string | number | null;
			}>`
				with matched as (${matched})
				select count(distinct ${sql.ref(GROUP_KEY_ALIAS)}) as total_groups, count(*) as total_rows
				from matched
			`.execute(this.db);
			const totals = empty.rows[0];
			return {
				groups: [],
				totalGroups: Number(totals?.total_groups ?? 0),
				totalRows: Number(totals?.total_rows ?? 0),
			};
		}

		// Rows arrive already clustered and already in member order, so
		// one linear pass on adjacent keys rebuilds the groups — the same
		// adjacency `getEntitiesForCurrentPage` counts boundaries on.
		const groups: { key: string; rows: CaseRowWithCalculated[] }[] = [];
		for (const row of rows) {
			const key = String(row[GROUP_KEY_ALIAS] ?? "");
			const last = groups.at(-1);
			const shaped = this.shapeCaseRow(row, calcAliases, GROUPED_ROW_ALIASES);
			if (last !== undefined && last.key === key) last.rows.push(shaped);
			else groups.push({ key, rows: [shaped] });
		}

		const first = rows[0];
		return {
			groups,
			totalGroups: Number(first[TOTAL_GROUPS_ALIAS] ?? 0),
			totalRows: Number(first[TOTAL_ROWS_ALIAS] ?? 0),
		};
	}

	async count(args: CountArgs): Promise<number> {
		if (args.missingIndexIdentifier !== undefined) {
			// The empty-key population: cases of this type carrying no index
			// with the named identifier. Held rows are included because this
			// answers a question about the stored data an author governs, not
			// about what the running app can currently reach.
			const identifier = args.missingIndexIdentifier;
			const missing = await this.db
				.selectFrom("cases as c")
				.select((eb) => eb.fn.countAll<string>().as("total"))
				.where("c.app_id", "=", args.appId)
				.where("c.case_type", "=", args.caseType)
				.where("c.project_id", "=", this.requireProjectId())
				.where(({ not, exists, selectFrom }) =>
					not(
						exists(
							selectFrom("case_indices as grouping_index")
								.select("grouping_index.ancestor_id")
								.whereRef("grouping_index.case_id", "=", "c.case_id")
								.where("grouping_index.identifier", "=", identifier)
								.where("grouping_index.depth", "=", 1),
						),
					),
				)
				.executeTakeFirst();
			return Number(missing?.total ?? 0);
		}
		if ("ownerId" in args) {
			if (
				typeof args.ownerId !== "string" ||
				args.ownerId.trim().length === 0
			) {
				throw new Error("Case owner identity must be a nonblank string.");
			}
			let ownerQuery = this.db
				.selectFrom("cases as c")
				.select((eb) => eb.fn.countAll<string>().as("total"))
				.where("c.app_id", "=", args.appId)
				.where("c.owner_id", "=", args.ownerId)
				.where("c.project_id", "=", this.requireProjectId())
				// The worker's OWN case is excluded. This count answers "what of
				// your data stays behind if this worker goes", and the usercase is
				// Nova's bookkeeping rather than the author's data — every worker
				// has exactly one, so counting it would report "1 case kept" for a
				// persona who owns nothing and turn a real signal into noise.
				.where("c.case_type", "!=", USERCASE_CASE_TYPE);
			if (args.includeHeld !== true) {
				ownerQuery = ownerQuery.where(({ not, exists, selectFrom }) =>
					not(
						exists(
							selectFrom("parked_case_values as held")
								.select("held.id")
								.whereRef("held.case_id", "=", "c.case_id")
								.where("held.dismissed_at", "is", null),
						),
					),
				);
			}
			const row = await ownerQuery.executeTakeFirstOrThrow();
			return Number(row.total);
		}

		// Same predicate-context plumbing `query` uses — the WHERE
		// clause emitted here MUST match a predicate-narrowed `query`
		// against the same `(appId, caseType, caseTypeSchemas,
		// predicate)` tuple; the Filters-section preview pairs the
		// count with a limited `query` against the same predicate, so
		// any divergence between the two compile paths would surface
		// as a count vs row-list mismatch.
		const restore = this.buildRestoreScopeFor(args.appId, args.restoreScope);
		const ctx = this.buildPredicateContext({
			// The PLAIN handle, deliberately. `restore.creator` carries the
			// `WITH` clause into every query built from it, and the compile
			// stack builds subqueries — a relation walk's leaf, a `count`'s
			// scalar select. Each would then re-declare and recompute the whole
			// closure, and inside a `UNION` branch it is not even legal SQL.
			// Only the outermost statement below attaches the CTEs; the
			// membership reference is visible throughout it.
			db: this.db,
			appId: args.appId,
			caseType: args.caseType,
			schemas: args.caseTypeSchemas ?? new Map(),
			lookupTableSchemas: args.lookupTableSchemas,
			bindings: args.bindings ?? {},
			restore,
		});

		// pg-driver returns BIGINT counts as
		// strings (numeric-precision-preserving), so the typed
		// builder declares the column as string and the caller
		// `Number(...)` coerces. Tenant filter on the outer scan;
		// `compileRelationPath` handles JOIN-side cases independently
		// — the structural tenant-scoping contract splits the two
		// halves to make cross-tenant reads structurally impossible.
		const projectId = this.requireProjectId();
		const readsHost = args.automationCriteria?.requiresUnambiguousHost ?? false;
		const ambiguityHoldClause =
			args.includeHeld === true
				? sql<boolean>`true`
				: sql<boolean>`not exists (
					select 1
					from parked_case_values as automation_host_held
					where automation_host_held.case_id = automation_host_candidate.case_id
						and automation_host_held.dismissed_at is null
				)`;
		const ambiguousHostCaseCount = readsHost
			? sql<string>`(
				select count(*)
				from cases as automation_host_candidate
				where automation_host_candidate.app_id = ${args.appId}
					and automation_host_candidate.project_id = ${projectId}
					and automation_host_candidate.case_type = ${args.caseType}
					-- Open means "not closed", never "status = 'open'". The column is
					-- nullable with no default and optional on insert, so a great
					-- many rows carry NULL, and equality would drop every one of
					-- them from this probe. That direction fails OPEN: the probe
					-- exists to REFUSE a count whose host resolution is ambiguous,
					-- so a missed row means the count runs on an ambiguous
					-- population and reports a number nobody can trust.
					and automation_host_candidate.status is distinct from 'closed'
					and ${ambiguityHoldClause}
					and (
						select count(distinct automation_host_index.ancestor_id)
						from case_indices as automation_host_index
						where automation_host_index.case_id = automation_host_candidate.case_id
							and automation_host_index.relationship = 'extension'
							and automation_host_index.depth = 1
					) > 1
			)`
			: sql<string>`'0'`;
		let qb = (restore?.creator ?? this.db)
			.selectFrom("cases as c")
			.select((eb) => [
				eb.fn.countAll<string>().as("total"),
				ambiguousHostCaseCount.as("ambiguous_host_case_count"),
			])
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where("c.project_id", "=", projectId);
		// Same restore restriction `query` applies, for the same reason the
		// hold exclusion below is duplicated: a count that saw a different
		// population than its row list surfaces as a count-versus-rows
		// mismatch, not as a missing filter.
		if (restore !== undefined) {
			qb = restore.restrict(qb, "c");
		}
		// Same HOLD exclusion `query` applies — a count must agree with
		// the row list its caller pairs it with.
		if (args.includeHeld !== true) {
			qb = qb.where(({ not, exists, selectFrom }) =>
				not(
					exists(
						selectFrom("parked_case_values as held")
							.select("held.id")
							.whereRef("held.case_id", "=", "c.case_id")
							.where("held.dismissed_at", "is", null),
					),
				),
			);
		}

		if (args.predicate !== undefined) {
			qb = qb.where(compilePredicate(args.predicate, ctx));
		}
		if (args.automationCriteria !== undefined) {
			const group = args.automationCriteria;
			qb = qb.where((whereEb) => {
				const clauses = [
					...group.dates.map(automationDateCriterionClause),
					...group.comparisons.map((criterion) => {
						const comparisonForAlias = (alias: string) => {
							const scalar = RESERVED_SCALAR_COLUMN_BY_PROPERTY.get(
								criterion.property,
							);
							if (scalar === undefined) {
								// HQ compares each resolved Python value directly with the
								// form's string criterion. `->>` alone would stringify JSON
								// numbers and booleans and create matches HQ cannot make.
								const storedJson = sql<unknown | null>`${sql.ref(
									`${alias}.properties`,
								)} -> ${criterion.property}`;
								const storedText = sql<string | null>`${sql.ref(
									`${alias}.properties`,
								)} ->> ${criterion.property}`;
								return criterion.equal
									? sql<boolean>`jsonb_typeof(${storedJson}) = 'string' and ${storedText} = ${criterion.value}`
									: sql<boolean>`(jsonb_typeof(${storedJson}) is distinct from 'string' or ${storedText} <> ${criterion.value})`;
							}
							const storedText = sql<
								string | null
							>`${sql.ref(`${alias}.${scalar.column}`)}::text`;
							return criterion.equal
								? sql<boolean>`${storedText} = ${criterion.value}`
								: sql<boolean>`(${storedText} is null or ${storedText} <> ${criterion.value})`;
						};
						if (criterion.scope === "case") {
							return comparisonForAlias("c");
						}
						const relatedComparison = comparisonForAlias(
							"automation_comparison_related",
						);
						return sql<boolean>`exists (
							select 1
							from case_indices as automation_comparison_index
							join cases as automation_comparison_related
								on automation_comparison_related.case_id = automation_comparison_index.ancestor_id
								and automation_comparison_related.app_id = c.app_id
								and automation_comparison_related.project_id = c.project_id
							where automation_comparison_index.case_id = c.case_id
								and ${automationRelationIndexFilter({
									scope: criterion.scope,
									caseAlias: "c",
									indexAlias: "automation_comparison_index",
									firstHostAlias: "automation_comparison_first_host",
								})}
								and automation_comparison_index.depth = 1
								and ${relatedComparison}
						)`;
					}),
					...group.regexes.map((criterion) => {
						const scalar = RESERVED_SCALAR_COLUMN_BY_PROPERTY.get(
							criterion.property,
						);
						if (scalar !== undefined && !scalar.blankable) {
							return sql<boolean>`false`;
						}
						const matches =
							scalar === undefined
								? sql<boolean>`jsonb_typeof(c.properties -> ${criterion.property}) = 'string'
									and ((c.properties ->> ${criterion.property}) collate "C") ~ ${postgresAutomationRegex(criterion.pattern)}`
								: sql<boolean>`${sql.ref(`c.${scalar.column}`)} is not null
									and ((${sql.ref(`c.${scalar.column}`)}) collate "C") ~ ${postgresAutomationRegex(criterion.pattern)}`;
						return (
							// HQ's REGEX uses Python `re.match`, anchored at the
							// beginning, and only tests actual strings. The lowering adds
							// that anchor and preserves Python's newline semantics.
							matches
						);
					}),
					...group.blankness.map((criterion) => {
						const scalar = RESERVED_SCALAR_COLUMN_BY_PROPERTY.get(
							criterion.property,
						);
						if (criterion.scope !== "case") {
							const relatedHasPropertyValue =
								scalar === undefined
									? automationStringHasValue(
											sql<
												string | null
											>`automation_related.properties ->> ${criterion.property}`,
										)
									: scalar.blankable
										? automationStringHasValue(
												sql<
													string | null
												>`${sql.ref(`automation_related.${scalar.column}`)}`,
											)
										: sql<boolean>`${sql.ref(`automation_related.${scalar.column}`)} is not null`;
							const relatedHasValue = sql<boolean>`exists (
								select 1
								from case_indices as automation_related_index
								join cases as automation_related
									on automation_related.case_id = automation_related_index.ancestor_id
									and automation_related.app_id = c.app_id
									and automation_related.project_id = c.project_id
								where automation_related_index.case_id = c.case_id
									and ${automationRelationIndexFilter({
										scope: criterion.scope,
										caseAlias: "c",
										indexAlias: "automation_related_index",
										firstHostAlias: "automation_blankness_first_host",
									})}
									and automation_related_index.depth = 1
									and ${relatedHasPropertyValue}
							)`;
							return criterion.hasValue
								? relatedHasValue
								: sql<boolean>`not (${relatedHasValue})`;
						}
						const hasValue =
							scalar === undefined
								? automationStringHasValue(
										sql<string | null>`c.properties ->> ${criterion.property}`,
									)
								: scalar.blankable
									? automationStringHasValue(
											sql<string | null>`${sql.ref(`c.${scalar.column}`)}`,
										)
									: sql<boolean>`${sql.ref(`c.${scalar.column}`)} is not null`;
						return criterion.hasValue
							? hasValue
							: sql<boolean>`not (${hasValue})`;
					}),
					...group.closedParents.map(
						(criterion) => sql<boolean>`exists (
							select 1
							from case_indices as automation_parent_index
							join cases as automation_parent
								on automation_parent.case_id = automation_parent_index.ancestor_id
								and automation_parent.app_id = c.app_id
								and automation_parent.project_id = c.project_id
							where automation_parent_index.case_id = c.case_id
								and automation_parent_index.identifier = ${criterion.identifier}
								and automation_parent_index.relationship = ${criterion.relationship}
								and automation_parent_index.depth = 1
								and automation_parent.closed_on is not null
						)`,
					),
					...group.locationOwnerSets.map((ownerIds) =>
						ownerIds.length === 0
							? sql<boolean>`false`
							: sql<boolean>`c.owner_id = any(${sql.val(ownerIds)}::text[])`,
					),
				];
				if (clauses.length === 0) {
					// Python's all([]) is true and any([]) is false. Preserve that
					// identity explicitly rather than relying on a query-builder
					// empty-expression convention or dropping the group entirely.
					return group.operator === "all"
						? sql<boolean>`true`
						: sql<boolean>`false`;
				}
				return group.operator === "all"
					? whereEb.and(clauses)
					: whereEb.or(clauses);
			});
		}

		// `executeTakeFirstOrThrow` is appropriate here — Postgres'
		// `count` aggregate always returns exactly one row even on
		// empty input. A `undefined` from the executor would indicate
		// a structural pg-driver violation rather than a runtime
		// branch the caller can recover from.
		const row = await qb.executeTakeFirstOrThrow();
		const ambiguityCount = Number(row.ambiguous_host_case_count);
		if (readsHost && ambiguityCount > 0) {
			throw new AutomationHostAmbiguityError(ambiguityCount);
		}
		return Number(row.total);
	}

	async insert(args: {
		appId: string;
		row: CaseInsert;
		parentRelationship?: CaseIndicesTable["relationship"];
	}): Promise<{ caseId: string }> {
		// One transaction across cases + case_indices so a derived
		// edge insert can't observe a partial cases-row commit.
		// Validation runs INSIDE it — the schema `FOR SHARE` must hold
		// until the row commits (the write-vs-sync contract on
		// `getValidator`) — and AFTER the advisory block, keeping the
		// uniform advisory → schema → rows lock order.
		return await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			const caseId = await this.insertRowInTransaction(trx, {
				appId: args.appId,
				row: args.row,
				...(args.parentRelationship === undefined
					? {}
					: { parentRelationship: args.parentRelationship }),
			});
			return { caseId };
		});
	}

	/**
	 * Single-row insert core shared by `insert` and the submission
	 * envelope: validate, stamp, write the row, derive the parent edge.
	 * Runs on the caller's transaction under the standard lock order.
	 *
	 * `caseId` overrides the column default for callers whose identity
	 * is minted/derived up front (the envelope's create allocations);
	 * `ownerId` overrides the bound owner for an operation's evaluated
	 * owner expression. Ordinary callers omit both.
	 */
	private async insertRowInTransaction(
		trx: Transaction<Database>,
		args: {
			appId: string;
			row: CaseInsert;
			caseId?: string;
			ownerId?: string;
			parentRelationship?: CaseIndicesTable["relationship"];
		},
	): Promise<string> {
		const propertiesObject = parseJsonbInput(args.row.properties);
		await this.validateProperties({
			appId: args.appId,
			caseType: args.row.case_type,
			properties: propertiesObject,
			executor: trx,
		});
		if (
			args.row.parent_case_id !== null &&
			args.row.parent_case_id !== undefined
		) {
			await this.assertParentExists(trx, {
				appId: args.appId,
				parentCaseId: args.row.parent_case_id,
			});
		}

		// `properties` re-stringifies because the `cases` table's JSONB
		// insert side is a JSON string for pg's JSONB cast. The
		// caller may pass either string or `JsonObject`; both converge
		// through `parseJsonbInput` and stringify back to wire form
		// here. Without this, a `JsonObject` caller silently writes
		// `[object Object]` (pg's parameter binder calls `String(value)`
		// on non-string inputs to a text-cast slot).
		const insertRow: InsertObject<Database, "cases"> = {
			...args.row,
			case_name: normalizedCaseScalar(
				"case_name",
				args.row.case_name,
				"reject",
			),
			...(args.row.external_id === null || args.row.external_id === undefined
				? { external_id: null }
				: {
						external_id: normalizedCaseScalar(
							"external_id",
							args.row.external_id,
							"allow",
						),
					}),
			...(args.caseId === undefined ? {} : { case_id: args.caseId }),
			app_id: args.appId,
			project_id: this.requireProjectId(),
			owner_id: args.ownerId ?? this.requireOwnerId(),
			...creationStamps(args.row),
			properties: JSON.stringify(propertiesObject),
		};
		const inserted = await trx
			.insertInto("cases")
			.values(insertRow)
			.returning("case_id")
			.executeTakeFirstOrThrow();
		const caseId = inserted.case_id;

		// Direct-edge derivation: depth=1 edges only; recursive
		// walks compose at read time via `compileRelationPath`.
		// A direct insert defaults to an ordinary child. The running-app
		// submission path supplies the committed case type's relationship so
		// extension hosts survive the same way the emitted case block does.
		if (
			args.row.parent_case_id !== null &&
			args.row.parent_case_id !== undefined
		) {
			await trx
				.insertInto("case_indices")
				.values({
					case_id: caseId,
					ancestor_id: args.row.parent_case_id,
					identifier: "parent",
					relationship: args.parentRelationship ?? "child",
					depth: 1,
				})
				.execute();
		}

		return caseId;
	}

	async applySubmission(
		args: ApplySubmissionArgs,
	): Promise<SubmissionEnvelopeResult> {
		// One transaction for the WHOLE submission — the ordinary form
		// action and the advanced operation program land together or not
		// at all. Every envelope first adjudicates and claims its durable
		// entry receipt, even with no attachments. Standard lock order:
		// authorize → entry receipt → relationship advisory → schema locks in
		// sorted order for every case type the
		// submission names up front (a followup/close bound case's type
		// is discovered inside the update core, which acquires its own
		// schema lock — the same pattern `update` uses).
		return await this.db.transaction().execute(async (trx) => {
			const authorization = await this.authorizeMutation(trx, args.appId);
			const replay = await prepareSubmissionReceipt(trx, {
				appId: args.appId,
				projectId: this.requireProjectId(),
				actorUserId: this.requireActorUserId(),
				receipt: args.submissionReceipt,
				...(args.captureIntent === undefined
					? {}
					: { captureIntent: args.captureIntent }),
				...(authorization === undefined
					? {}
					: {
							authorizedAppMutationSeq: authorization.appMutationSeq,
						}),
			});
			if (replay !== undefined) return replay;
			await this.lockRelationshipWrites(trx, args.appId);
			await this.lockValidators(trx, args.appId, submissionCaseTypes(args));
			const result = await executeSubmissionEnvelope(
				trx,
				this.submissionEnvelopeHost(),
				args,
			);
			await completeSubmissionReceipt(trx, {
				appId: args.appId,
				projectId: this.requireProjectId(),
				actorUserId: this.requireActorUserId(),
				receipt: args.submissionReceipt,
				result,
			});
			return result;
		});
	}

	/** The narrow store internals the envelope executor borrows — see
	 * `SubmissionEnvelopeHost`. */
	private submissionEnvelopeHost(): SubmissionEnvelopeHost {
		return {
			projectId: this.requireProjectId(),
			// The WORKER, not the member: a submission's `acting-user` and its
			// create-time owner are what a device would record, and on a device
			// that is whoever is logged in.
			actingUserId: this.requireOwnerId(),
			validateProperties: (trx, a) =>
				this.validateProperties({
					appId: a.appId,
					caseType: a.caseType,
					properties: a.properties,
					executor: trx,
				}),
			declaredProperties: async (trx, appId, caseType) =>
				(await this.getValidator(appId, caseType, trx)).declared,
			insertCase: (trx, a) =>
				this.insertRowInTransaction(trx, {
					appId: a.appId,
					row: {
						case_type: a.seed.caseType,
						case_name: a.seed.caseName,
						external_id: a.seed.externalId ?? null,
						status: "open",
						properties: a.seed.properties,
						...(a.seed.parentCaseId === undefined
							? {}
							: { parent_case_id: a.seed.parentCaseId }),
					},
					...(a.caseId === undefined ? {} : { caseId: a.caseId }),
					...(a.ownerId === undefined ? {} : { ownerId: a.ownerId }),
					...(a.seed.parentRelationship === undefined
						? {}
						: { parentRelationship: a.seed.parentRelationship }),
				}),
			updateCase: (trx, a) => this.updateInTransaction(trx, a),
			closeCase: (trx, a) => this.closeCaseInTransaction(trx, a),
		};
	}

	/**
	 * Bulk-insert rows + derived `case_indices` edges against the
	 * caller's transaction. Reserved for the bulk callers
	 * (`generateSampleData` / `resetSampleData` /
	 * `insertWithChildren`); per-row latency of N sequential
	 * `insert` calls is perceptible at sample-data scale.
	 *
	 * Shape: hoist the JSON Schema validator out of the per-row loop
	 * (the per-row path pays a `case_type_schemas` SELECT per row
	 * even on cache hit; hoisting is the single biggest latency
	 * win), validate every row against the cached validator, bulk
	 * INSERT into `cases`, bulk INSERT derived edges into
	 * `case_indices`. ~3 round-trips per batch vs N for the per-row
	 * path. All-or-nothing on validation failure — stricter than
	 * per-row `insert` (which commits earlier rows before hitting a
	 * bad one); aligns with every existing bulk caller's contract.
	 *
	 * `case_id` is generated up-front in TS so the parallel
	 * `case_indices` insert can reference each row's id without
	 * depending on `RETURNING` ordering. UUID v7 in TS uses the same
	 * RFC 9562 shape as Postgres's built-in, so B-tree clustering on
	 * the primary-key page is identical to the column-default path.
	 *
	 * Throws `CasePropertiesValidationError` on the first row that
	 * fails validation; the caller's transaction rolls back so no
	 * partial-batch row lands. All rows must share the same
	 * `case_type`.
	 */
	private async insertManyInTransaction(
		trx: Transaction<Database>,
		args: {
			appId: string;
			rows: ReadonlyArray<CaseInsert>;
			parentRelationship?: CaseIndicesTable["relationship"];
		},
	): Promise<{ caseIds: ReadonlyArray<string> }> {
		if (args.rows.length === 0) {
			return { caseIds: [] };
		}

		// All rows must share one `case_type` so the hoisted-validator
		// optimization holds (one validator-fetch per `(appId,
		// caseType)`). Sample-data generation operates on one case-
		// type per call; `insertWithChildren` chunks at its call site.
		const caseTypes = new Set(args.rows.map((row) => row.case_type));
		if (caseTypes.size !== 1) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.insertManyInTransaction",
					invariant: `every row in a bulk-insert batch must share the same \`case_type\`; received ${caseTypes.size} distinct types`,
					detail:
						"The hoisted-validator optimization fetches the JSON Schema validator ONCE per `(appId, caseType)` at the top of the transaction. A mixed-type batch would defeat that optimization or quietly validate every row against the wrong schema. The current callers (`generateSampleData`, `resetSampleData`'s regeneration step) always operate on one case-type at a time, so the constraint is structurally satisfied at every call site.\n\nHint: chunk the batch by `case_type` at the call site, or call `insert` per row if mixed-type ordering matters.",
				}),
			);
		}
		const caseType = args.rows[0]?.case_type;
		if (caseType === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.insertManyInTransaction",
					invariant:
						"first row's `case_type` is undefined while the input array is non-empty",
					detail:
						"The early-return at the top of the function rejects empty inputs; reaching this throw means an entry in the array was undefined, which would be an upstream lifecycle bug.",
				}),
			);
		}

		// `case_id ?? uuidv7()` lets a caller supply an explicit id
		// while defaulting to the generator. Generated up-front so
		// the parallel `case_indices` insert can reference each row's
		// id without depending on `RETURNING` ordering.
		const caseIds: string[] = args.rows.map((row) => row.case_id ?? uuidv7());

		const validator = await this.getValidator(args.appId, caseType, trx);

		const insertRows: InsertObject<Database, "cases">[] = args.rows.map(
			(row, index) => {
				const propertiesObject = parseJsonbInput(row.properties);
				this.assertValidProperties(validator, {
					appId: args.appId,
					caseType,
					properties: propertiesObject,
				});
				return {
					...row,
					case_id: caseIds[index],
					app_id: args.appId,
					project_id: this.requireProjectId(),
					// The WORKER, exactly as the single-row insert stamps it. The
					// two paths must agree: a split here would mean sample data
					// generated while previewing as a persona belonged to the
					// signed-in member while everything else that persona wrote
					// belonged to the persona.
					owner_id: this.requireOwnerId(),
					case_name: normalizedCaseScalar("case_name", row.case_name, "reject"),
					...(row.external_id === null || row.external_id === undefined
						? { external_id: null }
						: {
								external_id: normalizedCaseScalar(
									"external_id",
									row.external_id,
									"allow",
								),
							}),
					...creationStamps(row),
					properties: JSON.stringify(propertiesObject),
				};
			},
		);

		// Cases first so derived edges' `ancestor_id` references can
		// resolve. No FK constraint declared, so the order is
		// functional rather than structural.
		await trx.insertInto("cases").values(insertRows).execute();

		const indexRows: Insertable<CaseIndicesTable>[] = [];
		for (let i = 0; i < args.rows.length; i++) {
			const row = args.rows[i];
			const caseId = caseIds[i];
			if (row === undefined || caseId === undefined) {
				continue;
			}
			if (row.parent_case_id === null || row.parent_case_id === undefined) {
				continue;
			}
			indexRows.push({
				case_id: caseId,
				ancestor_id: row.parent_case_id,
				identifier: "parent",
				relationship: args.parentRelationship ?? "child",
				depth: 1,
			});
		}
		if (indexRows.length > 0) {
			await trx.insertInto("case_indices").values(indexRows).execute();
		}

		return { caseIds };
	}

	async update(args: CaseUpdateArgs): Promise<void> {
		if (
			args.patch.parent_case_id !== undefined &&
			args.patch.parent_case_id !== null &&
			args.parentRelationship === undefined
		) {
			throw new TypeError(
				"A non-null parent_case_id update requires parentRelationship.",
			);
		}
		await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			await this.updateInTransaction(trx, args);
		});
	}

	/** Validated update core for `update` and atomic parked-value replace. */
	private async updateInTransaction(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseId: string;
			patch: CaseUpdate;
			parentRelationship?: CaseIndicesTable["relationship"];
		},
	): Promise<void> {
		// Discover the immutable type without a row lock, then acquire its schema
		// lock before re-reading the case `FOR UPDATE`. This preserves the global
		// app -> membership -> relationship -> schema -> case-row order while
		// making merge + validation + write atomic against concurrent updates.
		const discovered = await trx
			.selectFrom("cases as c")
			.select("c.case_type")
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.project_id", "=", this.requireProjectId())
			.executeTakeFirst();
		if (discovered === undefined) throw new CaseNotFoundError(args.caseId);

		const validator = await this.getValidator(
			args.appId,
			discovered.case_type,
			trx,
		);
		const existing = await trx
			.selectFrom("cases as c")
			.select(["c.case_type", "c.parent_case_id", "c.properties"])
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.project_id", "=", this.requireProjectId())
			.forUpdate()
			.executeTakeFirst();
		if (existing === undefined || existing.case_type !== discovered.case_type) {
			throw new CaseNotFoundError(args.caseId);
		}
		if (
			args.patch.parent_case_id !== undefined &&
			args.patch.parent_case_id !== null
		) {
			await this.assertParentExists(trx, {
				appId: args.appId,
				parentCaseId: args.patch.parent_case_id,
			});
		}

		let mergedProperties: Record<string, unknown> | undefined;
		if (args.patch.properties !== undefined) {
			const inherited: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(existing.properties)) {
				if (validator.declared.has(key)) inherited[key] = value;
			}
			mergedProperties = {
				...inherited,
				...parseJsonbInput(args.patch.properties),
			};
			this.assertValidProperties(validator, {
				appId: args.appId,
				caseType: existing.case_type,
				properties: mergedProperties,
			});
		}

		const { properties: _patchProperties, ...patchRest } = args.patch;
		const normalizedPatch = {
			...patchRest,
			...(args.patch.case_name === undefined
				? {}
				: {
						case_name: normalizedCaseScalar(
							"case_name",
							args.patch.case_name,
							"reject",
						),
					}),
			...(args.patch.external_id === undefined
				? {}
				: {
						external_id: normalizedCaseScalar(
							"external_id",
							args.patch.external_id,
							"allow",
						),
					}),
		};
		await trx
			.updateTable("cases as c")
			.set({
				...normalizedPatch,
				modified_on: sql<Date>`now()`,
				...(mergedProperties !== undefined
					? { properties: JSON.stringify(mergedProperties) }
					: {}),
			})
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.project_id", "=", this.requireProjectId())
			.execute();

		if (args.patch.parent_case_id === null) {
			await this.rebuildParentEdge(trx, {
				caseId: args.caseId,
				newParent: null,
			});
		} else if (args.patch.parent_case_id !== undefined) {
			if (args.parentRelationship === undefined) {
				throw new TypeError(
					"A non-null parent_case_id update requires parentRelationship.",
				);
			}
			await this.rebuildParentEdge(trx, {
				caseId: args.caseId,
				newParent: args.patch.parent_case_id,
				relationship: args.parentRelationship,
			});
		}
	}

	async close(args: { appId: string; caseId: string }): Promise<void> {
		await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			await this.closeCaseInTransaction(trx, args);
		});
	}

	/**
	 * Lifecycle-close core shared by `close` and the submission
	 * envelope. Status is NOT caller input: CCHQ's built-in `@status`
	 * is exactly `open` / `closed`, so close owns the canonical
	 * `closed` write alongside the timestamp. `coalesce` preserves an
	 * existing closure timestamp while the second WHERE arm lets a
	 * re-close repair rows written by the old close path (`closed_on`
	 * present but status still `open`). `modified_on` advances only for
	 * a genuinely open row; status-only repair preserves the original
	 * close event's timestamp. Import/reopen flows go through `update`
	 * with both lifecycle fields.
	 */
	private async closeCaseInTransaction(
		trx: Transaction<Database>,
		args: { appId: string; caseId: string },
	): Promise<void> {
		const discovered = await trx
			.selectFrom("cases as c")
			.select("c.case_type")
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.project_id", "=", this.requireProjectId())
			.executeTakeFirst();
		if (discovered === undefined) return;
		await this.getValidator(args.appId, discovered.case_type, trx);
		await trx
			.updateTable("cases as c")
			.set({
				closed_on: sql<Date>`coalesce(c.closed_on, now())`,
				modified_on: sql<Date>`case when c.closed_on is null then now() else c.modified_on end`,
				status: "closed",
			})
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.project_id", "=", this.requireProjectId())
			.where((eb) =>
				eb.or([
					eb("c.closed_on", "is", null),
					eb("c.status", "is distinct from", "closed"),
				]),
			)
			.execute();
	}

	async traverse(args: {
		appId: string;
		caseId: string;
		via: RelationPath;
	}): Promise<CaseRow[]> {
		// Self-paths return the anchor row directly; synthesizing a
		// join-on-self would just duplicate the read.
		if (args.via.kind === "self") {
			const rows = await this.db
				.selectFrom("cases as c")
				.selectAll("c")
				.where("c.app_id", "=", args.appId)
				.where("c.case_id", "=", args.caseId)
				.where("c.project_id", "=", this.requireProjectId())
				.execute();
			// Strip the bound-tenant key off the `selectAll` rows — the
			// non-self arms below already omit it via explicit projection.
			return rows.map(stripTenantKey);
		}

		// Non-self path: compile the relation-walk subquery, join it
		// against the anchor row. The compiler enforces tenant scope
		// on every joined `cases` row inside its subquery; the outer
		// scan adds the anchor's Project filter.
		const compiled = compileRelationPath(args.via, {
			db: this.db,
			appId: args.appId,
			projectId: this.requireProjectId(),
			anchorAlias: "c",
		});
		// `self` short-circuited above; the other three arms return
		// `kind: "joined"`. The narrowing is structural.
		if (compiled.kind !== "joined") {
			return [];
		}

		// The leaf row exposes every `cases` column plus
		// `anchor_case_id`. Adding a new column to `cases` requires
		// extending this list AND the leaf-builder projections in
		// `compileRelationPath.ts` — a missed column would fall
		// through to `undefined` at runtime even though the type-cast
		// below narrows to `CaseRow`.
		const leafAlias = compiled.leafAlias;
		const rows = await this.db
			.selectFrom("cases as c")
			.innerJoin(compiled.buildLeafSubquery(), (jb) =>
				jb.onRef(`${leafAlias}.anchor_case_id`, "=", "c.case_id"),
			)
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.project_id", "=", this.requireProjectId())
			.select([
				`${leafAlias}.case_id as case_id`,
				`${leafAlias}.app_id as app_id`,
				`${leafAlias}.case_type as case_type`,
				`${leafAlias}.owner_id as owner_id`,
				`${leafAlias}.status as status`,
				`${leafAlias}.opened_on as opened_on`,
				`${leafAlias}.modified_on as modified_on`,
				`${leafAlias}.closed_on as closed_on`,
				`${leafAlias}.case_name as case_name`,
				`${leafAlias}.external_id as external_id`,
				`${leafAlias}.parent_case_id as parent_case_id`,
				`${leafAlias}.properties as properties`,
			])
			.execute();
		// Cast through `unknown` because Kysely's typed builder over
		// runtime-suffixed alias strings widens the leaf's column
		// type. The projection above pulls each `CaseRow` field by
		// name; the runtime shape matches exactly.
		return rows as unknown as CaseRow[];
	}

	/**
	 * The consent preview for a prospective retype — see
	 * `ConversionImpact`. Runs the migration's OWN cast
	 * (`tryCastValue`, with the same blank-value drop) over the
	 * migration's OWN population (every row of the app's case type
	 * carrying the property — no tenant filter, no hold filter), so
	 * the numbers a consent surface shows are the numbers the
	 * migration would produce for the same data. Read-only; plain
	 * reads outside a transaction (a concurrent write can shift the
	 * outcome regardless — the post-migration report is the truth).
	 */
	async conversionImpact(args: {
		appId: string;
		caseType: string;
		property: string;
		toType: CasePropertyDataType;
	}): Promise<ConversionImpact> {
		// Only rows holding the key leave Postgres, and only the one
		// value per row — `?` tests key presence, `->` projects it. The
		// property rides as a BOUND parameter (not the migration code's
		// `sql.lit`): this method is reachable from a Server Action, so
		// its property name is client input, not a blueprint-validated
		// identifier.
		const rows = await this.db
			.selectFrom("cases as c")
			.select("c.case_id")
			.select(sql<JsonValue>`c.properties -> ${args.property}`.as("value"))
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where(sql<boolean>`c.properties ? ${args.property}`)
			.execute();

		let totalWithValue = 0;
		const failingCaseIds: string[] = [];
		const samples: JsonValue[] = [];
		for (const row of rows) {
			if (hasNoDataToKeep(row.value)) continue;
			totalWithValue++;
			const cast = tryCastValue(row.value, args.toType);
			if (cast.ok) continue;
			failingCaseIds.push(row.case_id);
			if (samples.length < CONVERSION_IMPACT_SAMPLE_CAP) {
				samples.push(row.value);
			}
		}

		let alreadyHeld = 0;
		if (failingCaseIds.length > 0) {
			const heldRow = await this.db
				.selectFrom("parked_case_values as held")
				.select(sql<string>`count(DISTINCT held.case_id)`.as("held"))
				.where("held.app_id", "=", args.appId)
				.where("held.dismissed_at", "is", null)
				.where(sql<boolean>`held.case_id = ANY(${failingCaseIds}::text[])`)
				.executeTakeFirstOrThrow();
			alreadyHeld = Number(heldRow.held);
		}

		return {
			totalWithValue,
			uncastable: failingCaseIds.length,
			alreadyHeld,
			samples,
		};
	}

	async applySchemaChange(
		args: ApplySchemaChangeArgs,
	): Promise<MigrationReport> {
		const phaseA = await this.db.transaction().execute(async (tx) => {
			await this.authorizeSchemaMutation(tx, args.appId);
			return this.applySchemaChangePhaseA(tx, args);
		});
		await phaseA.completeAfterCommit();
		return phaseA.report;
	}

	async applyCasePropertyRenamePhaseA(
		tx: Transaction<Database>,
		args: ApplyCasePropertyRenameArgs,
	): Promise<PreparedCasePropertyRenamePhaseB> {
		const desiredSeq = safePersistedSequence(
			args.desiredSeq,
			`case-property rename sequence for app ${args.appId}`,
		);
		if (args.entries.length === 0) {
			throw new Error("A case-property rename plan must not be empty.");
		}
		const sourceKeys = new Set<string>();
		const destinationKeys = new Set<string>();
		const entriesByCaseType = new Map<
			string,
			Array<{ from: string; to: string }>
		>();
		for (const entry of args.entries) {
			const sourceKey = `${entry.caseType}\0${entry.from}`;
			const destinationKey = `${entry.caseType}\0${entry.to}`;
			if (
				entry.from === entry.to ||
				sourceKeys.has(sourceKey) ||
				destinationKeys.has(destinationKey) ||
				CASE_SCALAR_PROPERTY_NAMES.has(entry.from) ||
				CASE_SCALAR_PROPERTY_NAMES.has(entry.to)
			) {
				throw new Error(
					"Case-property rename storage received a non-bijective or scalar plan.",
				);
			}
			sourceKeys.add(sourceKey);
			destinationKeys.add(destinationKey);
			const caseType = args.caseTypeSchemas.get(entry.caseType);
			if (
				caseType === undefined ||
				!caseType.properties.some((property) => property.name === entry.to)
			) {
				throw new Error(
					"Case-property rename storage plan disagrees with the committed candidate catalog.",
				);
			}
			const group = entriesByCaseType.get(entry.caseType) ?? [];
			group.push({ from: entry.from, to: entry.to });
			entriesByCaseType.set(entry.caseType, group);
		}
		const caseTypes = [...entriesByCaseType.keys()].sort();
		for (const caseType of caseTypes) {
			await sql`
				SELECT pg_advisory_xact_lock(
					hashtextextended(${caseSchemaIndexLockScope(args.appId, caseType)}, 0)
				)
			`.execute(tx);
			await tx
				.deleteFrom("case_schema_index_deletions")
				.where("app_id", "=", args.appId)
				.where("case_type", "=", caseType)
				.execute();
		}

		// App lock is already held by the guarded writer. Lock schemas before
		// cases, matching every ordinary row writer's schema→case order.
		const priorSchemaRows = await tx
			.selectFrom("case_type_schemas")
			.select(["case_type", "schema", "synced_seq", "is_active"])
			.where("app_id", "=", args.appId)
			.where("case_type", "in", caseTypes)
			.orderBy("case_type")
			.forUpdate()
			.execute();
		const caseRows = await tx
			.selectFrom("cases")
			.select(["case_id", "case_type", "properties"])
			.where("app_id", "=", args.appId)
			.where("case_type", "in", caseTypes)
			.orderBy("case_type")
			.orderBy("case_id")
			.forUpdate()
			.execute();
		const parkedRows = await tx
			.selectFrom("parked_case_values")
			.select(["id", "case_id", "case_type", "property"])
			.where("app_id", "=", args.appId)
			.where("case_type", "in", caseTypes)
			.orderBy("case_type")
			.orderBy("case_id")
			.orderBy("id")
			.forUpdate()
			.execute();

		for (const caseType of caseTypes) {
			const renames = entriesByCaseType.get(caseType) ?? [];
			const movingSources = new Set(renames.map((entry) => entry.from));
			for (const row of caseRows) {
				if (row.case_type !== caseType) continue;
				for (const rename of renames) {
					if (
						!movingSources.has(rename.to) &&
						Object.hasOwn(row.properties, rename.to)
					) {
						throw new CasePropertyRenameStorageConflictError(
							caseType,
							rename.to,
							"case-row",
						);
					}
				}
			}
			for (const rename of renames) {
				if (
					!movingSources.has(rename.to) &&
					parkedRows.some(
						(row) => row.case_type === caseType && row.property === rename.to,
					)
				) {
					throw new CasePropertyRenameStorageConflictError(
						caseType,
						rename.to,
						"parked-value",
					);
				}
			}
		}

		for (const caseType of caseTypes) {
			const priorSchemaRow = priorSchemaRows.find(
				(row) => row.case_type === caseType,
			);
			if (
				priorSchemaRow !== undefined &&
				!priorSchemaRow.is_active &&
				desiredSeq <=
					safePersistedSequence(
						priorSchemaRow.synced_seq,
						`stored case_type_schemas.synced_seq for ${args.appId}/${caseType}`,
					)
			) {
				throw new Error(
					`A stale case-property rename cannot reactivate retired case type ${caseType}.`,
				);
			}
			const priorSchema =
				priorSchemaRow === undefined
					? undefined
					: decodeStoredCaseSchema(args.appId, caseType, priorSchemaRow.schema);
			const nextType = args.caseTypeSchemas.get(caseType);
			if (nextType === undefined) {
				throw new CaseTypeNotInBlueprintError(args.appId, caseType);
			}
			const transitions: DetectedRetype[] = [];
			for (const rename of entriesByCaseType.get(caseType) ?? []) {
				const oldDestinationType = priorSchema?.dataTypes.get(rename.to);
				const incomingType =
					nextType.properties.find((property) => property.name === rename.to)
						?.data_type ?? "text";
				if (oldDestinationType !== undefined) {
					transitions.push({
						property: rename.to,
						fromType: oldDestinationType,
						toType: incomingType,
					});
				}
			}
			await this.dropStaleNumericIndexes(tx, {
				appId: args.appId,
				caseType,
				transitions,
			});
		}

		for (const caseType of caseTypes) {
			const declaration = args.caseTypeSchemas.get(caseType);
			if (declaration === undefined) {
				throw new CaseTypeNotInBlueprintError(args.appId, caseType);
			}
			const schema = caseTypeToJsonSchema(declaration);
			computeDesiredIndexSet(args.appId, caseType, declaration.properties);
			await tx
				.insertInto("case_type_schemas")
				.values({
					app_id: args.appId,
					case_type: caseType,
					schema: JSON.stringify(schema),
					synced_seq: desiredSeq,
					index_pending_seq: desiredSeq,
				})
				.onConflict((conflict) =>
					conflict.columns(["app_id", "case_type"]).doUpdateSet({
						schema: JSON.stringify(schema),
						synced_seq: desiredSeq,
						index_pending_seq: desiredSeq,
					}),
				)
				.execute();
		}

		const caseUpdates: Array<{
			caseId: string;
			properties: JsonObject;
		}> = [];
		for (const row of caseRows) {
			const renames = entriesByCaseType.get(row.case_type) ?? [];
			if (
				!renames.some((rename) => Object.hasOwn(row.properties, rename.from))
			) {
				continue;
			}
			const sources = new Set(renames.map((rename) => rename.from));
			const properties: JsonObject = {};
			for (const [key, value] of Object.entries(row.properties)) {
				if (!sources.has(key)) properties[key] = value;
			}
			for (const rename of renames) {
				if (Object.hasOwn(row.properties, rename.from)) {
					properties[rename.to] = row.properties[rename.from] as JsonValue;
				}
			}
			caseUpdates.push({ caseId: row.case_id, properties });
		}
		if (caseUpdates.length > 0) {
			const values = caseUpdates.map(
				(row) =>
					sql`(${row.caseId}::text, ${JSON.stringify(row.properties)}::jsonb)`,
			);
			const updated = await sql`
				UPDATE cases
				SET properties = incoming.properties
				FROM (VALUES ${sql.join(values)})
					AS incoming(case_id, properties)
				WHERE cases.app_id = ${args.appId}
				  AND cases.case_id = incoming.case_id
			`.execute(tx);
			if (Number(updated.numAffectedRows) !== caseUpdates.length) {
				throw new Error("Case-property rename lost a locked live case row.");
			}
		}

		const parkedUpdates = parkedRows.flatMap((row) => {
			const rename = (entriesByCaseType.get(row.case_type) ?? []).find(
				(entry) => entry.from === row.property,
			);
			return rename === undefined ? [] : [{ id: row.id, property: rename.to }];
		});
		if (parkedUpdates.length > 0) {
			const values = parkedUpdates.map(
				(row) => sql`(${row.id}::uuid, ${row.property}::text)`,
			);
			const updated = await sql`
				UPDATE parked_case_values
				SET property = incoming.property
				FROM (VALUES ${sql.join(values)})
					AS incoming(id, property)
				WHERE parked_case_values.app_id = ${args.appId}
				  AND parked_case_values.id = incoming.id
			`.execute(tx);
			if (Number(updated.numAffectedRows) !== parkedUpdates.length) {
				throw new Error("Case-property rename lost a locked parked value.");
			}
		}

		return {
			report: {
				renamedRows: caseUpdates.length,
				renamedParkedValues: parkedUpdates.length,
				caseTypes,
			},
			completeAfterCommit: async () => {
				await this.drainPendingIndexConvergence({
					appId: args.appId,
					caseTypes,
				});
			},
		};
	}

	async retireSchemasPhaseA(
		tx: Transaction<Database>,
		args: ApplyCaseTypeSchemaRetirementArgs,
	): Promise<PreparedCaseTypeSchemaRetirementPhaseB> {
		const retired = await retireCaseTypeSchemasPhaseA(tx, args);
		return {
			caseTypes: retired,
			completeAfterCommit: async () => {
				if (retired.length === 0) return;
				await this.drainRetiredIndexConvergence({
					appId: args.appId,
					caseTypes: retired,
				});
			},
		};
	}

	async drainPendingIndexConvergence(args: {
		readonly appId: string;
		readonly caseTypes?: readonly string[];
	}): Promise<void> {
		const pendingSchemas = await this.db
			.selectFrom("case_type_schemas")
			.select("case_type")
			.where("app_id", "=", args.appId)
			.where("index_pending_seq", "is not", null)
			.$if(args.caseTypes !== undefined, (query) =>
				query.where("case_type", "in", [...(args.caseTypes ?? [])]),
			)
			.orderBy("case_type")
			.execute();
		const pendingDeletions = await this.db
			.selectFrom("case_schema_index_deletions")
			.select("case_type")
			.where("app_id", "=", args.appId)
			.$if(args.caseTypes !== undefined, (query) =>
				query.where("case_type", "in", [...(args.caseTypes ?? [])]),
			)
			.orderBy("case_type")
			.execute();
		const caseTypes = new Set([
			...pendingSchemas.map((row) => row.case_type),
			...pendingDeletions.map((row) => row.case_type),
		]);
		for (const caseType of [...caseTypes].sort()) {
			await this.drainPendingIndexConvergenceForType(args.appId, caseType);
		}
	}

	async drainRetiredIndexConvergence(args: {
		readonly appId: string;
		readonly caseTypes: readonly string[];
	}): Promise<void> {
		// Unlike the ordinary pending drain, this deliberately ignores the
		// marker and rechecks the latest lifecycle state under the advisory lock.
		// It closes the rollout-overlap window where an older worker can clear the
		// marker without understanding that an inactive row wants no indexes.
		for (const caseType of [...new Set(args.caseTypes)].sort()) {
			await this.drainPendingIndexConvergenceForType(args.appId, caseType);
		}
	}

	async drainAllPendingIndexConvergence(): Promise<void> {
		// A previous application revision can consume an inactive row's pending
		// seq without understanding that its desired index set is empty. Force
		// every durable retirement through the current reconciler once before the
		// ordinary pending loop; this is finite even though retired rows persist.
		const retired = await this.db
			.selectFrom("case_type_schemas")
			.select(["app_id", "case_type"])
			.where("is_active", "=", false)
			.orderBy("app_id")
			.orderBy("case_type")
			.execute();
		for (const row of retired) {
			await this.drainPendingIndexConvergenceForType(row.app_id, row.case_type);
		}
		while (true) {
			const pending = await sql<{ app_id: string; case_type: string }>`
				SELECT app_id, case_type
				FROM case_type_schemas
				WHERE index_pending_seq IS NOT NULL
				UNION
				SELECT app_id, case_type
				FROM case_schema_index_deletions
				ORDER BY app_id, case_type
			`.execute(this.db);
			if (pending.rows.length === 0) return;
			for (const row of pending.rows) {
				await this.drainPendingIndexConvergenceForType(
					row.app_id,
					row.case_type,
				);
			}
		}
	}

	private async drainPendingIndexConvergenceForType(
		appId: string,
		caseType: string,
	): Promise<void> {
		await this.db.connection().execute(async (connection) => {
			const scope = caseSchemaIndexLockScope(appId, caseType);
			await sql`
				SELECT pg_advisory_lock(hashtextextended(${scope}, 0))
			`.execute(connection);
			try {
				const latest = await connection
					.selectFrom("case_type_schemas")
					.select(["schema", "is_active", "synced_seq", "index_pending_seq"])
					.where("app_id", "=", appId)
					.where("case_type", "=", caseType)
					.executeTakeFirst();
				const pendingDeletion = await connection
					.selectFrom("case_schema_index_deletions")
					.select("case_type")
					.where("app_id", "=", appId)
					.where("case_type", "=", caseType)
					.executeTakeFirst();
				if (latest === undefined) {
					if (pendingDeletion === undefined) return;
					await this.syncExpressionIndexes({
						db: connection,
						appId,
						caseType,
						desired: new Map(),
					});
					await connection
						.deleteFrom("case_schema_index_deletions")
						.where("app_id", "=", appId)
						.where("case_type", "=", caseType)
						.execute();
					return;
				}
				if (pendingDeletion !== undefined) {
					// A schema recreated after a drop is authoritative. Phase A
					// normally removed this tombstone under the same lock; this
					// branch also converges a stale Phase-B owner that observed
					// the recreation after it began.
					await connection
						.deleteFrom("case_schema_index_deletions")
						.where("app_id", "=", appId)
						.where("case_type", "=", caseType)
						.execute();
				}
				if (latest.is_active && latest.index_pending_seq === null) return;
				const pendingSeq =
					latest.index_pending_seq === null
						? undefined
						: safePersistedSequence(
								latest.index_pending_seq,
								`case_type_schemas.index_pending_seq for ${appId}/${caseType}`,
							);
				await this.syncExpressionIndexes({
					db: connection,
					appId,
					caseType,
					desired: latest.is_active
						? desiredIndexesFromStoredSchema(appId, caseType, latest.schema)
						: new Map(),
				});
				if (pendingSeq !== undefined) {
					await connection
						.updateTable("case_type_schemas")
						.set({
							index_pending_seq: null,
							index_synced_seq: pendingSeq,
						})
						.where("app_id", "=", appId)
						.where("case_type", "=", caseType)
						.where("index_pending_seq", "=", String(pendingSeq))
						.execute();
				} else if (!latest.is_active) {
					// Forced retirement reconciliation can arrive after an older
					// application revision consumed the marker while retaining the old
					// desired indexes. The current reconciler has now observed the empty
					// set, so advance the durable convergence watermark as well as the
					// physical catalog state.
					const syncedSeq = safePersistedSequence(
						latest.synced_seq,
						`case_type_schemas.synced_seq for forced index convergence ${appId}/${caseType}`,
					);
					await connection
						.updateTable("case_type_schemas")
						.set({ index_synced_seq: syncedSeq })
						.where("app_id", "=", appId)
						.where("case_type", "=", caseType)
						.where("is_active", "=", false)
						.where("synced_seq", "=", String(syncedSeq))
						.where("index_pending_seq", "is", null)
						.execute();
				}
			} finally {
				await sql`
					SELECT pg_advisory_unlock(hashtextextended(${scope}, 0))
				`.execute(connection);
			}
		});
	}

	async applySchemaChangePhaseA(
		tx: Transaction<Database>,
		args: ApplySchemaChangeArgs,
	): Promise<PreparedSchemaChangePhaseB> {
		// `change` (a per-row migration) and `syncedSeq` (the monotone additive
		// gate) are mutually exclusive: the migration path runs pre-commit with
		// no committed seq, the additive path carries a seq and no migration. If
		// they combined, the coarse gate's whole-call `return` could silently
		// skip a migration's per-row work on a stale seq — so reject the
		// impossible state loudly rather than corrupt data.
		if (args.change !== undefined && args.syncedSeq !== undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.applySchemaChange",
					invariant:
						"`change` and `syncedSeq` are both set; a per-row migration and the monotone additive gate are mutually exclusive",
					detail:
						"`change` describes a per-row reshape (rename / retype / narrow-options) that runs pre-commit with no committed seq; `syncedSeq` is the monotone gate for an additive sync that carries a committed seq and no migration. Reaching this means a caller combined them, the coarse `synced_seq` gate could then skip the migration's per-row work on a stale seq. Hint: run the migration un-versioned (Phase 1) and let the post-commit sweep advance `synced_seq` additively.",
				}),
			);
		}
		const incomingSeq =
			args.syncedSeq === undefined
				? undefined
				: safePersistedSequence(
						args.syncedSeq,
						`case_type_schemas.synced_seq for ${args.appId}/${args.caseType}`,
					);
		const caseType = args.caseTypeSchemas.get(args.caseType);
		if (caseType === undefined) {
			throw new CaseTypeNotInBlueprintError(args.appId, args.caseType);
		}
		const schema = caseTypeToJsonSchema(caseType);

		// Pre-flight: compute the desired index set BEFORE Phase A
		// opens. `indexName` throws on identifier-shape violations
		// (non-conforming characters, post-transform collisions,
		// 63-byte identifier cap). A throw here leaves
		// `case_type_schemas` untouched. Pure CPU, no I/O.
		computeDesiredIndexSet(args.appId, args.caseType, caseType.properties);
		await sql`
			SELECT pg_advisory_xact_lock(
				hashtextextended(
					${caseSchemaIndexLockScope(args.appId, args.caseType)},
					0
				)
			)
		`.execute(tx);
		// The lifecycle row is the sequence fence. Lock and read it before
		// clearing a hard-purge tombstone or doing any row work. In particular,
		// an equal-sequence sync may retry an ACTIVE row, but it must never
		// resurrect an INACTIVE row retired by that sequence.
		const priorRow = await tx
			.selectFrom("case_type_schemas")
			.select(["schema", "synced_seq", "is_active"])
			.where("app_id", "=", args.appId)
			.where("case_type", "=", args.caseType)
			.forUpdate()
			.executeTakeFirst();
		if (
			incomingSeq === undefined &&
			priorRow !== undefined &&
			!priorRow.is_active
		) {
			throw new Error(
				`An unversioned schema migration cannot reactivate retired case type ${args.caseType}.`,
			);
		}

		// Monotone `synced_seq` gate — the coarse half. When the caller carries
		// a `syncedSeq` (the multiplayer additive sync + heal), read the row's
		// recorded seq: an incoming seq BELOW it is a stale sync a fresher
		// concurrent writer already superseded, so the ENTIRE call no-ops
		// (schema UPSERT + Phase-B index reconciliation both skipped). A
		// `syncedSeq` call never carries a `change` (they're mutually exclusive
		// — the throw above fires first), so there's no caller-intent migration
		// to skip here. The DETECTED string↔array reshape (Phase A step 2) can
		// be skipped by this no-op, and that is safe by construction: the
		// reshape derives from the stored row itself, so the fresher writer
		// that advanced the row already ran its own detection against the same
		// stored state in its own transaction. An absent row means "proceed"
		// (first sync). node-postgres returns `bigint`/`int8` as a string, so
		// every read crosses the shared nonnegative safe-sequence boundary. The
		// fine half is the guarded UPSERT SET below — a lost SELECT→UPSERT race
		// re-converges on the next sync (perf-only, not a correctness gate).
		if (args.syncedSeq !== undefined) {
			if (
				priorRow !== undefined &&
				incomingSeq !== undefined &&
				(incomingSeq <
					safePersistedSequence(
						priorRow.synced_seq,
						`stored case_type_schemas.synced_seq for ${args.appId}/${args.caseType}`,
					) ||
					(!priorRow.is_active &&
						incomingSeq ===
							safePersistedSequence(
								priorRow.synced_seq,
								`stored case_type_schemas.synced_seq for ${args.appId}/${args.caseType}`,
							)))
			) {
				return {
					report: {
						migrated: 0,
						reshaped: 0,
						retyped: 0,
						restored: 0,
						skipped: 0,
						parkedIds: [],
						failureReasons: [],
					},
					completeAfterCommit: async () => {},
				};
			}
		}
		await tx
			.deleteFrom("case_schema_index_deletions")
			.where("app_id", "=", args.appId)
			.where("case_type", "=", args.caseType)
			.execute();

		// Phase A: schema sync + per-row work in one transaction. `won` records
		// whether THIS call actually advanced the row — false only when the
		// versioned fine-gate WHERE suppressed the UPSERT (a monotone loser).
		// Phase B and the step-2 reshape are both gated on it.
		let won = true;
		const report = await (async (trx: Transaction<Database>) => {
			// Read the stored schema BEFORE the UPSERT overwrites it — the
			// string↔array reshape (step 2) diffs stored vs desired per
			// property. `FOR UPDATE` serializes concurrent syncs of the same
			// type, so a second syncer blocks here, then reads the winner's
			// committed schema and detects no remaining flip — the reshape
			// scan runs once per transition, not once per racer. It also
			// serializes ROW WRITERS: every insert/update holds this row
			// `FOR SHARE` through `validateProperties` until its own commit
			// (contract on `getValidator`), so a row validated against the
			// old schema is committed — and visible to the reshape scan —
			// before this lock is granted; none can slip between the scan
			// and the schema flip. An absent row locks nothing: first sync,
			// nothing to reshape.
			// Step 1: schema regen + UPSERT. Always runs. `RETURNING synced_seq`
			// is the win signal: Postgres emits a row only when the statement
			// actually inserted or updated, so a versioned loser (the DO UPDATE
			// WHERE was false) returns NOTHING.
			const upserted = await trx
				.insertInto("case_type_schemas")
				.values({
					app_id: args.appId,
					case_type: args.caseType,
					schema: JSON.stringify(schema),
					...(incomingSeq !== undefined && { synced_seq: incomingSeq }),
				})
				.onConflict((oc) => {
					const conflict = oc.columns(["app_id", "case_type"]);
					if (incomingSeq === undefined) {
						return conflict.doUpdateSet({
							schema: JSON.stringify(schema),
						});
					}
					// The fine half of the monotone gate — the UPSERT SET itself
					// can't regress `synced_seq` even if a fresher writer landed
					// between the coarse SELECT above and here. Omitted on the
					// un-versioned path (a plain additive UPSERT always wins its
					// own conflict).
					return conflict
						.doUpdateSet((eb) => ({
							schema: JSON.stringify(schema),
							synced_seq: eb.ref("excluded.synced_seq"),
						}))
						.where(
							sql<boolean>`excluded.synced_seq > case_type_schemas.synced_seq OR (case_type_schemas.is_active AND excluded.synced_seq = case_type_schemas.synced_seq)`,
						);
				})
				.returning("synced_seq")
				.executeTakeFirst();
			// A versioned loser returns no row. The un-versioned path never has
			// a suppressing WHERE, so it always returns a row (always a winner).
			won = upserted !== undefined;
			if (won && upserted !== undefined) {
				const wonSeq = safePersistedSequence(
					upserted.synced_seq,
					`returned case_type_schemas.synced_seq for ${args.appId}/${args.caseType}`,
				);
				await trx
					.updateTable("case_type_schemas")
					.set({
						index_pending_seq: wonSeq,
					})
					.where("app_id", "=", args.appId)
					.where("case_type", "=", args.caseType)
					.execute();
			}

			// Step 2: stored↔desired per-property transition detection. On
			// every WINNING sync the stored schema diffs against the newly
			// derived one and every same-name property whose validation
			// semantics changed migrates in the SAME transaction as the
			// schema write — so the schema row and the row population can
			// never disagree, whichever caller synced (the guarded
			// post-commit sweep, drain-end materialize, point-of-use heal,
			// or a drift script). Without it, a
			// regenerated schema strands every pre-transition row:
			// merged-document write validation rejects the old value on
			// the row's next write of ANY property. Two families:
			// string↔array flips take the TOTAL reshape; every other
			// change (a `format` keyword, string→integer, array→date, …)
			// takes the per-row cast whose uncastable values PARK. A
			// fine-gate loser skips both — the winner's schema is what's
			// stored, and the winner ran its own detection; a stale-seq
			// no-op is equally safe because detection derives from the
			// stored row itself.
			let reshaped = 0;
			let retyped = 0;
			let detectedParkedIds: string[] = [];
			let detectedFailureReasons: string[] = [];
			let transitions: PropertyTransitions = {
				flips: [],
				retypes: [],
				widenings: [],
			};
			if (won) {
				// Exclude the caller-targeted property: the explicit generic
				// migration rewrites that same key, so detecting it here would
				// double rewrite and double count.
				const priorSchema =
					priorRow === undefined
						? undefined
						: decodeStoredCaseSchema(
								args.appId,
								args.caseType,
								priorRow.schema,
							);
				transitions = detectPropertyTransitions(
					priorSchema,
					caseType,
					args.change === undefined ? undefined : args.property,
				);
				// A numeric-source transition writes values the stale
				// `::integer` / `::numeric` expression index can't cast (an
				// array target's rows, an int→decimal widening's RESTORED
				// fractions), which would abort the transaction — drop the
				// stale index FIRST (plain in-txn DROP; Phase B recreates
				// the new type's index after commit). The explicit `retype`
				// arm shares the hazard; widenings ride along because their
				// closing parked-value restore writes rows here in Phase A
				// even though the widening itself rewrites none.
				const explicitRetype =
					args.change !== undefined && args.change.kind === "retype"
						? [
								{
									property: this.requireMigrationProperty(
										args.property,
										"retype",
									),
									fromType: args.change.fromType,
									toType: args.change.toType,
								},
							]
						: [];
				await this.dropStaleNumericIndexes(trx, {
					appId: args.appId,
					caseType: args.caseType,
					transitions: [
						...transitions.retypes,
						...transitions.widenings,
						...explicitRetype,
					],
				});
				if (transitions.flips.length > 0) {
					reshaped = await this.runShapeReshape(trx, {
						appId: args.appId,
						caseType: args.caseType,
						flips: transitions.flips,
					});
				}
				if (transitions.retypes.length > 0) {
					const detected = await this.runRetypeMigrations(trx, {
						appId: args.appId,
						caseType: args.caseType,
						retypes: transitions.retypes,
					});
					retyped = detected.migrated;
					detectedParkedIds = detected.parkedIds;
					detectedFailureReasons = detected.failureReasons;
				}
			}

			// Step 3: caller-intent per-row migration. Additive blueprint
			// mutations (no `change`) skip this — adding a property still
			// emits its expression index in Phase B, but the row
			// population doesn't need migrating.
			const migration =
				args.change === undefined
					? undefined
					: await this.runPerRowMigration(trx, {
							appId: args.appId,
							caseType: args.caseType,
							property: args.property,
							change: args.change,
						});

			// Step 4: restore previously-parked values whose property's
			// declared TYPE changed in this sync and whose original value
			// the new schema accepts — the winning sync's closing move, so
			// a convert-back or an undo batch automatically recovers what the
			// forward conversion set aside. Identity WIDENINGS count: a
			// date→text convert-back rewrites no rows, but it is exactly
			// the transition the parked text values were waiting for.
			// Scoped to type-changed properties on purpose: a
			// narrow-options park's select value always conforms (selects
			// carry no enum), so an unscoped restore would silently undo
			// the opt-in flush on the type's next same-type sync. Runs
			// AFTER the migrations, so a value parked moments ago in this
			// same transaction is re-checked against the schema that
			// parked it and stays put.
			const transitionedProperties = new Set<string>([
				...transitions.flips.map((flip) => flip.property),
				...transitions.retypes.map((retype) => retype.property),
				...transitions.widenings.map((widening) => widening.property),
				...(args.change !== undefined && args.change.kind === "retype"
					? [this.requireMigrationProperty(args.property, "retype")]
					: []),
			]);
			const restored =
				won && transitionedProperties.size > 0
					? await this.restoreConformantParked(trx, {
							appId: args.appId,
							caseType: args.caseType,
							schema,
							properties: transitionedProperties,
						})
					: 0;

			// Step 2's work reports on its OWN axes rather than folding
			// into `migrated`: one physical row can be rewritten by both a
			// detected transition and the `change`-targeted migration, so
			// a sum would count it twice. Park ids and reasons concatenate
			// — each names a distinct VALUE.
			return {
				migrated: migration?.migrated ?? 0,
				reshaped,
				retyped,
				restored,
				skipped: migration?.skipped ?? 0,
				parkedIds: [...detectedParkedIds, ...(migration?.parkedIds ?? [])],
				failureReasons: [
					...detectedFailureReasons,
					...(migration?.failureReasons ?? []),
				],
			};
		})(tx);

		// Phase B: per-property expression-index DDL. Runs against
		// the post-commit state so the migration's row rewrites have
		// committed and the heap scan sees clean rows. Failure leaves Phase A
		// intact; the next call retries idempotently via the
		// `indisvalid`-aware catalog diff.
		//
		// SKIPPED for a monotone loser (`won === false`): the fine-gate WHERE
		// suppressed its schema UPSERT, so the row carries the WINNER's schema,
		// not this call's `desiredIndexes`. Running Phase B here would diff the
		// loser's OLDER desired set against the live index set (which already
		// has the winner's new-property index) and `DROP` the winner's live
		// index — a self-inflicted seq-scan regression. The winner ran (or will
		// run) Phase B with the correct desired set. (The coarse-gate no-op
		// earlier already returns before reaching Phase B; this closes the
		// narrower fine-gate-loser window.)
		return {
			report,
			completeAfterCommit: async () => {
				if (!won) return;
				try {
					await this.drainPendingIndexConvergence({
						appId: args.appId,
						caseTypes: [args.caseType],
					});
				} catch (phaseBErr) {
					// Phase A is already durable — wrap so the COMMITTED report
					// (parked ids and all) survives the throw; `cause` keeps
					// transient classification working.
					throw new SchemaChangePhaseBError({
						appId: args.appId,
						caseType: args.caseType,
						report,
						cause: phaseBErr,
					});
				}
			},
		};
	}

	/** Package-private maintenance/test escape hatch; never exposed by the barrel factory. */
	async purgeSchemaForMaintenance(args: {
		appId: string;
		caseType: string;
	}): Promise<void> {
		// Phase A: lock the live app placement, then DELETE the schema row in
		// that same transaction. Idempotent when the schema row is absent.
		await this.db.transaction().execute(async (trx) => {
			await this.authorizeSchemaMutation(trx, args.appId);
			await sql`
				SELECT pg_advisory_xact_lock(
					hashtextextended(
						${caseSchemaIndexLockScope(args.appId, args.caseType)},
						0
					)
				)
			`.execute(trx);
			await trx
				.deleteFrom("case_type_schemas")
				.where("app_id", "=", args.appId)
				.where("case_type", "=", args.caseType)
				.execute();
			await trx
				.insertInto("case_schema_index_deletions")
				.values({ app_id: args.appId, case_type: args.caseType })
				.onConflict((conflict) =>
					conflict.columns(["app_id", "case_type"]).doNothing(),
				)
				.execute();
		});

		// Phase B: drop every per-property expression index for THIS
		// app's case type. The "desired set" for a dropped case type is
		// empty, so `diffIndexSets` would emit drops for every live
		// index `readLiveIndexSet` returns — and that read is scoped to
		// `(appId, caseType)`, so a drop never touches another app's
		// same-named case type. Calling `syncExpressionIndexes` with an
		// empty desired map is the established way to express "drop
		// everything for this app's case type" — keeping the index-DDL
		// plumbing in one place. `DROP INDEX CONCURRENTLY IF EXISTS`
		// survives a missing-index path (Phase B already committed in a
		// prior run, the schema-row DELETE is the only outstanding work).
		await this.drainPendingIndexConvergenceForType(args.appId, args.caseType);
	}

	/**
	 * Sync per-property expression indexes against the pre-flighted
	 * desired set, scoped to one `(appId, caseType)`. Naming
	 * convention `cases_<scopeTag>_<property>_<mode>` makes the diff
	 * mechanical — a property rename drops old-name indexes and
	 * creates new-name indexes; a retype drops the old type's indexes
	 * and creates the new type's, because `<mode>` encodes the full
	 * index shape so a type change always lands a distinct name (e.g.
	 * `text → int` shifts `fuzzy → int`; `int → decimal` shifts
	 * `int → num` since the two btree casts differ). The `<scopeTag>`
	 * name segment (a fixed-width hash of `(app_id, case_type)`) plus
	 * the `WHERE app_id = '<app>' AND case_type = '<type>'`
	 * partial-index predicate scope each index to one app's case-type
	 * rows, so two apps that share a case-type + property name never
	 * collide.
	 */
	private async syncExpressionIndexes(args: {
		db?: Kysely<Database>;
		appId: string;
		caseType: string;
		desired: ReadonlyMap<string, DesiredIndex>;
	}): Promise<void> {
		const db = args.db ?? this.db;
		const live = await readLiveIndexSet(db, args.appId, args.caseType);
		const { creates, drops } = diffIndexSets(args.desired, live);

		// Drops first so a same-name INVALID artifact clears before
		// the create reuses it. The ordered loop is what makes that
		// pair atomic at the name level. `DROP INDEX CONCURRENTLY`
		// avoids `ACCESS EXCLUSIVE` for the drop's duration; `IF
		// EXISTS` makes the drop idempotent against a half-completed
		// prior run. The name is schema-qualified from the catalog read
		// so the drop targets the entry the diff decided on rather than
		// whatever a bare name resolves to on the search path.
		for (const drop of drops) {
			await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(drop.schema, drop.name)}`.execute(
				db,
			);
		}
		for (const create of creates) {
			await emitCreateIndex(db, create);
		}
	}

	/**
	 * Drop the live `::integer` / `::numeric` btree expression index of
	 * every numeric-SOURCE retype before its rows rewrite (plain in-txn
	 * `DROP INDEX` — brief `ACCESS EXCLUSIVE`, safe at preview scale).
	 * A retype away from a numeric type writes values the stale cast
	 * can't evaluate (an array target's `'["x"]'::integer`), which
	 * would abort Phase A mid-migration; Phase B's catalog diff would
	 * drop the index anyway, this just moves the drop ahead of the row
	 * writes. Non-numeric sources have no cast-bearing index (`text`'s
	 * trgm GIN and multi_select's jsonb GIN read uncast) and are
	 * skipped.
	 */
	private async dropStaleNumericIndexes(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			transitions: ReadonlyArray<DetectedRetype>;
		},
	): Promise<void> {
		for (const transition of args.transitions) {
			if (transition.fromType !== "int" && transition.fromType !== "decimal") {
				continue;
			}
			// Keep a cast-bearing destination index exactly when every incoming
			// value remains in its acceptance set. `::integer` admits only int;
			// `::numeric` admits both int and decimal. The reverse widening can
			// restore fractions through a stale integer cast and therefore must
			// still pre-drop it.
			if (
				(transition.fromType === "int" && transition.toType === "int") ||
				(transition.fromType === "decimal" &&
					(transition.toType === "int" || transition.toType === "decimal"))
			) {
				continue;
			}
			const staleName = indexName(
				args.appId,
				args.caseType,
				transition.property,
				BTREE_SUFFIX_FOR_DATA_TYPE[transition.fromType],
			);
			const staleResult = await sql<{ name: string; schema: string }>`
				SELECT index_relation.relname AS name,
				       namespace.nspname AS schema
				FROM pg_index AS index_row
				JOIN pg_class AS index_relation
				  ON index_relation.oid = index_row.indexrelid
				JOIN pg_namespace AS namespace
				  ON namespace.oid = index_relation.relnamespace
				WHERE index_row.indrelid = to_regclass('cases')
				  AND index_relation.relname = ${staleName}
			`.execute(trx);
			const stale = staleResult.rows[0];
			if (stale !== undefined) {
				await sql`DROP INDEX IF EXISTS ${sql.id(stale.schema, stale.name)}`.execute(
					trx,
				);
			}
		}
	}

	async generateSampleData(
		args: GenerateSampleDataArgs,
	): Promise<{ inserted: number }> {
		// Transactional body lives in `generateSampleDataInTransaction`
		// so `resetSampleData` can pass its own `trx` and the full
		// delete + regenerate runs as one Postgres transaction.
		return await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			await this.getValidator(args.appId, args.caseType.name, trx);
			return await this.generateSampleDataInTransaction(trx, args);
		});
	}

	/**
	 * Generate sample rows + bulk-insert against the caller's
	 * transaction. Parent-ref resolution runs inside the same
	 * transaction so a `resetSampleData` reset reads the post-delete
	 * row population (the parent type may have been deleted in the
	 * same operation).
	 */
	private async generateSampleDataInTransaction(
		trx: Transaction<Database>,
		args: GenerateSampleDataArgs,
	): Promise<{ inserted: number }> {
		// Parent ids feed the generator's `parentRefs` so generated
		// children's `parent_case_id` resolves to real edges via the
		// bulk-insert path. When the case-type declares no parent or
		// no parents exist, the generator emits orphan rows.
		const parentRefs = await this.resolveParentRefs(trx, {
			appId: args.appId,
			caseType: args.caseType,
		});

		const rows = this.sampleGenerator.generate({
			appId: args.appId,
			caseType: args.caseType,
			count: args.count,
			seed: args.seed,
			parentRefs,
		});

		// Generated rows participate in JSON Schema validation,
		// `case_indices` derivation, and tenant scoping the same way
		// user-authored rows do; the bulk path collapses ~30
		// round-trips to ~4 per batch.
		const { caseIds } = await this.insertManyInTransaction(trx, {
			appId: args.appId,
			rows,
			parentRelationship: args.caseType.relationship ?? "child",
		});
		return { inserted: caseIds.length };
	}

	async resetSampleData(
		args: ResetSampleDataArgs,
	): Promise<{ deleted: number; inserted: number }> {
		// One Postgres transaction across the whole operation —
		// edges + rows delete, regenerate, validate, bulk-insert. A
		// mid-operation failure rolls back deletion alongside partial
		// regeneration so the user never lands on an empty case type.
		const caseTypeName = args.caseType.name;
		return await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			// Take the schema `FOR SHARE` BEFORE the row deletes below —
			// the bulk insert's hoisted validator fetch would otherwise
			// acquire it after this transaction already holds `cases` row
			// locks, inverting the advisory → schema → rows order every
			// other writer follows (a concurrent `applySchemaChange`
			// holding the schema lock while its reshape waits on the
			// deleted rows would deadlock-cycle). Also pre-warms the
			// compiled-validator cache the bulk path reuses.
			await this.getValidator(args.appId, caseTypeName, trx);
			const resetCaseIds = () =>
				trx
					.selectFrom("cases as reset_cases")
					.select("reset_cases.case_id")
					.where("reset_cases.app_id", "=", args.appId)
					.where("reset_cases.case_type", "=", caseTypeName)
					.where("reset_cases.project_id", "=", this.requireProjectId());
			const tenantCaseIds = () =>
				trx
					.selectFrom("cases as tenant_cases")
					.select("tenant_cases.case_id")
					.where("tenant_cases.app_id", "=", args.appId)
					.where("tenant_cases.project_id", "=", this.requireProjectId());

			/* Replacing a parent population cannot preserve its children's
			 * exact relationships: every referenced parent is about to receive a
			 * new id. Preserve the surviving child cases and detach them rather
			 * than cascading an unexpected delete or assigning a random new
			 * parent. `case_indices` has no FK, so remove both outgoing edges from
			 * reset rows and tenant-local incoming/derived edges to those rows
			 * before the parent rows disappear. */
			await trx
				.deleteFrom("case_indices")
				.where((eb) =>
					eb.or([
						eb("case_id", "in", resetCaseIds()),
						eb.and([
							eb("ancestor_id", "in", resetCaseIds()),
							eb("case_id", "in", tenantCaseIds()),
						]),
					]),
				)
				.execute();
			await trx
				.updateTable("cases")
				.set({ parent_case_id: null, modified_on: new Date() })
				.where("app_id", "=", args.appId)
				.where("project_id", "=", this.requireProjectId())
				.where("parent_case_id", "in", resetCaseIds())
				.execute();
			const deleteResult = await trx
				.deleteFrom("cases")
				.where("app_id", "=", args.appId)
				.where("case_type", "=", caseTypeName)
				.where("project_id", "=", this.requireProjectId())
				.executeTakeFirst();
			const deleted = Number(deleteResult.numDeletedRows ?? 0);

			const { inserted } = await this.generateSampleDataInTransaction(trx, {
				appId: args.appId,
				caseType: args.caseType,
				count: args.count,
				seed: Date.now().toString(),
			});

			return { deleted, inserted };
		});
	}

	/**
	 * Build the `parentRefs` map the generator consumes to populate
	 * `parent_case_id`. The generator picks one id per child row at
	 * random; an empty map produces orphan rows.
	 *
	 * `executor` shares the transaction with the bulk insert that
	 * consumes its output — `resetSampleData` passes its outer
	 * transaction so the read sees the post-delete row population.
	 */
	private async resolveParentRefs(
		executor: Transaction<Database>,
		args: {
			appId: string;
			caseType: CaseType;
		},
	): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
		const parentType = args.caseType.parent_type;
		if (parentType === undefined) {
			return new Map();
		}
		const parents = await executor
			.selectFrom("cases")
			.select("case_id")
			.where("app_id", "=", args.appId)
			.where("case_type", "=", parentType)
			.where("project_id", "=", this.requireProjectId())
			.execute();
		return new Map([[parentType, parents.map((p) => p.case_id)]]);
	}

	/**
	 * Dispatch to the per-row migration matching the `change` shape.
	 * Two arms: `retype(fromType, toType)` and
	 * `narrow-options(removedOptions)`. No arm removes a row — a value
	 * the new declaration cannot hold PARKS (`parked_case_values`) with
	 * its key dropped, and the row stays present and writable.
	 */
	private async runPerRowMigration(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			property: string | undefined;
			change: SchemaChangeKind;
		},
	): Promise<MigrationReport> {
		switch (args.change.kind) {
			case "retype":
				return await this.runRetypeMigrations(trx, {
					appId: args.appId,
					caseType: args.caseType,
					retypes: [
						{
							property: this.requireMigrationProperty(args.property, "retype"),
							fromType: args.change.fromType,
							toType: args.change.toType,
						},
					],
				});
			case "narrow-options":
				return await this.runNarrowOptionsMigration(trx, {
					appId: args.appId,
					caseType: args.caseType,
					property: this.requireMigrationProperty(
						args.property,
						"narrow-options",
					),
					removedOptions: args.change.removedOptions,
				});
		}
	}

	/**
	 * The `retype` / `narrow-options` arms target ONE property and
	 * require the paired `property` argument; a `rename` change
	 * carries its own targets in `renames` and never reaches this.
	 */
	private requireMigrationProperty(
		property: string | undefined,
		kind: "retype" | "narrow-options",
	): string {
		if (property !== undefined) return property;
		throw new Error(
			compilerBugMessage({
				where: "case-store.PostgresCaseStore.runPerRowMigration",
				invariant: `\`property\` is undefined for a \`${kind}\` change; that migration targets a specific property and the per-row loop reads from it`,
				detail:
					"The `ApplySchemaChangeArgs` contract pairs `property` with the `retype` / `narrow-options` change arms. Hint: pass `property` alongside the change at the call site.",
			}),
		);
	}

	/**
	 * Rewrite every row whose value for a flipped property still holds
	 * the OLD shape (Phase A step 2). The SELECT carries a
	 * `jsonb_typeof` filter per flip so only MISMATCHED rows leave
	 * Postgres — conforming and property-less rows never load into
	 * Node, bounding the scan's memory to the affected population
	 * (which also keeps the schema-row lock window short on a large
	 * case type). Final classification still runs in TypeScript,
	 * mirroring the retype arm; the writes flow through
	 * `bulkUpdateProperties` — two round-trips regardless of row
	 * count. Rows already in the target shape are untouched (no
	 * write, no `modified_on` stamp), which is also what makes a
	 * re-detection of the same transition a no-op. Both rewrite arms
	 * are TOTAL (`tryCastValue` cannot fail for them — see
	 * `detectPropertyTransitions`), so unlike the retype arms there
	 * is no park path here.
	 *
	 * App-scoped, not tenant-scoped — the same rule as every per-row
	 * migration: a schema change reshapes EVERY member's rows of the
	 * case type, so the filter is `(app_id, case_type)` only.
	 *
	 * Returns the number of rows rewritten.
	 */
	private async runShapeReshape(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			flips: readonly ShapeFlip[];
		},
	): Promise<number> {
		// `jsonb_typeof` of an ABSENT key is SQL NULL, so both arms'
		// comparisons resolve unknown and the row is filtered — matching
		// the loop's value-absent skip. JSON `null` values are likewise
		// excluded on both arms.
		const rows = await trx
			.selectFrom("cases as c")
			.select(["c.case_id", "c.properties"])
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where((eb) =>
				eb.or(
					args.flips.map((flip) =>
						flip.toType === "multi_select"
							? sql<boolean>`jsonb_typeof(c.properties->${sql.lit(flip.property)}) NOT IN ('array', 'null')`
							: sql<boolean>`jsonb_typeof(c.properties->${sql.lit(flip.property)}) = 'array'`,
					),
				),
			)
			.execute();

		const migratedRows: { caseId: string; newProperties: JsonObject }[] = [];
		for (const row of rows) {
			let next: JsonObject | undefined;
			for (const flip of args.flips) {
				const source = next ?? row.properties;
				const value = source[flip.property];
				if (value === undefined || value === null) continue;
				const conforms =
					flip.toType === "multi_select"
						? Array.isArray(value)
						: !Array.isArray(value);
				if (conforms) continue;
				if (typeof value === "string" && value.trim() === "") {
					// A blank scalar has no selection to lift — the key drops
					// (absent ≡ nothing selected, the form-completion
					// convention), keeping the flip total without minting a
					// one-empty-string selection.
					next = withoutKey(source, flip.property);
					continue;
				}
				const cast = tryCastValue(value, flip.toType);
				if (!cast.ok) continue; // unreachable — both arms are total for non-blank values
				next = { ...source, [flip.property]: cast.value as JsonValue };
			}
			if (next !== undefined) {
				migratedRows.push({ caseId: row.case_id, newProperties: next });
			}
		}

		if (migratedRows.length > 0) {
			await this.bulkUpdateProperties(trx, {
				appId: args.appId,
				rows: migratedRows,
			});
		}
		return migratedRows.length;
	}

	/**
	 * Retype: cast each row's values into their properties' new
	 * declarations — ALL entries in one row scan. A successful cast
	 * rewrites the value in place; an uncastable value PARKS: its key
	 * drops from the row (merged-document validation would reject it
	 * under the new declaration) and a `parked_case_values` entry
	 * preserves it. The row itself always stays. A JSON `null` or
	 * blank-string value drops with its key silently — nothing to
	 * keep, same rule as the rename arm.
	 *
	 * Classification runs in TypeScript because the Postgres-side cast
	 * produces a transaction-fatal exception on the first bad value,
	 * and per-value parking needs per-value failure observation. The
	 * writes then flow through bulk SQL — constant round-trips
	 * regardless of row count.
	 *
	 * Consumed by the write-time retype detection (possibly several
	 * properties in one sync) and the explicit `retype` change arm
	 * (exactly one).
	 */
	private async runRetypeMigrations(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			retypes: ReadonlyArray<DetectedRetype>;
		},
	): Promise<MigrationReport> {
		const totalRow = await trx
			.selectFrom("cases as c")
			.select((eb) => eb.fn.countAll<string>().as("total"))
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.executeTakeFirstOrThrow();
		const totalCount = Number(totalRow.total);

		// Only rows holding at least one targeted key leave Postgres —
		// `?` tests key presence, so key-less rows never load into Node.
		const rows = await trx
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where((eb) =>
				eb.or(
					args.retypes.map(
						(retype) =>
							sql<boolean>`c.properties ? ${sql.lit(retype.property)}`,
					),
				),
			)
			.execute();

		const migratedRows: { caseId: string; newProperties: JsonObject }[] = [];
		const parks: ParkEntry[] = [];
		const failureReasons: string[] = [];

		for (const row of rows) {
			let next: JsonObject | undefined;
			for (const retype of args.retypes) {
				const source = next ?? row.properties;
				if (!Object.hasOwn(source, retype.property)) continue;
				const value = source[retype.property];
				if (hasNoDataToKeep(value)) {
					next = withoutKey(source, retype.property);
					continue;
				}
				const cast = tryCastValue(value, retype.toType);
				if (cast.ok) {
					next = { ...source, [retype.property]: cast.value as JsonValue };
				} else {
					const reason = `cast ${retype.fromType}→${retype.toType} failed for property '${retype.property}': ${cast.reason}`;
					parks.push({
						caseId: row.case_id,
						caseType: row.case_type,
						property: retype.property,
						value,
						reason,
						fromType: retype.fromType,
						toType: retype.toType,
					});
					failureReasons.push(reason);
					next = withoutKey(source, retype.property);
				}
			}
			if (next !== undefined) {
				migratedRows.push({ caseId: row.case_id, newProperties: next });
			}
		}

		// `UPDATE cases SET properties = data.new_props ... FROM
		// (VALUES ...) AS data(case_id, new_props) WHERE cases.case_id
		// = data.case_id` — each row gets its own recomputed JSONB
		// from a VALUES table. A single `jsonb_set` on a fixed key
		// wouldn't work because the cast value's typed shape varies
		// across rows.
		if (migratedRows.length > 0) {
			await this.bulkUpdateProperties(trx, {
				appId: args.appId,
				rows: migratedRows,
			});
		}
		const parkedIds = await this.bulkPark(trx, args.appId, parks);

		return {
			migrated: migratedRows.length,
			reshaped: 0,
			retyped: 0,
			restored: 0,
			skipped: totalCount - rows.length,
			parkedIds,
			failureReasons,
		};
	}

	/**
	 * Narrow-options: a select value matching the removed set PARKS.
	 * A single-select's value parks whole and its key drops; a
	 * multi-select keeps its SURVIVING elements in the row (the key
	 * drops only when none survive) while the FULL original array
	 * parks — the entry preserves the exact pre-flush selection, so a
	 * restore is faithful rather than a merge puzzle. Deliberate
	 * opt-in flush: stored values outside the current options are
	 * otherwise legitimate history (see the `single_select` rationale
	 * in the JSON Schema generator). Constant round-trips.
	 */
	private async runNarrowOptionsMigration(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			property: string;
			removedOptions: string[];
		},
	): Promise<MigrationReport> {
		const removedSet = new Set(args.removedOptions);
		const rows = await trx
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.execute();

		const migratedRows: { caseId: string; newProperties: JsonObject }[] = [];
		const parks: ParkEntry[] = [];
		let skipped = 0;
		const failureReasons: string[] = [];

		for (const row of rows) {
			const propsRecord = row.properties;
			const rawValue = propsRecord[args.property];
			if (rawValue === undefined || rawValue === null) {
				skipped++;
				continue;
			}

			const conflict = findRemovedOptionConflict(rawValue, removedSet);
			if (conflict === null) {
				skipped++;
				continue;
			}

			const reason = `option '${conflict}' removed from property '${args.property}'; case ${row.case_id}'s value was set aside`;
			// Not a type change — the park's transition carries the select
			// type (read off the value's own shape) on both sides.
			const selectType = Array.isArray(rawValue)
				? ("multi_select" as const)
				: ("single_select" as const);
			parks.push({
				caseId: row.case_id,
				caseType: row.case_type,
				property: args.property,
				value: rawValue,
				reason,
				fromType: selectType,
				toType: selectType,
			});
			failureReasons.push(reason);

			const survivors = Array.isArray(rawValue)
				? rawValue.filter(
						(element) =>
							!(typeof element === "string" && removedSet.has(element)),
					)
				: [];
			migratedRows.push({
				caseId: row.case_id,
				newProperties:
					survivors.length > 0
						? { ...propsRecord, [args.property]: survivors }
						: withoutKey(propsRecord, args.property),
			});
		}

		if (migratedRows.length > 0) {
			await this.bulkUpdateProperties(trx, {
				appId: args.appId,
				rows: migratedRows,
			});
		}
		const parkedIds = await this.bulkPark(trx, args.appId, parks);

		return {
			migrated: migratedRows.length,
			reshaped: 0,
			retyped: 0,
			restored: 0,
			skipped,
			parkedIds,
			failureReasons,
		};
	}

	/**
	 * Bulk-update `properties` for the row set. Joins `cases` to a
	 * `VALUES` table mapping `case_id → new properties`. The outer
	 * WHERE pins app + owner. `modified_on = now()` stamps every row
	 * uniformly.
	 */
	private async bulkUpdateProperties(
		trx: Transaction<Database>,
		args: {
			appId: string;
			rows: ReadonlyArray<{ caseId: string; newProperties: JsonObject }>;
		},
	): Promise<void> {
		// `VALUES (...)` carries `(case_id, new_props)` pairs; each
		// pair stringifies + casts to JSONB so the SET side flows as
		// a typed JSONB value.
		const entries = args.rows.map(
			({ caseId, newProperties }) =>
				sql`(${caseId}::text, ${JSON.stringify(newProperties)}::jsonb)`,
		);
		await sql`
			UPDATE cases
			   SET properties = data.new_props,
			       modified_on = now()
			  FROM (VALUES ${sql.join(entries)}) AS data(case_id, new_props)
			 WHERE cases.case_id = data.case_id
			   AND cases.app_id = ${args.appId}
		`.execute(trx);
	}

	/**
	 * Insert park entries — one per VALUE a migration could not carry
	 * into its property's new declaration — and return their ids in
	 * entry order. The rows the values came from are NOT touched here;
	 * each caller drops the keys in its own row rewrite. `appId` is
	 * passed explicitly rather than read off `entries[0]` so the
	 * helper stays well-defined for empty inputs.
	 */
	private async bulkPark(
		trx: Transaction<Database>,
		appId: string,
		entries: ReadonlyArray<ParkEntry>,
	): Promise<string[]> {
		if (entries.length === 0) return [];
		const inserted = await trx
			.insertInto("parked_case_values")
			.values(
				entries.map((entry) => ({
					app_id: appId,
					case_id: entry.caseId,
					case_type: entry.caseType,
					property: entry.property,
					original_value: JSON.stringify(entry.value),
					reason: entry.reason,
					from_type: entry.fromType,
					to_type: entry.toType,
				})),
			)
			.returning("id")
			.execute();
		return inserted.map((row) => row.id);
	}

	/**
	 * Restore every parked value of the sync's TRANSITIONED properties
	 * whose original value conforms to the JUST-WRITTEN derived schema
	 * and whose key is free — the winning sync's closing move (Phase A
	 * step 4). Same
	 * safety rules as `unparkValues` (row exists, key free, value
	 * conforms; a blocked entry stays parked), checked against the
	 * in-memory derived schema the transaction just UPSERTed rather
	 * than a re-read of the stored row (identical bytes). The cases
	 * read locks `FOR UPDATE`, consistent with the transaction's
	 * advisory → schema → cases lock order. Returns the restore count
	 * for the report's `restored` axis.
	 */
	private async restoreConformantParked(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			schema: CaseTypeJsonSchema;
			/** Only entries of these properties are candidates — the sync's
			 *  TRANSITIONED set (see the step-4 comment for why the scope
			 *  is load-bearing). */
			properties: ReadonlySet<string>;
		},
	): Promise<number> {
		// Dismissed entries stay put: the user reviewed them and chose
		// the archive, so a later convert-back doesn't resurrect them —
		// the review surface's explicit Restore is their only way back.
		const entries = await trx
			.selectFrom("parked_case_values as p")
			.selectAll("p")
			.where("p.app_id", "=", args.appId)
			.where("p.case_type", "=", args.caseType)
			.where("p.property", "in", [...args.properties])
			.where("p.dismissed_at", "is", null)
			.execute();
		if (entries.length === 0) return 0;

		const ajv = new Ajv2020({ strict: false });
		addFormats(ajv);
		const validators = new Map<string, ValidateFunction<unknown> | null>();
		const conforms = (property: string, value: unknown): boolean => {
			let validate = validators.get(property);
			if (validate === undefined) {
				const propSchema = args.schema.properties[property];
				validate = propSchema !== undefined ? ajv.compile(propSchema) : null;
				validators.set(property, validate);
			}
			return validate !== null && validate(value) === true;
		};
		const candidates = entries.filter((entry) =>
			conforms(entry.property, entry.original_value),
		);
		if (candidates.length === 0) return 0;

		const rows = await trx
			.selectFrom("cases as c")
			.select(["c.case_id", "c.properties"])
			.where("c.app_id", "=", args.appId)
			.where(
				"c.case_id",
				"in",
				candidates.map((entry) => entry.case_id),
			)
			.forUpdate()
			.execute();
		const rowByCaseId = new Map(rows.map((row) => [row.case_id, row]));
		const nextByCaseId = new Map<string, JsonObject>();
		const restoredIds: string[] = [];
		for (const entry of candidates) {
			const row = rowByCaseId.get(entry.case_id);
			if (row === undefined) continue;
			const current = nextByCaseId.get(entry.case_id) ?? row.properties;
			if (
				Object.hasOwn(current, entry.property) &&
				current[entry.property] !== null &&
				current[entry.property] !== ""
			) {
				continue; // a real value occupies the key — the entry stays
			}
			nextByCaseId.set(entry.case_id, {
				...current,
				[entry.property]: entry.original_value,
			});
			restoredIds.push(entry.id);
		}

		if (nextByCaseId.size > 0) {
			await this.bulkUpdateProperties(trx, {
				appId: args.appId,
				rows: [...nextByCaseId.entries()].map(([caseId, newProperties]) => ({
					caseId,
					newProperties,
				})),
			});
		}
		if (restoredIds.length > 0) {
			await trx
				.deleteFrom("parked_case_values")
				.where("parked_case_values.app_id", "=", args.appId)
				.where("parked_case_values.id", "in", restoredIds)
				.execute();
		}
		return restoredIds.length;
	}

	/**
	 * Write parked values back under their keys and delete the restored
	 * entries. A restore happens ONLY when it is safe on
	 * every axis, else the entry is KEPT (lossless beats tidy; the
	 * review surface settles it):
	 *
	 *   - the row still exists, and its key holds no real concurrent
	 *     value (the cases read is `FOR UPDATE`, so a concurrent
	 *     `update()`'s merged write serializes against the restore
	 *     instead of clobbering it);
	 *   - the value CONFORMS to the property's declaration in the
	 *     CURRENTLY-STORED schema row, checked here rather than trusted from
	 *     the caller — a concurrent peer can commit a differently typed
	 *     declaration before restoration, and an unchecked restore would then
	 *     poison the row against merged-document validation, abort on
	 *     a live typed expression index, or write an orphan key the
	 *     write-time shed silently eats. An undeclared property keeps
	 *     the entry for the same reason.
	 */
	async unparkValues(args: {
		appId: string;
		ids: ReadonlyArray<string>;
	}): Promise<{ restored: number; kept: number }> {
		if (args.ids.length === 0) return { restored: 0, kept: 0 };
		return await this.db.transaction().execute(async (trx) => {
			await this.authorizeSchemaMutation(trx, args.appId);
			const entries = await trx
				.selectFrom("parked_case_values as p")
				.selectAll("p")
				.where("p.app_id", "=", args.appId)
				.where("p.id", "in", [...args.ids])
				.execute();
			// Every requested entry can have vanished with its rows (a
			// cascade from sample-data replace / case deletion) — return
			// the honest nothing-to-restore rather than compiling an
			// empty `IN ()`.
			if (entries.length === 0) {
				return { restored: 0, kept: args.ids.length };
			}
			const result = await this.restoreEntries(trx, args.appId, entries, {
				overwriteExisting: false,
			});
			// Never-overwrite caller: nothing can be displaced.
			return { restored: result.restored, kept: result.kept };
		});
	}

	/**
	 * The shared restore core `unparkValues` and `restoreParkedValues`
	 * (the review surface) both run on their
	 * ALREADY-FETCHED entries: lock the case rows `FOR UPDATE`, prove
	 * each entry safe (row exists, value conforms to the
	 * CURRENTLY-stored schema), write the safe values back grouped per
	 * row, and delete exactly the restored entries. A blocked entry is
	 * KEPT — lossless beats tidy; the review surface settles it.
	 *
	 * `overwriteExisting` splits the two callers on the one axis where
	 * they differ: the review's Put back is a HUMAN decision made
	 * against the whole record, so it writes the original over
	 * whatever the slot holds; automatic restoration never overwrites —
	 * an occupied key keeps its entry for
	 * review. An overwrite never DESTROYS: when the displaced value
	 * carries information the original doesn't already contain (it
	 * isn't equal, and isn't a multi-select subset — the narrow
	 * flush's survivors), it is archived as a NEW dismissed entry, so
	 * every value a put back displaces stays recoverable under the
	 * Dismissed filter. The hold makes an occupied slot unreachable in
	 * the normal flow, but dismissal round-trips can land real data
	 * under a parked key (dismiss releases the case → a form writes →
	 * move-back re-holds) — that data must never silently vanish.
	 */
	private async restoreEntries(
		trx: Transaction<Database>,
		appId: string,
		entries: ReadonlyArray<Selectable<ParkedCaseValuesTable>>,
		opts: { overwriteExisting: boolean },
	): Promise<{ restored: number; kept: number; displaced: number }> {
		const { classify, currentTypeOf } = await this.parkedValueFitClassifier(
			trx,
			appId,
			new Set(entries.map((entry) => entry.case_type)),
		);
		const rows = await trx
			.selectFrom("cases as c")
			.select(["c.case_id", "c.properties"])
			.where("c.app_id", "=", appId)
			.where(
				"c.case_id",
				"in",
				entries.map((entry) => entry.case_id),
			)
			.forUpdate()
			.execute();
		const rowByCaseId = new Map(rows.map((row) => [row.case_id, row]));

		// Group per row so several restored properties on one case
		// compose into a single rewrite.
		const nextByCaseId = new Map<string, JsonObject>();
		const restoredIds: string[] = [];
		const displaced: Array<{
			caseId: string;
			caseType: string;
			property: string;
			value: JsonValue;
		}> = [];
		let kept = 0;
		for (const entry of entries) {
			const row = rowByCaseId.get(entry.case_id);
			if (row === undefined) {
				// The row vanished (cascade would have removed the entry
				// with it inside one transaction, but the id list can span
				// operations) — nothing to restore into.
				kept++;
				continue;
			}
			const current = nextByCaseId.get(entry.case_id) ?? row.properties;
			const occupant = Object.hasOwn(current, entry.property)
				? current[entry.property]
				: undefined;
			const occupied =
				occupant !== undefined && occupant !== null && occupant !== "";
			if (!opts.overwriteExisting && occupied) {
				// Automatic caller + a real value under the key: keep the
				// entry rather than clobber without a human decision.
				kept++;
				continue;
			}
			if (
				classify(entry.case_type, entry.property, entry.original_value) !==
				"fits"
			) {
				kept++;
				continue;
			}
			if (occupied && !occupantRedundant(occupant, entry.original_value)) {
				displaced.push({
					caseId: entry.case_id,
					caseType: entry.case_type,
					property: entry.property,
					value: occupant as JsonValue,
				});
			}
			nextByCaseId.set(entry.case_id, {
				...current,
				[entry.property]: entry.original_value,
			});
			restoredIds.push(entry.id);
		}

		if (nextByCaseId.size > 0) {
			await this.bulkUpdateProperties(trx, {
				appId,
				rows: [...nextByCaseId.entries()].map(([caseId, newProperties]) => ({
					caseId,
					newProperties,
				})),
			});
		}
		if (restoredIds.length > 0) {
			await trx
				.deleteFrom("parked_case_values")
				.where("parked_case_values.app_id", "=", appId)
				.where("parked_case_values.id", "in", restoredIds)
				.execute();
		}
		if (displaced.length > 0) {
			// The displaced values land ARCHIVED (dismissed at birth):
			// recoverable under the Dismissed filter, but holding nothing
			// — the user just resolved this case, and a fresh active
			// entry would silently re-hold it. Both type slots carry the
			// property's CURRENT declared type (the displaced value lived
			// under it) — there is no transition, only a displacement.
			await trx
				.insertInto("parked_case_values")
				.values(
					displaced.map((d) => ({
						app_id: appId,
						case_id: d.caseId,
						case_type: d.caseType,
						property: d.property,
						original_value: JSON.stringify(d.value),
						reason: `displaced when the reviewed value was put back under '${d.property}'`,
						from_type: currentTypeOf(d.caseType, d.property) ?? "text",
						to_type: currentTypeOf(d.caseType, d.property) ?? "text",
						dismissed_at: new Date(),
					})),
				)
				.execute();
		}
		return { restored: restoredIds.length, kept, displaced: displaced.length };
	}

	async listParkedValues(args: {
		appId: string;
		caseType: string;
	}): Promise<ParkedValueEntry[]> {
		const projectId = this.requireProjectId();
		// REPEATABLE READ so the two statements — the entry list and the
		// schema read the standings are computed against — see one
		// snapshot (default READ COMMITTED snapshots per statement); the
		// write paths re-prove every verdict anyway, so this only keeps
		// the listing self-consistent. The `cases` join is the tenant
		// gate — an entry is only as visible as its row. No occupancy
		// read: an active entry HOLDS its case out of the running app,
		// so nothing can land a newer value in the parked slot.
		return await this.db
			.transaction()
			.setIsolationLevel("repeatable read")
			.execute(async (trx) => {
				const rows = await trx
					.selectFrom("parked_case_values as p")
					.innerJoin("cases as c", "c.case_id", "p.case_id")
					.selectAll("p")
					.select("c.case_name")
					.where("p.app_id", "=", args.appId)
					.where("p.case_type", "=", args.caseType)
					.where("c.project_id", "=", projectId)
					.orderBy("p.created_at", "desc")
					.orderBy("p.id", "desc")
					.execute();
				if (rows.length === 0) return [];
				const { classify } = await this.parkedValueFitClassifier(
					trx,
					args.appId,
					new Set(rows.map((row) => row.case_type)),
				);
				// `from_type`/`to_type` were written from typed tokens by
				// `bulkPark` — the only writer — so the read-side narrowing
				// trusts the column the same way `original_value` trusts
				// its jsonb shape.
				return rows.map((row) => ({
					id: row.id,
					caseId: row.case_id,
					caseName: row.case_name,
					caseType: row.case_type,
					property: row.property,
					originalValue: row.original_value,
					reason: row.reason,
					fromType: row.from_type as CasePropertyDataType,
					toType: row.to_type as CasePropertyDataType,
					createdAt: row.created_at,
					dismissedAt: row.dismissed_at,
					standing: classify(row.case_type, row.property, row.original_value),
				}));
			});
	}

	async restoreParkedValues(args: {
		appId: string;
		ids: ReadonlyArray<string>;
	}): Promise<{ restored: number; kept: number; displaced: number }> {
		const projectId = this.requireProjectId();
		if (args.ids.length === 0) return { restored: 0, kept: 0, displaced: 0 };
		return await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			// The `cases` join is the tenant gate; an id it filters out
			// (vanished row, foreign Project) counts as `kept`, exactly
			// like every other blocked entry — never touched, never
			// distinguished (the boundary stays structural).
			const entries = await trx
				.selectFrom("parked_case_values as p")
				.innerJoin("cases as c", "c.case_id", "p.case_id")
				.selectAll("p")
				.where("p.app_id", "=", args.appId)
				.where("p.id", "in", [...args.ids])
				// A DISMISSED entry has no direct way back to the case: its
				// case may be live again and its slot may hold a peer's
				// replacement, so a stale client's Put back must fall to
				// `kept` (the refreshed list explains), never overwrite.
				// Move back to review first — that re-holds the case and
				// re-offers Put back against fresh standings.
				.where("p.dismissed_at", "is", null)
				.where("c.project_id", "=", projectId)
				.execute();
			if (entries.length === 0) {
				return { restored: 0, kept: args.ids.length, displaced: 0 };
			}
			const result = await this.restoreEntries(trx, args.appId, entries, {
				overwriteExisting: true,
			});
			return {
				restored: result.restored,
				kept: result.kept + (args.ids.length - entries.length),
				displaced: result.displaced,
			};
		});
	}

	async setParkedValuesDismissed(args: {
		appId: string;
		ids: ReadonlyArray<string>;
		dismissed: boolean;
	}): Promise<number> {
		const projectId = this.requireProjectId();
		if (args.ids.length === 0) return 0;
		return await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			const entries = await trx
				.selectFrom("parked_case_values as p")
				.innerJoin("cases as c", "c.case_id", "p.case_id")
				.select("c.case_type")
				.where("p.app_id", "=", args.appId)
				.where("p.id", "in", [...args.ids])
				.where("c.project_id", "=", projectId)
				.execute();
			if (entries.length === 0) return 0;
			await this.lockValidators(
				trx,
				args.appId,
				entries.map((entry) => entry.case_type),
			);
			const result = await trx
				.updateTable("parked_case_values as p")
				.set({ dismissed_at: args.dismissed ? new Date() : null })
				.where("p.app_id", "=", args.appId)
				.where("p.id", "in", [...args.ids])
				.where(({ exists, selectFrom }) =>
					exists(
						selectFrom("cases as c")
							.select("c.case_id")
							.whereRef("c.case_id", "=", "p.case_id")
							.where("c.project_id", "=", projectId),
					),
				)
				.executeTakeFirst();
			return Number(result.numUpdatedRows);
		});
	}

	async replaceParkedValue(args: {
		appId: string;
		id: string;
		value: JsonValue;
	}): Promise<void> {
		const projectId = this.requireProjectId();
		await this.db.transaction().execute(async (trx) => {
			await this.authorizeMutation(trx, args.appId);
			await this.lockRelationshipWrites(trx, args.appId);
			const discovered = await trx
				.selectFrom("parked_case_values as p")
				.innerJoin("cases as c", "c.case_id", "p.case_id")
				.select(["p.case_id", "c.case_type"])
				.where("p.app_id", "=", args.appId)
				.where("p.id", "=", args.id)
				.where("c.project_id", "=", projectId)
				.executeTakeFirst();
			if (discovered === undefined) {
				throw new ParkedValueNotFoundError(args.id);
			}
			await this.getValidator(args.appId, discovered.case_type, trx);
			const entry = await trx
				.selectFrom("parked_case_values as p")
				.innerJoin("cases as c", "c.case_id", "p.case_id")
				.select(["p.id", "p.case_id", "p.property", "c.case_type"])
				.where("p.app_id", "=", args.appId)
				.where("p.id", "=", args.id)
				.where("c.project_id", "=", projectId)
				.forUpdate("p")
				.executeTakeFirst();
			if (
				entry === undefined ||
				entry.case_type !== discovered.case_type ||
				entry.case_id !== discovered.case_id
			) {
				throw new ParkedValueNotFoundError(args.id);
			}
			await this.updateInTransaction(trx, {
				appId: args.appId,
				caseId: entry.case_id,
				patch: { properties: { [entry.property]: args.value } },
			});
			await trx
				.updateTable("parked_case_values")
				.set({ dismissed_at: new Date() })
				.where("id", "=", entry.id)
				.execute();
		});
	}

	/**
	 * Build the per-`(caseType, property)` fit classifier both restores
	 * and the review listing read: it loads the involved types'
	 * CURRENTLY-STORED schema rows inside the caller's transaction and
	 * strictly decodes their canonical Nova shape before compiling a
	 * per-property ajv validator on demand. `"fits"` is the only arm a
	 * restore proceeds on; `"undeclared"` covers only a property the
	 * canonical schema no longer declares or an absent schema row;
	 * malformed stored bytes throw rather than becoming a second format;
	 * `"blocked"` is a live declaration rejecting the value.
	 */
	private async parkedValueFitClassifier(
		trx: Transaction<Database>,
		appId: string,
		caseTypes: ReadonlySet<string>,
	): Promise<{
		classify: (
			caseType: string,
			property: string,
			value: unknown,
		) => "fits" | "blocked" | "undeclared";
		/** The CURRENT declared type token for a property, from the same
		 *  stored schema the classifier validates against — `undefined`
		 *  only for an undeclared property or absent schema row. */
		currentTypeOf: (
			caseType: string,
			property: string,
		) => CasePropertyDataType | undefined;
	}> {
		const schemaRows = await trx
			.selectFrom("case_type_schemas")
			.select(["case_type", "schema"])
			.where("app_id", "=", appId)
			.where("case_type", "in", [...caseTypes].sort())
			.where("is_active", "=", true)
			.orderBy("case_type")
			.forShare()
			.execute();
		const schemasByType = new Map<string, DecodedStoredCaseSchema>();
		for (const row of schemaRows) {
			schemasByType.set(
				row.case_type,
				decodeStoredCaseSchema(appId, row.case_type, row.schema),
			);
		}
		const ajv = new Ajv2020({ strict: false });
		addFormats(ajv);
		const cache = new Map<string, ValidateFunction<unknown> | null>();
		return {
			classify: (caseType, property, value) => {
				const key = `${caseType}\u0000${property}`;
				let validate = cache.get(key);
				if (validate === undefined) {
					const propSchema =
						schemasByType.get(caseType)?.schema.properties[property];
					validate = propSchema === undefined ? null : ajv.compile(propSchema);
					cache.set(key, validate);
				}
				if (validate === null) return "undeclared";
				return validate(value) === true ? "fits" : "blocked";
			},
			currentTypeOf: (caseType, property) =>
				schemasByType.get(caseType)?.dataTypes.get(property),
		};
	}

	/**
	 * Validate a candidate `properties` payload against the case
	 * type's JSON Schema. Throws on failure; returns on success.
	 *
	 * `executor` is the caller's WRITING transaction — required, not
	 * optional, for two structural reasons: the schema read's
	 * `FOR SHARE` must hold until the write commits (the write-vs-sync
	 * serialization contract on `getValidator`), and a `pg.Pool` with
	 * `max: 1` (the per-test harness's size) deadlocks if the read
	 * runs off-transaction while the pool's only connection is held
	 * by the in-flight transaction.
	 */
	private async validateProperties(args: {
		appId: string;
		caseType: string;
		properties: Record<string, unknown>;
		executor: Transaction<Database>;
	}): Promise<void> {
		const validator = await this.getValidator(
			args.appId,
			args.caseType,
			args.executor,
		);
		this.assertValidProperties(validator, args);
	}

	/**
	 * Run an already-fetched validator over a candidate document and
	 * project AJV's errors onto `CasePropertyFailure` so API routes
	 * get one consistent shape across per-row and bulk paths —
	 * `ajvErrorToCaseFailure` names the offending key on an
	 * `additionalProperties` failure (AJV's default message doesn't).
	 */
	private assertValidProperties(
		validator: ValidatorCacheEntry,
		args: {
			appId: string;
			caseType: string;
			properties: Record<string, unknown>;
		},
	): void {
		const ok = validator.validate(args.properties);
		if (!ok) {
			const failures = (validator.validate.errors ?? []).map(
				ajvErrorToCaseFailure,
			);
			throw new CasePropertiesValidationError(
				args.appId,
				args.caseType,
				failures,
			);
		}
	}

	/**
	 * Read the case-type JSON Schema and return a compiled ajv
	 * validator. Caches per `(appId, caseType, schemaJson)` — a
	 * schema row update automatically invalidates the cache because
	 * the JSON-stringified content changes.
	 *
	 * The read takes `FOR SHARE` on the schema row, held to the end
	 * of the caller's WRITING transaction — the writer half of the
	 * write-vs-sync serialization contract. `applySchemaChange` takes
	 * the same row `FOR UPDATE` before its Phase-A reshape, so a row
	 * write and a schema flip order strictly: a write that validated
	 * against the OLD schema commits before the sync's reshape scan
	 * runs (the scan sees its row), and a write that starts after the
	 * sync holds the lock validates against the NEW schema. Without
	 * the lock, a scalar row validated against the old schema could
	 * commit after the reshape's scan — permanently stranded under
	 * the flipped schema, with detection never firing again.
	 *
	 * Lock-ordering rule (deadlock-freedom): every transaction that
	 * takes both acquires the relationship advisory lock
	 * (`lockRelationshipWrites`) BEFORE this schema lock, and both
	 * before any `cases` row locks. The executor is therefore
	 * REQUIRED to be the caller's transaction — on a bare connection
	 * the lock would release at statement end and the contract above
	 * silently would not hold.
	 *
	 * Throws `SchemaNotSyncedError` when no schema row exists; the
	 * blueprint mutator must run `applySchemaChange` first so the
	 * row is materialized before any write reaches this validator.
	 */
	private async getValidator(
		appId: string,
		caseType: string,
		executor: Transaction<Database>,
	): Promise<ValidatorCacheEntry> {
		const row = await executor
			.selectFrom("case_type_schemas")
			.select("schema")
			.where("app_id", "=", appId)
			.where("case_type", "=", caseType)
			.where("is_active", "=", true)
			.forShare()
			.executeTakeFirst();
		if (row === undefined) {
			throw new SchemaNotSyncedError(appId, caseType);
		}

		const schemaJson = JSON.stringify(row.schema);
		const cacheKey = `${appId}::${caseType}`;
		const cached = this.validatorCache.get(cacheKey);
		if (cached !== undefined && cached.schemaJson === schemaJson) {
			return cached;
		}

		const decoded = decodeStoredCaseSchema(appId, caseType, row.schema);
		const validate = this.ajv.compile(decoded.schema);
		const entry: ValidatorCacheEntry = {
			schemaJson,
			validate,
			declared: new Set(decoded.dataTypes.keys()),
		};
		this.validatorCache.set(cacheKey, entry);
		return entry;
	}

	/** Centralized factory so schema-map + bindings defaults stay aligned across every predicate-compile site. */
	private buildPredicateContext(args: {
		db: Kysely<Database>;
		appId: string;
		caseType: string;
		schemas: ReadonlyMap<string, CaseType>;
		lookupTableSchemas?: PredicateCompileContext["lookupTableSchemas"];
		bindings: PredicateCompileContext["bindings"];
		/** Bound only by a read standing at a device — see `RestoreScope`. */
		restore?: RestoreScopeQuery;
	}): PredicateCompileContext {
		return {
			db: args.db,
			appId: args.appId,
			projectId: this.requireProjectId(),
			anchorAlias: "c",
			currentCaseType: args.caseType,
			caseTypeSchemas: args.schemas,
			...(args.lookupTableSchemas === undefined
				? {}
				: { lookupTableSchemas: args.lookupTableSchemas }),
			...(args.restore === undefined
				? {}
				: { restrictToRestoreScope: args.restore.restrict }),
			bindings: args.bindings,
		};
	}

	/**
	 * Compile one worker's restore closure, or nothing when the caller did not
	 * ask for one. Absent is the whole tenant — see `RestoreScope`.
	 */
	private buildRestoreScopeFor(
		appId: string,
		scope: RestoreScope | undefined,
	): RestoreScopeQuery | undefined {
		return scope === undefined
			? undefined
			: buildRestoreScope(this.db, {
					appId,
					projectId: this.requireProjectId(),
					ownerIds: scope.ownerIds,
				});
	}

	/**
	 * Re-derive the parent edge in `case_indices` after an UPDATE
	 * that changed `parent_case_id`. Direct edges only — recursive
	 * walks compose at read time via `compileRelationPath`.
	 *
	 * The DELETE is broad — every `'parent'` edge for the case —
	 * so leftover edges from any prior shape don't accumulate. The
	 * INSERT skips when `newParent` is null (clearing the edge). A non-null
	 * assignment requires its authoritative relationship explicitly; preserving
	 * the prior row would retain historical mistakes, while consulting the case
	 * catalog would corrupt deliberately authored advanced-operation links.
	 */
	private async rebuildParentEdge(
		trx: Transaction<Database>,
		args:
			| {
					readonly caseId: string;
					readonly newParent: string;
					readonly relationship: CaseIndicesTable["relationship"];
			  }
			| {
					readonly caseId: string;
					readonly newParent: null;
			  },
	): Promise<void> {
		await trx
			.deleteFrom("case_indices")
			.where("case_indices.case_id", "=", args.caseId)
			.where("case_indices.identifier", "=", "parent")
			.execute();
		if (args.newParent !== null) {
			const edge: Insertable<CaseIndicesTable> = {
				case_id: args.caseId,
				ancestor_id: args.newParent,
				identifier: "parent",
				relationship: args.relationship,
				depth: 1,
			};
			await trx.insertInto("case_indices").values(edge).execute();
		}
	}
}

/**
 * Every case type a submission names up front, for the envelope's
 * sorted schema-lock acquisition: the registration primary + children,
 * the followup/close children (and the declared module type when
 * supplied), and each operation's declared type, retype target, and
 * link target types. The followup/close BOUND case's type is
 * deliberately absent — it is discovered inside the update core, which
 * acquires its own schema lock, the same pattern `update` uses.
 */
function submissionCaseTypes(args: ApplySubmissionArgs): string[] {
	const types = new Set<string>();
	const ordinary = args.ordinary;
	if (ordinary.kind === "registration") {
		types.add(ordinary.primary.caseType);
		for (const child of ordinary.children) types.add(child.caseType);
	} else if (ordinary.kind === "followup" || ordinary.kind === "close") {
		if (ordinary.caseType !== undefined) types.add(ordinary.caseType);
		for (const child of ordinary.children) types.add(child.caseType);
	}
	for (const entry of args.operations?.operations ?? []) {
		types.add(entry.operation.caseType);
		if (entry.operation.retype !== undefined) {
			types.add(entry.operation.retype);
		}
		for (const link of entry.operation.links ?? []) {
			types.add(link.targetType);
		}
	}
	return [...types];
}

/**
 * Strip the bound-tenant `project_id` off a raw `cases` row. It is the
 * tenant scoping key the store filters on, NOT part of the `CaseRow`
 * contract (`Omit<Selectable<CasesTable>, "project_id">`), and must
 * never reach a consumer or cross the wire. Destructured (not deleted
 * after a spread) so the result keeps a fast V8 hidden class. EVERY
 * `selectAll("c")` read path routes its rows through this — `query` and
 * `traverse`'s self arm; the explicit-projection paths (`traverse`'s
 * relation-walk arms, `compileRelationPath`'s leaf builders) already omit
 * `project_id` by listing columns.
 */
function stripTenantKey<T extends object>(row: T): Omit<T, "project_id"> {
	const { project_id: _omit, ...rest } = row as T & { project_id?: unknown };
	return rest as Omit<T, "project_id">;
}

/**
 * The creation-time stamps every INSERT carries unless the caller supplied
 * its own values: `opened_on` and `modified_on` both default to the insert's
 * server time. This mirrors CommCare's own case lifecycle — a device sets
 * `date_opened` AND `last_modified` the moment a case is created
 * (`commcare-core .../cases/model/Case.java` constructor), and the casedb
 * exposes both locally with no sync involved — so the standard-name projections
 * (`date_opened` → `opened_on`, `last_modified` → `modified_on`) resolve to
 * real values on a freshly registered case, exactly as they would on a
 * device. `update`/`close` keep re-stamping `modified_on` on every write.
 * `?? sql\`now()\`` (not spread-if-present) so an explicit caller value —
 * a future importer carrying device timestamps — always wins.
 */
function creationStamps(
	row: CaseInsert,
): Pick<InsertObject<Database, "cases">, "opened_on" | "modified_on"> {
	return {
		opened_on: row.opened_on ?? sql<Date>`now()`,
		modified_on: row.modified_on ?? sql<Date>`now()`,
	};
}

/**
 * Normalize a writable case-row scalar exactly as CommCare Core does before
 * any Postgres write. Java/JavaScript string length is UTF-16 code units.
 */
function normalizedCaseScalar(
	property: "case_name" | "external_id",
	value: string,
	blank: "allow" | "reject",
): string {
	const prepared = prepareCaseScalarTextValue(value, blank);
	if (prepared.ok) return prepared.value;
	throw new Error(
		`Case scalar "${property}" is ${prepared.reason === "blank" ? "blank after boundary U+0000..U+0020 code units are removed" : "longer than 255 UTF-16 code units"}.`,
	);
}

/**
 * Parse a JSONB write-side input into a JS object. Kysely's
 * `JSONColumnType` accepts a JSON string on insert; helpers need
 * to cope with either form. Typical callers pass a string; tests
 * and the `update` merge path pass an object — both converge here.
 */
function parseJsonbInput(value: unknown): Record<string, unknown> {
	if (value === null || value === undefined) {
		return {};
	}
	if (typeof value === "string") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch (err) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.parseJsonbInput",
					invariant:
						"input string is not parseable JSON, but every CaseStore caller stringifies through `JSON.stringify` before passing the payload here",
					detail: `Underlying parser message: ${err instanceof Error ? err.message : String(err)}\n\nHint: trace the caller's stringify path, a serializer that produces non-JSON text (a stray sentinel, a non-stringifiable type) is the structural cause.`,
				}),
			);
		}
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, unknown>;
		}
		throw new Error(
			compilerBugMessage({
				where: "case-store.parseJsonbInput",
				invariant:
					"input string parses as JSON but the parsed value is not a JSON object",
				detail: `Got: ${JSON.stringify(parsed)}\n\nThe \`cases.properties\` column stores a JSONB object; primitives, arrays, and \`null\` at the document root are not admissible. Hint: confirm the caller's stringify path produces an object literal.`,
			}),
		);
	}
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	throw new Error(
		compilerBugMessage({
			where: "case-store.parseJsonbInput",
			invariant: `unexpected JSONB input shape \`${typeof value}\`; the type contract admits only \`JsonObject | string | null | undefined\``,
			detail:
				"Hint: the `CaseInsert.properties` / `CaseUpdate.properties` slot widens to `JsonObject | string | undefined`; reaching this throw means a runtime value bypassed the type system (e.g., an array or a primitive at the JSONB document root).",
		}),
	);
}

/**
 * One property whose stored value shape must flip to match a
 * newly-derived schema. `toType` names the `tryCastValue` arm that
 * performs the TOTAL rewrite: `multi_select` lifts a scalar into a
 * one-element string array; `single_select` space-joins an array (the
 * XForms convention — the same total rewrite for any unconstrained
 * string target).
 */
interface ShapeFlip {
	property: string;
	toType: "multi_select" | "single_select";
}

/**
 * One property whose stored values must CAST into a differently-typed
 * declaration (the write-time retype detection). `fromType` is the
 * stored schema's data-type reading (drives the stale-index pre-drop
 * and the park reason); `toType` drives `tryCastValue`.
 */
interface DetectedRetype {
	property: string;
	fromType: CasePropertyDataType;
	toType: CasePropertyDataType;
}

/** The two per-property migration families a schema diff can name. */
interface PropertyTransitions {
	flips: ShapeFlip[];
	retypes: DetectedRetype[];
	/**
	 * Properties whose declared type CHANGED but whose stored values all
	 * already conform (`castIsIdentityWidening`) — no row rewrite runs,
	 * yet the type change must still scope the winning sync's parked-
	 * value restore: a date→text convert-back is exactly as much a
	 * "convert the property back and the values return" transition as
	 * the int→text one that rewrites rows. Carries the transition pair
	 * (same shape as a retype) because the int→decimal widening must
	 * ALSO pre-drop the stale `::integer` expression index — the
	 * restore writes fractions back inside Phase A, before Phase B can
	 * swap the index.
	 */
	widenings: DetectedRetype[];
}

/**
 * Whether an occupying value carries nothing the restored original
 * doesn't already contain — equal values, or a multi-select occupant
 * that is a subset of the original's selections (the narrow-options
 * flush keeps SURVIVORS on the row, and survivors ⊆ original by
 * construction). A redundant occupant is overwritten without an
 * archive entry; anything else a put back displaces gets one.
 */
function occupantRedundant(occupant: unknown, original: unknown): boolean {
	if (JSON.stringify(occupant) === JSON.stringify(original)) return true;
	return (
		Array.isArray(occupant) &&
		Array.isArray(original) &&
		occupant.every((element) => original.includes(element))
	);
}

/**
 * A transition every stored value ALREADY satisfies — the destination
 * schema is a superset of the source's, so rows need no rewrite and
 * detection skips it: every temporal/geopoint value is a plain string,
 * and every int4 integer is a number.
 */
function castIsIdentityWidening(
	fromType: CasePropertyDataType,
	toType: CasePropertyDataType,
): boolean {
	if (toType === "text") {
		return (
			fromType === "date" ||
			fromType === "time" ||
			fromType === "datetime" ||
			fromType === "geopoint" ||
			// text ⇄ single_select differ only by the generator's annotation
			// keyword — both are UNCONSTRAINED strings, so every stored
			// value already conforms in either direction and a rewrite
			// would only churn `modified_on`.
			fromType === "single_select"
		);
	}
	if (toType === "single_select") {
		// A select's validation shape is an unconstrained string (no
		// enum), so every string-shaped source already conforms — the
		// same set the `text` target accepts.
		return (
			fromType === "text" ||
			fromType === "date" ||
			fromType === "time" ||
			fromType === "datetime" ||
			fromType === "geopoint"
		);
	}
	return fromType === "int" && toType === "decimal";
}

/**
 * Diff the stored schema document against the newly-derived one and
 * classify every same-name property whose validation semantics
 * changed into one of two migration families:
 *
 *   - `flips` — the TOTAL string↔array rewrites (the select
 *     single↔multi conversion as the case store sees it): a stored
 *     string lifts to a one-element array; a stored array space-joins
 *     into an UNCONSTRAINED string target (the XForms convention). No
 *     value can fail these.
 *   - `retypes` — every other semantic change (a `format` keyword
 *     appearing or changing, string→integer, array→date, …): each
 *     row's value attempts `tryCastValue` into the new type and PARKS
 *     when no faithful cast exists. An array target from a NUMERIC
 *     source lands here rather than in `flips` because its rewrite
 *     must first drop the source's live `::integer`/`::numeric`
 *     expression index (`dropStaleNumericIndexes`) — writing an array
 *     through that cast would abort Phase A.
 *
 * Identity WIDENINGS (temporal/geopoint→text, int→decimal,
 * text⇄single_select) are skipped — every stored value already
 * satisfies the destination schema, so a rewrite would only churn
 * `modified_on`. `text` and `single_select` share one VALIDATION
 * shape but distinct tokens (the generator's `x-novaDataType`
 * annotation, required by the canonical decoder), so a select's park
 * records its authored type while flips between the two still
 * migrate nothing.
 *
 * The stored schema has already passed the exact canonical decoder; malformed
 * or pre-cutover shapes throw before classification. `exclude` names the
 * property a caller-intent `retype` /
 * `narrow-options` migration already owns in the same call, so its
 * rows aren't rewritten twice. Matching is same-name only: a rename
 * is indistinguishable from remove+add at this layer and never
 * reports (the rename arm owns its keys — including casting values
 * INTO its destinations — while a merge-rename destination's
 * OWN-population type change still surfaces here as a retype, which
 * runs before the rename arm and composes with its conflict rule). An absent
 * schema row alone yields no transitions because there is no prior population
 * contract to migrate.
 */
function detectPropertyTransitions(
	stored: DecodedStoredCaseSchema | undefined,
	next: CaseType,
	exclude: string | undefined,
): PropertyTransitions {
	const none: PropertyTransitions = { flips: [], retypes: [], widenings: [] };
	if (stored === undefined) return none;

	const flips: ShapeFlip[] = [];
	const retypes: DetectedRetype[] = [];
	const widenings: DetectedRetype[] = [];
	for (const nextProperty of next.properties) {
		const name = nextProperty.name;
		if (CASE_SCALAR_PROPERTY_NAMES.has(name)) continue;
		if (name === exclude) continue;
		const fromType = stored.dataTypes.get(name);
		if (fromType === undefined) continue;
		const toType = nextProperty.data_type ?? "text";
		if (fromType === toType) continue;
		if (castIsIdentityWidening(fromType, toType)) {
			widenings.push({ property: name, fromType, toType });
			continue;
		}
		const fromIsString =
			fromType !== "int" &&
			fromType !== "decimal" &&
			fromType !== "multi_select";
		if (toType === "multi_select" && fromIsString) {
			flips.push({ property: name, toType: "multi_select" });
		} else if (
			fromType === "multi_select" &&
			(toType === "text" || toType === "single_select")
		) {
			flips.push({ property: name, toType: "single_select" });
		} else {
			retypes.push({ property: name, fromType, toType });
		}
	}
	return { flips, retypes, widenings };
}

/** Cast result for a per-row migration's cast attempt. */
type CastResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** One value a migration could not carry — becomes a `parked_case_values` row. */
interface ParkEntry {
	caseId: string;
	caseType: string;
	property: string;
	value: JsonValue;
	reason: string;
	/**
	 * The transition the park happened under, captured here because
	 * nothing else records the FROM side once the schema has moved on.
	 * A narrow-options park carries its select type on both sides.
	 */
	fromType: CasePropertyDataType;
	toType: CasePropertyDataType;
}

/** A shallow copy of `source` without `key` — the row-side half of a park/drop. */
function withoutKey(source: JsonObject, key: string): JsonObject {
	const { [key]: _dropped, ...rest } = source;
	return rest;
}

/** How many uncastable values `conversionImpact` returns as samples —
 *  enough for a consent surface to show what would be set aside
 *  without shipping the whole failing population. */
const CONVERSION_IMPACT_SAMPLE_CAP = 3;

/**
 * A value with nothing worth keeping through a migration: JSON
 * `null`, a blank string, or an EMPTY selection array (a cleared
 * multi-select). Such a key drops silently — parking it would fill
 * the review surface (and the couldn't-convert toast count) with
 * valueless entries.
 */
function hasNoDataToKeep(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		(typeof value === "string" && value.trim() === "") ||
		(Array.isArray(value) && value.length === 0)
	);
}

/**
 * Per-data-type conformance validators for cast outputs, compiled
 * once from the SAME `schemaForDataType` shapes the row validator
 * embeds. `tryCastValue`'s contract is that an `ok` value ALWAYS
 * validates under the destination property's schema, and delegating
 * the final check to ajv makes that structural — a keyword added to
 * the schema generator tightens the casts automatically instead of
 * drifting (the pre-conformance datetime arm accepted values the
 * `format: "date-time"` keyword then rejected on the row's next
 * write).
 */
const castConformance = (() => {
	const ajv = new Ajv2020({ strict: false });
	addFormats(ajv);
	const cache = new Map<CasePropertyDataType, ValidateFunction<unknown>>();
	return (dataType: CasePropertyDataType): ValidateFunction<unknown> => {
		let validate = cache.get(dataType);
		if (validate === undefined) {
			validate = ajv.compile(schemaForDataType(dataType));
			cache.set(dataType, validate);
		}
		return validate;
	};
})();

/**
 * Try to cast a stored value to a new property data type during a
 * per-row migration (the write-time retype detection, the explicit
 * `retype` arm, and the rename arm's destination cast). Failure
 * `reason`s flow into `parked_case_values.reason` and the report's
 * `failureReasons`. Exhaustive over `CasePropertyDataType`.
 *
 * Two-stage: NORMALIZE into the type's canonical shape, then PROVE
 * conformance against `schemaForDataType` via ajv — `ok` therefore
 * guarantees the value survives the row's next merged-document
 * validation. The temporal truncation/extension arms lean on a
 * stored-data invariant: every write validates against the
 * then-stored schema, so a stored temporal value is schema-canonical
 * for its stored type (a datetime always looks like
 * `YYYY-MM-DDTHH:MM:SS[.sss]Z|±hh:mm`).
 */
function tryCastValue(
	value: unknown,
	toType: CasePropertyDataType,
): CastResult {
	const candidate = normalizeValueForType(value, toType);
	if (!candidate.ok) return candidate;
	if (!castConformance(toType)(candidate.value)) {
		return {
			ok: false,
			reason: `value ${JSON.stringify(value)} normalized to ${JSON.stringify(candidate.value)}, which the \`${toType}\` schema still rejects`,
		};
	}
	return candidate;
}

/**
 * The normalization half of `tryCastValue`: produce the destination
 * type's canonical shape where a faithful transformation exists, or
 * fail with the reason there is none. Deliberately does NOT prove
 * conformance — `tryCastValue` runs the ajv check over every `ok`
 * result, so garbage that merely LOOKS shaped (a `2026-13-40` date)
 * still fails, with the schema as the single authority.
 */
function normalizeValueForType(
	value: unknown,
	toType: CasePropertyDataType,
): CastResult {
	// A multi-select value is a JSONB array of selected option values; its
	// string projection is the XForms wire convention — space-separated —
	// not JS's default comma join. Every string-target arm below reads this.
	const stringValue = Array.isArray(value)
		? value.join(" ")
		: typeof value === "string"
			? value
			: String(value);

	switch (toType) {
		case "text":
		case "single_select":
			return { ok: true, value: stringValue };
		case "geopoint":
			return { ok: true, value: stringValue.trim() };
		case "int": {
			const trimmed = stringValue.trim();
			if (!/^-?\d+$/.test(trimmed)) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(stringValue)} is not a whole number`,
				};
			}
			// int4 range enforcement is the conformance check's job —
			// `schemaForDataType` bounds the integer schema to int4.
			return { ok: true, value: Number.parseInt(trimmed, 10) };
		}
		case "decimal": {
			const trimmed = stringValue.trim();
			const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
			if (!Number.isFinite(parsed)) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(stringValue)} is not a number`,
				};
			}
			return { ok: true, value: parsed };
		}
		case "date": {
			// A canonical datetime truncates to its calendar date — the
			// date part IS what a datetime→date conversion asks to keep.
			const trimmed = stringValue.trim();
			return {
				ok: true,
				value: /^\d{4}-\d{2}-\d{2}T/.test(trimmed)
					? trimmed.slice(0, 10)
					: trimmed,
			};
		}
		case "time": {
			// A canonical datetime truncates to its time-of-day (an
			// explicit offset survives the cut); a bare time takes the
			// storage tag the strict `format: "time"` schema requires.
			const trimmed = stringValue.trim();
			const tIndex = trimmed.indexOf("T");
			return {
				ok: true,
				value: storageTimeValue(
					tIndex >= 0 ? trimmed.slice(tIndex + 1) : trimmed,
				),
			};
		}
		case "datetime": {
			// UTC, because a migration has no viewer whose zone could
			// stand in for the device's. The value being cast is stored
			// text with no zone of its own, so any other reading would be
			// invented — and one that varied by whoever triggered the
			// migration would make the same row convert differently.
			return { ok: true, value: storageDatetimeValue(stringValue, "UTC") };
		}
		case "multi_select": {
			if (Array.isArray(value)) {
				return { ok: true, value: value.map(String) };
			}
			if (stringValue.trim() === "") {
				return {
					ok: false,
					reason: "a blank value has nothing to carry into a selection list",
				};
			}
			// Scalar → one-element array (the lift used when retyping
			// any scalar data type to multi_select).
			return { ok: true, value: [stringValue] };
		}
		default: {
			const _exhaustive: never = toType;
			throw new Error(
				unhandledKindMessage({
					where: "case-store.tryCastValue",
					family: "CasePropertyDataType",
					received: _exhaustive,
					knownKinds: [
						"text",
						"int",
						"decimal",
						"date",
						"datetime",
						"time",
						"single_select",
						"multi_select",
						"geopoint",
					],
				}),
			);
		}
	}
}

/**
 * Return the first option string in `removed` that matches the
 * stored value. Multi-select arrays surface the first matching
 * element; scalars return themselves on a match. `null` means no
 * conflict.
 */
function findRemovedOptionConflict(
	value: unknown,
	removed: ReadonlySet<string>,
): string | null {
	if (Array.isArray(value)) {
		for (const element of value) {
			if (typeof element === "string" && removed.has(element)) {
				return element;
			}
		}
		return null;
	}
	if (typeof value === "string" && removed.has(value)) {
		return value;
	}
	return null;
}

// Per-property expression-index DDL helpers.
//
// The desired index set for a case type is computed from each
// property's `data_type` — each type implies the Postgres operator
// shape the predicate compiler emits at query time, and the
// matching expression-index DDL is what makes the emitted SQL hit
// the index instead of a sequential scan. Index names follow
// `cases_<scopeTag>_<property>_<mode>`: the `<scopeTag>` segment is a
// fixed-width hash of `(app_id, case_type)` (plus the `app_id` /
// `case_type` partial predicate) that scopes each index to one app's
// case type — case-type names are per-app, so without it one global
// index would span every app's rows of a shared case-type name and
// evaluate its cast against another app's values. The case type is
// hashed into the tag, not spelled out, so the name length depends on
// the property name alone. The `<mode>` segment encodes the full
// index SHAPE (access method +
// opclass + cast), so a shape change always picks a different suffix
// and flows through as drop + create under distinct names rather
// than a same-name rewrite — the property the name-keyed catalog
// diff (`diffIndexSets`) relies on. This is load-bearing across a
// retype: `text → int` shifts
// `fuzzy → int`, and crucially `int → decimal` shifts `int → num`
// because the two btree casts (`::integer` vs `::numeric`) are
// distinct expressions that MUST carry distinct names. (A shared
// `btree` suffix for both — the prior shape — left an `int↔decimal`
// retype's stale-cast index in place: the diff saw a same-name
// match and skipped it, and the next insert of a value the new cast
// rejected — a fractional `17.01` under a stale `::integer` index —
// failed with a raw Postgres cast error at write time.) Each shape
// was empirically verified via `EXPLAIN`.

/**
 * The index naming-suffix label per `(data_type, mode)` shape. A
 * property carrying multiple modes (e.g. text with both fuzzy and
 * starts-with) maps to a distinct index per mode.
 *
 * - `fuzzy` — pg_trgm GIN on the text read, built for every text
 *   property. The `match` modes no longer route through it: `fuzzy`
 *   and `phonetic` now evaluate token-wise (per-token `levenshtein`
 *   / `soundex` over `unnest`ed tokens, faithful to HQ's case-search
 *   rather than whole-string trigram similarity), and `starts-with`
 *   uses `starts_with(...)` — none of which a trigram GIN serves. At
 *   preview-scale row counts those scan sequentially; the index is
 *   retained as the established text-property index slot, and
 *   dropping it is a separate schema-migration decision.
 * - `int` / `num` — btree on the typed numeric cast. Covers
 *   `compare` / `between` for `int` (`::integer`) and `decimal`
 *   (`::numeric`). They share the btree access method but split by
 *   cast: the suffix encodes the cast token so the two never collide
 *   on one name (see `BTREE_SUFFIX_FOR_DATA_TYPE`). Kept compact (≤
 *   the prior shared `btree`) so they never tighten `indexName`'s
 *   63-byte budget.
 * - `contains` — jsonb_ops GIN. Covers `multi-select-contains`
 *   (`?|` / `?&` / `@>`); jsonb_path_ops is the wrong choice — it
 *   only supports `@>`.
 */
type IndexModeSuffix = "fuzzy" | "int" | "num" | "contains";

/**
 * Index-name suffix per numeric `data_type`. `int` and `decimal`
 * are the two types that index a btree on a typed cast; the suffix
 * MUST distinguish their casts (`::integer` vs `::numeric`) so the
 * name-keyed catalog diff (`diffIndexSets`) treats an `int↔decimal`
 * retype as a drop + create rather than a no-op same-name match.
 * The pure unit test "two data types share an index name only if
 * they share a cast" pins this against any future numeric type that
 * reuses a suffix; the tokens are kept compact (no longer than the
 * prior shared `btree`) so the rename never tightens `indexName`'s
 * 63-byte identifier budget.
 */
const BTREE_SUFFIX_FOR_DATA_TYPE: Readonly<
	Record<"int" | "decimal", IndexModeSuffix>
> = {
	int: "int",
	decimal: "num",
};

/**
 * One expression-index entry — name + DDL pieces the build step
 * needs. Exported for the index-shape invariant test (the
 * `diffIndexSets` name-keying contract that an `int↔decimal` retype
 * once violated); not on the package barrel.
 */
export interface DesiredIndex {
	/** `cases_<scopeTag>_<property>_<mode>`. */
	name: string;
	/** Postgres access method. */
	using: "gin" | "btree";
	/**
	 * The indexed expression, built via `sql.lit` substitutions —
	 * expression-index expressions must be immutable and reject
	 * parameter binds, so the typed builder's `${param}` shape
	 * would be silently rejected.
	 */
	expression: ReturnType<typeof sql>;
	opclass?: "gin_trgm_ops" | "jsonb_ops";
	/** Catalog-normalized expression expected after Postgres parses the DDL. */
	catalogExpression: string;
	/** Effective opclass, including the default btree opclass. */
	catalogOpclass: "gin_trgm_ops" | "jsonb_ops" | "int4_ops" | "numeric_ops";
	/**
	 * Feeds the partial-index predicate
	 * `WHERE app_id = ... AND case_type = ...`. The `app_id` scope is
	 * load-bearing: case-type names are per-app (`case_type_schemas`
	 * is keyed `(app_id, case_type)`), so a predicate on `case_type`
	 * alone makes ONE global index span every app's rows of that
	 * case-type name — and two apps that declare the same case-type +
	 * property name with different `data_type`s then share a single
	 * index whose cast rejects the other app's values at INSERT.
	 */
	appId: string;
	caseType: string;
}

/**
 * One live index entry read from the catalog. `isValid` mirrors
 * `pg_index.indisvalid` — a failed `CREATE INDEX CONCURRENTLY`
 * leaves the partially-built index visible with
 * `indisvalid = false`. Postgres treats INVALID indexes as
 * "possibly incomplete: must still be modified by INSERT/UPDATE,
 * but cannot safely be used for queries"
 * (`https://www.postgresql.org/docs/current/catalog-pg-index.html`).
 * The diff treats INVALID entries as "drop and recreate" so the
 * next call converges idempotently.
 *
 * `schema` is the namespace the index actually lives in (an index
 * always lands in its table's schema), so a drop names the exact
 * catalog entry the read found instead of re-resolving a bare name
 * through the search path.
 */
interface LiveIndex {
	name: string;
	schema: string;
	isValid: boolean;
	isUnique: boolean;
	keyCount: number;
	accessMethod: string;
	opclass: string | null;
	expression: string | null;
	predicate: string | null;
}

/**
 * Compute the desired index set for a case type. Each property
 * contributes one index keyed on its `data_type`; `single_select`,
 * temporal types, and `geopoint` map to `undefined` (see
 * `desiredIndexForProperty` for per-arm rationale).
 *
 * Defends the `diffIndexSets` name-keying contract: if two distinct
 * properties ever compose to the same index name (only possible via a
 * `propertyIndexTag` SHA-256 collision, negligible at 48 bits), throw
 * with both originating names rather than let one silently shadow the
 * other in the diff.
 */
function computeDesiredIndexSet(
	appId: string,
	caseType: string,
	properties: ReadonlyArray<CaseProperty>,
): Map<string, DesiredIndex> {
	const result = new Map<string, DesiredIndex>();
	// Track which property name produced each index name so a
	// collision error names both originating properties rather than
	// the composed hash.
	const sourceProperty = new Map<string, string>();
	for (const property of properties) {
		// Explicit standard entries remain useful in the effective catalog for
		// authoring metadata/order, but their values live in first-class case
		// columns. A JSONB expression index for one would index a key that no
		// valid row can carry and would disagree with `caseTypeToJsonSchema`.
		if (CASE_SCALAR_PROPERTY_NAMES.has(property.name)) {
			continue;
		}
		const entry = desiredIndexForProperty(appId, caseType, property);
		if (entry === undefined) {
			continue;
		}
		const existing = sourceProperty.get(entry.name);
		if (existing !== undefined && existing !== property.name) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.computeDesiredIndexSet",
					invariant: `properties \`${existing}\` and \`${property.name}\` compose into the same index name \`${entry.name}\``,
					detail:
						"Distinct property names compose distinct fixed-width `propertyIndexTag` segments, so a shared index name means their SHA-256 tags collided (negligible at 48 bits) or a name segment lost its fixed width.\n\nHint: rename one of the two properties at the blueprint layer.",
				}),
			);
		}
		sourceProperty.set(entry.name, property.name);
		result.set(entry.name, entry);
	}
	return result;
}

interface DecodedStoredCaseSchema {
	readonly schema: CaseTypeJsonSchema;
	readonly dataTypes: ReadonlyMap<string, CasePropertyDataType>;
}

/**
 * Decode the one canonical persisted case-schema representation. The frozen
 * identity migration owns every pre-cutover shape; steady-state readers never
 * infer, normalize, or skip malformed schema bytes.
 */
function decodeStoredCaseSchema(
	appId: string,
	caseType: string,
	stored: unknown,
): DecodedStoredCaseSchema {
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
		throw new Error(
			`Stored case schema for "${caseType}" in app "${appId}" is not Nova's exact canonical object schema.`,
		);
	}
	const record = stored as Record<string, unknown>;
	if (
		record.type !== "object" ||
		record.additionalProperties !== false ||
		typeof record.properties !== "object" ||
		record.properties === null ||
		Array.isArray(record.properties) ||
		!isDeepStrictEqual(Object.keys(record).sort(), [
			"additionalProperties",
			"properties",
			"type",
		])
	) {
		throw new Error(
			`Stored case schema for "${caseType}" in app "${appId}" is not Nova's exact canonical object schema.`,
		);
	}
	const dataTypes = new Map<string, CasePropertyDataType>();
	for (const [name, propertySchema] of Object.entries(record.properties)) {
		assertSafeIdentifierFragment(name, "property");
		if (CASE_SCALAR_PROPERTY_NAMES.has(name)) {
			throw new Error(
				`Stored case schema for "${caseType}" in app "${appId}" declares reserved scalar "${name}" as a JSON property.`,
			);
		}
		dataTypes.set(
			name,
			strictStoredDataType(appId, caseType, name, propertySchema),
		);
	}
	return {
		schema: stored as CaseTypeJsonSchema,
		dataTypes,
	};
}

function desiredIndexesFromStoredSchema(
	appId: string,
	caseType: string,
	schema: JsonObject,
): Map<string, DesiredIndex> {
	const decoded = decodeStoredCaseSchema(appId, caseType, schema);
	const declarations: CaseProperty[] = [];
	for (const [name, dataType] of decoded.dataTypes) {
		declarations.push({
			name,
			label: proseText(name),
			data_type: dataType,
		});
	}
	return computeDesiredIndexSet(appId, caseType, declarations);
}

function strictStoredDataType(
	appId: string,
	caseType: string,
	property: string,
	propertySchema: unknown,
): CasePropertyDataType {
	for (const dataType of casePropertyDataTypes) {
		if (isDeepStrictEqual(propertySchema, schemaForDataType(dataType))) {
			return dataType;
		}
	}
	throw new Error(
		`Stored case schema for "${caseType}.${property}" in app "${appId}" has an unknown or noncanonical property declaration.`,
	);
}

/**
 * Build the desired-index entry for one property, or `undefined`
 * when the data type carries no per-property index.
 *
 * - `single_select` — equality on a small option set is fast
 *   without an expression index.
 * - `date` / `datetime` / `time` — the text-to-typed casts and the
 *   canonical `to_date(...)` / `to_timestamp(...)` builtins are
 *   STABLE in Postgres (DateStyle / TimeZone session dependency);
 *   expression indexes require IMMUTABLE. Compare / between runs
 *   as a sequential scan; an indexed path requires a Nova-owned
 *   IMMUTABLE wrapper function the term compiler also emits against.
 * - `geopoint` — the `within-distance` arm builds a WKT string via
 *   `concat(...)` over `split_part(...)` to bridge the wire shape
 *   `"lat lon alt acc"` to PostGIS's WKT input; `concat(...)` over
 *   text args is STABLE so the expression cannot be indexed. The
 *   simpler `ST_GeogFromText(properties->>'<key>')` form would
 *   index but the planner cannot bridge it to the compiler's
 *   WKT-build form for index match.
 *
 * Properties with no declared `data_type` default to `text` (same
 * default `lib/domain/predicate/jsonSchema.ts` uses).
 */
export function desiredIndexForProperty(
	appId: string,
	caseType: string,
	property: CaseProperty,
): DesiredIndex | undefined {
	const dataType: CasePropertyDataType = property.data_type ?? "text";
	const propertyKey = property.name;

	switch (dataType) {
		case "text": {
			const suffix: IndexModeSuffix = "fuzzy";
			return {
				name: indexName(appId, caseType, propertyKey, suffix),
				using: "gin",
				// Postgres requires expression-index expressions be
				// parenthesized.
				expression: sql`((properties->>${sql.lit(propertyKey)}))`,
				opclass: "gin_trgm_ops",
				catalogExpression: `properties->>${postgresCatalogString(propertyKey)}`,
				catalogOpclass: "gin_trgm_ops",
				appId,
				caseType,
			};
		}
		case "int":
		case "decimal": {
			// `int` and `decimal` share the btree access method but
			// compile to DIFFERENT casts (`::integer` vs `::numeric`),
			// so each MUST carry a distinct index name. The suffix
			// encodes the cast (`int` / `num`) — the one dimension the
			// btree family varies by — so the name-keyed catalog diff
			// treats an `int↔decimal` retype as drop + create. A shared
			// `btree` suffix (the prior shape) left such a retype's
			// stale-cast index in place, and the next insert of a value
			// the new cast rejected (a fractional `17.01` under a stale
			// `::integer` index) failed at write time.
			const suffix: IndexModeSuffix = BTREE_SUFFIX_FOR_DATA_TYPE[dataType];
			const cast = POSTGRES_CAST_FOR_DATA_TYPE[dataType];
			return {
				name: indexName(appId, caseType, propertyKey, suffix),
				using: "btree",
				// `((properties->>'<key>')::<cast>)` matches the term
				// compiler's emission so the planner reaches the index.
				// The cast token comes from the same data-type table
				// the query path reads, so retyping retargets both
				// surfaces in lockstep.
				expression: sql`(((properties->>${sql.lit(propertyKey)}))::${sql.raw(cast)})`,
				catalogExpression: `properties->>${postgresCatalogString(propertyKey)}::${cast}`,
				catalogOpclass: dataType === "int" ? "int4_ops" : "numeric_ops",
				appId,
				caseType,
			};
		}
		case "multi_select": {
			const suffix: IndexModeSuffix = "contains";
			return {
				name: indexName(appId, caseType, propertyKey, suffix),
				using: "gin",
				// `->` (returns jsonb) NOT `->>` — `jsonb_ops` supports
				// the full `?` / `?|` / `?&` / `@>` set, while
				// `jsonb_path_ops` only covers `@>` and would force
				// `multi-select-contains` queries emitting `?|` / `?&`
				// to a sequential scan.
				expression: sql`((properties->${sql.lit(propertyKey)}))`,
				opclass: "jsonb_ops",
				catalogExpression: `properties->${postgresCatalogString(propertyKey)}`,
				catalogOpclass: "jsonb_ops",
				appId,
				caseType,
			};
		}
		case "date":
		case "datetime":
		case "time":
		case "geopoint":
		case "single_select":
			return undefined;
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				unhandledKindMessage({
					where: "case-store.desiredIndexForProperty",
					family: "CasePropertyDataType",
					received: _exhaustive,
					knownKinds: [
						"text",
						"int",
						"decimal",
						"date",
						"datetime",
						"time",
						"single_select",
						"multi_select",
						"geopoint",
					],
				}),
			);
		}
	}
}

/**
 * Length of the hex `indexScopeTag` segment. 12 hex chars = 48 bits
 * of the pair's SHA-256; the collision probability across any
 * realistic `(app, case_type)` population (a shared tag would let
 * two scopes' same-`(property, mode)` indexes collide on one name)
 * is negligible, and the fixed width keeps the name's scope segment
 * bounded so the 63-byte budget below is predictable.
 */
/**
 * A short, fixed-length, Postgres-identifier-safe tag derived from
 * the `(appId, caseType)` pair, used as the FIRST name segment of
 * every per-property expression index. Folding both into one
 * fixed-WIDTH tag is what makes `readLiveIndexSet`'s name prefix
 * (`cases_<tag>_%`) an EXACT scope match: distinct `(app, case_type)`
 * pairs hash to distinct tags, so the prefix never bleeds across apps
 * NOR across case types whose names are prefixes of each other
 * (`patient` vs `patient_visit`, which a `..._patient_%` prefix would
 * otherwise both match) — the diff stays scoped to one
 * `(app, case_type)` without reading the partial predicate. Neither
 * the case type nor the property is spelled out in the name — both
 * are folded into fixed-width hashes (this tag + `propertyIndexTag`)
 * — so the composed name is BOUNDED and can't overflow the 63-byte
 * identifier cap no matter how long those names are. The space
 * separator can't appear in either fragment (an app id contains no
 * space — a UUID or a compact alphanumeric id; case-type names follow
 * `CASE_PROPERTY_PATTERN`), so `("ab","c")` and `("a","bc")` never collide. SHA-256 is
 * deterministic, so every write composes the same name for a given
 * scope — the catalog diff stays stable across runs.
 */
/**
 * A short, fixed-length, Postgres-identifier-safe tag for a property
 * name — the second name segment of every per-property expression
 * index. Hashing the property (rather than spelling it out) is what
 * keeps the composed index name BOUNDED: `cases_` + scope tag +
 * property tag + mode is at most `6 + 12 + 1 + 12 + 1 + 8 = 40`
 * bytes, well under Postgres' 63-byte identifier cap, for ANY
 * property name — a verbose 40-char field that overflowed when the
 * property was carried literally no longer can. SHA-256 is
 * deterministic, so runtime and migration compose the same name; a
 * collision between two distinct properties in one scope is caught by
 * `computeDesiredIndexSet` (negligible at 48 bits).
 */
/**
 * Compose the index name `cases_<scopeTag>_<propertyTag>_<mode>` from
 * `(appId, caseType, property, mode)`. Both identity segments are
 * FIXED-WIDTH hashes — `indexScopeTag(appId, caseType)` for exact
 * per-scope prefix enumeration (`readLiveIndexSet`), `propertyIndexTag`
 * for per-property uniqueness — so the name is bounded (≤ 40 bytes)
 * and can NEVER overflow Postgres' 63-byte identifier cap, regardless
 * of how long the case-type or property names are (a 40-char property
 * name once overflowed when carried literally). `<mode>` stays
 * readable so the name still encodes the index SHAPE (the suffix's
 * cast); the case-type + property text live in the partial predicate
 * / indexed expression (`emitCreateIndex`), which `pg_get_indexdef`
 * surfaces for ops. The cap assertion is belt-and-suspenders against
 * a future change that reintroduces a variable-length segment.
 */
function indexName(
	appId: string,
	caseType: string,
	property: string,
	mode: IndexModeSuffix,
): string {
	assertSafeIdentifierFragment(caseType, "case type");
	assertSafeIdentifierFragment(property, "property");
	const composed = `cases_${indexScopeTag(appId, caseType)}_${propertyIndexTag(property)}_${mode}`;
	if (Buffer.byteLength(composed, "utf8") > 63) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.indexName",
				invariant: `composed index name \`${composed}\` exceeds Postgres' 63-byte identifier cap (\`NAMEDATALEN - 1\`)`,
				detail:
					"Both identity segments are fixed-width hashes, so a composed name is at most 40 bytes and this throw is unreachable in the current scheme. Reaching it means a name segment regained a variable length. Restore fixed-width composition so the `readLiveIndexSet` name-prefix contract holds.\n\nHint: keep every non-`mode` name segment fixed-width.",
			}),
		);
	}
	return composed;
}

/**
 * Match `CASE_PROPERTY_PATTERN` from
 * `lib/domain/predicate/types.ts` so the case-store's identifier-
 * shape contract aligns with the blueprint AST. `kind` names the
 * fragment role for the error message.
 */
function assertSafeIdentifierFragment(
	fragment: string,
	kind: "property" | "case type",
): void {
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(fragment)) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.assertSafeIdentifierFragment",
				invariant: `${kind} name \`${fragment}\` contains characters other than letters, digits, underscores, and hyphens, or does not start with a letter`,
				detail:
					"The blueprint AST's `CASE_PROPERTY_PATTERN` (at `lib/domain/predicate/types.ts`) restricts case-type and property names to a leading letter followed by letters / digits / underscores / hyphens; the case-store's identifier-shape contract aligns with that AST pattern. Reaching this throw means a name bypassed the AST gate (e.g., a runtime-constructed blueprint that skipped Zod parsing).\n\nHint: rename the offending case type or property at the blueprint layer; restoring AST-gated construction is the structural fix.",
			}),
		);
	}
}

/**
 * Read every live per-property expression index for one
 * `(appId, caseType)` scope from the catalog. The name-prefix filter
 * pins the `indexScopeTag` segment, which is a fixed-width hash of
 * the `(appId, caseType)` pair — so `cases_<tag>_%` is an EXACT scope
 * match: it sees only THIS scope's indexes, never another app's
 * indexes, and never a prefix-related case type's indexes (`patient`
 * vs `patient_visit` hash to different tags). Foreign indexes
 * (manual, the static `case_indices_*_idx` set, or any name without
 * the leading scope tag) fall outside the prefix too. The exactness
 * comes from the fixed-width tag, so the diff never reads or parses
 * the partial predicate.
 *
 * The query joins `pg_index` + `pg_class` + `pg_namespace` rather
 * than reading the simpler `pg_indexes` view because `pg_indexes`
 * does not expose `indisvalid`. Capturing the validity flag lets
 * `diffIndexSets` emit a drop-and-recreate pair for an INVALID
 * artifact left by a prior failed CONCURRENTLY build — without
 * `indisvalid`, a name-only diff would skip recreation and leave
 * the broken artifact permanently in place. Catalog contract:
 * `https://www.postgresql.org/docs/current/catalog-pg-index.html`.
 */
async function readLiveIndexSet(
	executor: Kysely<Database>,
	appId: string,
	caseType: string,
): Promise<Map<string, LiveIndex>> {
	// `to_regclass('cases')` pins the table by SEARCH-PATH resolution —
	// the same resolution `emitCreateIndex`'s unqualified `ON cases`
	// performs, so the read and the DDL can never disagree about which
	// table they mean. Matching `current_schema()` instead reads the
	// FIRST schema on the path, which production's privilege
	// convergence makes the wrong one: it moves `cases` into
	// `nova_case_runtime` while the connection's path stays
	// `public,nova_case_runtime` (`postgres/connection.ts`), so a
	// `current_schema()` match returns zero rows for every scope. An
	// empty live set makes the diff re-`CREATE` every desired index —
	// `already exists` on the second sync of a case type — and emit no
	// drops at all.
	//
	// Underscores in the prefix are LIKE single-char wildcards on
	// `_`; the `ESCAPE '\\'` form treats `\_` as a literal underscore
	// so the prefix matches only the structural `cases_<tag>_` shape.
	// The `indexScopeTag` is hex (LIKE-safe) and fixed-width, so the
	// prefix can't bleed into an adjacent scope.
	assertSafeIdentifierFragment(caseType, "case type");
	const prefix = `cases\\_${indexScopeTag(appId, caseType)}\\_%`;
	const result = await sql<{
		indexname: string;
		indexschema: string;
		isvalid: boolean;
		isunique: boolean;
		keycount: number;
		accessmethod: string;
		opclass: string | null;
		expression: string | null;
		predicate: string | null;
	}>`SELECT
			c.relname AS indexname,
			n.nspname AS indexschema,
			i.indisvalid AS isvalid,
			i.indisunique AS isunique,
			i.indnkeyatts AS keycount,
			am.amname AS accessmethod,
			(
				SELECT opc.opcname
				FROM unnest(i.indclass::oid[]) WITH ORDINALITY AS classes(opclass_oid, position)
				JOIN pg_opclass AS opc ON opc.oid = classes.opclass_oid
				WHERE classes.position = 1
			) AS opclass,
			pg_get_expr(i.indexprs, i.indrelid, true) AS expression,
			pg_get_expr(i.indpred, i.indrelid, true) AS predicate
		FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_am am ON am.oid = c.relam
		WHERE i.indrelid = to_regclass('cases')
		  AND c.relname LIKE ${prefix} ESCAPE '\\'`.execute(executor);
	const live = new Map<string, LiveIndex>();
	for (const row of result.rows) {
		live.set(row.indexname, {
			name: row.indexname,
			schema: row.indexschema,
			isValid: row.isvalid,
			isUnique: row.isunique,
			keyCount: Number(row.keycount),
			accessMethod: row.accessmethod,
			opclass: row.opclass,
			expression: row.expression,
			predicate: row.predicate,
		});
	}
	return live;
}

/**
 * Diff the desired and live sets. Same name implies same shape
 * because `<mode>` encodes the full index shape (access method +
 * opclass + cast) — a shape change always picks a different suffix,
 * including `int → num` for an `int↔decimal` retype whose btree
 * casts differ — so a valid matching name skips. (Were two distinct
 * shapes to ever share a name, this skip would leave the stale shape
 * in place; `BTREE_SUFFIX_FOR_DATA_TYPE` and the index-shape
 * invariant test are what keep that from recurring.) INVALID matches
 * drop-and-recreate (the `indisvalid = false` recovery path);
 * ordered drop-then-create in `syncExpressionIndexes` ensures the
 * name is free before reuse. Live names not in desired drop
 * regardless of validity.
 */
function diffIndexSets(
	desired: ReadonlyMap<string, DesiredIndex>,
	live: ReadonlyMap<string, LiveIndex>,
): { creates: DesiredIndex[]; drops: LiveIndex[] } {
	const creates: DesiredIndex[] = [];
	const drops: LiveIndex[] = [];
	for (const [name, entry] of desired) {
		const liveEntry = live.get(name);
		if (liveEntry === undefined) {
			creates.push(entry);
			continue;
		}
		if (!liveIndexMatchesDesired(liveEntry, entry)) {
			// INVALID or physically wrong same-name artifact: drop and recreate.
			drops.push(liveEntry);
			creates.push(entry);
		}
	}
	for (const [name, entry] of live) {
		if (!desired.has(name)) {
			drops.push(entry);
		}
	}
	return { creates, drops };
}

function postgresCatalogString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function normalizeCatalogSql(value: string): string {
	return value.replaceAll(/::text\b/g, "").replaceAll(/[()\s"]/g, "");
}

function liveIndexMatchesDesired(
	live: LiveIndex,
	desired: DesiredIndex,
): boolean {
	const desiredPredicate = `app_id=${postgresCatalogString(desired.appId)}ANDcase_type=${postgresCatalogString(desired.caseType)}`;
	return (
		live.isValid &&
		!live.isUnique &&
		live.keyCount === 1 &&
		live.accessMethod === desired.using &&
		live.opclass === desired.catalogOpclass &&
		live.expression !== null &&
		normalizeCatalogSql(live.expression) ===
			normalizeCatalogSql(desired.catalogExpression) &&
		live.predicate !== null &&
		normalizeCatalogSql(live.predicate) === desiredPredicate
	);
}

/**
 * Emit one `CREATE INDEX CONCURRENTLY` statement. The partial-index
 * predicate is scoped to BOTH `app_id` and `case_type` so the index
 * covers only the owning app's rows — case-type names are per-app,
 * so a `case_type`-only predicate would make one index span every
 * app's rows of that name and evaluate its cast against other apps'
 * values. The `app_id` / `case_type` literals flow as `sql.lit`
 * strings because expression-index predicates require IMMUTABLE;
 * bound parameters would silently fail the immutability check.
 */
async function emitCreateIndex(
	executor: Kysely<Database>,
	entry: DesiredIndex,
): Promise<void> {
	const opclass =
		entry.opclass !== undefined ? sql` ${sql.raw(entry.opclass)}` : sql``;
	const using = sql.raw(entry.using.toUpperCase());
	await sql`CREATE INDEX CONCURRENTLY ${sql.id(entry.name)} ON cases USING ${using} (${entry.expression}${opclass}) WHERE app_id = ${sql.lit(entry.appId)} AND case_type = ${sql.lit(entry.caseType)}`.execute(
		executor,
	);
}
