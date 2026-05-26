/**
 * Read-only scan for `#case/<X>` (X ≠ `case_id`) references stored on
 * registration forms in production.
 *
 * Why: this branch ships a doc-layer validator rule
 * (`CASE_HASHTAG_ON_CREATE_FORM`) that rejects exactly this shape at
 * authoring time. Apps persisted BEFORE this branch may have stored
 * such references in any of the scanned XPath surfaces — they
 * previously emitted a case-loading XPath that JavaRosa couldn't
 * resolve at form-init (the silent install-time fatal the new rule
 * prevents). The scan reports what's out there so the operator can
 * decide blast radius BEFORE the branch ships — running before merge
 * means no app ever hits the new validator rejection.
 *
 * Scope of surfaces walked per registration form:
 *   - Each field's expression slots: relevant / validate / calculate /
 *     default_value / required (XPath).
 *   - Each field's prose slots: label / hint / validate_msg (inline
 *     bare-hashtag prose that the XForm builder lowers to
 *     `<output value>` at emit).
 *   - The form's Connect XPath bindings: deliver_unit.entity_id /
 *     entity_name, assessment.user_score.
 *
 * Output: CSV to stdout. Header: app_id, owner, module_uuid,
 * module_name, form_uuid, form_name, field_uuid, field_id, surface,
 * authored_expression, hashtag. One row per offending hashtag
 * occurrence; an expression with multiple invalid refs emits multiple
 * rows.
 *
 * Read-only by design — no Firestore writes, no `--apply` flag. Any
 * migration is a separate operator decision the user will make from
 * the scan output. Server-side filter: `deleted_at == null` AND
 * `status == "complete"` (matches the migrate-case-list pattern).
 *
 * Usage:
 *   npx tsx scripts/scan-hashtag-case-create-usage.ts                 # bulk scan
 *   npx tsx scripts/scan-hashtag-case-create-usage.ts --app-id=abc123 # single app
 *   npx tsx scripts/scan-hashtag-case-create-usage.ts --help
 */

import "dotenv/config";
import { Command } from "commander";
import { readFieldString } from "@/lib/commcare/fieldProps";
import { parser } from "@/lib/commcare/xpath";
import type { BlueprintDoc, Field, Form, Module, Uuid } from "@/lib/domain";
import { db, hydrateBlueprint } from "./lib/firestore";
import { runMain } from "./lib/main";

interface ScanOptions {
	appId?: string;
}

const program = new Command();
program
	.name("scan-hashtag-case-create-usage")
	.description(
		"Read-only scan for #case/<X> (X ≠ case_id) on registration forms. Emits CSV.",
	)
	.option("--app-id <id>", "scan a single app (bypasses the bulk filter)")
	.addHelpText(
		"after",
		"\nWhat this does:\n" +
			"  • Walks every persisted app (or one --app-id) for registration forms\n" +
			"  • For each registration form, scans every field's XPath + prose surfaces\n" +
			"    and the form's Connect XPath bindings for #case/<X> where X ≠ case_id\n" +
			"  • Emits CSV to stdout — one row per offending hashtag occurrence\n" +
			"\nThis script never writes. Any migration is a separate operator decision.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-hashtag-case-create-usage.ts > affected-apps.csv\n" +
			"  $ npx tsx scripts/scan-hashtag-case-create-usage.ts --app-id=abc123\n",
	);

program.parse();
const opts = program.opts<ScanOptions>();

// ── Hashtag scanning helpers ────────────────────────────────────────

/**
 * Pre-resolved Lezer node types. Identical to the rule in
 * `lib/commcare/validator/rules/form.ts::caseHashtagOnCreateForm` —
 * kept inline here so the script has no shared-helper coupling that
 * could drift between the validator + this scan over time.
 */
const HASHTAG_NODE_TYPES = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	return {
		HashtagRef: one("HashtagRef"),
		HashtagType: one("HashtagType"),
		HashtagSegment: one("HashtagSegment"),
	};
})();

