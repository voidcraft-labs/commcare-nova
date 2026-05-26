/**
 * Rewrite every `#case/<X>` (X ≠ `case_id`) reference stored on a
 * registration form to `#form/<X>`, when the form has a field with
 * `id === X`. When the field doesn't exist, the reference is left
 * un-rewritten — the operator gets a WARN line for triage.
 *
 * Why: this branch ships a doc-layer validator rule
 * (`CASE_HASHTAG_ON_CREATE_FORM`) that rejects `#case/<X>` (X ≠
 * `case_id`) at authoring time. Apps persisted BEFORE this branch may
 * carry such references on a registration form's XPath or prose
 * surfaces — they previously expanded to a case-loading XPath
 * (`instance('casedb')/casedb/case[@case_id = …]/<X>`) which JavaRosa
 * could not resolve at form-init on a case-create form (the case
 * being created doesn't exist in `casedb` yet). The runtime symptom
 * is a silent empty-string evaluation; for Connect deliver_unit
 * bindings this collapses every submission's `entity_id` to "", so
 * Connect treats every visit as the same entity and the FLW is
 * underpaid on every distinct delivery after the first.
 *
 * The rewrite is deterministic because Nova's field id == case
 * property name is an authoring invariant — `#case/<X>` on a
 * registration form was ALWAYS intended to grab the value the form
 * itself is about to write to property `<X>`. The correct ref for
 * that intent is `#form/<X>` (a form-question reference); the wire
 * layer lowers it to `/data/<X>`, which JavaRosa resolves to the
 * value the user typed before submission. Connect doesn't care which
 * XPath produced the string — `form_receiver/processor.py::
 * process_deliver_form` reads `deliver_unit_block.get("entity_id")`
 * from the submitted form XML and stores it verbatim.
 *
 * Scope of surfaces rewritten per registration form:
 *   - Each field's XPath slots: relevant / validate / calculate /
 *     default_value / required.
 *   - Each field's prose slots: label / hint / validate_msg (inline
 *     bare-hashtag prose the XForm builder lowers to
 *     `<output value>` at emit).
 *   - The form's Connect XPath bindings: deliver_unit.entity_id /
 *     entity_name, assessment.user_score.
 *
 * Safety contract:
 *   - **Dry-run is the default.** Bare invocation scans + plans +
 *     logs every per-app edit list WITHOUT touching Firestore. The
 *     operator must pass `--apply` to take the live-write path.
 *   - `--app-id=<id>` for surgical retry; bypasses the bulk filter.
 *   - Server-side `deleted_at == null` AND `status == "complete"`
 *     filter on the bulk apps query.
 *   - Per-app `try / catch` so one bad doc cannot abort the run.
 *   - Per-rewrite WARN when the target field doesn't exist; the
 *     authored expression is left untouched.
 *
 * Idempotency: re-running the script on already-rewritten data is a
 * no-op. The rewrite finds `#case/<X>` (X ≠ `case_id`) only; once an
 * expression has been rewritten to `#form/<X>` there is nothing for a
 * second pass to find.
 *
 * Usage:
 *   npx tsx scripts/migrate-hashtag-case-create.ts               # dry-run (default)
 *   npx tsx scripts/migrate-hashtag-case-create.ts --apply       # live writes
 *   npx tsx scripts/migrate-hashtag-case-create.ts --app-id=abc  # surgical dry-run
 *   npx tsx scripts/migrate-hashtag-case-create.ts --app-id=abc --apply
 *   npx tsx scripts/migrate-hashtag-case-create.ts --help
 */

import "dotenv/config";
import { parser } from "@/lib/commcare/xpath";
import { db } from "./lib/firestore";

// ── Hashtag detection ───────────────────────────────────────────────

/**
 * Pre-resolved Lezer node types. Kept inline (rather than imported
 * from the validator) so the migration is self-contained and a future
 * extension to the validator's rule can't silently change the
 * migration's rewrite shape.
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

/**
 * One offending hashtag occurrence inside an XPath expression: the
 * `from`/`to` byte offsets carve out the original
 * `#case/<X>[/<Y>...]` span, and `segments` carries the path segments
 * for the rewrite — the migration uses the first segment to look up a
 * matching form field.
 */
