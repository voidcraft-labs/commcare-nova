// lib/case-store/postgres/store.ts
//
// `PostgresCaseStore` — the only implementation of the `CaseStore`
// interface. Wraps the `Kysely<Database>` instance, threading
// Plan 1's predicate / expression / relation-path compilers into
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
// Splitting Phase B out of the transaction lets the in-transaction
// DELETE commit first, the dead tuple becomes "recently dead"
// outside any active snapshot, and Phase B's `CREATE INDEX` (in a
// fresh statement against the post-commit state) skips the dead
// tuple cleanly.
//
// ## Phase B failure semantics
//
// Phase B is idempotent against itself: `pg_indexes` reads the
// current live set, the diff against the desired set drives the
// drops + creates. A mid-Phase-B failure (a CREATE INDEX that fails
// due to e.g. a name collision with a manually-pre-created index)
// throws, leaves Phase A's commit intact, and the next
// `applySchemaChange` call retries Phase B against whatever state
// is current. The data + schema stay consistent through the
// failure window; only the indexes lag, and missing indexes degrade
// query performance but never correctness.
//
// The plan-doc's promise of "the database never holds a state where
// a search input references an unindexed property" softens here:
// the achievable invariant is "schema and data are always
// consistent; indexes converge on the next idempotent call". The
// architectural alternative — `CREATE INDEX CONCURRENTLY` —
// requires no enclosing transaction either, so the two-phase split
// is the only single-binary path that respects the engine's
// constraints.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { type Insertable, type Kysely, sql, type Transaction } from "kysely";
import type {
	BlueprintDoc,
	CaseProperty,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import {
	type CaseTypeJsonSchema,
	caseTypeToJsonSchema,
} from "@/lib/domain/predicate/jsonSchema";
import type { RelationPath } from "@/lib/domain/predicate/types";
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
				throw new Error(
					`update: case ${args.caseId} not found in app ${args.appId} for the bound owner. ` +
						`The row does not exist, has been closed-and-deleted out of band, or belongs to ` +
						`another tenant.`,
				);
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
			// unmerged value; the rest of the patch passes through.
			// `CaseUpdate` already excludes `case_id` / `app_id` /
			// `owner_id` so no defensive stripping is needed.
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
		// pulls the eight columns matching `CaseRow`.
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
					"applySchemaChange: `property` is required when `change` is supplied — " +
						"the change shape targets a specific property and the migration loop reads from it.",
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
			definitions: caseType.properties,
		});

		return report;
	}

	/**
	 * Sync the per-property expression indexes for a case type
	 * against the prospective blueprint state. Computes the desired
	 * index set from the case type's properties, reads the live
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
	 */
	private async syncExpressionIndexes(args: {
		caseType: string;
		definitions: ReadonlyArray<CaseProperty>;
	}): Promise<void> {
		const desired = computeDesiredIndexSet(args.caseType, args.definitions);
		const live = await readLiveIndexSet(this.db, args.caseType);
		const { creates, drops } = diffIndexSets(desired, live);

		// Drops first so a same-name index that's changing shape
		// (e.g. a column-level cast change after retype) drops the
		// old definition before the create attempts to claim the
		// name. The diff's `creates` and `drops` lists are computed
		// with set-difference semantics so a name appearing in both
		// (the changed-shape case) goes through both lists in the
		// right order.
		for (const drop of drops) {
			await sql`DROP INDEX IF EXISTS ${sql.id(drop.name)}`.execute(this.db);
		}
		for (const create of creates) {
			await emitCreateIndex(this.db, create);
		}
	}

	// -----------------------------------------------------------
	// `generateSampleData` — heuristic generator → insert
	// -----------------------------------------------------------

	async generateSampleData(
		args: GenerateSampleDataArgs,
	): Promise<{ inserted: number }> {
		// Resolve parent ids for the generator's `parentRefs` map.
		// The generator uses these to populate `parent_case_id` on
		// child rows so `case_indices` derivation in `insert` produces
		// real edges. When the case-type declares no parent or no
		// parents exist yet, the generator emits orphan rows.
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

		// Route every generated row through `insert`. This is the
		// architectural seam: generated rows participate in JSON
		// Schema validation, `case_indices` derivation, and tenant
		// scoping the same way user-authored rows do. The single-
		// row `insert` shape iterates here rather than batching
		// because the validation + edge-derivation contract is the
		// per-row primitive.
		let inserted = 0;
		for (const row of rows) {
			await this.insert({ appId: args.appId, row });
			inserted++;
		}
		return { inserted };
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
			const detail = (validator.errors ?? [])
				.map((e) => `${e.instancePath || "<root>"}: ${e.message ?? "invalid"}`)
				.join("; ");
			throw new Error(
				`case_store: properties payload failed validation against ` +
					`case_type_schemas[${args.appId}, ${args.caseType}].schema. Details: ${detail}`,
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
				`case_store: no JSON Schema row found in case_type_schemas for ` +
					`(${appId}, ${caseType}). The blueprint mutator must call ` +
					`applySchemaChange() before any write to a case type.`,
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
		try {
			const parsed = JSON.parse(value);
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				!Array.isArray(parsed)
			) {
				return parsed as Record<string, unknown>;
			}
			throw new Error("parsed JSONB value is not an object");
		} catch (err) {
			throw new Error(
				`case_store: failed to parse JSONB input as a JSON object: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	throw new Error(
		`case_store: unexpected JSONB input shape ${typeof value}; expected a JSON-string or a plain object.`,
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
				`tryCastValue: unhandled toType '${String(_exhaustive)}'`,
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
// property's `data_type`: the type implies which Postgres operator
// shape the predicate compiler emits at query time (`pg_trgm`
// similarity for text, btree expression for ordered scalars,
// jsonb_path_ops GIN for multi_select containment, GiST for
// geopoint distance), and the matching expression-index DDL is
// what makes the operator's emitted SQL reach the index instead of
// a sequential scan.
//
// The diff against the live index set is keyed by name. Index
// names follow `cases_<case_type>_<property>_<mode>` where `<mode>`
// is the suffix label per `IndexModeSuffix`; a shape change (e.g.
// retype text → int) picks a different suffix (`_fuzzy` → `_btree`)
// so the change flows through as a drop + create under distinct
// names rather than as a same-name shape rewrite.
//
// `desiredIndexForProperty` is keyed on `CasePropertyDataType`
// alone today — one index per searchable property determined by
// its declared data type. Search-input declarations that demand a
// different mode than the data-type implies (an explicit fuzzy
// mode on a select, etc.) extend through the same naming
// convention: each `(case_type, property, mode)` tuple maps to a
// distinct index name, so a wider input source naturally widens
// the desired set without changing the diff machinery.

/**
 * The index naming-suffix label per `(data_type, mode)` shape. The
 * suffix is part of the unique index name so a property that
 * carries multiple modes (e.g. text with both fuzzy similarity and
 * a starts-with prefix declaration) maps to a distinct index per
 * mode.
 *
 * The label set:
 *
 *   - `_fuzzy` — pg_trgm GIN on the property's text read. Covers
 *     fuzzy similarity, planner-recognised LIKE prefix matching,
 *     and the fuzzy-date permutation lookup.
 *   - `_btree` — btree on the typed cast. Covers `compare` /
 *     `between` for ordered numeric types.
 *   - `_contains` — jsonb_path_ops GIN on the JSONB read. Covers
 *     `multi-select-contains` (`?|` / `?&` / `@>`).
 *   - `_geo` — GiST on the geography point. Covers `within-distance`.
 */
type IndexModeSuffix = "fuzzy" | "btree" | "contains" | "geo";

/**
 * One expression-index entry — name plus the DDL pieces the build
 * step needs. `using` is the access method (`gin` / `btree` /
 * `gist`); `expression` is the indexed expression as a Kysely
 * `RawBuilder` (e.g. `(properties->>'age')::integer`); `caseType`
 * is the partial-index predicate's right-hand value.
 */
interface DesiredIndex {
	/** `cases_<case_type>_<property>_<mode>`. */
	name: string;
	/** Postgres access method — `gin` / `btree` / `gist`. */
	using: "gin" | "btree" | "gist";
	/**
	 * The indexed expression. Built via Kysely's `sql` template
	 * with `sql.lit` substitutions so the property key flows as a
	 * SQL string literal — Postgres expression-index expressions
	 * must be immutable and reject parameter binds, so the typed
	 * builder's `${param}` shape would be silently rejected.
	 */
	expression: ReturnType<typeof sql>;
	/** Optional opclass token (`gin_trgm_ops` / `jsonb_path_ops`). */
	opclass?: "gin_trgm_ops" | "jsonb_path_ops";
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
 * → btree expression, multi_select → contains GIN, geopoint → geo
 * GiST. `single_select` and `date` / `datetime` / `time` map to
 * `undefined` — see `desiredIndexForProperty` for the per-arm
 * rationale.
 *
 * The result is a Map keyed by index name so the diff against the
 * live set stays a simple key intersection.
 */
function computeDesiredIndexSet(
	caseType: string,
	properties: ReadonlyArray<CaseProperty>,
): Map<string, DesiredIndex> {
	const result = new Map<string, DesiredIndex>();
	for (const property of properties) {
		const entry = desiredIndexForProperty(caseType, property);
		if (entry !== undefined) {
			result.set(entry.name, entry);
		}
	}
	return result;
}

/**
 * Build the desired-index entry for one property, or return
 * `undefined` when the property's data type carries no per-property
 * index. Three arms of `CasePropertyDataType` produce no index:
 *
 *   - `single_select` — equality on a small option set is fast
 *     without an expression index, so the equality operator's
 *     emitted SQL reaches the row population through the
 *     case-type partial filter alone.
 *   - `date` / `datetime` / `time` — the text-to-typed casts
 *     (`::date` / `::timestamptz` / `::time`) are STABLE in
 *     Postgres (DateStyle / TimeZone session dependency) and
 *     expression indexes require IMMUTABLE expressions. The
 *     canonical `to_date('YYYY-MM-DD')` / `to_timestamp(...)`
 *     functions are also STABLE — no built-in cast satisfies the
 *     immutability requirement. Compare / between on these data
 *     types runs as a sequential scan over the case-type partition;
 *     correct semantically, slower on large case-types. Indexing
 *     them requires an IMMUTABLE wrapper function plus a matching
 *     change on the query side so both surfaces target the same
 *     expression.
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
		case "date":
		case "datetime":
		case "time":
			// Postgres marks the text-to-date / text-to-timestamp /
			// text-to-time casts as STABLE (DateStyle / TimeZone
			// session dependency), and expression indexes require
			// IMMUTABLE expressions. The canonical
			// `to_date('YYYY-MM-DD')` / `to_timestamp(...)` builtins
			// are also STABLE for the same reason. Sequential scans
			// over the case-type partition are the only correct
			// option until an IMMUTABLE wrapper exists on both the
			// index side and the term-compiler emission side.
			return undefined;
		case "multi_select": {
			const suffix: IndexModeSuffix = "contains";
			return {
				name: indexName(caseType, propertyKey, suffix),
				using: "gin",
				// `properties->'<key>'` returns jsonb (NOT `->>`) —
				// `jsonb_path_ops` operates on jsonb values, and the
				// `?|` / `?&` / `@>` operators the predicate compiler
				// emits also consume jsonb on the left.
				expression: sql`((properties->${sql.lit(propertyKey)}))`,
				opclass: "jsonb_path_ops",
				caseType,
			};
		}
		case "geopoint": {
			const suffix: IndexModeSuffix = "geo";
			return {
				name: indexName(caseType, propertyKey, suffix),
				using: "gist",
				// `ST_GeogFromText('<wire>')` returns a geography
				// value the predicate compiler's `within-distance`
				// arm builds the same way (see
				// `lib/case-store/sql/CLAUDE.md` § "Zero raw-SQL
				// emission"). The expression-index expression must
				// match the query-side expression for the planner to
				// recognise the index.
				expression: sql`(ST_GeogFromText(properties->>${sql.lit(propertyKey)}))`,
				caseType,
			};
		}
		case "single_select":
			// No expression index. Equality on a small option set
			// matches efficiently through the case-type partial
			// filter alone; the trgm GIN shape doesn't pay off for a
			// closed value space.
			return undefined;
		default: {
			const _exhaustive: never = dataType;
			throw new Error(
				`desiredIndexForProperty: unhandled data_type '${String(_exhaustive)}'`,
			);
		}
	}
}

/**
 * Postgres identifier-length cap is 63 bytes (`NAMEDATALEN - 1`).
 * Identifiers longer than that are silently truncated by Postgres,
 * which means a long property name on a long case type could
 * collide with another property's index. Detect the overflow at
 * compile time and throw — the operator surfaces the conflict
 * before it produces silently-misnamed indexes that survive
 * `pg_indexes` reads but fail the diff.
 *
 * Property names AND case-type names are user-authored; we sanitize
 * the input shape to alphanumeric + underscore so the index name is
 * a legal unquoted identifier and stays readable in `pg_indexes`
 * listings. Non-conforming inputs throw early — the blueprint
 * validator should have caught them, but the index-DDL emitter is
 * the last line of defense.
 */
function indexName(
	caseType: string,
	property: string,
	mode: IndexModeSuffix,
): string {
	assertSafeIdentifierFragment(caseType, "case type");
	assertSafeIdentifierFragment(property, "property");
	const composed = `cases_${caseType}_${property}_${mode}`;
	if (Buffer.byteLength(composed, "utf8") > 63) {
		throw new Error(
			`index name ${JSON.stringify(composed)} exceeds Postgres' 63-byte ` +
				`identifier cap. Shorten the case-type name or the property name.`,
		);
	}
	return composed;
}