/** Lezer scan for an XPath expression. */
function findInvalidCaseHashtagsInXPath(expr: string): string[] {
	if (!expr) return [];
	const out: string[] = [];
	const tree = parser.parse(expr);
	tree.iterate({
		enter(node) {
			if (node.type !== HASHTAG_NODE_TYPES.HashtagRef) return;
			const ref = node.node;
			const type = ref.getChild(HASHTAG_NODE_TYPES.HashtagType.id);
			if (!type) return false;
			if (expr.slice(type.from, type.to) !== "case") return false;
			const segments = ref.getChildren(HASHTAG_NODE_TYPES.HashtagSegment.id);
			if (segments.length === 1) {
				const seg = expr.slice(segments[0].from, segments[0].to);
				if (seg === "case_id") return false;
			}
			out.push(expr.slice(node.from, node.to));
			return false;
		},
	});
	return out;
}

/** Regex scan for prose surfaces. */
const PROSE_HASHTAG_RE = /#case((?:\/[a-zA-Z_][a-zA-Z0-9_-]*)+)/g;
function findInvalidCaseHashtagsInProse(text: string): string[] {
	if (!text) return [];
	const out: string[] = [];
	for (const match of text.matchAll(PROSE_HASHTAG_RE)) {
		const segments = match[1].split("/").filter((s) => s.length > 0);
		if (segments.length === 1 && segments[0] === "case_id") continue;
		out.push(match[0]);
	}
	return out;
}

// ── Doc walk ────────────────────────────────────────────────────────

interface ScanRow {
	app_id: string;
	owner: string;
	module_uuid: Uuid;
	module_name: string;
	form_uuid: Uuid;
	form_name: string;
	field_uuid: Uuid | "";
	field_id: string;
	surface: string;
	authored_expression: string;
	hashtag: string;
}

const XPATH_FIELD_SURFACES = [
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"required",
] as const;
const PROSE_FIELD_SURFACES = ["label", "hint", "validate_msg"] as const;

/**
 * Walk one app and emit rows for every offending occurrence under any
 * registration form. Mirrors the surface set of
 * `caseHashtagOnCreateForm` so what the scan reports is exactly what
 * the new rule would reject if the app were re-validated post-merge.
 */
function scanApp(appId: string, owner: string, doc: BlueprintDoc): ScanRow[] {
	const rows: ScanRow[] = [];

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid] as Module | undefined;
		if (!mod) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid] as Form | undefined;
			if (!form || form.type !== "registration") continue;

			/** Push one row per offending hashtag in a single surface value. */
			const pushFieldRows = (
				field: Field,
				surface: string,
				value: string | undefined,
				kind: "xpath" | "prose",
			): void => {
				if (!value) return;
				const hashtags =
					kind === "xpath"
						? findInvalidCaseHashtagsInXPath(value)
						: findInvalidCaseHashtagsInProse(value);
				for (const hashtag of hashtags) {
					rows.push({
						app_id: appId,
						owner,
						module_uuid: moduleUuid,
						module_name: mod.name,
						form_uuid: formUuid,
						form_name: form.name,
						field_uuid: field.uuid,
						field_id: field.id,
						surface,
						authored_expression: value,
						hashtag,
					});
				}
			};

			// Field-tree walker — XPath, prose, and repeat-cardinality
			// surfaces per field. Mirrors the surfaces the doc-layer rule
			// `caseHashtagOnCreateForm` walks; keeping the scan + the rule
			// in lockstep means the report names exactly what the rule
			// would reject on re-validation.
			const walkFields = (parentUuid: Uuid): void => {
				for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
					const field = doc.fields[uuid] as Field | undefined;
					if (!field) continue;
					for (const surface of XPATH_FIELD_SURFACES) {
						pushFieldRows(
							field,
							surface,
							readFieldString(field, surface),
							"xpath",
						);
					}
					for (const surface of PROSE_FIELD_SURFACES) {
						pushFieldRows(
							field,
							surface,
							readFieldString(field, surface),
							"prose",
						);
					}
					if (field.kind === "repeat") {
						if (field.repeat_mode === "count_bound") {
							pushFieldRows(field, "repeat_count", field.repeat_count, "xpath");
						} else if (field.repeat_mode === "query_bound") {
							pushFieldRows(
								field,
								"data_source.ids_query",
								field.data_source.ids_query,
								"xpath",
							);
						}
					}
					if (doc.fieldOrder[uuid] !== undefined) walkFields(uuid);
				}
			};
			walkFields(formUuid);

			// Connect XPath surfaces are not field-bound — emit rows with
			// `field_uuid=""` + a surface label naming the Connect slot.
			const connect = form.connect;
			if (connect?.deliver_unit) {
				for (const [slot, expr] of [
					["connect deliver_unit.entity_id", connect.deliver_unit.entity_id],
					[
						"connect deliver_unit.entity_name",
						connect.deliver_unit.entity_name,
					],
				] as const) {
					if (!expr) continue;
					for (const hashtag of findInvalidCaseHashtagsInXPath(expr)) {
						rows.push({
							app_id: appId,
							owner,
							module_uuid: moduleUuid,
							module_name: mod.name,
							form_uuid: formUuid,
							form_name: form.name,
							field_uuid: "",
							field_id: "",
							surface: slot,
							authored_expression: expr,
							hashtag,
						});
					}
				}
			}
			if (connect?.assessment?.user_score) {
				const expr = connect.assessment.user_score;
				for (const hashtag of findInvalidCaseHashtagsInXPath(expr)) {
					rows.push({
						app_id: appId,
						owner,
						module_uuid: moduleUuid,
						module_name: mod.name,
						form_uuid: formUuid,
						form_name: form.name,
						field_uuid: "",
						field_id: "",
						surface: "connect assessment.user_score",
						authored_expression: expr,
						hashtag,
					});
				}
			}
		}
	}

	return rows;
}

