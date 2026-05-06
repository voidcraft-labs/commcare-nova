// lib/case-store/postgres/store.ts
//
// `PostgresCaseStore` — the only implementation of the `CaseStore`
// interface. Wraps the `Kysely<Database>` instance, threading the
// AST→Kysely predicate / expression / relation-path compilers into
// the live runtime. Spec source:
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
// "CaseStore — Cloud SQL Postgres from day-1" section
// (lines 350-389) and "Schema migration policy" (lines 309-340).
//
// ## Tenant scoping is anchored on the bound owner
//
// The constructor takes the owner id at construction; every method
// internally adds `WHERE owner_id = <bound userId>` to the outer
// query. The compiler stack handles the JOIN-side filter inside
// relation walks (see `lib/case-store/sql/compileRelationPath.ts`);
// this module owns the outer-scan filter on every method's
// underlying SELECT / UPDATE / DELETE.
//
// ## JSON Schema validation runs at the API trust boundary
//
// `insert` and `update` validate the candidate `properties` payload
// against `case_type_schemas[appId, caseType].schema` via `ajv`
// before any write hits Postgres. The schema row is fetched on
// demand and the compiled validator is cached per
// `(appId, caseType, schemaContent)` so repeated writes don't pay
// the compile cost. Spec § "Write-time validation" (lines 297-301):
// the API route is the trust boundary; the database is internal.
// No in-database trigger, no `pg_jsonschema` dependency.
//
// ## `applySchemaChange` runs in two phases
//
// **Phase A (one Kysely transaction):**
//
//   1. **Schema sync** — regenerate the JSON Schema via
//      `caseTypeToJsonSchema` and UPSERT into `case_type_schemas`.
//   2. **Per-row migration** — only when `change` is supplied. The
//      three `change` arms are:
//      - `rename(from, to)` — JSONB key rename in one UPDATE.
//      - `retype(fromType, toType)` — per-row cast attempt; cast
//        failures move to `cases_quarantine`.
//      - `narrow-options(removedOptions)` — rows with the removed
//        value move to `cases_quarantine`.
//
// Phase A commits when both steps succeed and rolls back atomically
// on failure. The schema row + data are always consistent with each
// other — the database never holds a new schema with rows that fail
// validation against it.
//
// **Phase B (no transaction, runs after Phase A commits):**
//
//   3. **Per-property expression-index DDL emission** — always runs.
//      Computes the desired index set for the case-type from the
//      blueprint (per-`data_type` mode derivation), reads the live
//      index set from `pg_indexes`, emits the matching `DROP INDEX`
//      / `CREATE INDEX` statements for the diff. Naming convention
//      `cases_<case_type>_<property>_<mode>` keys each index by its
//      `(case_type, property, mode)` tuple so the diff is mechanical
//      across blueprint mutations.
//
// ## Why DDL is split out of Phase A's transaction
//
// PostgreSQL's `CREATE INDEX` (non-`CONCURRENTLY`) heap-scans with
// `SnapshotAny` semantics, which includes recently-deleted but
// not-yet-vacuumed tuples. Inside the same transaction as Phase A's
// per-row migration, a retype that moves a non-castable row to
// `cases_quarantine` (DELETE from `cases` + INSERT into
// `cases_quarantine`) leaves a dead tuple in `cases`'s heap. A
// subsequent in-transaction `CREATE INDEX` over the new typed
// expression scans that dead tuple and fails the cast on its
// pre-migration value — the `text → int` retype's `"abc"`
// quarantined row trips `((properties->>'X')::integer)`, rolling
// back the transaction and defeating quarantine.
//
// Phase B uses `CREATE INDEX CONCURRENTLY`, which carries two
// design properties Phase B requires: (1) it uses MVCC snapshot
// semantics strict enough to ignore tuples being modified by
// concurrent (or recently committed) transactions, so dead tuples
// from Phase A's quarantine DELETE are excluded from the heap
// scan; (2) it cannot run inside an outer transaction, which
// aligns with the non-transactional shape Phase B adopts for the
// SnapshotAny reason above. As a side benefit, CONCURRENTLY does
// not hold `ACCESS EXCLUSIVE` on `cases` for the build's
// duration — concurrent reads and writes against `cases` keep
// working while the index builds, which matters for production
// case-types large enough that the build takes seconds.
//
// ## Phase B failure semantics
//
// Schema and data are always consistent. Phase B's CREATE INDEX
// statements run after Phase A's commit; a failure mid-Phase-B
// throws, the schema row + per-row migration are already
// committed, and the next `applySchemaChange` call diffs against
// `pg_indexes` and re-emits whatever drops + creates remain
// outstanding. Missing indexes degrade query performance but
// never correctness — the term compiler's emitted SQL falls back
// to a sequential scan over the case-type partial-predicate
// without one.
//
// ## Pre-flight identifier validation runs BEFORE Phase A
//
// `computeDesiredIndexSet` runs synchronously at the top of
// `applySchemaChange`, before the transaction opens. Property
// names and case-type names compose into the index name through
// `indexName`, which throws on identifier-shape violations
// (non-alphanumeric+underscore+hyphen characters, post-transform
// collisions between hyphenated and underscored siblings, and the
// 63-byte identifier cap). A throw at this point leaves
// `case_type_schemas` untouched — the database never holds a
// schema row whose properties cannot all be indexed.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { type Insertable, type Kysely, sql, type Transaction } from "kysely";
import { v7 as uuidv7 } from "uuid";
import type {
	BlueprintDoc,
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
import { CaseNotFoundError, CasePropertiesValidationError } from "../errors";
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
} from "../sql/database";
import type {
	ApplySchemaChangeArgs,
	CaseInsert,
	CaseRow,
	CaseStore,
	CaseUpdate,
	GenerateSampleDataArgs,
	MigrationReport,
	QueryArgs,
	ResetSampleDataArgs,
	SchemaChangeKind,
} from "../store";
import { buildCaseTypeMap, findCaseTypeOrThrow } from "../store";

// ---------------------------------------------------------------
// Constructor args
// ---------------------------------------------------------------

/**
 * Construction arguments. All three fields are required: the owner
 * id pins tenant scope; the Kysely instance is the connection root
 * the store binds against; the sample generator is the seam
 * `generateSampleData` and `resetSampleData` route through.
 *
 * Production callers go through `withOwnerContext(userId)` which
 * resolves `db` from `getCaseStoreDatabase()` and wires the default
 * `HeuristicCaseGenerator`. Tests construct directly with a per-
 * test isolated Kysely instance and either the heuristic generator
 * or a stub.
 */
export interface PostgresCaseStoreArgs {
	/** The owner id every method's WHERE clause filters on. */
	ownerId: string;
	/** The bound Kysely instance — production singleton or per-test fixture. */
	db: Kysely<Database>;
	/**
	 * The bound `SampleCaseGenerator`. `generateSampleData` and
	 * `resetSampleData` invoke `generator.generate(...)` to build
	 * the row population; the store then routes those rows through
	 * `this.insert(...)` so generated rows participate in the same
	 * JSON Schema validation + `case_indices` derivation real
	 * inserts use.
	 */
	sampleGenerator: SampleCaseGenerator;
}

// ---------------------------------------------------------------
// Validator cache
// ---------------------------------------------------------------

/**
 * One ajv instance per `PostgresCaseStore` instance. Reusing one
 * ajv across compilations (rather than per-validator) lets ajv's
 * internal schema cache amortize keyword resolution across
 * different case-type schemas.
 *
 * `Ajv2020` is the draft 2020-12 export — matches the JSON Schema
 * draft level `caseTypeToJsonSchema` produces. `addFormats` wires
 * the `format: date` / `format: time` / `format: date-time`
 * handlers the temporal-property arms of `caseTypeToJsonSchema`
 * emit; without it, the formats are unrecognized and the schema
 * silently passes any string. `strict: false` admits extra ajv
 * keywords (the schema generator is intentionally loose per its
 * file-level comment).
 */
function buildAjv(): Ajv2020 {
	const ajv = new Ajv2020({ strict: false });
	addFormats(ajv);
	return ajv;
}

