/**
 * Backfill `caseListConfig` onto every persisted module that
 * still carries the legacy `caseListColumns` / `caseDetailColumns`
 * fields. Operator-run; archived after the live run lands.
 *
 * Strategy: for each app doc, walk `blueprint.modules`; rewrite
 * legacy column arrays into a structured `caseListConfig` with
 * empty `sort` / `calculatedColumns` / `searchInputs` arrays;
 * drop the legacy keys; persist the doc back. Re-running is
 * safe: a module already on the new shape (or one that never had
 * either array) is left untouched.
 *
 * Safety contract — production-data-bound:
 *   - Server-side `deleted_at == null` + `status == "complete"`
 *     filter on the apps query. Soft-deleted rows are out of
 *     scope; in-flight `generating` rows would race with the
 *     active build's writes; `error` rows are excluded because
 *     their blueprint is suspect by definition.
 *   - Output passes `caseListConfigSchema.safeParse` before any
 *     write. Firestore's `ignoreUndefinedProperties: true` would
 *     otherwise let a malformed legacy entry round-trip with
 *     missing required keys.
 *   - Per-app `try / catch` so one bad doc cannot abort the run;
 *     the failed app id + error are logged and the run continues.
 *     A non-zero summary increments a `failedCount` and the
 *     process exits non-zero so CI / automation can detect partial
 *     failures.
 *   - `--app-id=<id>` flag for surgical retry. Reads the one doc
 *     by id (skipping the apps-query filter) so an operator can
 *     re-run a previously-failed app without re-scanning the
 *     entire collection.
 *
 * Usage:
 *   npx tsx scripts/migrate-case-list-config.ts --dry-run
 *   npx tsx scripts/migrate-case-list-config.ts
 *   npx tsx scripts/migrate-case-list-config.ts --app-id=abc123
 *   npx tsx scripts/migrate-case-list-config.ts --app-id=abc123 --dry-run
 *
 * Run BEFORE the deploy that enforces the new schema on reads;
 * the post-migration deploy can safely parse legacy docs (the
 * Zod schema drops the legacy keys silently) but the validator's
 * `MISSING_CASE_LIST_COLUMNS` rule reads `caseListConfig`, so
 * pre-migration docs would surface false-positive validation
 * errors until backfill completes.
 */

import "dotenv/config";
import { getDb } from "@/lib/db/firestore";
import {
	type CaseListConfig,
	type Column,
	caseListConfigSchema,
	plainColumn,
} from "@/lib/domain";
import { log } from "@/lib/logger";

/** Legacy column shape — dropped from the live schema. */
interface LegacyColumn {
	field: string;
	header: string;
}

/**
 * Module record with both legacy + new fields surfaced — the
 * pre-rewrite read view. The `caseListConfig` slot is typed
 * directly against `CaseListConfig` so a partial-migration doc
 * carrying a `date` / `id-mapping` / etc. column survives the
 * rewrite without a narrowing-cast erasure.
 */
interface MigrableModule {
	caseListColumns?: LegacyColumn[];
	caseDetailColumns?: LegacyColumn[];
	caseListConfig?: CaseListConfig;
	[key: string]: unknown;
}

/**
 * Per-module migration. Returns `null` when no rewrite is needed
 * (idempotency path — the module is already on the new shape OR
 * never carried legacy fields). Returns the next module shape
 * when a rewrite is required.
 *
 * Merge semantics: when both legacy column arrays AND a partial
 * `caseListConfig` are present (a partially-applied migration
 * shape), the legacy arrays win for the column slots they cover,
 * and every other slot on `caseListConfig` (`sort` /
 * `calculatedColumns` / `searchInputs` / `filter` /
 * `detailColumns`) survives the rewrite verbatim. The `filter`
 * preservation matters in particular: a previously-authored
 * filter would otherwise be silently dropped on the second pass
 * if a stale legacy column array is also present.
 */
