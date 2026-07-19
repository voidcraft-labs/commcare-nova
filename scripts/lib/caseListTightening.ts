/**
 * Shared walk + transform for the case-workspace SCHEMA tightenings —
 * the persisted states `blueprintDocSchema` newly REJECTS at parse:
 *
 *   - `dateColumnSchema.pattern` / `formatDateSchema.pattern` narrowed
 *     from any non-empty string to `COMMCARE_DATE_PATTERN_REGEX`;
 *   - `withinDistanceSchema.distance` narrowed from `nonnegative()` to
 *     `positive()` plus the meters-overflow refinement.
 *
 * These CANNOT ride the legacy-findings repair pipeline: `assembleDoc`'s
 * throwing parse runs on every read, and validation never reaches a doc
 * that fails parse — so the transform operates on the RAW
 * `blueprint_entities` module rows, then proves the result parses before
 * anything writes. (Validator-level strands — the broadened
 * `MISSING_CASE_LIST_COLUMNS`, the excluded-owner case-data rejection,
 * the on-device expression gates — stay on scan-legacy-findings.ts /
 * repair-legacy-findings.ts, which handle everything the schema still
 * loads.)
 *
 * Rewrites preserve observed behavior:
 *   - An unsupported date pattern was already REJECTED by JavaRosa's
 *     formatter at runtime (broken cell on device); known strftime no-pad
 *     spellings alias to their JavaRosa equivalents (`%-d` → `%e`), and
 *     anything still unsupported normalizes to the ISO default
 *     `%Y-%m-%d`, restoring function.
 *   - `within-distance` with a non-positive distance matched (at most) the
 *     exact center point — a measure-zero set — and rewrites to
 *     `match-none`; a meters-overflow distance matched everything and
 *     rewrites to `match-all`.
 *
 * Only module rows are touched: both AST families live exclusively in
 * module-level slots (case-list columns, filters, search inputs,
 * `caseSearchConfig`); field expression slots store the separate XPath
 * AST, which carries neither shape.
 */

import type { Kysely } from "kysely";
import {
	assembleBlueprint,
	type BlueprintScalars,
	type EntityRow,
} from "@/lib/db/blueprintRows";
import type { AppDatabase } from "@/lib/db/pg";
import { isSupportedCommCareDatePattern } from "@/lib/domain/commCareDatePattern";
import {
	type DistanceUnit,
	distanceValidationIssue,
} from "@/lib/domain/predicate/distance";
import { FORMAT_DATE_PRESETS } from "@/lib/domain/predicate/types";

export interface TighteningFix {
	readonly kind:
		| "date-column-pattern"
		| "format-date-pattern"
		| "within-distance-not-positive"
		| "within-distance-overflow";
	/** JSON path inside the module row's `data`, for the report. */
	readonly path: string;
	/** The stored value being replaced, for the report. */
	readonly stored: string;
}

export interface AppTighteningReport {
	readonly appId: string;
	readonly appName: string;
	readonly fixes: readonly TighteningFix[];
	/** Rows carrying at least one fix, keyed for the write-back. */
	readonly changedRows: readonly EntityRow[];
	/** Post-transform parse proof; a non-null value blocks the write. */
	readonly parseError: string | null;
}

const ISO_PATTERN = "%Y-%m-%d";
const PRESET_SET: ReadonlySet<string> = new Set(FORMAT_DATE_PRESETS);

/**
 * strftime's GNU no-pad `%-X` spellings have exact JavaRosa
 * equivalents — an author (or the SA) who wrote `%b %-d, %Y` meant
 * `%b %e, %Y`. Aliasing first preserves the authored format; only a
 * pattern that STILL fails after aliasing falls back to the ISO
 * default (its unsupported escape was already rejected by JavaRosa's
 * formatter at runtime, so the fallback restores a broken cell).
 */
const NO_PAD_ALIASES: ReadonlyArray<readonly [string, string]> = [
	["%-d", "%e"],
	["%-m", "%n"],
	["%-H", "%h"],
];