/**
 * Cached compiled-validator entry. The schema is captured by
 * reference; cache lookups compare against the JSON-stringified
 * schema content so a `case_type_schemas` row update invalidates
 * the cached validator without manual eviction.
 */
interface ValidatorCacheEntry {
	/** JSON-stringified schema — the cache key invariant. */
	schemaJson: string;
	/** The ajv-compiled validator. */
	validate: ValidateFunction<unknown>;
}

// ---------------------------------------------------------------
// `PostgresCaseStore`
// ---------------------------------------------------------------

/**
 * The Postgres-backed implementation of `CaseStore`. Constructed
 * via `withOwnerContext` in production; tests construct directly
 * with an isolated Kysely instance.
 */
export class PostgresCaseStore implements CaseStore {
	private readonly ownerId: string;
	private readonly db: Kysely<Database>;
	private readonly ajv: Ajv2020;
	private readonly validatorCache: Map<string, ValidatorCacheEntry>;
	private readonly sampleGenerator: SampleCaseGenerator;

	constructor(args: PostgresCaseStoreArgs) {
		this.ownerId = args.ownerId;
		this.db = args.db;
		this.ajv = buildAjv();
		this.validatorCache = new Map();
		this.sampleGenerator = args.sampleGenerator;
	}

	// -----------------------------------------------------------
	// `query` — predicate-driven SELECT
	// -----------------------------------------------------------