export function migrateModule(mod: MigrableModule): MigrableModule | null {
	const legacyList = mod.caseListColumns;
	const legacyDetail = mod.caseDetailColumns;
	const hasLegacy = Array.isArray(legacyList) || Array.isArray(legacyDetail);

	if (!hasLegacy) return null;

	const next: MigrableModule = { ...mod };
	delete next.caseListColumns;
	delete next.caseDetailColumns;

	const existing = mod.caseListConfig;

	const columns: Column[] = Array.isArray(legacyList)
		? legacyList.map((c) => plainColumn(c.field, c.header))
		: (existing?.columns ?? []);

	const detailColumns: Column[] | undefined = Array.isArray(legacyDetail)
		? legacyDetail.map((c) => plainColumn(c.field, c.header))
		: existing?.detailColumns;

	/* Spread the existing config first, then overlay required-field
	 * defaults + the legacy-derived columns. The spread carries the
	 * full structural shape (including `filter` and any future
	 * additions to `caseListConfig`) without per-slot conditional
	 * spreads — drift on `caseListConfigSchema` surfaces here as a
	 * type error rather than a silent drop. */
	next.caseListConfig = {
		...existing,
		columns,
		sort: existing?.sort ?? [],
		calculatedColumns: existing?.calculatedColumns ?? [],
		searchInputs: existing?.searchInputs ?? [],
		...(detailColumns && { detailColumns }),
	};

	return next;
}

interface ModuleMap {
	[uuid: string]: MigrableModule;
}

interface BlueprintShape {
	modules?: ModuleMap;
	[key: string]: unknown;
}

/** Per-module diff line surfaced by the dry-run + live logs. */
export interface ModuleMigrationDiff {
	uuid: string;
	fromLegacyList: number;
	fromLegacyDetail: number;
}

export interface MigrateResult {
	blueprint: BlueprintShape;
	migratedModules: number;
	/** Per-module diff entries; one per module that was rewritten. */
	diffs: ModuleMigrationDiff[];
}

/**
 * Per-app migration. Returns the rewritten blueprint, a count of
 * modules touched, and a per-module diff list (sized matched to
 * `migratedModules`). When no module needs migrating the result
 * carries the input blueprint unchanged + count 0; callers skip
 * the Firestore write in that case.
 */
export function migrateBlueprintShape(
	blueprint: BlueprintShape,
): MigrateResult {
	const modules = blueprint.modules;
	if (!modules || typeof modules !== "object") {
		return { blueprint, migratedModules: 0, diffs: [] };
	}

	const nextModules: ModuleMap = {};
	const diffs: ModuleMigrationDiff[] = [];
	for (const [uuid, mod] of Object.entries(modules)) {
		const next = migrateModule(mod);
		if (next === null) {
			nextModules[uuid] = mod;
		} else {
			nextModules[uuid] = next;
			diffs.push({
				uuid,
				fromLegacyList: Array.isArray(mod.caseListColumns)
					? mod.caseListColumns.length
					: 0,
				fromLegacyDetail: Array.isArray(mod.caseDetailColumns)
					? mod.caseDetailColumns.length
					: 0,
			});
		}
	}

	if (diffs.length === 0) {
		return { blueprint, migratedModules: 0, diffs: [] };
	}

	return {
		blueprint: { ...blueprint, modules: nextModules },
		migratedModules: diffs.length,
		diffs,
	};
}

/**
 * Validate a rewritten blueprint's `caseListConfig` slots through
 * the live schema before any Firestore write. A failed parse
 * surfaces the offending module's uuid + error message so the
 * operator can investigate without a separate Firestore read.
 *
 * Firestore's `ignoreUndefinedProperties: true` would otherwise
 * silently strip undefined-valued fields from the on-disk doc —
 * a malformed legacy entry (e.g. `{ field: undefined, header: "X" }`
 * inside `caseListColumns`) would round-trip as a column missing
 * its required `field` slot, producing a doc the live schema
 * would reject on read.
 *
 * Returns `{ ok: true }` when every module on the blueprint passes
 * `caseListConfigSchema.safeParse`; returns `{ ok: false, ... }`
 * with the offending module's uuid + the Zod error message at the
 * first failure.
 */
