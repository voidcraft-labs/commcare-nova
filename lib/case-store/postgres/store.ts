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
//     stamps `owner_id = <actor>` (the CommCare case-owner, a separate
//     axis — not the tenant filter) on every insert; the JOIN-side
//     `project_id` filter on every joined `cases` row inside relation
//     walks lives at the compiler stack (`compileRelationPath`).
//     Cross-Project reads are structurally impossible. The per-row
//     SCHEMA migrations are the deliberate exception — they are
//     app-scoped (`(app_id, case_type)`, no tenant filter) so a schema
//     change migrates every member's rows, and run on a tenant-free
//     `withSchemaContext` store.
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

import { createHash } from "node:crypto";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
	type Insertable,
	type InsertObject,
	type Kysely,
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
	compilerBugMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import {
	type CaseTypeJsonSchema,
	caseTypeToJsonSchema,
	schemaForDataType,
} from "@/lib/domain/predicate/jsonSchema";
import type { RelationPath } from "@/lib/domain/predicate/types";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	ParkedValueNotFoundError,
	SchemaChangePhaseBError,
	SchemaNotSyncedError,
} from "../errors";
import type { SampleCaseGenerator } from "../sample/generator";
import {
	compileExpression,
	compilePredicate,
	compileRelationPath,
	expressionContextFor,
	POSTGRES_CAST_FOR_DATA_TYPE,
	type PredicateCompileContext,
} from "../sql";
import type {
	CaseIndicesTable,
	Database,
	JsonObject,
	JsonValue,
	ParkedCaseValuesTable,
} from "../sql/database";
import type {
	ApplySchemaChangeArgs,
	CalculatedColumn,
	CalculatedValue,
	CaseInsert,
	CaseRow,
	CaseRowWithCalculated,
	CaseStore,
	CaseUpdate,
	CountArgs,
	GenerateSampleDataArgs,
	MigrationReport,
	ParkedValueEntry,
	QueryArgs,
	ResetSampleDataArgs,
	SchemaChangeKind,
} from "../store";
import { ajvErrorToCaseFailure } from "./validationFailure";

/**
 * Construction arguments. Production callers go through
 * `withProjectContext(projectId, actorUserId)` (tenant-bound) or
 * `withSchemaContext()` (schema-only); tests construct directly with a
 * per-test isolated Kysely instance and either the heuristic generator
 * or a stub.
 *
 * `projectId` / `actorUserId` are `null` for a schema-only store
 * (`withSchemaContext`): `applySchemaChange` / `dropSchema` are
 * app-scoped and bind no tenant. Every tenant-bound read/write reads
 * them through `requireProjectId()` / `requireActorUserId()`, which
 * throw if reached on a schema-only store — unreachable in practice
 * because `withSchemaContext` returns the narrow `SchemaCaseStore`
 * type that exposes no such method.
 */
export interface PostgresCaseStoreArgs {
	projectId: string | null;
	actorUserId: string | null;
	db: Kysely<Database>;
	sampleGenerator: SampleCaseGenerator;
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

/** The Postgres-backed implementation of `CaseStore`. */
export class PostgresCaseStore implements CaseStore {
	/**
	 * Bound Project (tenant) for every read/write, or `null` for a
	 * schema-only store (`withSchemaContext`). `null` only on a store
	 * whose typed surface is `SchemaCaseStore`, so a tenant-bound method
	 * never observes it — `requireProjectId()` guards regardless.
	 */
	private readonly projectId: string | null;
	/**
	 * User id stamped as `owner_id` (the CommCare case-owner) on every
	 * inserted case, or `null` on a schema-only store. Not a tenant
	 * boundary — the reserved axis future location-based access carves
	 * on. `requireActorUserId()` guards the insert paths.
	 */
	private readonly actorUserId: string | null;
	private readonly db: Kysely<Database>;
	private readonly ajv: Ajv2020;
	private readonly validatorCache: Map<string, ValidatorCacheEntry>;
	private readonly sampleGenerator: SampleCaseGenerator;