// ── CSV emit ────────────────────────────────────────────────────────

/**
 * Quote a CSV value per RFC 4180 — wrap in double quotes if the value
 * contains a comma, newline, or double quote; double internal quotes
 * are escaped by doubling.
 */
function csvField(value: string): string {
	if (/[",\n\r]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function emitRow(row: ScanRow): void {
	const cols = [
		row.app_id,
		row.owner,
		row.module_uuid,
		row.module_name,
		row.form_uuid,
		row.form_name,
		row.field_uuid,
		row.field_id,
		row.surface,
		row.authored_expression,
		row.hashtag,
	];
	console.log(cols.map(csvField).join(","));
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// CSV header.
	console.log(
		"app_id,owner,module_uuid,module_name,form_uuid,form_name,field_uuid,field_id,surface,authored_expression,hashtag",
	);

	/**
	 * Narrow shape — same pattern as `migrate-case-list-schema-reshape`:
	 * define the read surface inline so the script stays decoupled from
	 * the full `@google-cloud/firestore` type surface (the SDK's
	 * `data()` returns `DocumentData | undefined`, and only `blueprint`
	 * + `owner` are read here).
	 */
	interface AppDocSnapshot {
		readonly id: string;
		data(): { blueprint?: unknown; owner?: unknown } | undefined;
	}

	let docs: AppDocSnapshot[];
	if (opts.appId) {
		// Surgical path — bypass the deleted_at / status filter.
		const snap = await db.collection("apps").doc(opts.appId).get();
		if (!snap.exists) {
			console.error(`App ${opts.appId} not found.`);
			process.exit(1);
		}
		docs = [snap as AppDocSnapshot];
	} else {
		// Bulk path — same filter as migrate-case-list-schema-reshape.ts:
		// soft-deletes out of scope; generating rows would race the scan;
		// error rows have suspect blueprint shape.
		const result = await db
			.collection("apps")
			.where("deleted_at", "==", null)
			.where("status", "==", "complete")
			.get();
		docs = result.docs as AppDocSnapshot[];
	}

	let scanned = 0;
	let appsWithFindings = 0;
	let totalRows = 0;

	for (const snap of docs) {
		scanned += 1;
		const data = snap.data() ?? {};
		const blueprint = data.blueprint;
		if (!blueprint) continue;
		try {
			const doc = hydrateBlueprint(blueprint);
			const owner = typeof data.owner === "string" ? data.owner : "";
			const rows = scanApp(snap.id, owner, doc);
			if (rows.length > 0) {
				appsWithFindings += 1;
				totalRows += rows.length;
				for (const row of rows) emitRow(row);
			}
		} catch (err) {
			// Per-app try/catch — one corrupt doc cannot abort the run.
			// Surface to stderr so the CSV stream stays valid.
			console.error(
				`[scan] app=${snap.id} skipped: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	console.error(
		`[scan] apps_scanned=${scanned} apps_with_findings=${appsWithFindings} total_rows=${totalRows}`,
	);
}

runMain(main);