function repairDatePattern(pattern: string): string {
	let aliased = pattern;
	for (const [from, to] of NO_PAD_ALIASES) {
		aliased = aliased.replaceAll(from, to);
	}
	return isSupportedCommCareDatePattern(aliased) ? aliased : ISO_PATTERN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk one module row's raw JSON, repairing in place. Returns the fixes
 * applied. The walk is generic — the doc cannot be Zod-parsed yet, which
 * is the whole reason this module exists — and keys on the discriminators
 * the schemas own:
 *
 *   - `kind: "date"` with a string `pattern` — the date Column arm (the
 *     only `kind: "date"` node in module JSON that carries `pattern`);
 *   - `kind: "format-date"` with a non-preset string `pattern`;
 *   - `kind: "within-distance"` with a numeric `distance` — replaced
 *     WHOLESALE by a sentinel predicate, so the walker returns the
 *     replacement for the parent to splice.
 */
function repairNode(
	node: unknown,
	path: string,
	fixes: TighteningFix[],
): unknown {
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			node[i] = repairNode(node[i], `${path}[${i}]`, fixes);
		}
		return node;
	}
	if (!isRecord(node)) return node;

	if (
		node.kind === "within-distance" &&
		typeof node.distance === "number" &&
		typeof node.unit === "string"
	) {
		const issue = distanceValidationIssue(
			node.distance,
			node.unit as DistanceUnit,
		);
		if (issue === "not-positive-finite") {
			fixes.push({
				kind: "within-distance-not-positive",
				path,
				stored: `distance ${node.distance} ${node.unit}`,
			});
			return { kind: "match-none" };
		}
		if (issue === "meters-overflow") {
			fixes.push({
				kind: "within-distance-overflow",
				path,
				stored: `distance ${node.distance} ${node.unit}`,
			});
			return { kind: "match-all" };
		}
	}

	if (
		node.kind === "date" &&
		typeof node.pattern === "string" &&
		!isSupportedCommCareDatePattern(node.pattern)
	) {
		fixes.push({
			kind: "date-column-pattern",
			path: `${path}.pattern`,
			stored: node.pattern,
		});
		node.pattern = repairDatePattern(node.pattern);
	}

	if (
		node.kind === "format-date" &&
		typeof node.pattern === "string" &&
		!PRESET_SET.has(node.pattern) &&
		!isSupportedCommCareDatePattern(node.pattern)
	) {
		fixes.push({
			kind: "format-date-pattern",
			path: `${path}.pattern`,
			stored: node.pattern,
		});
		node.pattern = repairDatePattern(node.pattern);
	}

	for (const [key, value] of Object.entries(node)) {
		node[key] = repairNode(value, `${path}.${key}`, fixes);
	}
	return node;
}

/**
 * Scan + plan one app from its raw rows. Pure over the inputs: clones the
 * module rows, repairs the clones, and proves the repaired doc parses
 * (`assembleBlueprint` runs `blueprintDocSchema.parse`). Never writes.
 */
export function planAppTightening(args: {
	appId: string;
	appName: string;
	scalars: BlueprintScalars;
	rows: readonly EntityRow[];
}): AppTighteningReport {
	const fixes: TighteningFix[] = [];
	const changedRows: EntityRow[] = [];
	const repairedRows = args.rows.map((row) => {
		if (row.kind !== "module") return row;
		const before = fixes.length;
		const data = structuredClone(row.data);
		repairNode(data, `module ${row.uuid}`, fixes);
		if (fixes.length === before) return row;
		const repaired = { ...row, data };
		changedRows.push(repaired);
		return repaired;
	});

	let parseError: string | null = null;
	if (changedRows.length > 0) {
		try {
			assembleBlueprint(args.appId, args.scalars, repairedRows);
		} catch (err) {
			parseError = err instanceof Error ? err.message : String(err);
		}
	}
	return {
		appId: args.appId,
		appName: args.appName,
		fixes,
		changedRows,
		parseError,
	};
}

/** Plan every app (or one) from raw rows — shared by scan and migrate. */
export async function planTightening(
	db: Kysely<AppDatabase>,
	scope: { readonly appId?: string },
): Promise<AppTighteningReport[]> {
	let appsQuery = db
		.selectFrom("apps")
		.select(["id", "app_name", "connect_type", "case_types", "logo"]);
	if (scope.appId !== undefined) {
		appsQuery = appsQuery.where("id", "=", scope.appId);
	}
	const apps = await appsQuery.execute();

	const reports: AppTighteningReport[] = [];
	for (const app of apps) {
		const rows = (await db
			.selectFrom("blueprint_entities")
			.select(["uuid", "kind", "parent_uuid", "ordinal", "data"])
			.where("app_id", "=", app.id)
			.execute()) as EntityRow[];
		const report = planAppTightening({
			appId: app.id,
			appName: app.app_name || "unnamed",
			scalars: {
				app_name: app.app_name,
				connect_type: app.connect_type,
				case_types: app.case_types,
				logo: app.logo,
			},
			rows,
		});
		if (report.fixes.length > 0) reports.push(report);
	}
	return reports;
}

/** Write one planned app's repaired module rows. */
export async function writeAppTightening(
	db: Kysely<AppDatabase>,
	report: AppTighteningReport,
): Promise<void> {
	if (report.parseError !== null) {
		throw new Error(
			`refusing to write app ${report.appId}: the repaired doc still fails parse — ${report.parseError}`,
		);
	}
	await db.transaction().execute(async (tx) => {
		for (const row of report.changedRows) {
			await tx
				.updateTable("blueprint_entities")
				.set({ data: JSON.stringify(row.data) })
				.where("app_id", "=", report.appId)
				.where("uuid", "=", row.uuid)
				.execute();
		}
	});
}
