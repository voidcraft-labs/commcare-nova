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
 * Usage:
 *   npx tsx scripts/migrate-case-list-config.ts --dry-run
 *   npx tsx scripts/migrate-case-list-config.ts
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
import { type Column, plainColumn } from "@/lib/domain";
import { log } from "@/lib/logger";

/** Legacy column shape — dropped from the live schema. */
interface LegacyColumn {
	field: string;
	header: string;
}

/**
 * Plain-kind column on the new structured config — narrowed
 * extraction over the domain `Column` union. Sourced from the
 * shared domain type so the migration's constructed shape stays
 * in lockstep with `plainColumnSchema`; routing every column
 * through the typed `plainColumn(...)` builder below keeps a
 * future required field on the schema visible as a builder-
 * signature change rather than a silent rot.
 */
type PlainColumn = Extract<Column, { kind: "plain" }>;

interface NewCaseListConfig {
	columns: PlainColumn[];
	sort: unknown[];
	calculatedColumns: unknown[];
	searchInputs: unknown[];
	detailColumns?: PlainColumn[];
}

/** Module record with both legacy + new fields surfaced — read-time view. */
interface MigrableModule {
	caseListColumns?: LegacyColumn[];
	caseDetailColumns?: LegacyColumn[];
	caseListConfig?: NewCaseListConfig;
	[key: string]: unknown;
}

/**
 * Per-module migration. Returns `null` when no rewrite is needed
 * (idempotency path — the module is already on the new shape OR
 * never carried legacy fields). Returns the next module shape
 * when a rewrite is required.
 */
export function migrateModule(mod: MigrableModule): MigrableModule | null {
	const legacyList = mod.caseListColumns;
	const legacyDetail = mod.caseDetailColumns;
	const hasLegacy = Array.isArray(legacyList) || Array.isArray(legacyDetail);

	if (!hasLegacy) return null;

	const next: MigrableModule = { ...mod };
	delete next.caseListColumns;
	delete next.caseDetailColumns;

	const columns: PlainColumn[] = Array.isArray(legacyList)
		? legacyList.map((c) => plainColumn(c.field, c.header))
		: (mod.caseListConfig?.columns ?? []);

	const detailColumns: PlainColumn[] | undefined = Array.isArray(legacyDetail)
		? legacyDetail.map((c) => plainColumn(c.field, c.header))
		: mod.caseListConfig?.detailColumns;

	next.caseListConfig = {
		columns,
		// Preserve any author-side authoring already on the new
		// shape. Most pre-migration apps have nothing here, but
		// the merge keeps a partial migration's output stable.
		sort: mod.caseListConfig?.sort ?? [],
		calculatedColumns: mod.caseListConfig?.calculatedColumns ?? [],
		searchInputs: mod.caseListConfig?.searchInputs ?? [],
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

interface MigrateResult {
	blueprint: BlueprintShape;
	migratedModules: number;
}

/**
 * Per-app migration. Returns the rewritten blueprint and a count
 * of modules touched. When no module needs migrating the result
 * carries the input blueprint unchanged + count 0; callers skip
 * the Firestore write in that case.
 */
export function migrateBlueprintShape(
	blueprint: BlueprintShape,
): MigrateResult {
	const modules = blueprint.modules;
	if (!modules || typeof modules !== "object") {
		return { blueprint, migratedModules: 0 };
	}

	const nextModules: ModuleMap = {};
	let migratedModules = 0;
	for (const [uuid, mod] of Object.entries(modules)) {
		const next = migrateModule(mod);
		if (next === null) {
			nextModules[uuid] = mod;
		} else {
			nextModules[uuid] = next;
			migratedModules++;
		}
	}

	if (migratedModules === 0) {
		return { blueprint, migratedModules: 0 };
	}

	return {
		blueprint: { ...blueprint, modules: nextModules },
		migratedModules,
	};
}

async function run(dryRun: boolean): Promise<void> {
	const db = getDb();
	const apps = await db.collection("apps").get();

	let scanned = 0;
	let appsTouched = 0;
	let modulesMigrated = 0;

	for (const app of apps.docs) {
		scanned++;
		const data = app.data() as { blueprint?: unknown };
		const blueprint = data.blueprint;
		if (!blueprint || typeof blueprint !== "object") continue;

		const result = migrateBlueprintShape(blueprint as BlueprintShape);
		if (result.migratedModules === 0) continue;

		appsTouched++;
		modulesMigrated += result.migratedModules;

		if (!dryRun) {
			await app.ref.update({ blueprint: result.blueprint });
		}
	}

	log.info(
		`[migrate-case-list-config] scanned=${scanned} apps_touched=${appsTouched} modules_migrated=${modulesMigrated} dryRun=${dryRun}`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const dry = process.argv.includes("--dry-run");
	run(dry).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
