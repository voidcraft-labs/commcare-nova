#!/usr/bin/env tsx
/**
 * One-time migration: rewrite historical ConversationEvent payloads in
 * `apps/{appId}/events/` from the CommCare-flavored SA tool vocabulary
 * to the new domain vocabulary.
 *
 * ## Why
 *
 * The SA refactor (April 2026) renamed five tools and their argument
 * shapes so the agent speaks domain vocabulary end-to-end:
 *
 *   tool name renames
 *     addQuestions → addFields
 *     addQuestion  → addField
 *     editQuestion → editField
 *     getQuestion  → getField
 *     removeQuestion → removeField
 *
 *   tool-argument key renames
 *     questionId        → fieldId
 *     afterQuestionId   → afterFieldId
 *     beforeQuestionId  → beforeFieldId
 *     question          → field     (single-insert shape)
 *     questions         → fields    (batch-insert shape)
 *
 *   per-field property renames (inside the `field`/`fields` shapes
 *   AND inside `editField`'s `updates` patch)
 *     type              → kind
 *     validation        → validate
 *     validation_msg    → validate_msg
 *     case_property_on  → case_property
 *
 *   miscellaneous
 *     updateForm's close_condition.question → close_condition.field
 *
 * The live generator + SA code emit the new shape from now on. Historical
 * event docs still carry the old shape verbatim — this script rewrites
 * them in place so admin replay, inspect scripts, and any UI that reads
 * `toolName` or displays tool input/output don't see a mix of eras.
 *
 * ## Safety
 *
 * - Destination path = source path. This is an in-place rewrite; take a
 *   Firestore export to GCS before running against prod.
 * - `--dry-run` prints the rewrite plan (per-app counts) without writing.
 * - `--app=<id>` restricts to one app.
 * - `--verbose` logs every per-event rewrite.
 * - Firestore writes are batched in chunks of 400 (under the 500-op
 *   batch limit).
 * - The rewrite is idempotent: running twice on the same app is a no-op
 *   on the second run because old keys are gone and new ones don't match
 *   any rename rules.
 *
 * ## Scope
 *
 * Only ConversationEvent docs with a `tool-call` or `tool-result`
 * payload whose `toolName` is in the rename set are touched.
 * MutationEvents are untouched — they already carry domain vocabulary
 * (the rename happened at the wire boundary before the log writer).
 * Non-renamed tools (generateSchema, askQuestions, searchBlueprint,
 * updateModule, etc.) are also untouched.
 */

import "dotenv/config";
import { getDb } from "@/lib/db/firestore";

// ── CLI flag parsing ────────────────────────────────────────────────

interface Flags {
	app?: string;
	dryRun: boolean;
	verbose: boolean;
}

function parseFlags(): Flags {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`
Usage: npx tsx scripts/migrate-agent-tool-vocab.ts [options]

Rewrites historical SA tool-call / tool-result events under
apps/{appId}/events/ from CommCare-flavored vocabulary (type /
validation / case_property_on / questionId) to domain vocabulary
(kind / validate / case_property / fieldId).

Options:
  --app=<id>      Restrict to a single app (default: every app).
  --dry-run       Print the plan without writing.
  --verbose       Log per-event rewrite decisions.
  --help, -h      Show this help.

Run --dry-run first. Take a Firestore export before running for real.
`);
		process.exit(0);
	}
	return {
		app: args.find((a) => a.startsWith("--app="))?.split("=")[1],
		dryRun: args.includes("--dry-run"),
		verbose: args.includes("--verbose"),
	};
}

// ── Rename tables ───────────────────────────────────────────────────

/**
 * Tool-name remapping. Any toolName NOT in this map is left as-is —
 * other renamed tools would live alongside these, so the list is the
 * authoritative surface of what changed.
 */
const TOOL_NAME_RENAMES: Readonly<Record<string, string>> = {
	addQuestions: "addFields",
	addQuestion: "addField",
	editQuestion: "editField",
	getQuestion: "getField",
	removeQuestion: "removeField",
};

/** Tool-argument top-level key renames that apply to the tools above. */
const ARG_KEY_RENAMES: Readonly<Record<string, string>> = {
	questionId: "fieldId",
	afterQuestionId: "afterFieldId",
	beforeQuestionId: "beforeFieldId",
	question: "field",
	questions: "fields",
};

/**
 * Per-field property renames applied INSIDE a field / fields / updates
 * payload. Scoped to question-shape objects so we don't accidentally
 * rewrite unrelated keys elsewhere in the event.
 */
const FIELD_PROPERTY_RENAMES: Readonly<Record<string, string>> = {
	type: "kind",
	validation: "validate",
	validation_msg: "validate_msg",
	case_property_on: "case_property",
};