function validateMigratedBlueprint(
	blueprint: BlueprintShape,
): { ok: true } | { ok: false; moduleUuid: string; error: string } {
	const modules = blueprint.modules;
	if (!modules) return { ok: true };

	for (const [uuid, mod] of Object.entries(modules)) {
		const config = mod.caseListConfig;
		// Survey-only modules omit the slot entirely — schema admits
		// the absence, no parse needed.
		if (config === undefined) continue;
		const parsed = caseListConfigSchema.safeParse(config);
		if (!parsed.success) {
			return {
				ok: false,
				moduleUuid: uuid,
				error: parsed.error.message,
			};
		}
	}
	return { ok: true };
}

/** CLI argument shape — parsed once at the call boundary so the
 *  per-app loop reads a typed config rather than re-scanning
 *  `process.argv`. */
export interface MigrateOptions {
	/** When true, no Firestore writes occur; per-app diff lines
	 *  still print so the operator can review what would change. */
	dryRun: boolean;
	/** When set, the run targets one app by id (surgical retry).
	 *  The apps-collection filter is bypassed — `doc(appId).get()`
	 *  reads the row directly even when its `status` / `deleted_at`
	 *  would have excluded it from the bulk query. */
	appId?: string;
}

/** Run-summary counters returned by `run` so callers (the CLI
 *  entry below + the test surface) can assert on the same shape. */
export interface RunSummary {
	scanned: number;
	appsTouched: number;
	modulesMigrated: number;
	failedCount: number;
}

/**
 * Per-app processing — wraps the read / migrate / safeParse / write
 * triplet in one error-bounded unit. Returns the per-app counters
 * the run-level summary aggregates.
 *
 * Throwing is intentional on the safeParse-fail path: the caller's
 * `try / catch` converts the throw into a logged failure, and the
 * outer loop continues to the next app. A return-shape would force
 * every caller to handle two error sinks (return values + thrown
 * exceptions); a single throw lane keeps the per-app try / catch
 * symmetric.
 */
async function processApp(
	appRef: FirebaseFirestore.DocumentReference,
	data: { blueprint?: unknown; owner?: unknown },
	dryRun: boolean,
): Promise<{ migratedModules: number; touched: boolean }> {
	const blueprint = data.blueprint;
	if (!blueprint || typeof blueprint !== "object") {
		return { migratedModules: 0, touched: false };
	}

	const result = migrateBlueprintShape(blueprint as BlueprintShape);
	if (result.migratedModules === 0) {
		return { migratedModules: 0, touched: false };
	}

	// Per-app + per-module diff log — emitted on every invocation so
	// dry-run output and live-run output are byte-comparable for the
	// operator's pre-flight diff review.
	const owner = typeof data.owner === "string" ? data.owner : "<unknown>";
	const moduleSummary = result.diffs
		.map(
			(d) => `${d.uuid}(list=${d.fromLegacyList} detail=${d.fromLegacyDetail})`,
		)
		.join(",");
	log.info(
		`[migrate-case-list-config] app=${appRef.id} owner=${owner} modules=[${moduleSummary}]`,
	);

	const validation = validateMigratedBlueprint(result.blueprint);
	if (!validation.ok) {
		throw new Error(
			`caseListConfigSchema.safeParse failed at module ${validation.moduleUuid}: ${validation.error}`,
		);
	}

	if (!dryRun) {
		await appRef.update({ blueprint: result.blueprint });
	}

	return { migratedModules: result.migratedModules, touched: true };
}

/**
 * Drive the migration. Exported so the test surface can invoke it
 * with mocked Firestore handles + structured options instead of
 * scraping `process.argv`.
 *
 * Returns the run-level counters so callers can assert + the CLI
 * entry below can decide on a non-zero exit when `failedCount > 0`.
 */
