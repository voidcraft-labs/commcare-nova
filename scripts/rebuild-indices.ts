// scripts/rebuild-indices.ts
//
// One-time index-rebuild entrypoint. Runs once per deploy as the
// `commcare-nova-rebuild-indices` Cloud Run Job (see cloudbuild.yaml), AFTER
// the new revision is serving — so only the app-scoped index code is live when
// it runs, and the legacy globals it drops can't be recreated by old code.
// A non-zero exit fails the build, surfacing a botched heal.
//
// ## What it heals
//
// Per-property expression indexes were once keyed on `(case_type, property)`
// alone, with a partial predicate on `case_type` — but case-type names are
// per-app, so one global index spanned every app's rows of a shared case-type
// name and its cast rejected the OTHER app's values at INSERT (the
// `::integer`-vs-`"17.01"` cross-app failure). The deployed code now composes
// app-scoped names (`cases_<scopeTag>_<property>_<mode>`) + `app_id` predicates;
// this Job heals the data those globals already covered:
//
//   1. EAGERLY (re)build the app-scoped indexes for every `(app, case_type)` in
//      `case_type_schemas` — drop-then-create CONCURRENTLY (`rebuildAppScopedIndexes`).
//   2. Drop every legacy GLOBAL index (`dropLegacyGlobalIndexes`).
//
// Both run online (CONCURRENTLY) and idempotently, so a re-run after a partial
// failure converges. The Job is Postgres-only by design: it derives the desired
// index set from the stored JSON Schema in `case_type_schemas` (no Firestore /
// blueprint read), so it bundles the SAME deps as `migrate.cjs` (kysely + pg +
// the Cloud SQL connector) with no gRPC SDK to inline.
//
// ## Schema → data_type
//
// `case_type_schemas.schema` is the JSON Schema `caseTypeToJsonSchema`
// emits; `dataTypeFromPropertySchema` is its inverse. It is exact except for a
// bare `{ type: "string" }`, which is BOTH `text` and an unconfigured
// `single_select` — read as `text`, the common case. A real options-less
// `single_select` then gets one harmless extra trgm index (an unused GIN slot,
// not a wrong index); the app's next blueprint write drops it through the normal
// diff. Erring toward `text` keeps the heal EAGER for real text properties.
//
// Bundled into `rebuild-indices.cjs` by esbuild during the Docker build (see
// the Dockerfile + the `.dockerignore` negation); the Job runs `node
// rebuild-indices.cjs`. Reuses `getCaseStoreDatabase()` so it talks to Cloud
// SQL through the exact connector + IAM path the runtime uses.

import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "@/lib/case-store/postgres/connection";
import {
	dropLegacyGlobalIndexes,
	rebuildAppScopedIndexes,
} from "@/lib/case-store/postgres/store";
import type { CaseProperty, CasePropertyDataType } from "@/lib/domain";

/** A single property's slot inside a `case_type_schemas.schema` document. */
interface PropertySchema {
	type?: string;
	format?: string;
	enum?: unknown;
	pattern?: unknown;
}

/** One `case_type_schemas` row: the stored JSON Schema for one `(app, case_type)`. */
interface CaseTypeSchemaRow {
	app_id: string;
	case_type: string;
	schema: { properties?: Record<string, PropertySchema> } | null;
}

/**
 * Recover a property's `data_type` from its JSON-Schema slot — the inverse of
 * `caseTypeToJsonSchema`'s `propertyToSchema`. Lossy only for a bare
 * `{ type: "string" }` (read as `text`; see the module header).
 */
function dataTypeFromPropertySchema(
	slot: PropertySchema,
): CasePropertyDataType {
	switch (slot.type) {
		case "integer":
			return "int";
		case "number":
			return "decimal";
		case "array":
			return "multi_select";
		default:
			break;
	}
	// `string` (and any unexpected shape) — discriminate on the modifiers the
	// forward mapping sets.
	if (slot.format === "date") return "date";
	if (slot.format === "time") return "time";
	if (slot.format === "date-time") return "datetime";
	if (slot.enum !== undefined) return "single_select";
	if (slot.pattern !== undefined) return "geopoint";
	return "text";
}

/** Reconstruct the per-property `CaseProperty[]` an index rebuild needs from a stored schema. */
function propertiesFromSchema(row: CaseTypeSchemaRow): CaseProperty[] {
	const slots = row.schema?.properties ?? {};
	return Object.entries(slots).map(([name, slot]) => ({
		name,
		// `label` is not load-bearing for index composition; mirror the name.
		label: name,
		data_type: dataTypeFromPropertySchema(slot),
	}));
}

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();

	// Every `(app, case_type)` that has a materialized schema row — the
	// authoritative set of indexable case types.
	const rows = await db
		.selectFrom("case_type_schemas")
		.select(["app_id", "case_type", "schema"])
		.execute();

	let rebuilt = 0;
	for (const row of rows as unknown as CaseTypeSchemaRow[]) {
		await rebuildAppScopedIndexes(
			db,
			row.app_id,
			row.case_type,
			propertiesFromSchema(row),
		);
		rebuilt++;
	}

	const dropped = await dropLegacyGlobalIndexes(db);
	console.log(
		`[rebuild-indices] rebuilt app-scoped indexes for ${rebuilt} case-type schema(s); dropped ${dropped.length} legacy global index(es).`,
	);
}

/** Cap on best-effort teardown; the OS reclaims the socket on exit anyway. */
const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * Tear down and exit with `code`. The outcome (and `code`) is already decided in
 * `main()`; this only releases the pool, so it must NEVER change the exit code —
 * mirrors `scripts/migrate.ts`.
 */
async function finish(code: number): Promise<never> {
	try {
		await Promise.race([
			closeCaseStoreDatabase(),
			new Promise((resolve) => setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
		]);
	} catch (err) {
		console.error("[rebuild-indices] teardown error (ignored):", err);
	}
	process.exit(code);
}

main().then(
	() => finish(0),
	(err: unknown) => {
		console.error("[rebuild-indices] failed:", err);
		return finish(1);
	},
);