	async query(args: QueryArgs): Promise<CaseRow[]> {
		const ctx = this.buildPredicateContext({
			db: this.db,
			appId: args.appId,
			caseType: args.caseType,
			schemas: buildCaseTypeMap(args.blueprint),
		});

		// Outer query owns the `(app_id, owner_id)` tenant filter
		// per the foundation contract — `compileRelationPath` only
		// enforces the filter on JOIN-ed cases inside relation
		// walks. The case-type filter pins the SELECT to the
		// requested type so cross-type reads aren't accidentally
		// admitted.
		let qb = this.db
			.selectFrom("cases as c")
			.selectAll("c")
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where("c.owner_id", "=", this.ownerId);

		if (args.predicate !== undefined) {
			qb = qb.where(compilePredicate(args.predicate, ctx));
		}

		// Sort keys compile through `compileExpression` against
		// the thunk-wired context the predicate compiler exposes
		// via `expressionContextFor` — that same lift handles the
		// cycle break for the predicate-bearing arms (`if.cond`,
		// `count.where`) the expression compiler may recurse into.
		if (args.sort !== undefined) {
			const exprCtx = expressionContextFor(ctx);
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

		return await qb.execute();
	}

	// -----------------------------------------------------------
	// `insert` — schema-validated row write
	// -----------------------------------------------------------

	async insert(args: {
		appId: string;
		row: CaseInsert;
	}): Promise<{ caseId: string }> {
		// Validate the candidate `properties` payload against the
		// case-type's JSON Schema before any write. The schema row
		// is read on demand and the compiled validator is cached.
		const propertiesObject = parseJsonbInput(args.row.properties);
		await this.validateProperties({
			appId: args.appId,
			caseType: args.row.case_type,
			properties: propertiesObject,
		});

		// `owner_id` and `app_id` are imposed at the boundary:
		// `CaseInsert` excludes both, and the WRITE shape merges
		// the caller's row with the bound owner + the top-level
		// `appId` argument. Tenant scoping at the write side is
		// structurally impossible to bypass.
		//
		// `properties` flows through `JSON.stringify` because
		// `Insertable<CasesTable>`'s `properties` shape (the
		// `JSONColumnType<JsonObject>` insert side) is a JSON
		// string for pg's JSONB cast. The caller may pass either
		// a string or a `JsonObject` to `CaseInsert`; both shapes
		// converge through `parseJsonbInput` above, and the parsed
		// object stringifies back to the wire form here. Without
		// this, a `JsonObject` caller would silently write
		// `[object Object]` because pg's parameter binder calls
		// `String(value)` on non-string inputs to a text-cast slot.
		const insertRow: Insertable<CasesTable> = {
			...args.row,
			app_id: args.appId,
			owner_id: this.ownerId,
			properties: JSON.stringify(propertiesObject),
		};

		// All writes (cases + case_indices) run inside a single
		// transaction so a derived-edge insert can't observe a
		// partial cases-row commit.
		return await this.db.transaction().execute(async (trx) => {
			const inserted = await trx
				.insertInto("cases")
				.values(insertRow)
				.returning("case_id")
				.executeTakeFirstOrThrow();
			const caseId = inserted.case_id;

			// Derive the direct-edge `case_indices` row from
			// `parent_case_id` if present. Spec § "case_indices
			// materialization policy" Option B (lines 290-295):
			// direct edges only; recursive walks compose at read
			// time via the relation-path compiler. Default
			// `relationship` to `child` — the subcase / extension
			// distinction is a CCHQ relationship-id concern resolved
			// at the relation-path compile site, not at write.
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

	// -----------------------------------------------------------
	// `insertMany` — bulk-insert path for sample-data population
	// -----------------------------------------------------------
	//
	// Package-private; not on the `CaseStore` interface. The
	// per-call surface stays `insert` for every external consumer
	// (form-bridge, direct API writes); `insertMany` is reserved
	// for the sample-data generators where the per-row latency of
	// 30+ sequential `insert` calls is perceptible to a user
	// clicking "Generate sample data".
	//
	// One transaction across the whole batch. Inside it:
	//
	//   1. Fetch the JSON Schema validator ONCE per `(appId,
	//      caseType)` (the per-row path pays a SELECT round-trip
	//      per row even on cache hit; hoisting the fetch is the
	//      single biggest latency win).
	//   2. Pre-process every row in a pure TS loop: parse the
	//      properties shape, run AJV against the cached validator,
	//      reject on the first failure.
	//   3. Bulk INSERT into `cases`.
	//   4. Bulk INSERT derived edges into `case_indices`.
	//
	// Total: ~4 round-trips per batch (one schema fetch on cold
	// cache, one cases insert, one optional indices insert, one
	// transaction commit) vs ~30 round-trips for the per-row path.
	//
	// `case_id` is generated up-front in TS via `uuidv7()` rather
	// than relying on Postgres's `DEFAULT uuidv7()` clause. The
	// reason: the bulk shape needs every row's id BEFORE the INSERT
	// runs so the parallel `case_indices` insert can reference each
	// row's `case_id` without depending on `RETURNING`'s ordering
	// guarantees. UUID v7 in TS uses the same RFC 9562 shape as
	// Postgres's built-in (millisecond Unix timestamp prefix), so
	// the B-tree clustering on the primary-key page stays the same.
	//
	// **All-or-nothing failure semantics.** A validation failure on
	// any row aborts the entire batch — the transaction rolls back,
	// zero rows inserted. This is stricter than the per-row `insert`
	// path, which commits earlier rows before hitting a bad one.
	// For sample-data the strictness is the correct shape (the
	// generator either produces clean output for every row or
	// produces nothing); for any future caller with a multi-row
	// "best-effort" requirement, that caller should iterate `insert`
	// and decide per-row failure handling itself.

	/**
	 * Insert a batch of rows in one transaction. Hoists the JSON
	 * Schema validator fetch out of the per-row loop, generates
	 * `case_id`s up-front (so the derived `case_indices` rows can
	 * reference them), bulk-inserts into `cases`, then bulk-inserts
	 * derived edges into `case_indices`.
	 *
	 * Returns the generated case_ids in row-input order.
	 *
	 * Throws `CasePropertiesValidationError` on the first validation
	 * failure; the transaction rolls back so no partial-batch row
	 * lands. All rows must share the same `case_type` (sample-data's
	 * shape; the bulk path's single validator-fetch optimization
	 * depends on it).
	 */
	private async insertMany(args: {
		appId: string;
		rows: ReadonlyArray<CaseInsert>;
	}): Promise<{ caseIds: ReadonlyArray<string> }> {
		// Empty-input arm: skip the transaction entirely. The bulk
		// INSERT statements would otherwise need a non-empty values
		// list, and an empty transaction is a wasted round-trip.
		if (args.rows.length === 0) {
			return { caseIds: [] };
		}

		// All rows in a batch must share one `case_type`. The
		// hoisted-validator optimization is the architectural reason:
		// one validator-fetch per `(appId, caseType)` pair only works
		// when the batch is single-typed. Sample-data generation
		// always operates on one case-type per call (the public
		// `generateSampleData` arg pins `caseType`); future callers
		// with mixed-type batches would need to chunk by case-type
		// at the call site or extend `insertMany` to fetch a per-type
		// validator map.
		const caseTypes = new Set(args.rows.map((row) => row.case_type));
		if (caseTypes.size !== 1) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.insertMany",
					invariant: `every row in an \`insertMany\` batch must share the same \`case_type\`; received ${caseTypes.size} distinct types`,
					detail:
						"The hoisted-validator optimization fetches the JSON Schema validator ONCE per `(appId, caseType)` at the top of the transaction. A mixed-type batch would defeat that optimization or quietly validate every row against the wrong schema. The current callers (`generateSampleData`, `resetSampleData`'s regeneration step) always operate on one case-type at a time, so the constraint is structurally satisfied at every call site.\n\nHint: chunk the batch by `case_type` at the call site, or call `insert` per row if mixed-type ordering matters.",
				}),
			);
		}
		const caseType = args.rows[0]?.case_type;
		if (caseType === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.insertMany",
					invariant:
						"first row's `case_type` is undefined while the input array is non-empty",
					detail:
						"The early-return at the top of the function rejects empty inputs; reaching this throw means an entry in the array was undefined, which would be an upstream lifecycle bug.",
				}),
			);
		}

		// Generate every `case_id` up-front. UUID v7's millisecond
		// timestamp prefix means the ids stay close-to-sorted on the
		// B-tree primary-key page even though every row carries an
		// explicit value (rather than relying on the column default).
		// The runtime narrowing `case_id ?? uuidv7()` lets a caller
		// supply an explicit id (the form-bridge path doesn't, but
		// future callers might) while defaulting to the generator
		// otherwise.
		const caseIds: string[] = args.rows.map((row) => row.case_id ?? uuidv7());

		// One transaction across schema fetch + bulk inserts so the
		// schema-row read participates in the same connection the
		// inserts use. Same atomicity contract the per-row `insert`
		// provides, scaled to the full batch.
		await this.db.transaction().execute(async (trx) => {
			// Hoist the validator fetch out of the per-row loop. One
			// SELECT against `case_type_schemas` (cold cache) or one
			// cache hit (warm cache); validates every row in a tight
			// pure-TS loop afterward.
			const validator = await this.getValidator(args.appId, caseType, trx);

			const insertRows: Insertable<CasesTable>[] = args.rows.map(
				(row, index) => {
					const propertiesObject = parseJsonbInput(row.properties);
					const ok = validator(propertiesObject);
					if (!ok) {
						// Project AJV's failures the same way `insert`
						// does so callers see one consistent error
						// shape across the per-row and bulk paths.
						const failures = (validator.errors ?? []).map((e) => ({
							path: e.instancePath || "",
							message: e.message ?? "invalid",
						}));
						throw new CasePropertiesValidationError(
							args.appId,
							caseType,
							failures,
						);
					}
					return {
						...row,
						case_id: caseIds[index],
						app_id: args.appId,
						owner_id: this.ownerId,
						properties: JSON.stringify(propertiesObject),
					};
				},
			);

			// Bulk INSERT cases first. The derived `case_indices`
			// edges reference `cases.case_id`, but no FK constraint is
			// declared so the order is functional rather than
			// structural — the cases insert must land first because
			// the edges' `ancestor_id` references existing parent rows
			// (not part of THIS batch in the sample-data path, but
			// the constraint shape stays the same). Bulk inserts
			// execute as one statement, so all-or-nothing semantics
			// hold per-statement.
			await trx.insertInto("cases").values(insertRows).execute();

			// Build the parallel `case_indices` insert payload. A row
			// with `parent_case_id` set contributes one direct edge;
			// rows without a parent contribute none. The shape mirrors
			// the per-row `insert` body's edge derivation (Option B
			// materialization: depth=1 direct edges only; recursive
			// walks compose at read time via the relation-path
			// compiler).
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
		});

		return { caseIds };
	}

	// -----------------------------------------------------------
	// `update` — JSONB merge with re-validation
	// -----------------------------------------------------------

	async update(args: {
		appId: string;
		caseId: string;
		patch: CaseUpdate;
	}): Promise<void> {
		// Read the current row inside the transaction so the merge
		// + validate + write sequence is atomic. A separate read
		// followed by a write would race against a concurrent
		// updater of the same row.
		await this.db.transaction().execute(async (trx) => {
			const existing = await trx
				.selectFrom("cases as c")
				.select(["c.case_type", "c.parent_case_id", "c.properties"])
				.where("c.app_id", "=", args.appId)
				.where("c.case_id", "=", args.caseId)
				.where("c.owner_id", "=", this.ownerId)
				.executeTakeFirst();
			if (existing === undefined) {
				// `CaseNotFoundError` covers all three equivalent
				// causes (row never existed, row removed out of band,
				// row outside the bound owner's tenant) without
				// confirming which one tripped — tenant boundaries
				// stay structural rather than message-leaked. API
				// routes catch and map to HTTP 404.
				throw new CaseNotFoundError(args.caseId);
			}

			// Merge the patch's `properties` into the existing
			// document, then re-validate against the case type's
			// schema. Patches without a `properties` slot
			// short-circuit: every other column updates without
			// touching JSONB. Validation runs inside the
			// transaction by passing `trx` as the executor — with
			// `max: 1` pools (the per-test isolation harness's
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

			// Compose the UPDATE shape from the patch's other
			// columns plus the merged properties (when present)
			// and `modified_on = now()`. Properties is split out so
			// the merged-and-stringified form replaces the patch's
			// unmerged value; the rest of the patch (`case_name`,
			// `status`, `opened_on`, `closed_on`, `parent_case_id`)
			// passes through as column writes. `CaseUpdate` is an
			// explicit allowlist that excludes the immutable identity
			// columns (`case_id` / `app_id` / `owner_id` / `case_type`)
			// and the auto-stamped `modified_on`, so no defensive
			// stripping is needed.
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
				.where("c.owner_id", "=", this.ownerId)
				.execute();

			// Re-derive `case_indices` if `parent_case_id`
			// changed. The patch's value is the new edge target;
			// the existing row's value is the old. When both are
			// the same, the edge is unchanged and no rewrite
			// happens. Spec lock: direct-edge-only materialization
			// (Option B); the read path composes recursive walks.
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

	// -----------------------------------------------------------
	// `close` — sets closed_on
	// -----------------------------------------------------------

	async close(args: {
		appId: string;
		caseId: string;
		status?: string;
	}): Promise<void> {
		await this.db
			.updateTable("cases as c")
			.set({
				closed_on: sql<Date>`now()`,
				modified_on: sql<Date>`now()`,
				...(args.status !== undefined ? { status: args.status } : {}),
			})
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.owner_id", "=", this.ownerId)
			.execute();
	}

	// -----------------------------------------------------------
	// `traverse` — RelationPath compile + execute
	// -----------------------------------------------------------

	async traverse(args: {
		appId: string;
		caseId: string;
		via: RelationPath;
	}): Promise<CaseRow[]> {
		// Self-paths return the anchor row unchanged. The compiler
		// returns `{ kind: "self" }` for this case; we short-circuit
		// here rather than synthesize a join-on-self.
		if (args.via.kind === "self") {
			return await this.db
				.selectFrom("cases as c")
				.selectAll("c")
				.where("c.app_id", "=", args.appId)
				.where("c.case_id", "=", args.caseId)
				.where("c.owner_id", "=", this.ownerId)
				.execute();
		}

		// Non-self path: compile the relation-walk subquery, join
		// it against the anchor `cases` row. The leaf alias is
		// `RELATION_PATH_LEAF_ALIAS` at depth 0 (the outermost
		// caller). The compiler enforces tenant scope on every
		// joined `cases` row inside its own subquery; we add the
		// anchor's owner filter at the outer scan.
		const compiled = compileRelationPath(args.via, {
			db: this.db,
			appId: args.appId,
			ownerId: this.ownerId,
			anchorAlias: "c",
		});
		// `compileRelationPath` is exhaustive over `RelationPath`:
		// `self` short-circuited above, the other three arms all
		// return `kind: "joined"`. The narrowing is the type
		// system's structural guarantee.
		if (compiled.kind !== "joined") {
			return [];
		}

		// Build the wider query manually: join the leaf subquery
		// to the anchor row + tenant filter, project the leaf
		// columns. The leaf alias is a runtime string (depth-
		// suffixed for nested walks); the leaf row exposes every
		// `cases` column plus `anchor_case_id`, so the projection
		// pulls every column that makes up a `CaseRow`. Adding a
		// new column to `cases` requires extending this list along
		// with the leaf-builder projections in `compileRelationPath.ts`
		// — a missed column would fall through to `undefined` at
		// runtime even though the type-cast at the bottom of this
		// method narrows to `CaseRow`.
		const leafAlias = compiled.leafAlias;
		const rows = await this.db
			.selectFrom("cases as c")
			.innerJoin(compiled.buildLeafSubquery(), (jb) =>
				jb.onRef(`${leafAlias}.anchor_case_id`, "=", "c.case_id"),
			)
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId)
			.where("c.owner_id", "=", this.ownerId)
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
		// Cast through `unknown` because Kysely's typed builder
		// over runtime-suffixed alias strings widens the leaf's
		// column type — the projection list above pulls each
		// matching `CaseRow` field by name and the runtime shape
		// matches `CaseRow` exactly.
		return rows as unknown as CaseRow[];
	}

	// -----------------------------------------------------------
	// `applySchemaChange` — schema sync + optional migration
	// -----------------------------------------------------------

	async applySchemaChange(
		args: ApplySchemaChangeArgs,
	): Promise<MigrationReport> {
		// Resolve the case type from the prospective blueprint up
		// front. Throws if the blueprint doesn't carry the case
		// type — the caller is responsible for passing a coherent
		// blueprint state.
		const caseType = findCaseTypeOrThrow(args.blueprint, args.caseType);
		const schema = caseTypeToJsonSchema(caseType);

		// Pre-flight: compute the desired index set BEFORE the
		// Phase A transaction opens. `computeDesiredIndexSet` walks
		// the prospective property declarations through `indexName`,
		// which throws on identifier-shape violations (non-conforming
		// characters, post-transform collisions, 63-byte identifier
		// cap). A throw here leaves `case_type_schemas` untouched —
		// the database never holds a schema row whose properties
		// cannot all compose into safe index names. Pure CPU work,
		// no I/O.
		const desiredIndexes = computeDesiredIndexSet(
			args.caseType,
			caseType.properties,
		);

		// Phase A: schema sync + per-row migration in one transaction.
		// COMMITs when both succeed; rolls back atomically on failure.
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

			// Step 2: per-row migration. Only runs when a `change`
			// is supplied. Additive blueprint mutations (the
			// no-`change` path) skip this step — adding a property
			// still emits its expression index in Phase B, but the
			// row population doesn't need migrating.
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

		// Phase B: per-property expression-index DDL sync. Runs
		// against the post-commit state of `cases` so retype's
		// quarantine deletes have committed and the heap scan
		// `CREATE INDEX` runs sees clean rows. Failure surfaces as
		// a thrown error, leaves Phase A's commit intact, and the
		// next `applySchemaChange` call retries Phase B
		// idempotently (the diff against `pg_indexes` re-derives
		// the missing creates / extra drops on every call).
		await this.syncExpressionIndexes({
			caseType: args.caseType,
			desired: desiredIndexes,
		});

		return report;
	}

	/**
	 * Sync the per-property expression indexes for a case type
	 * against the supplied pre-flighted desired set. Reads the live
	 * index set from `pg_indexes`, emits `DROP INDEX` / `CREATE
	 * INDEX` statements for the diff against `this.db` directly
	 * (not inside a transaction — see the file-level "Why DDL is
	 * split out of Phase A's transaction" comment for the
	 * `SnapshotAny` rationale).
	 *
	 * Naming convention `cases_<case_type>_<property>_<mode>` makes
	 * the diff mechanical: a property rename drops the old-name
	 * indexes and creates the new-name indexes; a retype drops the
	 * old type's indexes (text trgm) and creates the new type's
	 * indexes (int btree); a property removal drops every index
	 * keyed on it.
	 *
	 * The `WHERE case_type = '<destination>'` partial-index predicate
	 * scopes each index to one case-type's rows, sharing the
	 * underlying `cases` heap across types but keeping the index
	 * tree per-type-narrow.
	 *
	 * The `desired` set is built by `computeDesiredIndexSet` at
	 * the top of `applySchemaChange` — running pre-flight rather
	 * than inside this method ensures identifier-shape errors
	 * surface BEFORE any transaction opens.
	 */
	private async syncExpressionIndexes(args: {
		caseType: string;
		desired: ReadonlyMap<string, DesiredIndex>;
	}): Promise<void> {
		const live = await readLiveIndexSet(this.db, args.caseType);
		const { creates, drops } = diffIndexSets(args.desired, live);

		// Drops first so a same-name index that's changing shape
		// (e.g. a column-level cast change after retype) drops the
		// old definition before the create attempts to claim the
		// name. The diff's `creates` and `drops` lists are computed
		// with set-difference semantics so a name appearing in both
		// (the changed-shape case) goes through both lists in the
		// right order.
		//
		// `DROP INDEX CONCURRENTLY` matches `CREATE INDEX
		// CONCURRENTLY`: avoids holding `ACCESS EXCLUSIVE` on the
		// underlying table for the drop's duration, and cannot run
		// inside an outer transaction (Phase B is already
		// non-transactional). `IF EXISTS` makes the drop idempotent
		// against a half-completed prior run.
		for (const drop of drops) {
			await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(drop.name)}`.execute(
				this.db,
			);
		}
		for (const create of creates) {
			await emitCreateIndex(this.db, create);
		}
	}

	// -----------------------------------------------------------
	// `generateSampleData` — heuristic generator → bulk insert
	// -----------------------------------------------------------

	async generateSampleData(
		args: GenerateSampleDataArgs,
	): Promise<{ inserted: number }> {
		// Resolve parent ids for the generator's `parentRefs` map.
		// The generator uses these to populate `parent_case_id` on
		// child rows so `case_indices` derivation in `insertMany`
		// produces real edges. When the case-type declares no parent
		// or no parents exist yet, the generator emits orphan rows.
		const parentRefs = await this.resolveParentRefs({
			appId: args.appId,
			caseType: args.caseType,
			blueprint: args.blueprint,
		});

		const rows = this.sampleGenerator.generate({
			blueprint: args.blueprint,
			appId: args.appId,
			caseType: args.caseType,
			count: args.count,
			seed: args.seed,
			parentRefs,
		});

		// Route the full row population through `insertMany`. The
		// architectural seam stays intact: generated rows participate
		// in JSON Schema validation, `case_indices` derivation, and
		// tenant scoping the same way user-authored rows do; the bulk
		// path collapses 30 round-trips to one transaction.
		const { caseIds } = await this.insertMany({
			appId: args.appId,
			rows,
		});
		return { inserted: caseIds.length };
	}

	// -----------------------------------------------------------
	// `resetSampleData` — atomic delete + regenerate
	// -----------------------------------------------------------

	async resetSampleData(
		args: ResetSampleDataArgs,
	): Promise<{ deleted: number; inserted: number }> {
		// Delete the existing rows + their `case_indices` edges in
		// one transaction so the deletion half is atomic — no
		// orphan edges remain if the cases delete fails. The
		// regeneration runs AFTER the delete commits because each
		// row's `insert` opens its own per-row transaction and
		// Postgres rejects a nested BEGIN. A mid-regeneration
		// failure leaves the case-type partially populated; the
		// reset's contract reflects that on the interface.
		const deleted = await this.db.transaction().execute(async (trx) => {
			// `case_indices` references are caller-managed (no FK
			// constraint declared) — delete them first so orphan
			// edges don't accumulate. The `case_id IN (...)`
			// subquery scopes the edge cleanup to rows the case-type
			// owns under the bound tenant.
			await trx
				.deleteFrom("case_indices")
				.where("case_id", "in", (eb) =>
					eb
						.selectFrom("cases")
						.select("case_id")
						.where("app_id", "=", args.appId)
						.where("case_type", "=", args.caseType)
						.where("owner_id", "=", this.ownerId),
				)
				.execute();
			const result = await trx
				.deleteFrom("cases")
				.where("app_id", "=", args.appId)
				.where("case_type", "=", args.caseType)
				.where("owner_id", "=", this.ownerId)
				.executeTakeFirst();
			return Number(result.numDeletedRows ?? 0);
		});

		// Regenerate with a fresh seed. `Date.now()` is the
		// canonical "fresh" source; callers who need a fixed seed
		// invoke `generateSampleData` directly.
		const { inserted } = await this.generateSampleData({
			appId: args.appId,
			caseType: args.caseType,
			count: args.count,
			seed: Date.now().toString(),
			blueprint: args.blueprint,
		});

		return { deleted, inserted };
	}

	// -----------------------------------------------------------
	// Sample-data parent-ref resolution
	// -----------------------------------------------------------

	/**
	 * Build the `parentRefs` map the generator consumes to populate
	 * `parent_case_id` on child rows. For each case type the
	 * blueprint declares as the supplied case type's `parent_type`,
	 * the helper queries the existing case ids in `cases` for the
	 * bound tenant + app and packs them into a `Map`. The generator
	 * picks one id per child row at random.
	 *
	 * When the case type has no `parent_type`, the result is an
	 * empty map — the generator's path produces orphan rows in
	 * that arm.
	 */
	private async resolveParentRefs(args: {
		appId: string;
		caseType: string;
		blueprint: BlueprintDoc;
	}): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
		const matching = args.blueprint.caseTypes?.find(
			(c) => c.name === args.caseType,
		);
		if (matching === undefined || matching.parent_type === undefined) {
			return new Map();
		}
		const parentType = matching.parent_type;
		const parents = await this.db
			.selectFrom("cases")
			.select("case_id")
			.where("app_id", "=", args.appId)
			.where("case_type", "=", parentType)
			.where("owner_id", "=", this.ownerId)
			.execute();
		return new Map([[parentType, parents.map((p) => p.case_id)]]);
	}

	// -----------------------------------------------------------
	// Per-row migration helpers
	// -----------------------------------------------------------

	/**
	 * Run the per-row migration matching the supplied `change`
	 * shape. Spec § "Schema migration policy" (lines 309-340).
	 *
	 * Each arm walks the matching rows via a SELECT inside the
	 * transaction, decides per-row whether to UPDATE in place
	 * or move to `cases_quarantine`, and aggregates the counts
	 * + failure reasons into the returned report.
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
	 * Rename a property key in every row's `properties` JSONB
	 * document. SQL: `properties = jsonb_set(properties #- '{from}',
	 * '{to}', properties->'from')` — the `#-` operator drops the
	 * old key and `jsonb_set` adds the new key with the old key's
	 * value. Rows that don't carry the `from` key are skipped.
	 *
	 * The shape runs in a single UPDATE bounded by `properties ?
	 * 'from'` so rows missing the key don't pay a no-op write.
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
		// Count the case-type's full row population first so the
		// `migrated` count from the UPDATE pairs with an accurate
		// `skipped` count for rows that don't carry the `from` key.
		// The two queries run inside the caller's transaction so
		// the counts are consistent with each other (no concurrent
		// inserter can land between them).
		const totalRow = await trx
			.selectFrom("cases as c")
			.select((eb) => eb.fn.countAll<string>().as("total"))
			.where("c.app_id", "=", args.appId)
			.where("c.case_type", "=", args.caseType)
			.where("c.owner_id", "=", this.ownerId)
			.executeTakeFirstOrThrow();
		const totalCount = Number(totalRow.total);

		// Use `sql.lit` for the JSONB key paths so the value flows
		// as a SQL string literal rather than a parameter — Postgres
		// `jsonb_set` requires a `text[]` path literal, and the
		// `#-` operator's right operand is a `text[]`. Building the
		// path as `array['key']` keeps the typed builder happy.
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
			.where("c.owner_id", "=", this.ownerId)
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
	 * Retype a property's stored values per the spec's policy:
	 * try to cast each row's value to the new type; on success
	 * UPDATE in place, on failure move to `cases_quarantine`.
	 *
	 * Implementation strategy: scan the matching rows, attempt the
	 * cast in TypeScript per row, write the outcome. The
	 * Postgres-side cast (`(properties->>'X')::int`) would be more
	 * efficient at scale but produces a single transaction-fatal
	 * exception on the first bad value — quarantine-by-row needs
	 * per-row failure observation, which a TypeScript-side cast
	 * loop provides cleanly. Migration runs inside the transaction
	 * so a pathological case type with millions of rows still
	 * commits atomically.
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
			.where("c.owner_id", "=", this.ownerId)
			.execute();

		let migrated = 0;
		let quarantined = 0;
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
				const newProps = { ...propsRecord, [args.property]: cast.value };
				await trx
					.updateTable("cases as c")
					.set({
						properties: JSON.stringify(newProps),
						modified_on: sql`now()`,
					})
					.where("c.app_id", "=", args.appId)
					.where("c.case_id", "=", row.case_id)
					.where("c.owner_id", "=", this.ownerId)
					.execute();
				migrated++;
			} else {
				const reason = `cast ${args.fromType}→${args.toType} failed for property '${args.property}': ${cast.reason}`;
				await this.quarantineRow(trx, row, reason);
				failureReasons.push(reason);
				quarantined++;
			}
		}

		return { migrated, quarantined, skipped, failureReasons };
	}

	/**
	 * Narrow-options migration. For every row whose property value
	 * (or any element of its multi-select array) is in the removed
	 * set, move the row to `cases_quarantine` with a reason naming
	 * the disqualified value.
	 *
	 * Single-select rows whose stored value is NOT in `removedOptions`
	 * are skipped (the row is unchanged). Multi-select rows are
	 * quarantined if ANY array element is in `removedOptions` —
	 * partial intersections still represent a row whose stored
	 * shape contradicts the new schema.
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
			.where("c.owner_id", "=", this.ownerId)
			.execute();

		let quarantined = 0;
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
			await this.quarantineRow(trx, row, reason);
			failureReasons.push(reason);
			quarantined++;
		}

		return { migrated: 0, quarantined, skipped, failureReasons };
	}

	/**
	 * Quarantine a row: copy it into `cases_quarantine` with the
	 * supplied `quarantine_reason`, then DELETE from `cases`.
	 * Both writes run inside the caller's transaction; failures
	 * roll back together.
	 *
	 * The shape mirrors the `cases` columns one-for-one (the
	 * quarantine table is a strict superset). `quarantined_at` is
	 * defaulted server-side via the `now()` clause on the column.
	 */
	private async quarantineRow(
		trx: Transaction<Database>,
		row: CaseRow,
		reason: string,
	): Promise<void> {
		const quarantinePayload: Insertable<CasesQuarantineTable> = {
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
			// `quarantined_at` omitted — defaulted server-side via
			// `now()`.
		};
		await trx
			.insertInto("cases_quarantine")
			.values(quarantinePayload)
			.execute();
		// Delete the case_indices edges first (FK-style cleanup is
		// caller-managed because no FK constraint is declared) so
		// orphaned index rows don't accumulate.
		await trx
			.deleteFrom("case_indices")
			.where("case_indices.case_id", "=", row.case_id)
			.execute();
		await trx
			.deleteFrom("cases as c")
			.where("c.case_id", "=", row.case_id)
			.where("c.app_id", "=", row.app_id)
			.execute();
	}

	// -----------------------------------------------------------
	// Validator + schema-map helpers
	// -----------------------------------------------------------

	/**
	 * Validate a candidate `properties` payload against the case
	 * type's JSON Schema. Throws on validation failure with a
	 * descriptive message naming each violation; on success
	 * returns. Schema rows are read from `case_type_schemas` per
	 * `(appId, caseType)`; the compiled validator is cached
	 * keyed by the schema's JSON-stringified content so a schema
	 * update invalidates the cached validator without manual
	 * eviction.
	 *
	 * `executor` selects the connection that issues the schema
	 * read. Defaults to `this.db` (a fresh connection from the
	 * pool); call sites already inside a Kysely transaction pass
	 * the transaction handle so the schema read shares the
	 * transaction's connection. Without that thread-through, a
	 * `pg.Pool` with `max: 1` (the per-test isolation harness's
	 * size) deadlocks on the schema read because the pool's only
	 * connection is held by the in-flight transaction. Production
	 * pools are larger but the deadlock-by-construction shape is
	 * the same regardless of size — sharing the executor is the
	 * structural fix.
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
		// `validator` returns `false` on failure and populates
		// `validator.errors`; the type signature widens to
		// `boolean` because Ajv `ValidateFunction` is generic.
		const ok = validator(args.properties);
		if (!ok) {
			// Project AJV's per-error array onto the typed
			// `CasePropertyFailure` shape API routes consume — the
			// `instancePath` is the JSONB pointer (empty string for
			// the document root) and `message` is AJV's reason text.
			// `CasePropertiesValidationError` carries the structured
			// list as a public field; API routes catch and map to
			// HTTP 400 with the failure array as the response body.
			const failures = (validator.errors ?? []).map((e) => ({
				path: e.instancePath || "",
				message: e.message ?? "invalid",
			}));
			throw new CasePropertiesValidationError(
				args.appId,
				args.caseType,
				failures,
			);
		}
	}

	/**
	 * Read the case-type JSON Schema from `case_type_schemas` and
	 * return a compiled ajv validator. Caches per
	 * `(appId, caseType, schemaJson)`; a schema row update
	 * automatically invalidates the cache because the
	 * JSON-stringified content changes.
	 *
	 * Throws when no schema row exists — the caller must run
	 * `applySchemaChange` (additive, no `change` arg) before any
	 * write to a case type. This is the structural enforcement of
	 * the spec's "schema sync is synchronous on the blueprint
	 * write path" rule (line 305): writes can't precede schema
	 * sync.
	 *
	 * `executor` is the connection that issues the schema-row
	 * SELECT — the bound `this.db` for outside-transaction call
	 * sites or the `Transaction<Database>` handle for in-flight
	 * transactions. The shared-executor contract is documented on
	 * `validateProperties` above.
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
			throw new Error(
				compilerBugMessage({
					where: "case-store.PostgresCaseStore.getValidator",
					invariant: `no JSON Schema row found in \`case_type_schemas\` for (\`${appId}\`, \`${caseType}\`)`,
					detail:
						'`applySchemaChange` is the only producer of `case_type_schemas` rows; reaching this throw means a write hit `cases` for a case type whose schema was never synced. The spec § "Write-time validation" makes the ordering contract explicit — schema sync is synchronous on the blueprint write path, every blueprint mutation that touches a case type\'s property set runs `applySchemaChange()` before any data write reaches that case type.\n\nHint: confirm the blueprint mutator routes through `applySchemaChange(args)` for every case type the mutation touches; reaching `cases` writes for an unseeded case type means the ordering contract was bypassed.',
				}),
			);
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

	/**
	 * Compose a `PredicateCompileContext` against the supplied
	 * fields. Centralized helper so the schema map + bindings
	 * defaults stay aligned across every method that compiles a
	 * predicate.
	 */
	private buildPredicateContext(args: {
		db: Kysely<Database>;
		appId: string;
		caseType: string;
		schemas: ReadonlyMap<string, CaseType>;
	}): PredicateCompileContext {
		return {
			db: args.db,
			appId: args.appId,
			ownerId: this.ownerId,
			anchorAlias: "c",
			caseTypeSchemas: args.schemas,
			bindings: {},
		};
	}

	// -----------------------------------------------------------
	// Edge helpers
	// -----------------------------------------------------------

	/**
	 * Re-derive the `(case_id, parent_case_id)` direct edge in
	 * `case_indices` after an UPDATE that changed the parent.
	 * Spec § "case_indices materialization policy" Option B
	 * (lines 290-295): direct edges only.
	 *
	 * Behavior:
	 *
	 *   - DELETE every existing `(case_id, *, 'parent', ...)` row
	 *     for the given case (multiple parent edges aren't
	 *     supported under Option B; the delete is broad to keep
	 *     leftover edges from any prior shape from accumulating).
	 *   - INSERT the new edge if `newParent` is non-null.
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

// ---------------------------------------------------------------
// Helpers — outside the class because they don't read `this`
// ---------------------------------------------------------------

/**
 * Parse a JSONB write-side input into a JS object. Kysely's
 * `JSONColumnType` accepts a JSON string on insert (the dialect
 * hands it to pg, which casts to JSONB); helpers reading the
 * input into a JS shape need to cope with either form. The case
 * store's typical caller passes a JSON string (from the form
 * boundary's serializer), but tests and the `update` merge path
 * occasionally pass an object — both shapes converge here.
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
			// JSON.parse failure is an upstream serializer bug —
			// the form-bridge / CaseStore consumer's stringify path
			// produced text that doesn't round-trip. The detail
			// preserves the underlying parser message so the
			// debugger can locate the malformed substring.
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
 * Cast result for a retype migration's per-row attempt. The
 * `value` field is the new typed value when the cast succeeded;
 * `reason` carries the human-readable cast-failure detail when
 * not.
 */
type CastResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Try to cast a stored value to the new property data type. Each
 * arm encodes the cast policy the spec § "Schema migration policy"
 * implies for `data_type` changes — text↔int / int↔decimal /
 * date-coerce / etc.
 *
 * The function is exhaustive over `CasePropertyDataType` so adding
 * a new variant surfaces a TypeScript error here. Failure cases
 * surface a descriptive `reason` that flows into the
 * `cases_quarantine.quarantine_reason` text.
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
			// Any value coerces to text via JS `String(...)`. Geopoint
			// admits any string here; deeper geopoint validation is
			// the JSON Schema's job (the validator runs on the post-
			// cast value when the row eventually re-inserts).
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
			// Non-array → array: lift the value (string-coerced)
			// into a one-element array. Used when retyping any
			// scalar data type to multi_select.
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
 * Walk a stored value and return the first option string in the
 * `removedOptions` set. Multi-select arrays surface the first
 * matching element; scalar values return the value itself when it
 * matches, `null` otherwise.
 *
 * Used by `runNarrowOptionsMigration` to decide whether a row
 * needs to move to quarantine and to format the failure reason
 * naming the offending value.
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

// ---------------------------------------------------------------
// Per-property expression-index DDL helpers
// ---------------------------------------------------------------
//
// The desired index set for a case type is computed from each
// property's `data_type`. The type implies which Postgres operator
// shape the predicate compiler emits at query time, and the
// matching expression-index DDL is what makes the operator's
// emitted SQL reach the index instead of a sequential scan. Each
// shape was empirically verified via `EXPLAIN` against the
// compiled SQL the term/predicate compilers produce.
//
// The diff against the live index set is keyed by name. Index
// names follow `cases_<case_type>_<property>_<mode>` where
// `<mode>` is the suffix label per `IndexModeSuffix`; a shape
// change (e.g. retype text → int) picks a different suffix
// (`fuzzy` → `btree`) so the change flows through as a drop +
// create under distinct names rather than as a same-name shape
// rewrite.
//
// Each `(case_type, property, mode)` tuple maps to one distinct
// index name, so a wider desired-set source — search-input
// declarations that demand a different mode than the data type
// implies — naturally extends through the same naming convention
// without changing the diff machinery.