export async function run(options: MigrateOptions): Promise<RunSummary> {
	const { dryRun, appId } = options;

	/* Unconditional deploy-order warning — prints on every invocation
	 * (dry-run AND live, single-app AND bulk). The risk is operational,
	 * not technical: the script itself is safe in any order, but the
	 * window between the schema-enforcing deploy and the backfill
	 * surfaces false-positive validation errors on legacy docs.
	 * Surface it before any Firestore traffic so operators see it
	 * even when scrolling logs after the fact. */
	console.warn(
		"[migrate-case-list-config] DEPLOY ORDER: run this BEFORE the deploy\n" +
			"  that enforces the new schema on reads. Re-running is safe.",
	);

	const db = getDb();

	/* Surgical-retry path — operator targets one app by id. The
	 * apps-query filter is bypassed; `doc(appId).get()` reads the
	 * row directly even when its `deleted_at` / `status` would
	 * exclude it from the bulk scan. The choice is intentional: an
	 * operator narrowing to a single id has already weighed whether
	 * the row is in scope; the filter would suppress legitimate
	 * retries on (e.g.) an `error`-status app the operator wants
	 * to revisit after a manual fix. */
	const docs = appId
		? await (async () => {
				const snap = await db.collection("apps").doc(appId).get();
				return snap.exists ? [snap] : [];
			})()
		: /* Bulk path: confine to live, finished apps. Soft-deletes
			 * are filtered server-side per the codebase convention
			 * (mirrors `lib/db/apps.ts::userHasApps` /
			 * `lib/db/apps.ts::listApps`). The status filter excludes
			 * `generating` (in-flight builds; their writes would race
			 * the migration) and `error` / `deleted` (suspect
			 * blueprint shape; safer to skip than to half-migrate). */
			(
				await db
					.collection("apps")
					.where("deleted_at", "==", null)
					.where("status", "==", "complete")
					.get()
			).docs;

	let scanned = 0;
	let appsTouched = 0;
	let modulesMigrated = 0;
	let failedCount = 0;

	for (const app of docs) {
		scanned++;
		try {
			const data = app.data() as { blueprint?: unknown; owner?: unknown };
			const result = await processApp(app.ref, data, dryRun);
			if (result.touched) {
				appsTouched++;
				modulesMigrated += result.migratedModules;
			}
		} catch (err) {
			failedCount++;
			log.error(
				`[migrate-case-list-config] app=${app.id} failed: ${err instanceof Error ? err.message : String(err)}`,
				err,
			);
		}
	}

	log.info(
		`[migrate-case-list-config] apps_scanned=${scanned} apps_succeeded=${appsTouched} apps_failed=${failedCount} modules_migrated=${modulesMigrated} dryRun=${dryRun}`,
	);

	return { scanned, appsTouched, modulesMigrated, failedCount };
}

/**
 * Parse the supported flags out of `process.argv`. Throws on an
 * unparseable `--app-id=` argument so the operator sees a clear
 * rejection rather than silently scanning every app.
 */
export function parseArgs(argv: readonly string[]): MigrateOptions {
	const dryRun = argv.includes("--dry-run");
	let appId: string | undefined;
	for (const arg of argv) {
		if (arg.startsWith("--app-id=")) {
			const value = arg.slice("--app-id=".length);
			if (value.length === 0) {
				throw new Error("--app-id flag requires a non-empty value");
			}
			appId = value;
		}
	}
	return { dryRun, appId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const opts = parseArgs(process.argv.slice(2));
	run(opts)
		.then((summary) => {
			/* Exit non-zero on any per-app failure so CI / automation
			 * can detect partial-failure runs. The summary log line
			 * above already enumerates the counters; the exit code
			 * is the machine-readable signal. */
			if (summary.failedCount > 0) process.exit(1);
		})
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