// ── Rewrite helpers ─────────────────────────────────────────────────

/**
 * True when the given object looks like a question/field payload shape
 * — has an `id` string and EITHER a `type`/`kind` discriminator. Used
 * to decide whether to apply the per-field property renames, which are
 * otherwise too-common key names (`type` in particular) to rewrite
 * blind.
 */
function looksLikeFieldShape(obj: unknown): obj is Record<string, unknown> {
	if (typeof obj !== "object" || obj === null || Array.isArray(obj))
		return false;
	const o = obj as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		(typeof o.type === "string" || typeof o.kind === "string")
	);
}

/** Apply per-field renames to a single field-shape object. */
function rewriteFieldShape(
	obj: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		const newKey = FIELD_PROPERTY_RENAMES[k] ?? k;
		// Recurse into `children` arrays — nested group/repeat questions
		// carry the same shape and need the same rewrite.
		if (newKey === "children" && Array.isArray(v)) {
			out[newKey] = v.map((child) =>
				looksLikeFieldShape(child) ? rewriteFieldShape(child) : child,
			);
		} else {
			out[newKey] = v;
		}
	}
	return out;
}

/**
 * Rewrite a value that's supposed to be a field or an array of fields
 * (batch-add / getForm output). Recurses where needed so nested groups
 * with `children` arrays get the same treatment.
 */
function rewriteFieldOrFields(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((v) =>
			looksLikeFieldShape(v) ? rewriteFieldShape(v) : v,
		);
	}
	if (looksLikeFieldShape(value)) {
		return rewriteFieldShape(value);
	}
	return value;
}

/** Rewrite the `input` object of a tool-call event for a renamed tool. */
function rewriteToolInput(newToolName: string, input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return input;
	}
	const src = input as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	for (const [k, v] of Object.entries(src)) {
		const renamedKey = ARG_KEY_RENAMES[k] ?? k;

		// The field / fields payload gets per-property renames on its
		// members. `updates` on editField is also a field-shape patch.
		if (
			renamedKey === "field" ||
			renamedKey === "fields" ||
			renamedKey === "updates"
		) {
			out[renamedKey] = rewriteFieldOrFields(v);
			continue;
		}

		out[renamedKey] = v;
	}

	// editField's `updates` may include a `type` / `validation` /
	// `validation_msg` / `case_property_on` key without looking like a
	// full field shape (no `id` — since id rename is the only change).
	// Apply the per-field property renames unconditionally to that
	// specific key, even when `looksLikeFieldShape` would have returned
	// false.
	if (
		newToolName === "editField" &&
		typeof out.updates === "object" &&
		out.updates !== null
	) {
		const updates = out.updates as Record<string, unknown>;
		const rewritten: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			const newKey = FIELD_PROPERTY_RENAMES[k] ?? k;
			rewritten[newKey] = v;
		}
		out.updates = rewritten;
	}

	return out;
}

/**
 * Rewrite a tool-result `output` payload. Results for `getForm`,
 * `getField`, and `addField` / `addFields` may carry nested field
 * shapes the SA reads — rewrite those. Error-shaped outputs (bare
 * `{ error: string }`) pass through untouched.
 */
function rewriteToolOutput(output: unknown): unknown {
	if (typeof output !== "object" || output === null || Array.isArray(output)) {
		return output;
	}
	const src = output as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	for (const [k, v] of Object.entries(src)) {
		const renamedKey = ARG_KEY_RENAMES[k] ?? k;

		// `form` snapshots from the old `getForm` returned a nested
		// tree via `questions`; the new shape uses `fields`. We've
		// already mapped `questions → fields` via ARG_KEY_RENAMES; now
		// apply the per-member property renames.
		if (renamedKey === "fields" || renamedKey === "field") {
			out[renamedKey] = rewriteFieldOrFields(v);
			continue;
		}

		// The `form` key (returned by getForm) has a nested `questions`
		// array (pre-rename) or `fields` (post-rename) — rewrite its
		// inner shape in place.
		if (renamedKey === "form" && typeof v === "object" && v !== null) {
			const form = v as Record<string, unknown>;
			const formOut: Record<string, unknown> = {};
			for (const [fk, fv] of Object.entries(form)) {
				const innerKey = ARG_KEY_RENAMES[fk] ?? fk;
				if (innerKey === "fields" || innerKey === "field") {
					formOut[innerKey] = rewriteFieldOrFields(fv);
				} else {
					formOut[innerKey] = fv;
				}
			}
			out[renamedKey] = formOut;
			continue;
		}

		out[renamedKey] = v;
	}

	return out;
}

// ── Event rewrite decision ──────────────────────────────────────────

interface RewriteResult {
	changed: boolean;
	data: Record<string, unknown>;
}