/**
 * The index naming-suffix label per `(data_type, mode)` shape. The
 * suffix is part of the unique index name so a property that
 * carries multiple modes (e.g. text with both fuzzy similarity and
 * a starts-with prefix declaration) maps to a distinct index per
 * mode.
 *
 * The label set:
 *
 *   - `fuzzy` — pg_trgm GIN on the property's text read. Covers
 *     fuzzy similarity (`%`), planner-recognised LIKE prefix
 *     matching, and the fuzzy-date permutation lookup.
 *   - `btree` — btree on the typed cast. Covers `compare` /
 *     `between` for ordered numeric types (int, decimal).
 *   - `contains` — jsonb_ops GIN on the JSONB read. Covers
 *     `multi-select-contains` (`?|` / `?&` / `@>`); jsonb_ops is
 *     required (NOT jsonb_path_ops) because the latter does not
 *     support the `?|` / `?&` / `?` operators.
 */
type IndexModeSuffix = "fuzzy" | "btree" | "contains";

/**
 * One expression-index entry — name plus the DDL pieces the build
 * step needs. `using` is the access method (`gin` / `btree`);
 * `expression` is the indexed expression as a Kysely
 * `RawBuilder` (e.g. `(properties->>'age')::integer`); `caseType`
 * is the partial-index predicate's right-hand value.
 */