interface XPathOffender {
	readonly from: number;
	readonly to: number;
	readonly segments: readonly string[];
}

function findXPathOffenders(expr: string): XPathOffender[] {
	if (!expr) return [];
	const out: XPathOffender[] = [];
	const tree = parser.parse(expr);
	tree.iterate({
		enter(node) {
			if (node.type !== HASHTAG_NODE_TYPES.HashtagRef) return;
			const ref = node.node;
			const type = ref.getChild(HASHTAG_NODE_TYPES.HashtagType.id);
			if (!type) return false;
			if (expr.slice(type.from, type.to) !== "case") return false;
			const segments = ref
				.getChildren(HASHTAG_NODE_TYPES.HashtagSegment.id)
				.map((s) => expr.slice(s.from, s.to));
			if (segments.length === 1 && segments[0] === "case_id") return false;
			out.push({ from: node.from, to: node.to, segments });
			return false;
		},
	});
	return out;
}

/** Apply a list of replace-spans in reverse order so earlier offsets stay valid. */
function applyEdits(
	source: string,
	edits: ReadonlyArray<{ from: number; to: number; text: string }>,
): string {
	if (edits.length === 0) return source;
	let result = source;
	for (let i = edits.length - 1; i >= 0; i--) {
		const { from, to, text } = edits[i];
		result = result.slice(0, from) + text + result.slice(to);
	}
	return result;
}

/**
 * Rewrite every `#case/<X>` (X ≠ `case_id`) in `expr` to
 * `#form/<X>[…]`, gated by `fieldExists`. Returns the rewritten
 * expression + the list of (segments, rewritten) the caller logs.
 * Refs whose first segment names a non-existent field stay
 * un-rewritten; the caller WARNs and the doc-layer validator surfaces
 * the same authoring error post-merge.
 */
function rewriteXPath(
	expr: string,
	fieldExists: (id: string) => boolean,
): {
	readonly result: string;
	readonly rewrites: ReadonlyArray<{ from: string; to: string }>;
	readonly unmatched: ReadonlyArray<string>;
} {
	const offenders = findXPathOffenders(expr);
	if (offenders.length === 0) {
		return { result: expr, rewrites: [], unmatched: [] };
	}
	const edits: Array<{ from: number; to: number; text: string }> = [];
	const rewrites: Array<{ from: string; to: string }> = [];
	const unmatched: string[] = [];
	for (const o of offenders) {
		const fieldId = o.segments[0];
		const original = expr.slice(o.from, o.to);
		if (!fieldExists(fieldId)) {
			unmatched.push(original);
			continue;
		}
		// Preserve any trailing path segments past the first — `#case/parent/age`
		// rewrites to `#form/parent/age` (the wire layer expands the form-side
		// ref to `/data/parent/age`). Same hash-namespace path semantics.
		const tail = o.segments.slice(1).join("/");
		const replacement = tail ? `#form/${fieldId}/${tail}` : `#form/${fieldId}`;
		edits.push({ from: o.from, to: o.to, text: replacement });
		rewrites.push({ from: original, to: replacement });
	}
	return { result: applyEdits(expr, edits), rewrites, unmatched };
}

/**
 * Prose pattern — same shape as the XForm builder's
 * `BARE_HASHTAG_RE`, scoped to `#case/<segments>`. The rewrite
 * preserves trailing segments past the first so a prose `#case/parent/age`
 * becomes `#form/parent/age`.
 */
const PROSE_HASHTAG_RE = /#case((?:\/[a-zA-Z_][a-zA-Z0-9_-]*)+)/g;

