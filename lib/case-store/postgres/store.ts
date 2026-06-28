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
import { type Insertable, type Kysely, sql, type Transaction } from "kysely";
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
} from "@/lib/domain/predicate/jsonSchema";
import type { RelationPath } from "@/lib/domain/predicate/types";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
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
	CasesQuarantineTable,
	CasesTable,
	Database,
	JsonObject,
	JsonValue,
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

	async query(args: QueryArgs): Promise<CaseRowWithCalculated[]> {
		const calculated: ReadonlyArray<CalculatedColumn> = args.calculated ?? [];

		const ctx = this.buildPredicateContext({
			db: this.db,
			appId: args.appId,
			caseType: args.caseType,
			schemas: args.caseTypeSchemas ?? new Map(),
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
		await this.validateProperties({
			appId: args.appId,
			caseType: args.row.case_type,
			properties: propertiesObject,
		});

		// `properties` re-stringifies because `Insertable<CasesTable>`'s
		// JSONB insert side is a JSON string for pg's JSONB cast. The
		// caller may pass either string or `JsonObject`; both converge
		// through `parseJsonbInput` and stringify back to wire form
		// here. Without this, a `JsonObject` caller silently writes
		// `[object Object]` (pg's parameter binder calls `String(value)`
		// on non-string inputs to a text-cast slot).
		const insertRow: Insertable<CasesTable> = {
			...args.row,
			app_id: args.appId,
			project_id: this.requireProjectId(),
			owner_id: this.requireActorUserId(),
			properties: JSON.stringify(propertiesObject),
		};

		// One transaction across cases + case_indices so a derived
		// edge insert can't observe a partial cases-row commit.
		return await this.db.transaction().execute(async (trx) => {
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
			const primaryRow: Insertable<CasesTable> = {
				...args.primary,
				case_id: primaryCaseId,
				app_id: args.appId,
				project_id: this.requireProjectId(),
				owner_id: this.requireActorUserId(),
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

		const insertRows: Insertable<CasesTable>[] = args.rows.map((row, index) => {
			const propertiesObject = parseJsonbInput(row.properties);
			const ok = validator(propertiesObject);
			if (!ok) {
				const failures = (validator.errors ?? []).map(ajvErrorToCaseFailure);
				throw new CasePropertiesValidationError(args.appId, caseType, failures);
			}
			return {
				...row,
				case_id: caseIds[index],
				app_id: args.appId,
				project_id: this.requireProjectId(),
				owner_id: this.requireActorUserId(),
				properties: JSON.stringify(propertiesObject),
			};
		});

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
			const mergedProperties =
				args.patch.properties !== undefined
					? {
							...existing.properties,
							...parseJsonbInput(args.patch.properties),
						}
					: undefined;
			if (mergedProperties !== undefined) {
				await this.validateProperties({
					appId: args.appId,
					caseType: existing.case_type,
					properties: mergedProperties,
					executor: trx,
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

	async close(args: {
		appId: string;
		caseId: string;
		status?: string;
	}): Promise<void> {
		// `closed_on IS NULL` makes close idempotent on row state:
		// an already-closed row is excluded so its `closed_on` keeps
		// the original timestamp. The same filter also prevents a
		// stray `status` patch on an already-closed row from sliding
		// through — status changes on closed rows go through `update`.
		await this.db
			.updateTable("cases as c")
			.set({
				closed_on: sql<Date>`now()`,
				modified_on: sql<Date>`now()`,
				...(args.status !== undefined ? { status: args.status } : {}),
			})
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.project_id", "=", this.requireProjectId())
			.where("c.closed_on", "is", null)
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

		// Phase A: schema sync + per-row migration in one transaction.
		const report = await this.db.transaction().execute(async (trx) => {
			// Step 1: schema regen + UPSERT. Always runs.
			await trx
				.insertInto("case_type_schemas")
				.values({
					app_id: args.appId,
					case_type: args.caseType,
					schema: JSON.stringify(schema),
				})
				.onConflict((oc) =>
					oc.columns(["app_id", "case_type"]).doUpdateSet({
						schema: JSON.stringify(schema),
					}),
				)
				.execute();

			// Step 2: per-row migration. Additive blueprint mutations
			// (no `change`) skip this — adding a property still emits
			// its expression index in Phase B, but the row population
			// doesn't need migrating.
			if (args.change === undefined) {
				return {
					migrated: 0,
					quarantined: 0,
					skipped: 0,
					failureReasons: [],
				};
			}
			if (args.property === undefined) {
				throw new Error(
					compilerBugMessage({
						where: "case-store.PostgresCaseStore.applySchemaChange",
						invariant:
							"`property` is undefined while `change` is defined; the change shape targets a specific property and the migration loop reads from it",
						detail:
							"The `ApplySchemaChangeArgs` contract pairs `change` and `property` — `change` describes WHAT shifts (`rename` / `retype` / `narrow-options`); `property` names WHICH property the shift targets. Reaching this throw means the caller passed `change` but omitted `property`. Hint: pass `property` alongside `change` at the call site.",
					}),
				);
			}
			return await this.runPerRowMigration(trx, {
				appId: args.appId,
				caseType: args.caseType,
				property: args.property,
				change: args.change,
				schema,
			});
		});

		// Phase B: per-property expression-index DDL. Runs against
		// the post-commit state so quarantine deletes have committed
		// and the heap scan sees clean rows. Failure leaves Phase A
		// intact; the next call retries idempotently via the
		// `indisvalid`-aware catalog diff.
		await this.syncExpressionIndexes({
			appId: args.appId,
			caseType: args.caseType,
			desired: desiredIndexes,
		});

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

	async generateSampleData(
		args: GenerateSampleDataArgs,
	): Promise<{ inserted: number }> {
		// Transactional body lives in `generateSampleDataInTransaction`
		// so `resetSampleData` can pass its own `trx` and the full
		// delete + regenerate runs as one Postgres transaction.
		return await this.db.transaction().execute(async (trx) => {
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
			// `case_indices` references are caller-managed (no FK
			// constraint) — delete first so orphan edges don't
			// accumulate.
			await trx
				.deleteFrom("case_indices")
				.where("case_id", "in", (eb) =>
					eb
						.selectFrom("cases")
						.select("case_id")
						.where("app_id", "=", args.appId)
						.where("case_type", "=", caseTypeName)
						.where("project_id", "=", this.requireProjectId()),
				)
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
	 * Three arms: `rename(from, to)`, `retype(fromType, toType)`, and
	 * `narrow-options(removedOptions)`. Cast / option-set failures
	 * move to `cases_quarantine` with the original value + failure
	 * reason.
	 */
	private async runPerRowMigration(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			property: string;
			change: SchemaChangeKind;
			schema: CaseTypeJsonSchema;
		},
	): Promise<MigrationReport> {
		switch (args.change.kind) {
			case "rename":
				return await this.runRenameMigration(trx, {
					appId: args.appId,
					caseType: args.caseType,
					from: args.change.from,
					to: args.change.to,
				});
			case "retype":
				return await this.runRetypeMigration(trx, {
					appId: args.appId,
					caseType: args.caseType,
					property: args.property,
					fromType: args.change.fromType,
					toType: args.change.toType,
				});
			case "narrow-options":
				return await this.runNarrowOptionsMigration(trx, {
					appId: args.appId,
					caseType: args.caseType,
					property: args.property,
					removedOptions: args.change.removedOptions,
				});
		}
	}

	/**
	 * Rename a JSONB property key. SQL:
	 * `properties = jsonb_set(properties #- '{from}', '{to}',
	 * properties->'from')` — the `#-` operator drops the old key
	 * and `jsonb_set` adds the new with the old value. One UPDATE
	 * bounded by `properties ? 'from'` so rows missing the key
	 * don't pay a no-op write.
	 */
	private async runRenameMigration(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			from: string;
			to: string;
		},
	): Promise<MigrationReport> {
		// Count the full row population first so `migrated` from the
		// UPDATE pairs with an accurate `skipped` count. Both queries
		// share the caller's transaction so no concurrent inserter
		// can land between them.
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

		// `sql.lit` flows the JSONB key as a SQL string literal —
		// `jsonb_set`'s path argument and `#-`'s right operand are
		// both `text[]`, which the typed builder constructs via
		// `ARRAY['key']`.
		const from = args.from;
		const to = args.to;
		const updated = await trx
			.updateTable("cases as c")
			.set({
				properties: sql`jsonb_set(c.properties #- ARRAY[${sql.lit(from)}]::text[], ARRAY[${sql.lit(to)}]::text[], c.properties->${sql.lit(from)})`,
				modified_on: sql`now()`,
			})
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where(sql<boolean>`c.properties ? ${sql.lit(from)}`)
			.executeTakeFirst();

		const migrated = Number(updated.numUpdatedRows ?? 0);
		const skipped = totalCount - migrated;
		return {
			migrated,
			quarantined: 0,
			skipped,
			failureReasons: [],
		};
	}

	/**
	 * Retype: cast each row's value; on success UPDATE in place, on
	 * failure move to `cases_quarantine`. Classification runs in
	 * TypeScript because the Postgres-side cast produces a
	 * transaction-fatal exception on the first bad value, and
	 * per-row quarantine needs per-row failure observation. The
	 * writes then flow through bulk SQL — five round-trips total
	 * regardless of row count.
	 */
	private async runRetypeMigration(
		trx: Transaction<Database>,
		args: {
			appId: string;
			caseType: string;
			property: string;
			fromType: CasePropertyDataType;
			toType: CasePropertyDataType;
		},
	): Promise<MigrationReport> {
		const rows = await trx
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.execute();

		const migratedRows: { caseId: string; newProperties: JsonObject }[] = [];
		const quarantinedRows: { row: CaseRow; reason: string }[] = [];
		let skipped = 0;
		const failureReasons: string[] = [];

		for (const row of rows) {
			const propsRecord = row.properties;
			const rawValue = propsRecord[args.property];
			if (rawValue === undefined || rawValue === null) {
				skipped++;
				continue;
			}

			const cast = tryCastValue(rawValue, args.toType);
			if (cast.ok) {
				migratedRows.push({
					caseId: row.case_id,
					newProperties: {
						...propsRecord,
						[args.property]: cast.value as JsonValue,
					},
				});
			} else {
				const reason = `cast ${args.fromType}→${args.toType} failed for property '${args.property}': ${cast.reason}`;
				quarantinedRows.push({ row, reason });
				failureReasons.push(reason);
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

		if (quarantinedRows.length > 0) {
			await this.bulkQuarantine(trx, args.appId, quarantinedRows);
		}

		return {
			migrated: migratedRows.length,
			quarantined: quarantinedRows.length,
			skipped,
			failureReasons,
		};
	}

	/**
	 * Narrow-options: rows whose property value (or any multi-select
	 * array element) is in the removed set move to quarantine. Multi-
	 * select rows quarantine if ANY element is removed — partial
	 * intersections still represent a row whose stored shape
	 * contradicts the new schema. Three round-trips total.
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

		const quarantinedRows: { row: CaseRow; reason: string }[] = [];
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

			const reason = `option '${conflict}' removed from property '${args.property}'`;
			quarantinedRows.push({ row, reason });
			failureReasons.push(reason);
		}

		if (quarantinedRows.length > 0) {
			await this.bulkQuarantine(trx, args.appId, quarantinedRows);
		}

		return {
			migrated: 0,
			quarantined: quarantinedRows.length,
			skipped,
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
	 * Move a batch of rows to `cases_quarantine` and remove them
	 * from `cases` + `case_indices`. Three bulk statements regardless
	 * of row count. `quarantined_at` defaults server-side. `appId` is
	 * passed explicitly rather than read off `entries[0]` so the
	 * helper stays well-defined for empty inputs.
	 */
	private async bulkQuarantine(
		trx: Transaction<Database>,
		appId: string,
		entries: ReadonlyArray<{ row: CaseRow; reason: string }>,
	): Promise<void> {
		if (entries.length === 0) return;
		const payloads: Insertable<CasesQuarantineTable>[] = entries.map(
			({ row, reason }) => ({
				case_id: row.case_id,
				app_id: row.app_id,
				case_type: row.case_type,
				owner_id: row.owner_id,
				status: row.status,
				opened_on: row.opened_on,
				modified_on: row.modified_on,
				closed_on: row.closed_on,
				case_name: row.case_name,
				parent_case_id: row.parent_case_id,
				properties: JSON.stringify(row.properties),
				quarantine_reason: reason,
			}),
		);
		const caseIds = entries.map((e) => e.row.case_id);

		await trx.insertInto("cases_quarantine").values(payloads).execute();

		await trx
			.deleteFrom("case_indices")
			.where("case_indices.case_id", "in", caseIds)
			.execute();

		// App-scoped DELETE, matching the per-row migration's app-scoped
		// SELECT: the explicit `case_id IN` list already pins the exact
		// rows, and `app_id` keeps it within the app's partition. No
		// tenant filter — a schema change quarantines every member's bad
		// rows, not just the actor's.
		await trx
			.deleteFrom("cases as c")
			.where("c.case_id", "in", caseIds)
			.where("c.app_id", "=", appId)
			.execute();
	}

	/**
	 * Validate a candidate `properties` payload against the case
	 * type's JSON Schema. Throws on failure; returns on success.
	 *
	 * `executor` selects the connection for the schema read. Call
	 * sites already inside a Kysely transaction MUST pass the
	 * transaction handle. Without that thread-through, a `pg.Pool`
	 * with `max: 1` (the per-test harness's size) deadlocks because
	 * the pool's only connection is held by the in-flight
	 * transaction. The shape is structural even at larger pool
	 * sizes; sharing the executor is the fix.
	 */
	private async validateProperties(args: {
		appId: string;
		caseType: string;
		properties: Record<string, unknown>;
		executor?: Kysely<Database> | Transaction<Database>;
	}): Promise<void> {
		const validator = await this.getValidator(
			args.appId,
			args.caseType,
			args.executor ?? this.db,
		);
		const ok = validator(args.properties);
		if (!ok) {
			// Project AJV's errors onto `CasePropertyFailure` so API
			// routes get one consistent shape across per-row and bulk
			// paths — `ajvErrorToCaseFailure` names the offending key on
			// an `additionalProperties` failure (AJV's default message
			// doesn't).
			const failures = (validator.errors ?? []).map(ajvErrorToCaseFailure);
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
	 * Throws `SchemaNotSyncedError` when no schema row exists; the
	 * blueprint mutator must run `applySchemaChange` first so the
	 * row is materialized before any write reaches this validator.
	 * `executor` shares the transaction (see `validateProperties`
	 * for the deadlock rationale).
	 */
	private async getValidator(
		appId: string,
		caseType: string,
		executor: Kysely<Database> | Transaction<Database>,
	): Promise<ValidateFunction<unknown>> {
		const row = await executor
			.selectFrom("case_type_schemas")
			.select("schema")
			.where("app_id", "=", appId)
			.where("case_type", "=", caseType)
			.executeTakeFirst();
		if (row === undefined) {
			throw new SchemaNotSyncedError(appId, caseType);
		}

		const schemaJson = JSON.stringify(row.schema);
		const cacheKey = `${appId}::${caseType}`;
		const cached = this.validatorCache.get(cacheKey);
		if (cached !== undefined && cached.schemaJson === schemaJson) {
			return cached.validate;
		}

		const validate = this.ajv.compile(row.schema as object);
		this.validatorCache.set(cacheKey, { schemaJson, validate });
		return validate;
	}

	/** Centralized factory so schema-map + bindings defaults stay aligned across every predicate-compile site. */
	private buildPredicateContext(args: {
		db: Kysely<Database>;
		appId: string;
		caseType: string;
		schemas: ReadonlyMap<string, CaseType>;
	}): PredicateCompileContext {
		return {
			db: args.db,
			appId: args.appId,
			projectId: this.requireProjectId(),
			anchorAlias: "c",
			caseTypeSchemas: args.schemas,
			bindings: {},
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

/** Cast result for a retype migration's per-row attempt. */
type CastResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Try to cast a stored value to the new property data type during
 * a `retype` per-row migration. Failure cases surface a descriptive
 * `reason` that flows into `cases_quarantine.quarantine_reason`.
 * Exhaustive over `CasePropertyDataType`.
 */
function tryCastValue(
	value: unknown,
	toType: CasePropertyDataType,
): CastResult {
	const stringValue = typeof value === "string" ? value : String(value);

	switch (toType) {
		case "text":
		case "single_select":
		case "geopoint":
			// Geopoint admits any string here; deeper geopoint
			// validation is the JSON Schema's job at re-insert.
			return { ok: true, value: stringValue };
		case "int": {
			const trimmed = stringValue.trim();
			if (!/^-?\d+$/.test(trimmed)) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(stringValue)} is not an integer`,
				};
			}
			return { ok: true, value: Number.parseInt(trimmed, 10) };
		}
		case "decimal": {
			const trimmed = stringValue.trim();
			const parsed = Number(trimmed);
			if (!Number.isFinite(parsed)) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(stringValue)} is not a number`,
				};
			}
			return { ok: true, value: parsed };
		}
		case "date":
			if (!/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(stringValue)} is not an ISO date (YYYY-MM-DD)`,
				};
			}
			return { ok: true, value: stringValue };
		case "time":
			if (!/^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(stringValue)) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(stringValue)} is not an ISO time`,
				};
			}
			return { ok: true, value: stringValue };
		case "datetime":
			if (Number.isNaN(Date.parse(stringValue))) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(stringValue)} is not parseable as a datetime`,
				};
			}
			return { ok: true, value: stringValue };
		case "multi_select":
			if (Array.isArray(value)) {
				return { ok: true, value };
			}
			// Scalar → one-element array (the lift used when retyping
			// any scalar data type to multi_select).
			return { ok: true, value: [stringValue] };
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
 * separator can't appear in either fragment (Firestore app ids are
 * alphanumeric; case-type names follow `CASE_PROPERTY_PATTERN`), so
 * `("ab","c")` and `("a","bc")` never collide. SHA-256 is
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
