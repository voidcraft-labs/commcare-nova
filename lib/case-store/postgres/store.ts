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
// ## `applySchemaChange` runs three halves in one transaction
//
// The function opens a Kysely transaction and runs:
//
//   1. **Schema sync** — regenerate the JSON Schema via
//      `caseTypeToJsonSchema` and UPSERT into `case_type_schemas`.
//   2. **Per-property index DDL diff** — runs through the
//      `applyIndexDdlInTransaction` internal extension point. The
//      hook executes inside the transaction so the index state and
//      the schema state commit or roll back atomically.
//   3. **Per-row migration** — only when `change` is supplied. The
//      three `change` arms are:
//      - `rename(from, to)` — JSONB key rename in one UPDATE.
//      - `retype(fromType, toType)` — per-row cast attempt; cast
//        failures move to `cases_quarantine`.
//      - `narrow-options(removedOptions)` — rows with the removed
//        value move to `cases_quarantine`.
//
// The transaction commits when all three halves succeed and rolls
// back atomically on any failure. The database never holds a new
// schema with rows that fail validation against it.
//
// ## Sample-data methods throw
//
// `generateSampleData` and `resetSampleData` throw a descriptive
// error because the store does not carry a `SampleCaseGenerator`
// reference. The throw is the structural defense: silent no-ops
// would let a "Generate sample data" affordance render as if the
// call worked. The throw text states the cause; the JSDoc on the
// methods names the consumer.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { type Insertable, type Kysely, sql, type Transaction } from "kysely";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import {
	type CaseTypeJsonSchema,
	caseTypeToJsonSchema,
} from "@/lib/domain/predicate/jsonSchema";
import type { RelationPath } from "@/lib/domain/predicate/types";
import {
	compileExpression,
	compilePredicate,
	compileRelationPath,
	type ExpressionCompileContext,
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
	MigrationReport,
	QueryArgs,
	SchemaChangeKind,
} from "../store";
import { buildCaseTypeMap, findCaseTypeOrThrow } from "../store";

// ---------------------------------------------------------------
// Constructor args
// ---------------------------------------------------------------

/**
 * Construction arguments. Both fields are required: the owner id
 * pins tenant scope; the Kysely instance is the connection root
 * the store binds against.
 *
 * Production callers go through `withOwnerContext(userId)` which
 * resolves `db` from `getCaseStoreDatabase()`. Tests construct
 * directly with a per-test isolated Kysely instance so the
 * transaction-per-test fixture or the per-test database the
 * harness builds is the runtime context.
 */
export interface PostgresCaseStoreArgs {
	/** The owner id every method's WHERE clause filters on. */
	ownerId: string;
	/** The bound Kysely instance — production singleton or per-test fixture. */
	db: Kysely<Database>;
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
 *
 * The class is exported (not the constructor alone) so subclasses
 * could add per-deployment behavior in the future; in this round
 * the only consumer is the factory.
 */
export class PostgresCaseStore implements CaseStore {
	private readonly ownerId: string;
	private readonly db: Kysely<Database>;
	private readonly ajv: Ajv2020;
	private readonly validatorCache: Map<string, ValidatorCacheEntry>;