interface DesiredIndex {
	/** `cases_<case_type>_<property>_<mode>`. */
	name: string;
	/** Postgres access method — `gin` / `btree`. */
	using: "gin" | "btree";
	/**
	 * The indexed expression. Built via Kysely's `sql` template
	 * with `sql.lit` substitutions so the property key flows as a
	 * SQL string literal — Postgres expression-index expressions
	 * must be immutable and reject parameter binds, so the typed
	 * builder's `${param}` shape would be silently rejected.
	 */
	expression: ReturnType<typeof sql>;
	/** Optional opclass token (`gin_trgm_ops` / `jsonb_ops`). */
	opclass?: "gin_trgm_ops" | "jsonb_ops";
	/** The case type's name — feeds the partial-index predicate. */
	caseType: string;
}

/**
 * One live index entry read from `pg_indexes`. Matched by name
 * against `DesiredIndex.name` to compute the diff.
 */
interface LiveIndex {
	/** The index name as Postgres reports it. */
	name: string;
}

/**
 * Compute the desired index set for a case type given the
 * blueprint's property declarations. Each property contributes one
 * index keyed on its `data_type`: text → fuzzy GIN, int / decimal
 * → btree expression, multi_select → contains GIN. `single_select`,
 * `date` / `datetime` / `time`, and `geopoint` map to `undefined`
 * — see `desiredIndexForProperty` for the per-arm rationale.
 *
 * Two properties whose names differ only by the hyphen-vs-underscore
 * distinction (e.g. `external-id` and `external_id`) compose into
 * the same index name after the hyphen-to-underscore transform
 * `indexName` applies; the function detects the collision and
 * throws with a directive message naming both properties so the
 * author can disambiguate at the blueprint layer.
 *
 * The result is a Map keyed by index name so the diff against the
 * live set stays a simple key intersection.
 */