/**
 * Assert that a fragment intended for use inside a Postgres
 * identifier is alphanumeric + underscore (lowercase recommended;
 * uppercase admitted) and starts with a letter or underscore. The
 * regex matches Postgres's unquoted-identifier rules; conforming
 * fragments compose into a safe identifier without quoting.
 *
 * `kind` is the human-readable label naming what the fragment is
 * (`"property"` / `"case type"`) so the error message points at the
 * right blueprint surface for the author to fix.
 */
function assertSafeIdentifierFragment(
	fragment: string,
	kind: "property" | "case type",
): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fragment)) {
		throw new Error(
			`${kind} name ${JSON.stringify(fragment)} contains characters other ` +
				`than alphanumerics and underscores; it cannot compose into a ` +
				`Postgres index name. Rename the ${kind} in the blueprint.`,
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
	executor: Kysely<Database> | Transaction<Database>,
	caseType: string,
): Promise<Map<string, LiveIndex>> {
	// `pg_indexes` is the canonical catalog view (per
	// `https://www.postgresql.org/docs/18/view-pg-indexes.html`).
	// `tablename = 'cases'` scopes the read; the `LIKE` filter on
	// `indexname` keys on the convention prefix.
	assertSafeIdentifierFragment(caseType, "case type");
	const prefix = `cases_${caseType}_%`;
	const result = await sql<{
		indexname: string;
	}>`SELECT indexname FROM pg_indexes WHERE tablename = 'cases' AND indexname LIKE ${prefix}`.execute(
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
	executor: Kysely<Database> | Transaction<Database>,
	entry: DesiredIndex,
): Promise<void> {
	const opclass =
		entry.opclass !== undefined ? sql` ${sql.raw(entry.opclass)}` : sql``;
	const using = sql.raw(entry.using.toUpperCase());
	await sql`CREATE INDEX ${sql.id(entry.name)} ON cases USING ${using} (${entry.expression}${opclass}) WHERE case_type = ${sql.lit(entry.caseType)}`.execute(
		executor,
	);
}
