import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RUNTIME_TABLES_WITHOUT_DELETE,
	RUNTIME_TABLES_WITHOUT_INSERT,
	RUNTIME_TABLES_WITHOUT_ROW_LOCKS,
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
const SQL_TAG = /\bsql(?:<[^`]+>)?\s*`/g;
const RAW_ROW_LOCK =
	/\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;
const WRITE_VERB =
	/\.(updateTable|deleteFrom|insertInto)\(\s*(?:(["'`])([^"'`$]+)\2)?/g;
const DO_UPDATE_SET = /\.doUpdateSet\(/;

interface TableSource {
	readonly table: string;
	readonly alias: string;
}

interface WriteVerbRule {
	readonly privilege: "UPDATE" | "DELETE" | "INSERT";
	readonly restricted: ReadonlySet<string>;
}

const WRITE_VERB_RULES: Record<
	"updateTable" | "deleteFrom" | "insertInto",
	WriteVerbRule
> = {
	updateTable: {
		privilege: "UPDATE",
		restricted: new Set(RUNTIME_TABLES_WITHOUT_UPDATE),
	},
	deleteFrom: {
		privilege: "DELETE",
		restricted: new Set(RUNTIME_TABLES_WITHOUT_DELETE),
	},
	insertInto: {
		privilege: "INSERT",
		restricted: new Set(RUNTIME_TABLES_WITHOUT_INSERT),
	},
};

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

type LexerFrame =
	| { kind: "code"; braceDepth: number }
	| { kind: "single" }
	| { kind: "double" }
	| { kind: "template" };

/** Remove comments without changing offsets or string/template contents.
 * Tracks template-literal `${}` interpolations as nested code frames — a
 * backtick inside an interpolation (a nested template) must not end the
 * enclosing template, or everything after it is misread until the next
 * backtick flips the state back. */
function maskComments(source: string): string {
	const characters = [...source];
	const stack: LexerFrame[] = [{ kind: "code", braceDepth: 0 }];
	let escaped = false;
	let comment: "line" | "block" | null = null;
	for (let index = 0; index < characters.length; index += 1) {
		const current = characters[index] ?? "";
		const next = characters[index + 1] ?? "";
		if (comment === "line") {
			if (current === "\n") comment = null;
			else characters[index] = " ";
			continue;
		}
		if (comment === "block") {
			if (current === "*" && next === "/") {
				characters[index] = " ";
				characters[index + 1] = " ";
				index += 1;
				comment = null;
			} else if (current !== "\n") characters[index] = " ";
			continue;
		}
		const frame = stack[stack.length - 1] ?? { kind: "code", braceDepth: 0 };
		if (frame.kind === "single" || frame.kind === "double") {
			if (escaped) escaped = false;
			else if (current === "\\") escaped = true;
			else if (current === (frame.kind === "single" ? "'" : '"')) {
				stack.pop();
			}
			continue;
		}
		if (frame.kind === "template") {
			if (escaped) escaped = false;
			else if (current === "\\") escaped = true;
			else if (current === "`") stack.pop();
			else if (current === "$" && next === "{") {
				stack.push({ kind: "code", braceDepth: 0 });
				index += 1;
			}
			continue;
		}
		if (current === "/" && next === "/") {
			characters[index] = " ";
			characters[index + 1] = " ";
			index += 1;
			comment = "line";
		} else if (current === "/" && next === "*") {
			characters[index] = " ";
			characters[index + 1] = " ";
			index += 1;
			comment = "block";
		} else if (current === "'") stack.push({ kind: "single" });
		else if (current === '"') stack.push({ kind: "double" });
		else if (current === "`") stack.push({ kind: "template" });
		else if (current === "{") frame.braceDepth += 1;
		else if (current === "}") {
			if (frame.braceDepth === 0 && stack.length > 1) stack.pop();
			else frame.braceDepth = Math.max(0, frame.braceDepth - 1);
		}
	}
	return characters.join("");
}

interface RawSqlTemplate {
	/** Offset of the `sql` tag in the (offset-preserving) masked source. */
	readonly index: number;
	/** The template's literal SQL text with each `${}` interpolation collapsed
	 * to one space, read to the template's true closing backtick. */
	readonly text: string;
}

/** Read one template literal's text starting just after its opening backtick,
 * skipping interpolation contents (nested templates included) instead of
 * ending at the first backtick they contain. */
function readTemplateText(masked: string, start: number): string {
	let text = "";
	const stack: LexerFrame[] = [{ kind: "template" }];
	let escaped = false;
	for (let index = start; index < masked.length; index += 1) {
		const current = masked[index] ?? "";
		const next = masked[index + 1] ?? "";
		const frame = stack[stack.length - 1];
		if (frame === undefined) break;
		if (frame.kind === "single" || frame.kind === "double") {
			if (escaped) escaped = false;
			else if (current === "\\") escaped = true;
			else if (current === (frame.kind === "single" ? "'" : '"')) {
				stack.pop();
			}
			continue;
		}
		if (frame.kind === "template") {
			const topLevel = stack.length === 1;
			if (escaped) {
				escaped = false;
				if (topLevel) text += current;
				continue;
			}
			if (current === "\\") {
				escaped = true;
				continue;
			}
			if (current === "`") {
				stack.pop();
				if (stack.length === 0) return text;
				continue;
			}
			if (current === "$" && next === "{") {
				stack.push({ kind: "code", braceDepth: 0 });
				if (topLevel) text += " ";
				index += 1;
				continue;
			}
			if (topLevel) text += current;
			continue;
		}
		if (current === "'") stack.push({ kind: "single" });
		else if (current === '"') stack.push({ kind: "double" });
		else if (current === "`") stack.push({ kind: "template" });
		else if (current === "{") frame.braceDepth += 1;
		else if (current === "}") {
			if (frame.braceDepth === 0) stack.pop();
			else frame.braceDepth -= 1;
		}
	}
	return text;
}

function extractRawSqlTemplates(masked: string): readonly RawSqlTemplate[] {
	const templates: RawSqlTemplate[] = [];
	for (const tag of masked.matchAll(SQL_TAG)) {
		templates.push({
			index: tag.index,
			text: readTemplateText(masked, tag.index + tag[0].length),
		});
	}
	return templates;
}

interface PreparedSource {
	readonly masked: string;
	readonly templates: readonly RawSqlTemplate[];
}

function prepareSource(sourceText: string): PreparedSource {
	const masked = maskComments(sourceText);
	return { masked, templates: extractRawSqlTemplates(masked) };
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
	prepared: PreparedSource = prepareSource(sourceText),
): readonly string[] {
	const restricted = new Set(RUNTIME_TABLES_WITHOUT_ROW_LOCKS);
	const violations: string[] = [];
	const source = prepared.masked;
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
				`${fileLabel}:${lineAt(sourceText, index)} ${method} locks a table this guard can't identify — it reads only string-literal table names, so restructure the query to name the locked table as a literal`,
			);
			continue;
		}
		for (const table of targets.filter((target) => restricted.has(target))) {
			violations.push(
				`${fileLabel}:${lineAt(sourceText, index)} ${method} targets ${table}, whose runtime capability forbids row locks`,
			);
		}
	}
	for (const template of prepared.templates) {
		if (!RAW_ROW_LOCK.test(template.text)) continue;
		for (const table of restricted) {
			if (new RegExp(`\\b${table}\\b`).test(template.text)) {
				violations.push(
					`${fileLabel}:${lineAt(sourceText, template.index)} raw SQL row lock names ${table}, whose runtime capability forbids row locks`,
				);
			}
		}
	}
	return violations;
}

/** The raw-SQL statement patterns per write verb, anchored on the table name
 * directly after the verb so `FOR UPDATE OF x` and `ON CONFLICT DO UPDATE`
 * cannot false-positive as a table-targeting UPDATE. */
function rawWriteVerbPattern(
	privilege: WriteVerbRule["privilege"],
	table: string,
): RegExp {
	switch (privilege) {
		case "UPDATE":
			return new RegExp(
				`\\bUPDATE\\s+(?:ONLY\\s+)?(?:public\\.)?${table}\\b`,
				"i",
			);
		case "DELETE":
			return new RegExp(
				`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?(?:public\\.)?${table}\\b`,
				"i",
			);
		case "INSERT":
			return new RegExp(`\\bINSERT\\s+INTO\\s+(?:public\\.)?${table}\\b`, "i");
	}
}

/** PostgreSQL requires UPDATE privilege for `ON CONFLICT ... DO UPDATE`, so an
 * upsert against a table whose capability withholds UPDATE fails with 42501
 * on the first conflicting row — long after the insert-only path went green. */
function rawInsertOnConflictUpdatePattern(table: string): RegExp {
	return new RegExp(
		`\\bINSERT\\s+INTO\\s+(?:public\\.)?${table}\\b[\\s\\S]*?\\bDO\\s+UPDATE\\b`,
		"i",
	);
}

function writeCapabilityViolationsInSource(
	sourceText: string,
	fileLabel: string,
	prepared: PreparedSource = prepareSource(sourceText),
): readonly string[] {
	const violations: string[] = [];
	const source = prepared.masked;
	const updateRestricted = WRITE_VERB_RULES.updateTable.restricted;
	const calls = [...source.matchAll(WRITE_VERB)];
	for (const [position, call] of calls.entries()) {
		const method = call[1] as keyof typeof WRITE_VERB_RULES;
		const rule = WRITE_VERB_RULES[method];
		const literal = call[3];
		if (literal === undefined) {
			violations.push(
				`${fileLabel}:${lineAt(sourceText, call.index)} ${method} names its table dynamically, so this guard can't check its write privileges — pass the table name as a literal string`,
			);
			continue;
		}
		const { table } = parseTableSource(literal);
		if (rule.restricted.has(table)) {
			violations.push(
				`${fileLabel}:${lineAt(sourceText, call.index)} ${method} targets ${table}, whose runtime capability lacks ${rule.privilege}`,
			);
		}
		if (method === "insertInto" && updateRestricted.has(table)) {
			/* A doUpdateSet before the next write verb necessarily chains off
			 * THIS insert: the builder exists only under onConflict. */
			const extentEnd = calls[position + 1]?.index ?? source.length;
			if (DO_UPDATE_SET.test(source.slice(call.index, extentEnd))) {
				violations.push(
					`${fileLabel}:${lineAt(sourceText, call.index)} insertInto targets ${table} with onConflict doUpdateSet, whose runtime capability lacks UPDATE`,
				);
			}
		}
	}
	for (const template of prepared.templates) {
		for (const rule of Object.values(WRITE_VERB_RULES)) {
			for (const table of rule.restricted) {
				if (rawWriteVerbPattern(rule.privilege, table).test(template.text)) {
					violations.push(
						`${fileLabel}:${lineAt(sourceText, template.index)} raw SQL ${rule.privilege} statement targets ${table}, whose runtime capability lacks ${rule.privilege}`,
					);
				}
			}
		}
		for (const table of updateRestricted) {
			if (rawInsertOnConflictUpdatePattern(table).test(template.text)) {
				violations.push(
					`${fileLabel}:${lineAt(sourceText, template.index)} raw SQL INSERT ... ON CONFLICT DO UPDATE statement targets ${table}, whose runtime capability lacks UPDATE`,
				);
			}
		}
	}
	return violations;
}

interface ServingSource {
	readonly label: string;
	readonly text: string;
	readonly prepared: PreparedSource;
}

/** One shared walk: reading and lexing ~1k production files dominates each
 * sweep's cost, and both sweeps consume the identical prepared sources. */
let cachedServingSources: readonly ServingSource[] | undefined;
function servingSources(): readonly ServingSource[] {
	if (cachedServingSources === undefined) {
		const root = process.cwd();
		cachedServingSources = [
			...productionTypeScriptFiles(join(root, "app")),
			...productionTypeScriptFiles(join(root, "lib")),
		].map((file) => {
			const text = readFileSync(file, "utf8");
			return {
				label: relative(root, file),
				text,
				prepared: prepareSource(text),
			};
		});
	}
	return cachedServingSources;
}

function servingSourceViolations(
	scanner: (
		sourceText: string,
		fileLabel: string,
		prepared: PreparedSource,
	) => readonly string[],
): readonly string[] {
	return servingSources().flatMap((source) =>
		scanner(source.text, source.label, source.prepared),
	);
}

describe("runtime row-lock privilege contract", () => {
	it("keeps every reduced-capability table non-row-lockable", () => {
		expect(RUNTIME_TABLES_WITHOUT_ROW_LOCKS).toEqual([
			"app_changes",
			"design_change_set_requests",
			"design_change_set_steps",
			"design_change_set_step_stages",
			"design_change_set_handles",
			"design_committed_slices",
			"design_source_packages",
			"design_revisions",
			"design_reviews",
			"design_review_dispositions",
			"design_build_plans",
			"design_orchestration_events",
			"design_artifact_workspace_steps",
			"design_model_context_items",
			"design_model_steps",
			"design_model_step_usage_accounts",
			"design_localization_receipts",
			"design_localization_batch_usage_accounts",
			"design_slice_attempt_budget_claims",
			"design_identity_handles",
			"case_schema_index_deletions",
			"media_asset_refs",
			"app_location_references",
			"thread_media_refs",
			"app_change_fold_baselines",
		]);
		for (const table of RUNTIME_TABLES_WITHOUT_ROW_LOCKS) {
			expect(runtimeTableCanUseRowLocks(table)).toBe(false);
		}
	});

	it("derives the write-verb guard sets exactly from the capability grants", () => {
		const rowLockOnly = RUNTIME_TABLES_WITHOUT_ROW_LOCKS.filter(
			(table) => !RUNTIME_TABLES_WITHOUT_UPDATE.includes(table),
		);
		expect(rowLockOnly).toEqual(["design_identity_handles"]);
		const deletable = RUNTIME_TABLES_WITHOUT_ROW_LOCKS.filter(
			(table) => !RUNTIME_TABLES_WITHOUT_DELETE.includes(table),
		);
		expect(deletable).toEqual([
			"case_schema_index_deletions",
			"media_asset_refs",
			"app_location_references",
			"thread_media_refs",
		]);
		expect(RUNTIME_TABLES_WITHOUT_INSERT).toEqual([
			"app_change_fold_baselines",
		]);
	});

	it("has no serving query that row-locks a table its capability forbids", () => {
		const violations = servingSourceViolations(rowLockViolationsInSource);
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("has no serving statement using a write privilege its table capability withholds", () => {
		const violations = servingSourceViolations(
			writeCapabilityViolationsInSource,
		);
		expect(violations, violations.join("\n")).toEqual([]);
	});

	it("detects Kysely and raw-SQL locks while respecting an OF alias", () => {
		expect(
			rowLockViolationsInSource(
				`db.selectFrom("app_changes").forShare()`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 forShare targets app_changes, whose runtime capability forbids row locks",
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
			"fixture.ts:1 raw SQL row lock names app_change_fold_baselines, whose runtime capability forbids row locks",
		]);
		expect(
			rowLockViolationsInSource(
				`db.selectFrom("design_identity_handles").forUpdate()`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 forUpdate targets design_identity_handles, whose runtime capability forbids row locks",
		]);
	});

	it("reads a raw template past a nested template in an interpolation", () => {
		/* The regression shape: a nested template literal inside \${} used to
		 * end the scan at ITS backtick, hiding everything after it. */
		expect(
			rowLockViolationsInSource(
				`sql\`WITH flags AS (SELECT \${enabled ? \`1\` : \`0\`} AS flag) SELECT seq FROM app_change_fold_baselines FOR UPDATE\``,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 raw SQL row lock names app_change_fold_baselines, whose runtime capability forbids row locks",
		]);
		expect(
			writeCapabilityViolationsInSource(
				`sql\`WITH flags AS (SELECT \${enabled ? \`1\` : \`0\`} AS flag) DELETE FROM design_identity_handles WHERE handle = '@x'\``,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 raw SQL DELETE statement targets design_identity_handles, whose runtime capability lacks DELETE",
		]);
	});

	it("detects Kysely and raw-SQL write statements against withheld privileges", () => {
		expect(
			writeCapabilityViolationsInSource(
				`db.updateTable("app_changes").set({ kind: "chat" })`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 updateTable targets app_changes, whose runtime capability lacks UPDATE",
		]);
		expect(
			writeCapabilityViolationsInSource(
				`db.updateTable("design_identity_handles").set({ entity_kind: "record" })`,
				"fixture.ts",
			),
		).toEqual([]);
		expect(
			writeCapabilityViolationsInSource(
				`db.deleteFrom("design_identity_handles").where("handle", "=", "@x")`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 deleteFrom targets design_identity_handles, whose runtime capability lacks DELETE",
		]);
		expect(
			writeCapabilityViolationsInSource(
				`db.insertInto("app_change_fold_baselines").values(row)`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 insertInto targets app_change_fold_baselines, whose runtime capability lacks INSERT",
		]);
		expect(
			writeCapabilityViolationsInSource(
				`db.updateTable("design_change_set_requests as request").set(patch)`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 updateTable targets design_change_set_requests, whose runtime capability lacks UPDATE",
		]);
		expect(
			writeCapabilityViolationsInSource(
				`db.updateTable(dynamicTarget).set(patch)`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 updateTable names its table dynamically, so this guard can't check its write privileges — pass the table name as a literal string",
		]);
		expect(
			writeCapabilityViolationsInSource(
				"sql`UPDATE app_changes SET kind = 'chat' WHERE app_id = 'a'`",
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 raw SQL UPDATE statement targets app_changes, whose runtime capability lacks UPDATE",
		]);
		expect(
			writeCapabilityViolationsInSource(
				"sql`DELETE FROM design_identity_handles WHERE handle = '@x'`",
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 raw SQL DELETE statement targets design_identity_handles, whose runtime capability lacks DELETE",
		]);
	});

	it("requires UPDATE for an upsert's ON CONFLICT DO UPDATE arm", () => {
		expect(
			writeCapabilityViolationsInSource(
				`db.insertInto("app_changes").values(row).onConflict((oc) => oc.doUpdateSet({ kind: "chat" }))`,
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 insertInto targets app_changes with onConflict doUpdateSet, whose runtime capability lacks UPDATE",
		]);
		expect(
			writeCapabilityViolationsInSource(
				`db.insertInto("presence").values(row).onConflict((oc) => oc.doUpdateSet({ left_at: null }))`,
				"fixture.ts",
			),
		).toEqual([]);
		expect(
			writeCapabilityViolationsInSource(
				"sql`INSERT INTO app_changes (id) VALUES ('a') ON CONFLICT (id) DO UPDATE SET kind = 'chat'`",
				"fixture.ts",
			),
		).toEqual([
			"fixture.ts:1 raw SQL INSERT ... ON CONFLICT DO UPDATE statement targets app_changes, whose runtime capability lacks UPDATE",
		]);
		/* design_identity_handles carries UPDATE (insert-update capability),
		 * so its upsert is legal on both arms. */
		expect(
			writeCapabilityViolationsInSource(
				"sql`INSERT INTO design_identity_handles (handle) VALUES ('@x') ON CONFLICT DO UPDATE SET handle = '@x'`",
				"fixture.ts",
			),
		).toEqual([]);
	});
});