function rewriteProse(
	text: string,
	fieldExists: (id: string) => boolean,
): {
	readonly result: string;
	readonly rewrites: ReadonlyArray<{ from: string; to: string }>;
	readonly unmatched: ReadonlyArray<string>;
} {
	if (!text) return { result: text, rewrites: [], unmatched: [] };
	const rewrites: Array<{ from: string; to: string }> = [];
	const unmatched: string[] = [];
	const result = text.replace(PROSE_HASHTAG_RE, (match, path: string) => {
		const segments = path.split("/").filter((s) => s.length > 0);
		if (segments.length === 1 && segments[0] === "case_id") return match;
		const fieldId = segments[0];
		if (!fieldExists(fieldId)) {
			unmatched.push(match);
			return match;
		}
		const replacement = `#form/${segments.join("/")}`;
		rewrites.push({ from: match, to: replacement });
		return replacement;
	});
	return { result, rewrites, unmatched };
}

// ── Doc walk ────────────────────────────────────────────────────────

const XPATH_FIELD_SURFACES = [
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"required",
] as const;
const PROSE_FIELD_SURFACES = ["label", "hint", "validate_msg"] as const;

interface PerAppOutcome {
	readonly rewriteCount: number;
	readonly unmatchedCount: number;
	readonly rewrites: ReadonlyArray<{
		readonly location: string;
		readonly from: string;
		readonly to: string;
	}>;
	readonly unmatched: ReadonlyArray<{
		readonly location: string;
		readonly hashtag: string;
	}>;
}

/**
 * Walk the doc's registration forms in place. Each rewrite happens
 * via direct property assignment on the existing nested object —
 * `db.update({ blueprint: doc })` writes the entire blueprint slot
 * verbatim, so a mutate-and-write strategy is correct as long as the
 * caller hasn't shared the doc reference with anyone who'd observe
 * partial state mid-rewrite. The migration script doesn't have any
 * such observer.
 */