/**
 * Given a single event doc's data, return the rewritten version along
 * with whether anything changed. A `changed: false` result means the
 * doc can be skipped on write.
 */
function rewriteEventDoc(data: Record<string, unknown>): RewriteResult {
	if (data.kind !== "conversation") return { changed: false, data };

	const payload = data.payload as Record<string, unknown> | undefined;
	if (!payload || typeof payload !== "object") {
		return { changed: false, data };
	}

	const payloadType = payload.type;
	if (payloadType !== "tool-call" && payloadType !== "tool-result") {
		return { changed: false, data };
	}

	const toolName = payload.toolName;
	if (typeof toolName !== "string") return { changed: false, data };

	const newToolName = TOOL_NAME_RENAMES[toolName] ?? toolName;
	const toolNameChanged = newToolName !== toolName;

	const rewrittenPayload: Record<string, unknown> = { ...payload };
	if (toolNameChanged) rewrittenPayload.toolName = newToolName;

	// Only rewrite input / output for the five renamed tools — other
	// tools' shapes don't use the question vocabulary.
	if (toolName in TOOL_NAME_RENAMES) {
		if (payloadType === "tool-call") {
			rewrittenPayload.input = rewriteToolInput(newToolName, payload.input);
		} else {
			rewrittenPayload.output = rewriteToolOutput(payload.output);
		}
	}

	// Cheap deep-equal via JSON.stringify — event payloads are small and
	// we only care about a yes/no signal to avoid a Firestore write.
	const before = JSON.stringify(payload);
	const after = JSON.stringify(rewrittenPayload);
	if (before === after) return { changed: false, data };

	return {
		changed: true,
		data: { ...data, payload: rewrittenPayload },
	};
}

// ── Main migration loop ─────────────────────────────────────────────

async function migrateApp(
	appId: string,
	flags: Flags,
): Promise<{ scanned: number; changed: number }> {
	const db = getDb();
	// Read events through the raw collection path, bypassing the Zod-
	// validated `eventConverter` on `collections.events()`. Historical
	// docs can drift from the current `Event` schema — a single old
	// mutation shape that doesn't parse under today's rules would crash
	// the whole read. Migrations need to see the raw shape anyway, so
	// the converter is the wrong tool here.
	const eventsRef = db.collection("apps").doc(appId).collection("events");
	const snap = await eventsRef.get();

	let scanned = 0;
	let changed = 0;
	let batch = db.batch();
	let batchOps = 0;

	for (const eventDoc of snap.docs) {
		scanned++;
		const result = rewriteEventDoc(eventDoc.data() as Record<string, unknown>);
		if (!result.changed) continue;
		changed++;

		if (flags.verbose) {
			const payload = result.data.payload as Record<string, unknown>;
			console.log(
				`  [${appId}] ${eventDoc.id}: toolName=${payload.toolName} (type=${payload.type})`,
			);
		}

		if (!flags.dryRun) {
			batch.set(eventDoc.ref, result.data);
			batchOps++;

			// Firestore's batched-write limit is 500 ops. Flush at 400
			// to keep a comfortable margin for cases where the migration
			// is run while other writers are active.
			if (batchOps >= 400) {
				await batch.commit();
				batch = db.batch();
				batchOps = 0;
			}
		}
	}

	if (!flags.dryRun && batchOps > 0) await batch.commit();

	return { scanned, changed };
}

async function main() {
	const flags = parseFlags();

	const db = getDb();
	const appIds = flags.app
		? [flags.app]
		: await db
				.collection("apps")
				.select()
				.get()
				.then((snap) => snap.docs.map((d) => d.id));

	console.log(
		`\n${flags.dryRun ? "[DRY RUN] " : ""}Rewriting SA tool vocab in ${appIds.length} app(s)...\n`,
	);

	let totalScanned = 0;
	let totalChanged = 0;
	let appsWithChanges = 0;

	for (const appId of appIds) {
		try {
			const { scanned, changed } = await migrateApp(appId, flags);
			totalScanned += scanned;
			totalChanged += changed;
			if (changed > 0) appsWithChanges++;

			if (flags.verbose || changed > 0) {
				console.log(
					`  ${appId}: ${scanned} events scanned, ${changed} rewrote`,
				);
			}
		} catch (err) {
			console.error(`  [${appId}] ERROR:`, err);
		}
	}

	console.log(
		`\n${flags.dryRun ? "[DRY RUN] " : ""}Done. ${totalScanned} events scanned across ${appIds.length} app(s); ${totalChanged} rewrites across ${appsWithChanges} app(s).\n`,
	);

	if (flags.dryRun) {
		console.log("Re-run without --dry-run to apply.\n");
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