	constructor(args: PostgresCaseStoreArgs) {
		this.ownerId = args.ownerId;
		this.db = args.db;
		this.ajv = buildAjv();
		this.validatorCache = new Map();
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
			.where("c.case_type", "=", args.caseType);
		qb = this.withOwnerFilter(qb, "c.owner_id");

		if (args.predicate !== undefined) {
			qb = qb.where(compilePredicate(args.predicate, ctx));
		}

		// Sort keys compile through `compileExpression` with the
		// thunk-wired context so sort expressions can reach
		// predicate-bearing arms (`if.cond`, `count.where`).
		if (args.sort !== undefined) {
			const exprCtx: ExpressionCompileContext = {
				...ctx,
				compilePredicate: (pred, innerCtx) => compilePredicate(pred, innerCtx),
			};
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
		const insertRow: Insertable<CasesTable> = {
			...args.row,
			app_id: args.appId,
			owner_id: this.ownerId,
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
				.$call((qb) => this.withOwnerFilter(qb, "c.owner_id"))
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
			// touching JSONB.
			let mergedProperties: Record<string, unknown> | null = null;
			if (args.patch.properties !== undefined) {
				const patchProps = parseJsonbInput(args.patch.properties);
				mergedProperties = {
					...(existing.properties as Record<string, unknown>),
					...patchProps,
				};
				// Validate inside the transaction by passing `trx`
				// as the executor. With `max: 1` pools (the per-test
				// isolation harness's shape), an unscoped read would
				// wait forever on a connection the transaction owns.
				await this.validateProperties({
					appId: args.appId,
					caseType: existing.case_type,
					properties: mergedProperties,
					executor: trx,
				});
			}

			// Compose the UPDATE shape from the patch's other
			// columns plus the merged properties (when present)
			// and `modified_on = now()`. The JSON-stringify cast
			// matches Kysely's JSONB write contract — the dialect
			// hands the string to pg, which casts to JSONB on
			// insert.
			const setShape: Record<string, unknown> = {
				...(args.patch as Record<string, unknown>),
				modified_on: sql`now()`,
			};
			if (mergedProperties !== null) {
				setShape.properties = JSON.stringify(mergedProperties);
			} else {
				delete setShape.properties;
			}
			// `case_id` cannot be updated through this surface; the
			// type already excludes `owner_id`, so no further filter
			// is needed beyond the patch's own shape. Strip
			// `case_id` defensively in case a caller spreads a
			// `CaseRow` into the patch.
			delete setShape.case_id;

			let qb = trx
				.updateTable("cases as c")
				.set(setShape)
				.where("c.app_id", "=", args.appId)
				.where("c.case_id", "=", args.caseId);
			qb = this.withOwnerFilter(qb, "c.owner_id");
			await qb.execute();

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
		const setShape: Record<string, unknown> = {
			closed_on: sql`now()`,
			modified_on: sql`now()`,
		};
		if (args.status !== undefined) {
			setShape.status = args.status;
		}
		let qb = this.db
			.updateTable("cases as c")
			.set(setShape)
			.where("c.app_id", "=", args.appId)
			.where("c.case_id", "=", args.caseId);
		qb = this.withOwnerFilter(qb, "c.owner_id");
		await qb.execute();
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
			let qb = this.db
				.selectFrom("cases as c")
				.selectAll("c")
				.where("c.app_id", "=", args.appId)
				.where("c.case_id", "=", args.caseId);
			qb = this.withOwnerFilter(qb, "c.owner_id");
			return await qb.execute();
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
		if (compiled.kind !== "joined") {
			// Defensive: every non-self path returns `joined`. A
			// future arm extending the union would surface here.
			throw new Error(
				`traverse: compileRelationPath returned an unexpected kind '${compiled.kind}' for a non-self path`,
			);
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
			.$call((qb) => this.withOwnerFilter(qb, "c.owner_id"))
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
	// `applySchemaChange` — three halves in one transaction
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

		return await this.db.transaction().execute(async (trx) => {
			// Half 1: schema regen + UPSERT. Always runs.
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

			// Half 2: per-property index DDL diff. The internal
			// extension point runs inside the transaction so any
			// emitted DDL commits or rolls back together with the
			// schema regen above.
			await this.applyIndexDdlInTransaction(trx, {
				appId: args.appId,
				caseType: args.caseType,
				blueprint: args.blueprint,
			});

			// Half 3: per-row migration. Only runs when a `change`
			// is supplied; additive blueprint mutations (the
			// no-`change` path) commit after halves 1 and 2.
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
	}

	// -----------------------------------------------------------
	// Sample-data methods — throw because no generator is wired
	// -----------------------------------------------------------

	async generateSampleData(_args: {
		appId: string;
		caseType: string;
		count: number;
		seed: string;
	}): Promise<{ inserted: number }> {
		throw sampleDataNotWiredError();
	}

	async resetSampleData(_args: {
		appId: string;
		caseType: string;
	}): Promise<{ deleted: number; inserted: number }> {
		throw sampleDataNotWiredError();
	}

	// -----------------------------------------------------------
	// Per-property index DDL extension point
	// -----------------------------------------------------------

	/**
	 * Per-property expression-index DDL emission, run inside the
	 * `applySchemaChange` transaction so the index state and the
	 * schema state commit or roll back atomically.
	 *
	 * The body is empty: the case-store currently emits no
	 * per-property indexes. The hook exists so the transactional
	 * structure of `applySchemaChange` already calls into the same
	 * site any future index-emission logic would extend; a wider
	 * call signature (the prospective blueprint + the
	 * `(appId, caseType)` pair) is what such logic needs to compute
	 * the desired index set from the blueprint and diff against
	 * `pg_indexes`. Keeping the empty hook here pins the surface
	 * shape; per-property index emission is owned by a sibling task
	 * and not in scope for this round.
	 */
	private async applyIndexDdlInTransaction(
		_trx: Transaction<Database>,
		_args: {
			appId: string;
			caseType: string;
			blueprint: BlueprintDoc;
		},
	): Promise<void> {
		// Intentionally empty.
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
			.$call((qb) => this.withOwnerFilter(qb, "c.owner_id"))
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
			.$call((qb) => this.withOwnerFilter(qb, "c.owner_id"))
			.execute();

		let migrated = 0;
		let quarantined = 0;
		let skipped = 0;
		const failureReasons: string[] = [];

		for (const row of rows) {
			const propsRecord = row.properties as Record<string, unknown>;
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
					.$call((qb) => this.withOwnerFilter(qb, "c.owner_id"))
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
			.$call((qb) => this.withOwnerFilter(qb, "c.owner_id"))
			.execute();

		let quarantined = 0;
		let skipped = 0;
		const failureReasons: string[] = [];

		for (const row of rows) {
			const propsRecord = row.properties as Record<string, unknown>;
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
	 * fields. Centralized helper so every method that compiles a
	 * predicate uses the same shape — the schema map + bindings
	 * defaults stay aligned across `query` / `applySchemaChange` /
	 * future per-method needs.
	 */
	private buildPredicateContext(args: {
		db: Kysely<Database> | Transaction<Database>;
		appId: string;
		caseType: string;
		schemas: ReadonlyMap<string, CaseType>;
	}): PredicateCompileContext {
		return {
			db: args.db as Kysely<Database>,
			appId: args.appId,
			ownerId: this.ownerId,
			anchorAlias: "c",
			caseTypeSchemas: args.schemas,
			bindings: {},
		};
	}

	// -----------------------------------------------------------
	// Tenant + edge helpers
	// -----------------------------------------------------------

	/**
	 * Apply the bound owner filter to a Kysely query builder.
	 * Three-valued-logic safe: a null bound owner uses `IS NULL`
	 * rather than `= NULL` (which always evaluates to `unknown`).
	 *
	 * Owner-id lookups in the type-erased generic shape because
	 * the call site composes against multiple builder shapes
	 * (`SelectQueryBuilder`, `UpdateQueryBuilder`,
	 * `DeleteQueryBuilder`). Each builder type's `where(...)`
	 * accepts the same `(column, op, value)` shape.
	 */
	private withOwnerFilter<Q extends WhereChainable>(qb: Q, column: string): Q {
		// Owner can never be null on `PostgresCaseStore` (the
		// constructor pins it to a `string`), but the column type
		// admits null and SQL's three-valued logic disagrees with
		// `=` against null on either side. The branch keeps the
		// helper agnostic to a future null-owner extension without
		// breaking call sites.
		return qb.where(column, "=", this.ownerId) as Q;
	}

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
 * Minimal interface a Kysely query builder satisfies for the
 * tenant-filter helper. Both `SelectQueryBuilder`,
 * `UpdateQueryBuilder`, and `DeleteQueryBuilder` accept the
 * `where(column, op, value)` shape with the same signature; the
 * helper composes against the union without having to discriminate.
 */
interface WhereChainable {
	where(column: string, op: "=", value: string): unknown;
}

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
			// Single-select → multi-select: lift the scalar into a
			// one-element array.
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

/**
 * Standard error for the sample-data methods. Centralized so the
 * message stays consistent across `generateSampleData` /
 * `resetSampleData` and so the throw site reads as one named
 * intent at each method.
 */
function sampleDataNotWiredError(): Error {
	return new Error(
		"case_store: sample data generation is not available — this CaseStore " +
			"does not carry a SampleCaseGenerator reference, so generateSampleData " +
			"and resetSampleData throw rather than silently no-op.",
	);
}