function rewriteBlueprintInPlace(
	doc: Record<string, unknown> & {
		modules: Record<string, { name: string }>;
		moduleOrder: string[];
		forms: Record<
			string,
			{
				name: string;
				type: string;
				connect?: {
					deliver_unit?: { entity_id?: string; entity_name?: string };
					assessment?: { user_score?: string };
				};
			}
		>;
		formOrder: Record<string, string[]>;
		fields: Record<string, Record<string, unknown> & { id: string }>;
		fieldOrder: Record<string, string[]>;
	},
): PerAppOutcome {
	const rewrites: PerAppOutcome["rewrites"][number][] = [];
	const unmatched: PerAppOutcome["unmatched"][number][] = [];

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		const formUuids = doc.formOrder[moduleUuid] ?? [];
		for (const formUuid of formUuids) {
			const form = doc.forms[formUuid];
			if (!form || form.type !== "registration") continue;

			// Collect every reachable field id under this form so the
			// `fieldExists` predicate runs in O(1). Forms are small;
			// rebuild per form rather than caching across forms (cross-form
			// field-id collisions don't matter — Nova rejects cross-level
			// sibling collisions at validate time).
			const fieldIds = new Set<string>();
			const collectIds = (parent: string): void => {
				for (const childUuid of doc.fieldOrder[parent] ?? []) {
					const child = doc.fields[childUuid];
					if (!child) continue;
					fieldIds.add(child.id);
					if (doc.fieldOrder[childUuid]) collectIds(childUuid);
				}
			};
			collectIds(formUuid);
			const fieldExists = (id: string) => fieldIds.has(id);

			// Field-tree walker — XPath + prose surfaces per field.
			const walkFields = (parent: string): void => {
				for (const uuid of doc.fieldOrder[parent] ?? []) {
					const field = doc.fields[uuid];
					if (!field) continue;
					const fieldId = field.id;
					for (const surface of XPATH_FIELD_SURFACES) {
						const expr = field[surface];
						if (typeof expr !== "string" || !expr) continue;
						const rewritten = rewriteXPath(expr, fieldExists);
						if (
							rewritten.rewrites.length === 0 &&
							rewritten.unmatched.length === 0
						) {
							continue;
						}
						const location = `module="${mod.name}" form="${form.name}" field="${fieldId}" surface=${surface}`;
						for (const r of rewritten.rewrites) {
							rewrites.push({ location, from: r.from, to: r.to });
						}
						for (const u of rewritten.unmatched) {
							unmatched.push({ location, hashtag: u });
						}
						if (rewritten.result !== expr) {
							field[surface] = rewritten.result;
						}
					}
					for (const surface of PROSE_FIELD_SURFACES) {
						const text = field[surface];
						if (typeof text !== "string" || !text) continue;
						const rewritten = rewriteProse(text, fieldExists);
						if (
							rewritten.rewrites.length === 0 &&
							rewritten.unmatched.length === 0
						) {
							continue;
						}
						const location = `module="${mod.name}" form="${form.name}" field="${fieldId}" surface=${surface}`;
						for (const r of rewritten.rewrites) {
							rewrites.push({ location, from: r.from, to: r.to });
						}
						for (const u of rewritten.unmatched) {
							unmatched.push({ location, hashtag: u });
						}
						if (rewritten.result !== text) {
							field[surface] = rewritten.result;
						}
					}
					if (doc.fieldOrder[uuid] !== undefined) walkFields(uuid);
				}
			};
			walkFields(formUuid);

			// Connect XPath surfaces.
			if (form.connect?.deliver_unit) {
				for (const slot of ["entity_id", "entity_name"] as const) {
					const expr = form.connect.deliver_unit[slot];
					if (typeof expr !== "string" || !expr) continue;
					const rewritten = rewriteXPath(expr, fieldExists);
					if (
						rewritten.rewrites.length === 0 &&
						rewritten.unmatched.length === 0
					) {
						continue;
					}
					const location = `module="${mod.name}" form="${form.name}" surface=connect deliver_unit.${slot}`;
					for (const r of rewritten.rewrites) {
						rewrites.push({ location, from: r.from, to: r.to });
					}
					for (const u of rewritten.unmatched) {
						unmatched.push({ location, hashtag: u });
					}
					if (rewritten.result !== expr) {
						form.connect.deliver_unit[slot] = rewritten.result;
					}
				}
			}
			if (form.connect?.assessment) {
				const expr = form.connect.assessment.user_score;
				if (typeof expr === "string" && expr) {
					const rewritten = rewriteXPath(expr, fieldExists);
					if (rewritten.rewrites.length > 0 || rewritten.unmatched.length > 0) {
						const location = `module="${mod.name}" form="${form.name}" surface=connect assessment.user_score`;
						for (const r of rewritten.rewrites) {
							rewrites.push({ location, from: r.from, to: r.to });
						}
						for (const u of rewritten.unmatched) {
							unmatched.push({ location, hashtag: u });
						}
						if (rewritten.result !== expr) {
							form.connect.assessment.user_score = rewritten.result;
						}
					}
				}
			}
		}
	}

	return {
		rewriteCount: rewrites.length,
		unmatchedCount: unmatched.length,
		rewrites,
		unmatched,
	};
}

// ── CLI args ────────────────────────────────────────────────────────

interface MigrateOptions {
	readonly apply: boolean;
	readonly appId?: string;
	readonly help: boolean;
}

const HELP_TEXT = [
	"Usage: migrate-hashtag-case-create [options]",
	"",
	"  Rewrite every `#case/<X>` (X ≠ case_id) reference on a registration",
	"  form to `#form/<X>` when the target field exists. Mirrors the",
	"  doc-layer rule CASE_HASHTAG_ON_CREATE_FORM the same branch ships.",
	"",
	"  DEFAULT MODE: dry-run. The script plans + logs every per-app edit",
	"  list WITHOUT writing to Firestore. The operator must pass --apply",
	"  to take the live-write path.",
	"",
	"Options:",
	"  --apply           Opt INTO live writes. Required to mutate Firestore.",
	"  --app-id=<id>     Target one app by id; bypasses the bulk apps query.",
	"  --help, -h        Print this help text and exit.",
	"",
	"Examples:",
	"  # Dry-run pass over every eligible app (default; no writes).",
	"  npx tsx scripts/migrate-hashtag-case-create.ts",
	"",
	"  # Live-write pass over every eligible app — only after a dry-run.",
	"  npx tsx scripts/migrate-hashtag-case-create.ts --apply",
	"",
	"  # Surgical-retry: dry-run a single app.",
	"  npx tsx scripts/migrate-hashtag-case-create.ts --app-id=abc123",
	"",
	"  # Surgical-retry: write a single app.",
	"  npx tsx scripts/migrate-hashtag-case-create.ts --app-id=abc123 --apply",
].join("\n");