function computeDesiredIndexSet(
	caseType: string,
	properties: ReadonlyArray<CaseProperty>,
): Map<string, DesiredIndex> {
	const result = new Map<string, DesiredIndex>();
	// Track which property name produced each index name so a
	// collision surfaces both originating property names in the
	// error message rather than the post-transform composed string.
	const sourceProperty = new Map<string, string>();
	for (const property of properties) {
		const entry = desiredIndexForProperty(caseType, property);
		if (entry === undefined) {
			continue;
		}
		const existing = sourceProperty.get(entry.name);
		if (existing !== undefined && existing !== property.name) {
			throw new Error(
				compilerBugMessage({
					where: "case-store.computeDesiredIndexSet",
					invariant: `properties \`${existing}\` and \`${property.name}\` compose into the same index name \`${entry.name}\` after the hyphen-to-underscore transform`,
					detail:
						"Postgres unquoted identifiers don't admit hyphens, so the indexer maps them to underscores when composing the index name. Two blueprint properties differing only by hyphen-vs-underscore (e.g., `external-id` vs `external_id`) collide post-transform.\n\nHint: the blueprint authoring layer is responsible for rejecting sibling property names whose identifier-shape projections collide; reaching this throw means the upstream gate didn't catch it. Rename one of the two properties at the blueprint layer.",
				}),
			);
		}
		sourceProperty.set(entry.name, property.name);
		result.set(entry.name, entry);
	}
	return result;
}

/**
 * Build the desired-index entry for one property, or return
 * `undefined` when the property's data type carries no per-property
 * index. Four arms of `CasePropertyDataType` produce no index:
 *
 *   - `single_select` — equality on a small option set is fast
 *     without an expression index. The equality operator's emitted
 *     SQL reaches the row population through the case-type partial
 *     filter alone.
 *   - `date` / `datetime` / `time` — the text-to-typed casts
 *     (`::date` / `::timestamptz` / `::time`) are STABLE in
 *     Postgres (DateStyle / TimeZone session dependency) and
 *     expression indexes require IMMUTABLE expressions. The
 *     canonical `to_date('YYYY-MM-DD')` / `to_timestamp(...)`
 *     builtins are also STABLE — no built-in cast satisfies the
 *     immutability requirement. Compare / between on these data
 *     types runs as a sequential scan over the case-type partition;
 *     correct semantically, slower on large case-types. Indexing
 *     them requires an IMMUTABLE wrapper function plus a matching
 *     change on the query side so both surfaces target the same
 *     expression.
 *   - `geopoint` — the predicate compiler's `within-distance`
 *     arm emits `ST_DWithin(ST_GeogFromText(concat('POINT(',
 *     split_part(properties->>'<key>', ' ', 2), ' ',
 *     split_part(properties->>'<key>', ' ', 1), ')')), ...)`
 *     because the stored format `"lat lon alt acc"` is not WKT and
 *     the term compiler builds a WKT string at query time. The
 *     full WKT-build expression cannot be indexed: Postgres
 *     `concat(...)` over text args is STABLE, so an index on that
 *     expression fails the IMMUTABLE check. The simpler
 *     `ST_GeogFromText(properties->>'<key>')` form would index
 *     successfully but the planner cannot bridge it to the
 *     compiler's WKT-build form for index match. `within-distance`
 *     queries run as a sequential scan over the case-type
 *     partition; an indexed path requires an IMMUTABLE Postgres
 *     wrapper function the term compiler also emits against.
 *
 * Properties with no declared `data_type` default to `text` — the
 * same default the JSON Schema generator uses (see
 * `lib/domain/predicate/jsonSchema.ts`). Treating them differently
 * here would split the default's source across two surfaces.
 */
