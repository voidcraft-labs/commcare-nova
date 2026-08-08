import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RUNTIME_TABLES_WITHOUT_UPDATE,
	runtimeTableCanUseRowLocks,
} from "../privilegeConvergence";

const EXCLUDED_DIRECTORIES = new Set(["__tests__", "migrations"]);
const ROW_LOCK =
	/\.(forUpdate|forShare|forNoKeyUpdate|forKeyShare)\(([^)]*)\)/g;
const TABLE_SOURCE =
	/\.(selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*(["'`])([^"'`$]+)\2/g;
const ANY_TABLE_SOURCE =
	/\.(?:selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\(/g;
const RAW_SQL_TEMPLATE = /\bsql(?:<[^`]+>)?\s*`([\s\S]*?)`/g;
const RAW_ROW_LOCK =
	/\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;

interface TableSource {
	readonly table: string;
	readonly alias: string;
}

function productionTypeScriptFiles(root: string): readonly string[] {
	const files: string[] = [];
	function walk(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIRECTORIES.has(entry.name))
					walk(join(directory, entry.name));
				continue;
			}
			if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
				files.push(join(directory, entry.name));
			}
		}
	}
	walk(root);
	return files.sort();
}

/** Remove comments without changing offsets or string/template contents. */
function maskComments(source: string): string {
	const characters = [...source];
	let state: "code" | "line" | "block" | "single" | "double" | "template" =
		"code";
	let escaped = false;
	for (let index = 0; index < characters.length; index += 1) {
		const current = characters[index] ?? "";
		const next = characters[index + 1] ?? "";
		if (state === "line") {
			if (current === "\n") state = "code";
			else characters[index] = " ";
			continue;
		}
		if (state === "block") {
			if (current === "*" && next === "/") {
				characters[index] = " ";
				characters[index + 1] = " ";
				index += 1;
				state = "code";
			} else if (current !== "\n") characters[index] = " ";
			continue;
		}
		if (state !== "code") {
			if (escaped) escaped = false;
			else if (current === "\\") escaped = true;
			else if (
				(state === "single" && current === "'") ||
				(state === "double" && current === '"') ||
				(state === "template" && current === "`")
			) {
				state = "code";
			}
			continue;
		}
		if (current === "/" && next === "/") {
			characters[index] = " ";
			characters[index + 1] = " ";
			index += 1;
			state = "line";
		} else if (current === "/" && next === "*") {
			characters[index] = " ";
			characters[index + 1] = " ";
			index += 1;
			state = "block";
		} else if (current === "'") state = "single";
		else if (current === '"') state = "double";
		else if (current === "`") state = "template";
	}
	return characters.join("");
}

function parseTableSource(specification: string): TableSource {
	const [tableWithSchema, explicitAlias] = specification
		.trim()
		.split(/\s+(?:as\s+)?/i, 2);
	const table =
		(tableWithSchema ?? specification).split(".").at(-1) ?? specification;
	return { table, alias: explicitAlias ?? table };
}

function lineAt(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

function queryLockTargets(
	source: string,
	lockIndex: number,
	argumentsText: string,
): { readonly targets: readonly string[]; readonly analyzable: boolean } {
	const selectIndex = source.lastIndexOf(".selectFrom", lockIndex);
	if (selectIndex < 0) return { targets: [], analyzable: false };
	const fragment = source.slice(selectIndex, lockIndex);
	if (!fragment.trimEnd().endsWith(")")) {
		return { targets: [], analyzable: false };
	}
	const allSourceCalls = [...fragment.matchAll(ANY_TABLE_SOURCE)].length;
	const sources = [...fragment.matchAll(TABLE_SOURCE)].map((match) =>
		parseTableSource(match[3] ?? ""),
	);
	if (sources.length === 0 || sources.length !== allSourceCalls) {
		return { targets: [], analyzable: false };
	}
	if (argumentsText.trim() === "") {
		return { targets: sources.map((entry) => entry.table), analyzable: true };
	}
	const aliases = [...argumentsText.matchAll(/(["'`])([^"'`$]+)\1/g)].map(
		(match) => match[2] ?? "",
	);
	if (aliases.length === 0) return { targets: [], analyzable: false };
	const requested = new Set(aliases);
	const targets = sources
		.filter((entry) => requested.has(entry.alias) || requested.has(entry.table))
		.map((entry) => entry.table);
	return { targets, analyzable: targets.length === requested.size };
}

function rowLockViolationsInSource(
	sourceText: string,
	fileLabel: string,
): readonly string[] {
	const restricted = new Set(RUNTIME_TABLES_WITHOUT_UPDATE);
	const violations: string[] = [];
	const source = maskComments(sourceText);
	for (const lock of source.matchAll(ROW_LOCK)) {
		const index = lock.index;
		const method = lock[1] ?? "row lock";
		const { targets, analyzable } = queryLockTargets(
			source,
			index,
			lock[2] ?? "",
		);
		if (!analyzable) {
			violations.push(
				`${fileLabel}:${lineAt(sourceText, index)} ${method} has no statically provable table target`,
			);
			continue;
		}
		for (const table of targets.filter((target) => restricted.has(target))) {
			violations.push(
				`${fileLabel}:${lineAt(sourceText, index)} ${method} targets ${table}, whose runtime capability lacks UPDATE`,
			);
		}
	}
	for (const template of source.matchAll(RAW_SQL_TEMPLATE)) {
		const sqlText = template[1] ?? "";
		if (!RAW_ROW_LOCK.test(sqlText)) continue;
		for (const table of restricted) {
			if (new RegExp(`\\b${table}\\b`).test(sqlText)) {
				violations.push(
					`${fileLabel}:${lineAt(sourceText, template.index)} raw SQL row lock names ${table}, whose runtime capability lacks UPDATE`,
				);
			}
		}
	}
	return violations;
}

function rowLockViolations(): readonly string[] {
	const root = process.cwd();
	const violations: string[] = [];
	for (const file of [
		...productionTypeScriptFiles(join(root, "app")),
		...productionTypeScriptFiles(join(root, "lib")),
	]) {
		const sourceText = readFileSync(file, "utf8");
		violations.push(
			...rowLockViolationsInSource(sourceText, relative(root, file)),
		);
	}
	return violations;
}

describe("runtime row-lock privilege contract", () => {
	it("keeps every reduced-capability table non-row-lockable", () => {
		expect(RUNTIME_TABLES_WITHOUT_UPDATE).toEqual([
			"app_changes",
			"design_change_set_requests",
			"design_change_set_steps",
			"design_change_set_step_stages",
			"design_change_set_handles",
			"design_committed_slices",
			"app_change_intents",
			"design_source_packages",
			"design_revisions",
			"design_reviews",
			"design_review_dispositions",
			"design_build_plans",
			"design_orchestration_events",
			"case_schema_index_deletions",
			"media_asset_refs",
			"app_location_references",
			"thread_media_refs",
			"app_change_fold_baselines",
		]);
		for (const table of RUNTIME_TABLES_WITHOUT_UPDATE) {
			expect(runtimeTableCanUseRowLocks(table)).toBe(false);
		}
	});

	it("has no serving query that row-locks a table without UPDATE", () => {
		const violations = rowLockViolations();
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("detects Kysely and raw-SQL locks while respecting an OF alias", () => {
		expect(
			rowLockViolationsInSource(
				`db.selectFrom("app_changes").forShare()`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 forShare targets app_changes, whose runtime capability lacks UPDATE",
		]);
		expect(
			rowLockViolationsInSource(
				`db.selectFrom("media_asset_refs as ref")
					.innerJoin("media_assets as asset", "asset.id", "ref.asset_id")
					.forShare("asset")`,
				"fixture.ts",
			),
		).toEqual([]);
		expect(
			rowLockViolationsInSource(
				"sql`SELECT seq FROM app_change_fold_baselines FOR UPDATE`",
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 raw SQL row lock names app_change_fold_baselines, whose runtime capability lacks UPDATE",
		]);
	});
});