function parseArgs(argv: readonly string[]): MigrateOptions {
	let apply = false;
	let appId: string | undefined;
	let help = false;
	for (const arg of argv) {
		if (arg === "--apply") {
			apply = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg.startsWith("--app-id=")) {
			const value = arg.slice("--app-id=".length);
			if (value.length === 0) {
				throw new Error("--app-id flag requires a non-empty value");
			}
			appId = value;
			continue;
		}
		throw new Error(`Unrecognized argument: ${arg}`);
	}
	return { apply, appId, help };
}

// ── Main loop ───────────────────────────────────────────────────────

interface AppDocSnapshot {
	readonly id: string;
	data(): { blueprint?: unknown; owner?: unknown } | undefined;
	readonly ref: {
		update(patch: { blueprint: unknown }): Promise<unknown>;
	};
}

async function run(opts: MigrateOptions): Promise<void> {
	let docs: AppDocSnapshot[];
	if (opts.appId) {
		const snap = await db.collection("apps").doc(opts.appId).get();
		if (!snap.exists) {
			console.error(`App ${opts.appId} not found.`);
			process.exit(1);
		}
		docs = [snap as AppDocSnapshot];
	} else {
		const result = await db
			.collection("apps")
			.where("deleted_at", "==", null)
			.where("status", "==", "complete")
			.get();
		docs = result.docs as AppDocSnapshot[];
	}

	const mode = opts.apply ? "APPLY" : "DRY-RUN";
	console.log(`[migrate-hashtag-case-create] mode=${mode} apps=${docs.length}`);

	let scanned = 0;
	let appsRewritten = 0;
	let totalRewrites = 0;
	let totalUnmatched = 0;
	let failedCount = 0;

	for (const snap of docs) {
		scanned += 1;
		const data = snap.data() ?? {};
		const blueprint = data.blueprint;
		if (!blueprint) continue;
		const owner = typeof data.owner === "string" ? data.owner : "<unknown>";

		try {
			const doc = blueprint as Parameters<typeof rewriteBlueprintInPlace>[0];
			const outcome = rewriteBlueprintInPlace(doc);

			if (outcome.rewriteCount === 0 && outcome.unmatchedCount === 0) {
				continue;
			}

			console.log(
				`[migrate-hashtag-case-create] app=${snap.id} owner=${owner} rewrites=${outcome.rewriteCount} unmatched=${outcome.unmatchedCount}`,
			);
			for (const r of outcome.rewrites) {
				console.log(`  REWRITE ${r.location}: "${r.from}" -> "${r.to}"`);
			}
			for (const u of outcome.unmatched) {
				console.warn(
					`  UNMATCHED ${u.location}: "${u.hashtag}" — no field with id "${u.hashtag.replace(/^#case\/([^/]+).*/, "$1")}" exists in this form; left untouched (operator triage)`,
				);
			}

			if (outcome.rewriteCount > 0) {
				appsRewritten += 1;
				totalRewrites += outcome.rewriteCount;
				if (opts.apply) {
					await snap.ref.update({ blueprint: doc });
				}
			}
			totalUnmatched += outcome.unmatchedCount;
		} catch (err) {
			failedCount += 1;
			console.error(
				`[migrate-hashtag-case-create] app=${snap.id} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	const verb = opts.apply ? "applied" : "planned (dry-run)";
	console.log(
		`[migrate-hashtag-case-create] mode=${mode} apps_scanned=${scanned} apps_rewritten=${appsRewritten} rewrites_${verb}=${totalRewrites} unmatched=${totalUnmatched} failed=${failedCount}`,
	);
	if (failedCount > 0) process.exit(1);
}

// ── Entrypoint ──────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	let opts: MigrateOptions;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error("");
		console.error(HELP_TEXT);
		process.exit(2);
	}
	if (opts.help) {
		console.log(HELP_TEXT);
		process.exit(0);
	}
	run(opts).catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