	constructor(args: PostgresCaseStoreArgs) {
		this.projectId = args.projectId;
		this.actorUserId = args.actorUserId;
		this.db = args.db;
		this.ajv = buildAjv();
		this.validatorCache = new Map();
		this.sampleGenerator = args.sampleGenerator;
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
						"This store was built by `withSchemaContext()` for app-scoped schema operations and carries no Project. A tenant-bound method (query / count / insert / update / close / traverse / generate / reset) requires one. Hint: build the store with `withProjectContext(projectId, actorUserId)` for read/write work.",
				}),
			);
		}
		return this.projectId;
	}

	/**
	 * The user id to stamp as a new case's `owner_id`. Throws on a
	 * schema-only store — same structural backstop as
	 * {@link requireProjectId}; the insert paths are tenant-bound.
	 */
	private requireActorUserId(): string {
		if (this.actorUserId === null) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.requireActorUserId",
					invariant:
						"an insert ran on a schema-only store (no bound actor for `owner_id`)",
					detail:
						"This store was built by `withSchemaContext()` and carries no actor. An insert stamps `owner_id` (the CommCare case-owner) from the bound actor. Hint: build the store with `withProjectContext(projectId, actorUserId)`.",
				}),
			);
		}
		return this.actorUserId;
	}

	/**
	 * Serialize the small set of operations that create, replace, or change
	 * parent relationships within one app + Project. `case_indices` cannot use
	 * a conventional FK because it also models CommCare relationship semantics,
	 * so reset and relationship writers share this transaction-level advisory
	 * lock instead. Unrelated, parentless case writes remain concurrent.
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

	async query(args: QueryArgs): Promise<CaseRowWithCalculated[]> {
		const calculated: ReadonlyArray<CalculatedColumn> = args.calculated ?? [];

		const ctx = this.buildPredicateContext({
			db: this.db,
			appId: args.appId,
			caseType: args.caseType,
			schemas: args.caseTypeSchemas ?? new Map(),
			bindings: args.bindings ?? {},
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
		let qb = this.db
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where("c.project_id", "=", this.requireProjectId());

		// Project each calculated column under its prefixed alias.
		for (const column of calculated) {
			const expr = compileExpression(column.expression, exprCtx);
			qb = qb.select(expr.as(aliasFor(column.uuid)));
		}

		if (args.predicate !== undefined) {
			qb = qb.where(compilePredicate(args.predicate, ctx));
		}

		// Sort keys compile through `compileExpression` against the
		// thunk-wired context — `expressionContextFor` handles the
		// cycle break for the predicate-bearing arms (`if.cond`,
		// `count.where`).
		if (args.sort !== undefined) {
			for (const key of args.sort) {
				const expr = compileExpression(key.expression, exprCtx);
				qb = qb.orderBy(expr, key.direction);
			}
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

		return rows.map((row) => {
			const calculatedMap: Record<string, CalculatedValue> = {};
			// Postgres returns calculated-column NULL as JS `null`; the
			// `CalculatedValue` union admits `null`. Non-null typed
			// values come back per pg's per-OID deserializer:
			//   - text → string
			//   - integer → number
			//   - numeric → string (pg's arbitrary-precision decimal
			//     deserializer)
			//   - boolean → boolean
			//   - date / timestamptz → Date object (NOT ISO string)
			//   - jsonb → object / array
			// The contract test for the date arm at
			// `lib/case-store/__tests__/storeContract.ts` pins the Date
			// shape; the renderer in `DisplayPreview.tsx` discriminates
			// on `instanceof Date` to format the temporal value without
			// `JSON.stringify`'s quoted-ISO output.
			for (const { alias, uuid } of calcAliases) {
				// `Object.hasOwn` guards against the rare case where
				// Postgres elides the alias from the row; the explicit
				// guard keeps the map clean of `undefined`-typed slots.
				if (Object.hasOwn(row, alias)) {
					calculatedMap[uuid] = row[alias] as CalculatedValue;
				} else {
					// Defensive fall-through: treat missing alias as null.
					// Documented contract from the interface JSDoc says
					// "expression evaluates to SQL NULL → uuid → null";
					// an elided alias is functionally equivalent at the
					// consumer layer (renderer reads the same blank
					// value).
					calculatedMap[uuid] = null;
				}
			}

			// Strip the prefixed-alias keys from the row's top-level
			// shape so the consumer's `row.calculated[uuid]` is the
			// only path to each evaluated value. The cases-side scalar
			// columns (`case_name`, `case_id`, etc.) survive verbatim
			// because the prefix puts the calculated slots in a
			// disjoint keyspace — the strip touches ONLY the prefixed
			// aliases, never a `cases` column.
			// `stripTenantKey` removes the bound-tenant `project_id` that
			// `selectAll("c")` materialized (not part of the `CaseRow`
			// contract); the loop then strips the dynamic calc aliases.
			const cleaned = stripTenantKey(row) as Record<string, unknown>;
			for (const { alias } of calcAliases) {
				delete cleaned[alias];
			}
			return {
				...(cleaned as unknown as CaseRow),
				calculated: calculatedMap,
			};
		});
	}

	async count(args: CountArgs): Promise<number> {
		// Same predicate-context plumbing `query` uses — the WHERE
		// clause emitted here MUST match a predicate-narrowed `query`
		// against the same `(appId, caseType, caseTypeSchemas,
		// predicate)` tuple; the Filters-section preview pairs the
		// count with a limited `query` against the same predicate, so
		// any divergence between the two compile paths would surface
		// as a count vs row-list mismatch.
		const ctx = this.buildPredicateContext({
			db: this.db,
			appId: args.appId,
			caseType: args.caseType,
			schemas: args.caseTypeSchemas ?? new Map(),
			bindings: args.bindings ?? {},
		});

		// `eb.fn.countAll<string>()` matches the existing usage at
		// `runRenameMigration` — pg-driver returns BIGINT counts as
		// strings (numeric-precision-preserving), so the typed
		// builder declares the column as string and the caller
		// `Number(...)` coerces. Tenant filter on the outer scan;
		// `compileRelationPath` handles JOIN-side cases independently
		// — the structural tenant-scoping contract splits the two
		// halves to make cross-tenant reads structurally impossible.
		let qb = this.db
			.selectFrom("cases as c")
			.select((eb) => eb.fn.countAll<string>().as("total"))
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where("c.project_id", "=", this.requireProjectId());

		if (args.predicate !== undefined) {
			qb = qb.where(compilePredicate(args.predicate, ctx));
		}

		// `executeTakeFirstOrThrow` is appropriate here — Postgres'
		// `count` aggregate always returns exactly one row even on
		// empty input. A `undefined` from the executor would indicate
		// a structural pg-driver violation rather than a runtime
		// branch the caller can recover from.
		const row = await qb.executeTakeFirstOrThrow();
		return Number(row.total);
	}

	async insert(args: {
		appId: string;
		row: CaseInsert;
	}): Promise<{ caseId: string }> {
		const propertiesObject = parseJsonbInput(args.row.properties);

		// `properties` re-stringifies because the `cases` table's JSONB
		// insert side is a JSON string for pg's JSONB cast. The
		// caller may pass either string or `JsonObject`; both converge
		// through `parseJsonbInput` and stringify back to wire form
		// here. Without this, a `JsonObject` caller silently writes
		// `[object Object]` (pg's parameter binder calls `String(value)`
		// on non-string inputs to a text-cast slot).
		const insertRow: InsertObject<Database, "cases"> = {
			...args.row,
			app_id: args.appId,
			project_id: this.requireProjectId(),
			owner_id: this.requireActorUserId(),
			...creationStamps(args.row),
			properties: JSON.stringify(propertiesObject),
		};

		// One transaction across cases + case_indices so a derived
		// edge insert can't observe a partial cases-row commit.
		// Validation runs INSIDE it — the schema `FOR SHARE` must hold
		// until the row commits (the write-vs-sync contract on
		// `getValidator`) — and AFTER the advisory block, keeping the
		// uniform advisory → schema → rows lock order.
		return await this.db.transaction().execute(async (trx) => {
			if (
				args.row.parent_case_id !== null &&
				args.row.parent_case_id !== undefined
			) {
				await this.lockRelationshipWrites(trx, args.appId);
				await this.assertParentExists(trx, {
					appId: args.appId,
					parentCaseId: args.row.parent_case_id,
				});
			}
			await this.validateProperties({
				appId: args.appId,
				caseType: args.row.case_type,
				properties: propertiesObject,
				executor: trx,
			});
			const inserted = await trx
				.insertInto("cases")
				.values(insertRow)
				.returning("case_id")
				.executeTakeFirstOrThrow();
			const caseId = inserted.case_id;

			// Direct-edge derivation: depth=1 edges only; recursive
			// walks compose at read time via `compileRelationPath`.
			// `relationship` defaults to `child` — the subcase vs
			// extension distinction is a CCHQ concern resolved at
			// the relation-path compile site, not at write.
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
						relationship: "child",
						depth: 1,
					})
					.execute();
			}

			return { caseId };
		});
	}

	async insertWithChildren(args: {
		appId: string;
		primary: CaseInsert;
		children: ReadonlyArray<CaseInsert>;
	}): Promise<{
		primaryCaseId: string;
		childCaseIds: ReadonlyArray<string>;
	}> {
		// Children must not carry an explicit `parent_case_id` —
		// the value is the primary's generated id, threaded below.
		// Guard outside the transaction so a malformed call fails
		// fast without opening a Postgres transaction at all.
		for (const child of args.children) {
			if (child.parent_case_id !== null && child.parent_case_id !== undefined) {
				throw new Error(
					compilerBugMessage({
						where: "case-store.PostgresCaseStore.insertWithChildren",
						invariant:
							"a child case carried an explicit `parent_case_id`; the value must be omitted because the primary's generated id is the implicit parent",
						detail: `Child case-type \`${child.case_type}\` carried \`parent_case_id = '${child.parent_case_id}'\`. The shape \`insertWithChildren\` accepts is "primary plus children that share its parent edge"; supplying a different parent on a child is ambiguous (does the caller want the supplied id or the primary's id?). Hint: pass children without \`parent_case_id\`; if a child needs a different parent, insert it via \`insert\` outside the registration call.`,
					}),
				);
			}
		}

		// One transaction across primary + every child + every
		// derived edge. A failure anywhere rolls the entire
		// registration back.
		return await this.db.transaction().execute(async (trx) => {
			const primaryParentCaseId = args.primary.parent_case_id ?? null;
			// Only a relationship-bearing registration serializes — the same
			// conditional `insert` / `update` apply, honoring
			// `lockRelationshipWrites`'s parentless-writes-stay-concurrent
			// contract. Unconditional locking would block every Preview form
			// submission behind `resetSampleData`'s whole replace
			// transaction, even for forms that create no relationships.
			if (primaryParentCaseId !== null || args.children.length > 0) {
				await this.lockRelationshipWrites(trx, args.appId);
			}
			if (primaryParentCaseId !== null) {
				await this.assertParentExists(trx, {
					appId: args.appId,
					parentCaseId: primaryParentCaseId,
				});
			}
			// Primary id generated up-front so child `parent_case_id`
			// resolves before the bulk-insert lands. UUID v7's
			// timestamp prefix matches `DEFAULT uuidv7()`'s B-tree
			// clustering shape.
			const primaryCaseId = args.primary.case_id ?? uuidv7();

			const primaryProperties = parseJsonbInput(args.primary.properties);
			await this.validateProperties({
				appId: args.appId,
				caseType: args.primary.case_type,
				properties: primaryProperties,
				executor: trx,
			});

			// Insert the primary row. With an explicit `case_id` the
			// `RETURNING` round-trip is unnecessary.
			const primaryRow: InsertObject<Database, "cases"> = {
				...args.primary,
				case_id: primaryCaseId,
				app_id: args.appId,
				project_id: this.requireProjectId(),
				owner_id: this.requireActorUserId(),
				...creationStamps(args.primary),
				properties: JSON.stringify(primaryProperties),
			};
			await trx.insertInto("cases").values(primaryRow).execute();

			// Primary parent edge if it carries one. Registration forms
			// typically don't, but the shape admits a primary that
			// itself points at an existing parent — handled uniformly
			// with the per-row `insert`.
			if (
				args.primary.parent_case_id !== null &&
				args.primary.parent_case_id !== undefined
			) {
				await trx
					.insertInto("case_indices")
					.values({
						case_id: primaryCaseId,
						ancestor_id: args.primary.parent_case_id,
						identifier: "parent",
						relationship: "child",
						depth: 1,
					})
					.execute();
			}

			// Empty-children arm behaves like `insert` for just the
			// primary; skip the bulk path entirely.
			if (args.children.length === 0) {
				return { primaryCaseId, childCaseIds: [] };
			}

			// Chunk children by case_type so the bulk path's
			// hoisted-validator optimization (one schema fetch per
			// `(appId, caseType)`) holds. Each chunk entry tracks its
			// origin index so the returned `childCaseIds` reassembles
			// into the caller's input order.
			interface ChunkEntry {
				originalIndex: number;
				row: CaseInsert;
			}
			const byCaseType = new Map<string, ChunkEntry[]>();
			for (let i = 0; i < args.children.length; i++) {
				const child = args.children[i];
				if (child === undefined) continue;
				const list = byCaseType.get(child.case_type) ?? [];
				list.push({
					originalIndex: i,
					row: { ...child, parent_case_id: primaryCaseId },
				});
				byCaseType.set(child.case_type, list);
			}

			const childCaseIds: string[] = new Array(args.children.length);
			for (const [, chunk] of byCaseType) {
				const { caseIds } = await this.insertManyInTransaction(trx, {
					appId: args.appId,
					rows: chunk.map((entry) => entry.row),
				});
				// Map each chunk position back to the caller's
				// original index.
				for (let i = 0; i < chunk.length; i++) {
					const entry = chunk[i];
					const generated = caseIds[i];
					if (entry !== undefined && generated !== undefined) {
						childCaseIds[entry.originalIndex] = generated;
					}
				}
			}

			return { primaryCaseId, childCaseIds };
		});
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
					owner_id: this.requireActorUserId(),
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
				relationship: "child",
				depth: 1,
			});
		}
		if (indexRows.length > 0) {
			await trx.insertInto("case_indices").values(indexRows).execute();
		}

		return { caseIds };
	}

	async update(args: {
		appId: string;
		caseId: string;
		patch: CaseUpdate;
	}): Promise<void> {
		// Read inside the transaction so merge + validate + write is
		// atomic against a concurrent updater of the same row.
		await this.db.transaction().execute(async (trx) => {
			if (args.patch.parent_case_id !== undefined) {
				await this.lockRelationshipWrites(trx, args.appId);
				if (args.patch.parent_case_id !== null) {
					await this.assertParentExists(trx, {
						appId: args.appId,
						parentCaseId: args.patch.parent_case_id,
					});
				}
			}
			const existing = await trx
				.selectFrom("cases as c")
				.select(["c.case_type", "c.parent_case_id", "c.properties"])
				.where("c.app_id", "=", args.appId)
				.where("c.case_id", "=", args.caseId)
				.where("c.project_id", "=", this.requireProjectId())
				.executeTakeFirst();
			if (existing === undefined) {
				throw new CaseNotFoundError(args.caseId);
			}

			// Patches without `properties` short-circuit JSONB
			// validation; every other column updates without touching
			// the document. Validation passes `trx` as the executor —
			// with `max: 1` pools (the per-test isolation harness's
			// shape), an unscoped read would wait forever on a
			// connection the transaction owns.
			//
			// The merge SHEDS inherited keys the current schema no longer
			// declares before validating: a key orphaned by a property
			// removal (or by a rename whose migration predates this
			// deploy) would otherwise fail `additionalProperties` on this
			// row's every future write — the value is dead data the
			// blueprint can no longer reference, so it drops with the
			// write instead of locking the row. Only the INHERITED half is
			// shed; an unknown key in the caller's PATCH is still a
			// validation error (a caller bug worth surfacing, not
			// residue).
			let mergedProperties: Record<string, unknown> | undefined;
			if (args.patch.properties !== undefined) {
				const validator = await this.getValidator(
					args.appId,
					existing.case_type,
					trx,
				);
				const inherited: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(existing.properties)) {
					if (validator.declared.has(key)) {
						inherited[key] = value;
					}
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

			// `properties` is split out because the merged-and-
			// stringified form replaces the patch's unmerged value;
			// the rest of the patch passes through as column writes.
			// `CaseUpdate` is an explicit allowlist that excludes
			// immutable identity columns and auto-stamped
			// `modified_on`, so no defensive stripping is needed.
			const { properties: _patchProperties, ...patchRest } = args.patch;
			await trx
				.updateTable("cases as c")
				.set({
					...patchRest,
					modified_on: sql<Date>`now()`,
					...(mergedProperties !== undefined
						? { properties: JSON.stringify(mergedProperties) }
						: {}),
				})
				.where("c.app_id", "=", args.appId)
				.where("c.case_id", "=", args.caseId)
				.where("c.project_id", "=", this.requireProjectId())
				.execute();

			// Re-derive `case_indices` only when the parent edge
			// actually changes — same-value patches are a no-op.
			if (
				args.patch.parent_case_id !== undefined &&
				args.patch.parent_case_id !== existing.parent_case_id
			) {
				await this.rebuildParentEdge(
					trx,
					args.caseId,
					args.patch.parent_case_id,
				);
			}
		});
	}

	async close(args: { appId: string; caseId: string }): Promise<void> {
		// Lifecycle status is NOT caller input: CCHQ's built-in `@status`
		// is exactly `open` / `closed`, so close owns the canonical
		// `closed` write alongside the timestamp. `coalesce` preserves an
		// existing closure timestamp while the second WHERE arm lets a
		// re-close repair rows written by the old close path (`closed_on`
		// present but status still `open`). `modified_on` advances only for
		// a genuinely open row; status-only repair preserves the original
		// close event's timestamp. Import/reopen flows go through `update`
		// with both lifecycle fields.
		await this.db
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

	async applySchemaChange(
		args: ApplySchemaChangeArgs,
	): Promise<MigrationReport> {
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
						"`change` describes a per-row reshape (rename / retype / narrow-options) that runs pre-commit with no committed seq; `syncedSeq` is the monotone gate for an additive sync that carries a committed seq and no migration. Reaching this means a caller combined them — the coarse `synced_seq` gate could then skip the migration's per-row work on a stale seq. Hint: run the migration un-versioned (Phase 1) and let the post-commit sweep advance `synced_seq` additively.",
				}),
			);
		}
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
		const desiredIndexes = computeDesiredIndexSet(
			args.appId,
			args.caseType,
			caseType.properties,
		);

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
		// coerce with `Number(...)`. The fine half is the guarded UPSERT SET
		// below — a lost SELECT→UPSERT race re-converges on the next sync
		// (perf-only, not a correctness gate).
		if (args.syncedSeq !== undefined) {
			const existing = await this.db
				.selectFrom("case_type_schemas")
				.select("synced_seq")
				.where("app_id", "=", args.appId)
				.where("case_type", "=", args.caseType)
				.executeTakeFirst();
			if (
				existing !== undefined &&
				args.syncedSeq < Number(existing.synced_seq)
			) {
				return {
					migrated: 0,
					reshaped: 0,
					retyped: 0,
					restored: 0,
					skipped: 0,
					parkedIds: [],
					failureReasons: [],
				};
			}
		}

		const incomingSeq = args.syncedSeq;

		// Phase A: schema sync + per-row work in one transaction. `won` records
		// whether THIS call actually advanced the row — false only when the
		// versioned fine-gate WHERE suppressed the UPSERT (a monotone loser).
		// Phase B and the step-2 reshape are both gated on it.
		let won = true;
		const report = await this.db.transaction().execute(async (trx) => {
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
			const priorRow = await trx
				.selectFrom("case_type_schemas")
				.select("schema")
				.where("app_id", "=", args.appId)
				.where("case_type", "=", args.caseType)
				.forUpdate()
				.executeTakeFirst();

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
						return conflict.doUpdateSet({ schema: JSON.stringify(schema) });
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
							sql<boolean>`excluded.synced_seq >= case_type_schemas.synced_seq`,
						);
				})
				.returning("synced_seq")
				.executeTakeFirst();
			// A versioned loser returns no row. The un-versioned path never has
			// a suppressing WHERE, so it always returns a row (always a winner).
			won = upserted !== undefined;

			// Step 2: stored↔desired per-property transition detection. On
			// every WINNING sync the stored schema diffs against the newly
			// derived one and every same-name property whose validation
			// semantics changed migrates in the SAME transaction as the
			// schema write — so the schema row and the row population can
			// never disagree, whichever caller synced (the saga's sweep,
			// the drain-end materialize, the point-of-use heal, the
			// compensate path, the drift scripts). Without it, a
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
				// Exclude only a RETYPE/NARROW-targeted property — those
				// migrations rewrite the same key their caller named, and a
				// double rewrite would double-count. A RENAME's keys are
				// deliberately NOT excluded: its FROM keys are absent from
				// the derived schema (invisible here), and a merge-rename
				// DESTINATION whose own population changes type must still
				// migrate the rows the rename never visits — this step runs
				// first, and the rename arm's conflict rule then treats the
				// freshly-cast destination value as the surviving one.
				transitions = detectPropertyTransitions(
					priorRow?.schema,
					schema,
					args.change !== undefined && args.change.kind !== "rename"
						? args.property
						: undefined,
				);
				// A numeric-source transition writes non-numeric values (an
				// array target) through the property's live `::integer` /
				// `::numeric` expression index, which would abort the
				// transaction — drop the stale index FIRST (plain in-txn
				// DROP; Phase B recreates the new type's index after
				// commit). The explicit `retype` arm shares the hazard.
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
					retypes: [...transitions.retypes, ...explicitRetype],
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
							caseTypeDecl: caseType,
							storedSchema: priorRow?.schema,
						});

			// Step 4: restore previously-parked values whose property's
			// declared TYPE changed in this sync and whose original value
			// the new schema accepts — the winning sync's closing move, so
			// a convert-back (a fresh conversion, an undo batch, the
			// saga's compensating re-sync) automatically recovers what the
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
				...transitions.widenings,
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
		});

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
		if (won) {
			try {
				await this.syncExpressionIndexes({
					appId: args.appId,
					caseType: args.caseType,
					desired: desiredIndexes,
				});
			} catch (phaseBErr) {
				// Phase A is already durable — wrap so the COMMITTED report
				// (parked ids and all) survives the throw for compensating
				// callers; `cause` keeps transient classification working.
				throw new SchemaChangePhaseBError({
					appId: args.appId,
					caseType: args.caseType,
					report,
					cause: phaseBErr,
				});
			}
		}

		return report;
	}

	async dropSchema(args: { appId: string; caseType: string }): Promise<void> {
		// Phase A: DELETE the `case_type_schemas` row. A single
		// statement is atomic on its own — no transaction needed
		// for one DELETE — but the structural shape mirrors
		// `applySchemaChange`'s Phase A so the file's two-phase
		// pattern stays uniform. Idempotent on every absence path:
		// DELETE matching zero rows is a no-op.
		await this.db
			.deleteFrom("case_type_schemas")
			.where("app_id", "=", args.appId)
			.where("case_type", "=", args.caseType)
			.execute();

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
		await this.syncExpressionIndexes({
			appId: args.appId,
			caseType: args.caseType,
			desired: new Map(),
		});
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
		appId: string;
		caseType: string;
		desired: ReadonlyMap<string, DesiredIndex>;
	}): Promise<void> {
		const live = await readLiveIndexSet(this.db, args.appId, args.caseType);
		const { creates, drops } = diffIndexSets(args.desired, live);

		// Drops first so a same-name INVALID artifact clears before
		// the create reuses it. The ordered loop is what makes that
		// pair atomic at the name level. `DROP INDEX CONCURRENTLY`
		// avoids `ACCESS EXCLUSIVE` for the drop's duration; `IF
		// EXISTS` makes the drop idempotent against a half-completed
		// prior run.
		for (const drop of drops) {
			await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(drop.name)}`.execute(
				this.db,
			);
		}
		for (const create of creates) {
			await emitCreateIndex(this.db, create);
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
			retypes: ReadonlyArray<DetectedRetype>;
		},
	): Promise<void> {
		for (const retype of args.retypes) {
			if (retype.fromType !== "int" && retype.fromType !== "decimal") continue;
			if (retype.toType === "int" || retype.toType === "decimal") continue;
			const staleName = indexName(
				args.appId,
				args.caseType,
				retype.property,
				BTREE_SUFFIX_FOR_DATA_TYPE[retype.fromType],
			);
			await sql`DROP INDEX IF EXISTS ${sql.id(staleName)}`.execute(trx);
		}
	}

	async generateSampleData(
		args: GenerateSampleDataArgs,
	): Promise<{ inserted: number }> {
		// Transactional body lives in `generateSampleDataInTransaction`
		// so `resetSampleData` can pass its own `trx` and the full
		// delete + regenerate runs as one Postgres transaction.
		return await this.db.transaction().execute(async (trx) => {
			await this.lockRelationshipWrites(trx, args.appId);
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
	 * Three arms: `rename(renames[])`, `retype(fromType, toType)`, and
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
			caseTypeDecl: CaseType;
			/** The stored (pre-sync) schema document — the rename arm reads each SOURCE property's type off it for its parks' `from_type`. */
			storedSchema: unknown;
		},
	): Promise<MigrationReport> {
		switch (args.change.kind) {
			case "rename": {
				// Each DESTINATION declaration's type drives its pair's
				// per-row cast. A plain rename carried its declaration with
				// it (identity cast); a merge-rename adopted the surviving
				// entry's type. An undeclared `data_type` derives a plain
				// string schema, so it casts as `text`. The SOURCE type
				// comes off the STORED schema (the declaration the parked
				// value was last valid under) with the same plain-string
				// fallback.
				const storedProps =
					typeof args.storedSchema === "object" && args.storedSchema !== null
						? ((args.storedSchema as { properties?: unknown }).properties as
								| Record<string, unknown>
								| undefined)
						: undefined;
				const renames = args.change.renames.map((pair) => ({
					from: pair.from,
					to: pair.to,
					fromType:
						dataTypeTokenOf(storedProps?.[pair.from]) ?? ("text" as const),
					toType:
						args.caseTypeDecl.properties.find((p) => p.name === pair.to)
							?.data_type ?? ("text" as const),
				}));
				return await this.runRenameMigration(trx, {
					appId: args.appId,
					caseType: args.caseType,
					renames,
				});
			}
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
	 * Rename: move each row's values from the old JSONB keys to the
	 * new ones — ALL pairs applied SIMULTANEOUSLY against the row's
	 * pre-migration document, so a same-batch swap (A→B while B→A) or
	 * name-reuse (A→B while a second writer's B→C) lands every value
	 * at its true destination with no ordering hazard: every old key
	 * drops first, then each destination fills from the OLD document's
	 * source value.
	 *
	 * Values cast into the DESTINATION declaration. A plain rename
	 * carries its declaration with it, so the cast is an identity pass
	 * — but a MERGE-rename (the destination name was already declared;
	 * the doc layer's cascade drops the old entry and keeps the
	 * existing declaration) can land a value under a differently-typed
	 * key, and an uncast move would re-strand the row on the
	 * destination's `type` keyword — or abort Phase B's typed
	 * expression index.
	 *
	 * Per-pair, per-row rules:
	 *   - Destination key already holds a non-null value that is NOT
	 *     itself being renamed away (a merge-rename conflict): the
	 *     destination value WINS — it already conforms to the
	 *     surviving declaration — and the old key's displaced value
	 *     PARKS. Preferring the old value would overwrite schema-valid
	 *     data with a value that may need a failable cast.
	 *   - Old key holds JSON `null` or a blank string: the key drops
	 *     and nothing parks — there is no data to keep, and the KEY
	 *     must still go (merged-document validation rejects the
	 *     undeclared key regardless of its value).
	 *   - Otherwise: `tryCastValue` into the destination type; success
	 *     writes the cast value under the new key, failure PARKS the
	 *     value with its old key dropped and records a
	 *     `failureReasons` entry. Never a row removal: a rename is a
	 *     first-class conversational/builder gesture, and making an
	 *     entire case vanish from every list over one uncastable field
	 *     value is worse than setting that value aside loudly. The row
	 *     stays present and writable.
	 */
	private async runRenameMigration(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			renames: ReadonlyArray<{
				from: string;
				to: string;
				/** The SOURCE property's type in the stored (pre-migration) schema — a park's `from_type`. */
				fromType: CasePropertyDataType;
				toType: CasePropertyDataType;
			}>;
		},
	): Promise<MigrationReport> {
		// Count the full row population first so `migrated` + `skipped`
		// stay an exact partition. Both queries share the caller's
		// transaction so no concurrent inserter can land between them.
		// App-scoped, NOT tenant-scoped: a schema change migrates EVERY
		// member's rows of the app's case type (a property rename is an
		// app-wide event, not a per-Project one), so every per-row
		// migration below filters on `(app_id, case_type)` only — never
		// `project_id` / `owner_id`. The store is typically a
		// `withSchemaContext` instance with no bound tenant; binding one
		// here would wrongly skip co-members' rows.
		const totalRow = await trx
			.selectFrom("cases as c")
			.select((eb) => eb.fn.countAll<string>().as("total"))
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.executeTakeFirstOrThrow();
		const totalCount = Number(totalRow.total);

		// Only rows holding at least one old key leave Postgres — `?`
		// tests key presence, so conforming and key-less rows never load
		// into Node.
		const rows = await trx
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where((eb) =>
				eb.or(
					args.renames.map(
						(pair) => sql<boolean>`c.properties ? ${sql.lit(pair.from)}`,
					),
				),
			)
			.execute();

		const fromKeys = new Set(args.renames.map((pair) => pair.from));
		const migratedRows: { caseId: string; newProperties: JsonObject }[] = [];
		const parks: ParkEntry[] = [];
		const failureReasons: string[] = [];

		for (const row of rows) {
			const old = row.properties;
			const next: JsonObject = {};
			for (const [key, value] of Object.entries(old)) {
				if (!fromKeys.has(key)) next[key] = value;
			}
			for (const pair of args.renames) {
				if (!Object.hasOwn(old, pair.from)) continue;
				const value = old[pair.from];
				if (hasNoDataToKeep(value)) {
					continue; // no data to keep — the key drop above suffices
				}
				const destination = old[pair.to];
				if (
					destination !== undefined &&
					destination !== null &&
					!fromKeys.has(pair.to)
				) {
					// Merge-rename conflict — the destination's surviving,
					// already-conforming value wins; the displaced source
					// value parks instead of silently vanishing.
					const reason = `rename ${pair.from}→${pair.to} on case ${row.case_id} kept the destination's existing value; the '${pair.from}' value was set aside`;
					parks.push({
						caseId: row.case_id,
						caseType: row.case_type,
						property: pair.from,
						value,
						reason,
						fromType: pair.fromType,
						toType: pair.toType,
					});
					failureReasons.push(reason);
					continue;
				}
				const cast = tryCastValue(value, pair.toType);
				if (cast.ok) {
					next[pair.to] = cast.value as JsonValue;
				} else {
					const reason = `rename ${pair.from}→${pair.to} set aside a value on case ${row.case_id}: it cannot live under the destination's \`${pair.toType}\` declaration: ${cast.reason}`;
					parks.push({
						caseId: row.case_id,
						caseType: row.case_type,
						property: pair.from,
						value,
						reason,
						fromType: pair.fromType,
						toType: pair.toType,
					});
					failureReasons.push(reason);
				}
			}
			migratedRows.push({ caseId: row.case_id, newProperties: next });
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
			skipped: totalCount - rows.length,
			parkedIds,
			failureReasons,
		};
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
				sql`(${caseId}::uuid, ${JSON.stringify(newProperties)}::jsonb)`,
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
	 * Write parked values back under their keys and delete the
	 * restored entries — the cross-store saga's compensation half for
	 * a failed blueprint commit (`parkedIds` off the forward apply's
	 * `MigrationReport`). A restore happens ONLY when it is safe on
	 * every axis, else the entry is KEPT (lossless beats tidy; the
	 * review surface settles it):
	 *
	 *   - the row still exists, and its key holds no real concurrent
	 *     value (the cases read is `FOR UPDATE`, so a concurrent
	 *     `update()`'s merged write serializes against the restore
	 *     instead of clobbering it);
	 *   - the value CONFORMS to the property's declaration in the
	 *     CURRENTLY-STORED schema row, checked here rather than
	 *     trusted from the caller — compensation's re-sync can lose a
	 *     race to a concurrent peer's differently-typed commit (or
	 *     fail and be swallowed), and an unchecked restore would then
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
			return await this.restoreEntries(trx, args.appId, entries);
		});
	}

	/**
	 * The shared restore core `unparkValues` (the saga's compensation)
	 * and `restoreParkedValues` (the review surface) both run on their
	 * ALREADY-FETCHED entries: lock the case rows `FOR UPDATE`, prove
	 * each entry safe on every axis (row exists, key free, value
	 * conforms to the CURRENTLY-stored schema), write the safe values
	 * back grouped per row, and delete exactly the restored entries. A
	 * blocked entry is KEPT — lossless beats tidy; the review surface
	 * settles it.
	 */
	private async restoreEntries(
		trx: Transaction<Database>,
		appId: string,
		entries: ReadonlyArray<Selectable<ParkedCaseValuesTable>>,
	): Promise<{ restored: number; kept: number }> {
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
		const conformance = await this.parkedValueConformance(
			trx,
			appId,
			new Set(entries.map((entry) => entry.case_type)),
		);

		// Group per row so several restored properties on one case
		// compose into a single rewrite.
		const nextByCaseId = new Map<string, JsonObject>();
		const restoredIds: string[] = [];
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
			if (
				Object.hasOwn(current, entry.property) &&
				current[entry.property] !== null &&
				current[entry.property] !== ""
			) {
				// A concurrent writer landed a real value under the key
				// after the park. Keep the entry rather than clobber the
				// newer value or delete the older one.
				kept++;
				continue;
			}
			if (!conformance(entry.case_type, entry.property, entry.original_value)) {
				kept++;
				continue;
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
		return { restored: restoredIds.length, kept };
	}

	async listParkedValues(args: {
		appId: string;
		caseType: string;
	}): Promise<ParkedValueEntry[]> {
		const projectId = this.requireProjectId();
		// One transaction so the entries, their case rows, and the
		// schema the verdicts are computed against are a single
		// consistent snapshot. The `cases` join is the tenant gate — an
		// entry is only as visible as its row.
		return await this.db.transaction().execute(async (trx) => {
			const rows = await trx
				.selectFrom("parked_case_values as p")
				.innerJoin("cases as c", "c.case_id", "p.case_id")
				.selectAll("p")
				.select(["c.case_name", "c.properties as case_properties"])
				.where("p.app_id", "=", args.appId)
				.where("p.case_type", "=", args.caseType)
				.where("c.project_id", "=", projectId)
				.orderBy("p.created_at", "desc")
				.orderBy("p.id", "desc")
				.execute();
			if (rows.length === 0) return [];
			const conformance = await this.parkedValueConformance(
				trx,
				args.appId,
				new Set(rows.map((row) => row.case_type)),
			);
			return rows.map((row) => {
				const conforms = conformance(
					row.case_type,
					row.property,
					row.original_value,
				);
				const held = row.case_properties[row.property];
				const occupied =
					Object.hasOwn(row.case_properties, row.property) &&
					held !== null &&
					held !== "";
				// `from_type`/`to_type` were written from typed tokens by
				// `bulkPark` — the only writer — so the read-side narrowing
				// trusts the column the same way `original_value` trusts
				// its jsonb shape.
				const fromType = row.from_type as CasePropertyDataType;
				return {
					id: row.id,
					caseId: row.case_id,
					caseName: row.case_name,
					caseType: row.case_type,
					property: row.property,
					originalValue: row.original_value,
					reason: row.reason,
					fromType,
					toType: row.to_type as CasePropertyDataType,
					createdAt: row.created_at,
					dismissedAt: row.dismissed_at,
					restorable: conforms && !occupied,
					blockedBy: conforms ? (occupied ? "occupied" : null) : "type",
					fitsOriginalType:
						castConformance(fromType)(row.original_value) === true,
				};
			});
		});
	}

	async restoreParkedValues(args: {
		appId: string;
		ids: ReadonlyArray<string>;
	}): Promise<{ restored: number; kept: number }> {
		const projectId = this.requireProjectId();
		if (args.ids.length === 0) return { restored: 0, kept: 0 };
		return await this.db.transaction().execute(async (trx) => {
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
				.where("c.project_id", "=", projectId)
				.execute();
			if (entries.length === 0) {
				return { restored: 0, kept: args.ids.length };
			}
			const result = await this.restoreEntries(trx, args.appId, entries);
			return {
				restored: result.restored,
				kept: result.kept + (args.ids.length - entries.length),
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
		const result = await this.db
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
	}

	async replaceParkedValue(args: {
		appId: string;
		id: string;
		value: JsonValue;
	}): Promise<void> {
		const projectId = this.requireProjectId();
		const entry = await this.db
			.selectFrom("parked_case_values as p")
			.innerJoin("cases as c", "c.case_id", "p.case_id")
			.select(["p.id", "p.case_id", "p.property"])
			.where("p.app_id", "=", args.appId)
			.where("p.id", "=", args.id)
			.where("c.project_id", "=", projectId)
			.executeTakeFirst();
		if (entry === undefined) {
			throw new ParkedValueNotFoundError(args.id);
		}
		// The write goes through the standard validated `update` (schema
		// validation, orphan shed, `modified_on` stamp) FIRST; the
		// dismiss follows in its own statement. A crash between the two
		// leaves the entry active with its key occupied — the list then
		// shows it blocked (`occupied`), which is honest and settled by
		// hand, whereas the inverse order could archive an entry whose
		// replacement never landed.
		await this.update({
			appId: args.appId,
			caseId: entry.case_id,
			patch: { properties: { [entry.property]: args.value } },
		});
		await this.db
			.updateTable("parked_case_values")
			.set({ dismissed_at: new Date() })
			.where("id", "=", entry.id)
			.execute();
	}

	/**
	 * Build the per-`(caseType, property)` conformance check restores
	 * gate on: reads the involved types' CURRENTLY-STORED schema rows
	 * inside the caller's transaction and compiles a per-property ajv
	 * validator on demand. An absent schema row, an unparseable stored
	 * document, or an undeclared property all answer `false` — a
	 * restore never proceeds on a guess.
	 */
	private async parkedValueConformance(
		trx: Transaction<Database>,
		appId: string,
		caseTypes: ReadonlySet<string>,
	): Promise<(caseType: string, property: string, value: unknown) => boolean> {
		const schemaRows = await trx
			.selectFrom("case_type_schemas")
			.select(["case_type", "schema"])
			.where("app_id", "=", appId)
			.where("case_type", "in", [...caseTypes])
			.execute();
		const propsByType = new Map<string, Record<string, unknown>>();
		for (const row of schemaRows) {
			const stored = row.schema;
			if (typeof stored !== "object" || stored === null) continue;
			const props = (stored as { properties?: unknown }).properties;
			if (typeof props !== "object" || props === null) continue;
			propsByType.set(row.case_type, props as Record<string, unknown>);
		}
		const ajv = new Ajv2020({ strict: false });
		addFormats(ajv);
		const cache = new Map<string, ValidateFunction<unknown> | null>();
		return (caseType, property, value) => {
			const key = `${caseType} ${property}`;
			let validate = cache.get(key);
			if (validate === undefined) {
				const propSchema = propsByType.get(caseType)?.[property];
				validate =
					typeof propSchema === "object" && propSchema !== null
						? ajv.compile(propSchema)
						: null;
				cache.set(key, validate);
			}
			return validate !== null && validate(value) === true;
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

		const validate = this.ajv.compile(row.schema as object);
		const declaredProps = (row.schema as { properties?: object }).properties;
		const entry: ValidatorCacheEntry = {
			schemaJson,
			validate,
			declared: new Set(Object.keys(declaredProps ?? {})),
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
		bindings: PredicateCompileContext["bindings"];
	}): PredicateCompileContext {
		return {
			db: args.db,
			appId: args.appId,
			projectId: this.requireProjectId(),
			anchorAlias: "c",
			currentCaseType: args.caseType,
			caseTypeSchemas: args.schemas,
			bindings: args.bindings,
		};
	}

	/**
	 * Re-derive the parent edge in `case_indices` after an UPDATE
	 * that changed `parent_case_id`. Direct edges only — recursive
	 * walks compose at read time via `compileRelationPath`.
	 *
	 * The DELETE is broad — every `'parent'` edge for the case —
	 * so leftover edges from any prior shape don't accumulate. The
	 * INSERT skips when `newParent` is null (clearing the edge).
	 */
	private async rebuildParentEdge(
		trx: Transaction<Database>,
		caseId: string,
		newParent: string | null,
	): Promise<void> {
		await trx
			.deleteFrom("case_indices")
			.where("case_indices.case_id", "=", caseId)
			.where("case_indices.identifier", "=", "parent")
			.execute();
		if (newParent !== null) {
			const edge: Insertable<CaseIndicesTable> = {
				case_id: caseId,
				ancestor_id: newParent,
				identifier: "parent",
				relationship: "child",
				depth: 1,
			};
			await trx.insertInto("case_indices").values(edge).execute();
		}
	}
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
 * exposes both locally with no sync involved — so the standard-name aliases
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
					detail: `Underlying parser message: ${err instanceof Error ? err.message : String(err)}\n\nHint: trace the caller's stringify path — a serializer that produces non-JSON text (a stray sentinel, a non-stringifiable type) is the structural cause.`,
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
	 * the int→text one that rewrites rows.
	 */
	widenings: string[];
}

/**
 * Read a property-schema shape back to the `data_type` that emits it —
 * the inverse of `schemaForDataType`, tolerant of the stored side's
 * `unknown`. `text` and `single_select` collapse to one token (their
 * schemas are byte-identical, so no migration can distinguish or need
 * them); an unrecognized shape returns `undefined` and detection skips
 * the property (fail open — the behavior of nothing stored to diff).
 */
function dataTypeTokenOf(
	propSchema: unknown,
): CasePropertyDataType | undefined {
	if (typeof propSchema !== "object" || propSchema === null) return undefined;
	const { type, format, pattern } = propSchema as {
		type?: unknown;
		format?: unknown;
		pattern?: unknown;
	};
	const annotation = (propSchema as Record<string, unknown>)["x-novaDataType"];
	if (type === "integer") return "int";
	if (type === "number") return "decimal";
	if (type === "array") return "multi_select";
	if (type !== "string") return undefined;
	if (typeof pattern === "string") return "geopoint";
	if (format === undefined) {
		// A select's VALIDATION shape is plain text (no enum — see the
		// generator's `single_select` arm), so the authored type survives
		// only through the generator's annotation keyword. A pre-annotation
		// stored schema reads as `text` — value-compatible in every cast,
		// so nothing depends on the distinction beyond the recorded park
		// transition, and re-syncs converge the stored bytes.
		return annotation === "single_select" ? "single_select" : "text";
	}
	if (format === "date") return "date";
	if (format === "time") return "time";
	if (format === "date-time") return "datetime";
	return undefined;
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
 * annotation, read by `dataTypeTokenOf`), so a select's park
 * records its authored type while flips between the two still
 * migrate nothing.
 *
 * `exclude` names the property a caller-intent `retype` /
 * `narrow-options` migration already owns in the same call, so its
 * rows aren't rewritten twice. Matching is same-name only: a rename
 * is indistinguishable from remove+add at this layer and never
 * reports (the rename arm owns its keys — including casting values
 * INTO its destinations — while a merge-rename destination's
 * OWN-population type change still surfaces here as a retype, which
 * runs before the rename arm and composes with its conflict rule). A
 * malformed or absent stored schema yields no transitions — detection
 * fails open to "nothing to migrate".
 */
function detectPropertyTransitions(
	stored: unknown,
	next: CaseTypeJsonSchema,
	exclude: string | undefined,
): PropertyTransitions {
	const none: PropertyTransitions = { flips: [], retypes: [], widenings: [] };
	if (typeof stored !== "object" || stored === null) return none;
	const storedProps = (stored as { properties?: unknown }).properties;
	if (typeof storedProps !== "object" || storedProps === null) return none;
	const storedByName = storedProps as Record<string, unknown>;

	const flips: ShapeFlip[] = [];
	const retypes: DetectedRetype[] = [];
	const widenings: string[] = [];
	for (const [name, nextProp] of Object.entries(next.properties)) {
		if (name === exclude) continue;
		const fromType = dataTypeTokenOf(storedByName[name]);
		const toType = dataTypeTokenOf(nextProp);
		if (fromType === undefined || toType === undefined) continue;
		if (fromType === toType) continue;
		if (castIsIdentityWidening(fromType, toType)) {
			widenings.push(name);
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
 * Normalize a time-of-day fragment to `HH:MM:SS` plus an explicit
 * offset. Strict `format: "time"` (RFC 3339 full-time) REQUIRES the
 * offset; Nova authors no app timezone, so an offset-less value reads
 * as UTC — the same stance the exact-day search helpers and the
 * sample generator take. Fractional seconds drop (one canonical
 * shape). Anything the padding can't make conformant is left for the
 * conformance check to reject.
 */
function normalizeTimeOfDay(fragment: string): string {
	const withoutFraction = fragment.replace(/\.\d+/, "");
	const withSeconds = /^\d{2}:\d{2}$/.test(withoutFraction)
		? `${withoutFraction}:00`
		: withoutFraction;
	return /(?:Z|[+-]\d{2}:\d{2})$/.test(withSeconds)
		? withSeconds
		: `${withSeconds}Z`;
}

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
			// explicit offset survives the cut); a bare time pads to the
			// offset-carrying canonical shape.
			const trimmed = stringValue.trim();
			const tIndex = trimmed.indexOf("T");
			return {
				ok: true,
				value: normalizeTimeOfDay(
					tIndex >= 0 ? trimmed.slice(tIndex + 1) : trimmed,
				),
			};
		}
		case "datetime": {
			const trimmed = stringValue.trim();
			if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
				// A bare date extends to midnight UTC — Nova authors no
				// app timezone, so UTC is the codebase-wide reading of an
				// offset-less temporal value.
				return { ok: true, value: `${trimmed}T00:00:00.000Z` };
			}
			if (
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)
			) {
				// The offset-less `datetime-local` shape: pad seconds to
				// the full RFC 3339 grammar and read the wall-clock as UTC.
				const withSeconds = /T\d{2}:\d{2}$/.test(trimmed)
					? `${trimmed}:00`
					: trimmed;
				return { ok: true, value: `${withSeconds}Z` };
			}
			// Already canonical (or garbage) — conformance adjudicates.
			return { ok: true, value: trimmed };
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
 */
interface LiveIndex {
	name: string;
	isValid: boolean;
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
const INDEX_SCOPE_TAG_LENGTH = 12;

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
export function indexScopeTag(appId: string, caseType: string): string {
	return createHash("sha256")
		.update(`${appId} ${caseType}`)
		.digest("hex")
		.slice(0, INDEX_SCOPE_TAG_LENGTH);
}

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
export function propertyIndexTag(property: string): string {
	return createHash("sha256")
		.update(property)
		.digest("hex")
		.slice(0, INDEX_SCOPE_TAG_LENGTH);
}

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
					"Both identity segments are fixed-width hashes, so a composed name is at most 40 bytes and this throw is unreachable in the current scheme — reaching it means a name segment regained a variable length. Restore fixed-width composition so the `readLiveIndexSet` name-prefix contract holds.\n\nHint: keep every non-`mode` name segment fixed-width.",
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
 * The query joins `pg_index` + `pg_class` (twice — once for the
 * index, once for the underlying table) + `pg_namespace` rather
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
	// `n.nspname = current_schema()` matches `pg_indexes`'s implicit
	// scoping; `t.relname = 'cases'` pins the underlying table.
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
		isvalid: boolean;
	}>`SELECT c.relname AS indexname, i.indisvalid AS isvalid
		FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_class t ON t.oid = i.indrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = current_schema()
		  AND t.relname = 'cases'
		  AND c.relname LIKE ${prefix} ESCAPE '\\'`.execute(executor);
	const live = new Map<string, LiveIndex>();
	for (const row of result.rows) {
		live.set(row.indexname, {
			name: row.indexname,
			isValid: row.isvalid,
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
		if (!liveEntry.isValid) {
			// INVALID artifact from a prior failed CONCURRENTLY build:
			// drop and recreate.
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