function desiredIndexForProperty(
	caseType: string,
	property: CaseProperty,
): DesiredIndex | undefined {
	const dataType: CasePropertyDataType = property.data_type ?? "text";
	const propertyKey = property.name;

	switch (dataType) {
		case "text": {
			const suffix: IndexModeSuffix = "fuzzy";
			return {
				name: indexName(caseType, propertyKey, suffix),
				using: "gin",
				// `properties->>'<key>'` returns text; `gin_trgm_ops`
				// is the trigram opclass. Postgres requires the index
				// expression be parenthesized.
				expression: sql`((properties->>${sql.lit(propertyKey)}))`,
				opclass: "gin_trgm_ops",
				caseType,
			};
		}
		case "int":
		case "decimal": {
			const suffix: IndexModeSuffix = "btree";
			const cast = POSTGRES_CAST_FOR_DATA_TYPE[dataType];
			return {
				name: indexName(caseType, propertyKey, suffix),
				using: "btree",
				// The btree expression `((properties->>'<key>')::<cast>)`
				// matches the term compiler's emission shape so the
				// planner reaches the index for `compare` / `between`
				// against the typed value. The cast token comes from
				// the same data-type table the query path reads —
				// retyping a property automatically retargets the
				// index because both surfaces share the table.
				expression: sql`(((properties->>${sql.lit(propertyKey)}))::${sql.raw(cast)})`,
				caseType,
			};
		}
		case "multi_select": {
			const suffix: IndexModeSuffix = "contains";
			return {
				name: indexName(caseType, propertyKey, suffix),
				using: "gin",
				// `properties->'<key>'` returns jsonb (NOT `->>`) —
				// `jsonb_ops` is the default opclass that supports
				// the full set of JSONB containment operators (`?` /
				// `?|` / `?&` / `@>`). `jsonb_path_ops` is a smaller
				// alternative but supports only `@>`, so a
				// `multi-select-contains` query that emits `?|` /
				// `?&` would not reach a `jsonb_path_ops` index — the
				// planner would fall back to a sequential scan.
				expression: sql`((properties->${sql.lit(propertyKey)}))`,
				opclass: "jsonb_ops",
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
 * Compose the index name from `(caseType, property, mode)`. The
 * blueprint vocabulary admits hyphens in property names
 * (`CASE_PROPERTY_PATTERN` at `lib/domain/predicate/types.ts:116`;
 * `external-id` is real CommCare convention), but Postgres
 * unquoted identifiers don't. Hyphens transform to underscores in
 * the composed name; the JSONB key inside the indexed expression
 * stays exactly as-is via `sql.lit`.
 *
 * Two properties whose names differ only by hyphen-vs-underscore
 * (e.g. `external-id` and `external_id`) compose to the same index
 * name after the transform; `computeDesiredIndexSet` detects that
 * collision before it reaches the database.
 *
 * Postgres's 63-byte identifier cap (`NAMEDATALEN - 1`) silently
 * truncates longer names, so a long case-type + long property
 * could produce a collision in `pg_indexes` even with distinct
 * pre-truncate names. Throws on overflow so the diff stays
 * mechanical against the live set.
 */
function indexName(
	caseType: string,
	property: string,
	mode: IndexModeSuffix,
): string {
	assertSafeIdentifierFragment(caseType, "case type");
	assertSafeIdentifierFragment(property, "property");
	const composed = `cases_${transformHyphens(caseType)}_${transformHyphens(property)}_${mode}`;
	if (Buffer.byteLength(composed, "utf8") > 63) {
		throw new Error(
			compilerBugMessage({
				where: "case-store.indexName",
				invariant: `composed index name \`${composed}\` exceeds Postgres' 63-byte identifier cap (\`NAMEDATALEN - 1\`)`,
				detail:
					"Postgres silently truncates identifiers at 63 bytes, so a long case-type + long property pair could collide in `pg_indexes` even with distinct pre-truncate names. The blueprint authoring layer is responsible for keeping case-type + property names short enough to compose; reaching this throw means the upstream gate didn't catch it.\n\nHint: shorten the case-type name or the property name at the blueprint layer.",
			}),
		);
	}
	return composed;
}

/**
 * Transform hyphens to underscores so a hyphenated blueprint name
 * composes into a legal unquoted Postgres identifier. The transform
 * runs at the COMPOSED-NAME boundary only; the JSONB key inside
 * the indexed expression stays exactly as the blueprint declares
 * it via `sql.lit`.
 */
function transformHyphens(fragment: string): string {
	return fragment.replace(/-/g, "_");
}

/**
 * Assert that a fragment intended for use inside a Postgres
 * identifier matches the blueprint's case-property vocabulary:
 * leading letter, then letters / digits / underscores / hyphens.
 * The regex matches `CASE_PROPERTY_PATTERN` from
 * `lib/domain/predicate/types.ts` so the case-store's
 * identifier-shape contract aligns with the blueprint AST's. The
 * compose step transforms hyphens to underscores; Postgres only
 * sees the post-transform shape.
 *
 * `kind` is the human-readable label naming what the fragment is
 * (`"property"` / `"case type"`) so the error message points at the
 * right blueprint surface for the author to fix.
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
 * Read every live per-property expression index for a case type
 * from `pg_indexes`. The filter pins to indexes whose name starts
 * with `cases_<case_type>_` so foreign indexes (manually created
 * indexes on `cases`, the static `case_indices_*_idx` set) don't
 * appear in the diff and accidentally get dropped.
 */
async function readLiveIndexSet(
	executor: Kysely<Database>,
	caseType: string,
): Promise<Map<string, LiveIndex>> {
	// `pg_indexes` is the canonical catalog view (per
	// `https://www.postgresql.org/docs/18/view-pg-indexes.html`).
	// `tablename = 'cases'` scopes the read; the `LIKE` filter on
	// `indexname` keys on the convention prefix.
	//
	// The hyphen-to-underscore transform `indexName` applies to
	// case-type names runs here too — the live filter must match
	// the same post-transform prefix as the create path. The
	// underscore separators in the prefix are LIKE single-char
	// wildcards on the literal `_`; the `ESCAPE '\\'` form treats
	// the `\_` sequence as a literal underscore so the prefix
	// matches only on the convention's structural underscores.
	assertSafeIdentifierFragment(caseType, "case type");
	const prefix = `cases\\_${transformHyphens(caseType)}\\_%`;
	const result = await sql<{
		indexname: string;
	}>`SELECT indexname FROM pg_indexes WHERE tablename = 'cases' AND indexname LIKE ${prefix} ESCAPE '\\'`.execute(
		executor,
	);
	const live = new Map<string, LiveIndex>();
	for (const row of result.rows) {
		live.set(row.indexname, { name: row.indexname });
	}
	return live;
}

/**
 * The diff between the desired and live index sets. `creates` are
 * desired entries with no live counterpart; `drops` are live
 * entries with no desired counterpart. Entries present in both are
 * skipped — same name implies same shape, because the naming
 * convention encodes `(case_type, property, mode)` and a shape
 * change always picks a different mode suffix.
 */
function diffIndexSets(
	desired: ReadonlyMap<string, DesiredIndex>,
	live: ReadonlyMap<string, LiveIndex>,
): { creates: DesiredIndex[]; drops: LiveIndex[] } {
	const creates: DesiredIndex[] = [];
	const drops: LiveIndex[] = [];
	for (const [name, entry] of desired) {
		if (!live.has(name)) {
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
 * Emit one `CREATE INDEX` statement against the supplied
 * transaction. The opclass token (`gin_trgm_ops` /
 * `jsonb_path_ops`) attaches to the indexed expression as a
 * trailing operator-class declaration when present.
 *
 * The `WHERE case_type = '<value>'` partial-index predicate scopes
 * the index to one case-type's rows. Property keys live inside the
 * indexed expression itself (already substituted via `sql.lit` at
 * the call site); the case-type name flows as a `sql.lit` string
 * literal here for the same expression-index immutability reason.
 */
async function emitCreateIndex(
	executor: Kysely<Database>,
	entry: DesiredIndex,
): Promise<void> {
	const opclass =
		entry.opclass !== undefined ? sql` ${sql.raw(entry.opclass)}` : sql``;
	const using = sql.raw(entry.using.toUpperCase());
	// `CREATE INDEX CONCURRENTLY` uses MVCC snapshot semantics
	// strict enough to ignore tuples being modified by concurrent
	// (or recently committed) transactions, which avoids the
	// `SnapshotAny` dead-tuple issue plain `CREATE INDEX` hits when
	// Phase A's quarantine DELETE just committed. CONCURRENTLY also
	// avoids holding `ACCESS EXCLUSIVE` on the table for the
	// build's duration — concurrent reads and writes against
	// `cases` keep working while the build runs. The trade-off is
	// that CONCURRENTLY internally manages its own transactions
	// and cannot run inside an outer transaction; Phase B is
	// already non-transactional by design (see file-level header
	// "Why DDL is split out of Phase A's transaction"), so the
	// constraint aligns naturally.
	await sql`CREATE INDEX CONCURRENTLY ${sql.id(entry.name)} ON cases USING ${using} (${entry.expression}${opclass}) WHERE case_type = ${sql.lit(entry.caseType)}`.execute(
		executor,
	);
}
