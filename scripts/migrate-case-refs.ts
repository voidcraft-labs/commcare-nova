/**
 * One-off migration: rewrite stored generic `#case/<segments>` references to
 * the per-case-type form `#<case_type>/<prop>` (e.g. `#case/edd` → `#mother/edd`).
 *
 * Existing blueprints were authored before per-case-type references landed, so
 * every stored ref still uses the ambiguous `#case/` namespace. The read side
 * (resolution / validation / chips) now only understands `#<case_type>/<prop>`,
 * so legacy refs render as inert plain text until rewritten. This script does
 * the rewrite once across stored data.
 *
 * ── Finding refs the way production does (NOT a substring scan) ───────────────
 * The migration's notion of "what is a `#case/` ref" must be byte-for-byte what
 * the read side and emitter use, or it mutates text they don't:
 *
 *   - XPath surfaces are located through the SAME Lezer XPath parser the emitter
 *     uses (`rewriteHashtags`): only real `HashtagRef` nodes are rewritten, so a
 *     `#case/x` sitting inside an XPath STRING LITERAL (`'#case/legacy'`) is left
 *     untouched, and a Unicode property (`#case/bébé`) is captured whole rather
 *     than truncated at the first non-ASCII byte.
 *   - Prose surfaces are located through the shared `BARE_HASHTAG_PATTERN` — the
 *     one pattern the prose emitter and deep validator already agree on — acting
 *     only when the namespace is `case`.
 *
 * ── The rewrite policy (resolve + auto-fix) ──────────────────────────────────
 * A form's OWN case type is its module's `caseType`; the reachable types are
 * `reachableCaseTypes(ownType, doc.caseTypes)` — own at depth 0, ancestors
 * ascending (depth 1 = parent, 2 = grandparent, …). A survey form loads no
 * case, and a module with no case type has nothing to read, so both yield NO
 * reachable types — every `#case/` ref on such a form is UNRESOLVED and left
 * exactly as written (there is no own type to anchor it to).
 *
 * For each `#case/<segments>` ref, `hops` = the count of leading `parent`
 * segments and `rest` = the remaining segments:
 *
 *   - hops > 0 (explicit parent walk, e.g. `#case/parent/edd`):
 *       · rest empty (a bare `#case/parent…` related-case-node ref) → LEFT AS-IS,
 *         UNRESOLVED. The per-type grammar requires `#<type>/<path>`, so a bare
 *         `#<type>` parses as inert text — rewriting would silently kill a ref
 *         the wire still resolves transitionally. Leave it for manual review.
 *       · target = the reachable type at `depth === hops`, rest non-empty:
 *           - found     → `#<target>/<rest>` (same wire walk the old ref produced).
 *           - not found → UNRESOLVED, LEFT AS-IS (the hop count says nothing about
 *                         whether `rest` is a property of the own type, so
 *                         anchoring to own could silently resolve to a plausible
 *                         WRONG case).
 *
 *   - hops === 0 (bare `#case/<prop>`):
 *       · `prop === "case_id"`            → `#<ownType>/case_id`.
 *       · nearest reachable type (depth-ascending, own wins a name collision)
 *         whose declared properties include `prop`:
 *           - found at depth 0            → `#<ownType>/<prop>`.
 *           - found at depth > 0          → `#<ancestorType>/<prop>` (the old
 *                                           `#case/<prop>` read the loaded case and
 *                                           silently returned empty; the new ref
 *                                           reads the ancestor — a WIRE-BEHAVIOR
 *                                           CHANGE that fixes a latent bug).
 *       · on NO reachable type            → `#<ownType>/<prop>` (rewritten, but the
 *                                           own type lacks the prop so it cannot
 *                                           resolve — the validator flags it).
 *
 * ── Honest classification (form-type validity, not just reachability) ─────────
 * After the reachability rewrite, each ref is classified against the read side's
 * form-type-narrowed accept map (`caseRefAcceptMap`): a registration form only
 * legitimately reads its own `case_id`, a survey reads nothing, followup / close
 * read every reachable property. A ref the accept map rejects is reclassified
 * UNRESOLVED even when reachability called it clean — so the dry-run counts never
 * tell the operator a ref is safe when the validator will reject it. Rejected
 * refs are still rewritten (so `#case/` is gone); only the label changes.
 *
 * ── Surfaces walked ──────────────────────────────────────────────────────────
 * Every ref-bearing field surface: the XPath surfaces (`relevant`, `validate`,
 * `calculate`, `default_value`, `required`, `repeat_count`, and
 * `data_source.ids_query`) and the prose surfaces (`label`, `hint`, `help`,
 * `validate_msg`, and each select option's `label`). Form-level XPath
 * (`formLinks`, `closeCondition`) and module-level case-list predicates are
 * structured ASTs, not `#case/` text, so they carry no legacy refs.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 * Default mode is a READ-ONLY scan (dry run) that prints what WOULD change and
 * writes nothing. Pass `--apply` to write. The bulk scan/apply targets only
 * `status === "complete"` non-deleted apps so in-flight `generating` apps are
 * never touched (and the stale-generating reaper's `updated_at` clock is never
 * reset under it). Each `--apply` write carries a `lastUpdateTime` precondition
 * captured at scan time, so a concurrent edit aborts that one write instead of
 * being silently clobbered, and writes only the `blueprint` + `updated_at`
 * fields. Each app is processed under its own try/catch — one malformed
 * blueprint is reported and skipped, never aborting the run. `--app <id>` scopes
 * to one app (bypassing the status filter) for testing.
 *
 * This is a one-off, deleted after it runs. The pure `migrateDocCaseRefs` core
 * holds all the logic and is unit-tested; the CLI below is a thin Firestore
 * I/O wrapper.
 *
 * Usage:
 *   npx tsx scripts/migrate-case-refs.ts                 # scan complete apps (dry run)
 *   npx tsx scripts/migrate-case-refs.ts --app <id>      # scan one app (dry run)
 *   npx tsx scripts/migrate-case-refs.ts --apply         # write complete apps
 *   npx tsx scripts/migrate-case-refs.ts --app <id> --apply
 */

import "dotenv/config";
import { FieldValue } from "@google-cloud/firestore";
import { readFieldString } from "@/lib/commcare/fieldProps";
import { rewriteHashtags } from "@/lib/commcare/hashtags";
import { BARE_HASHTAG_PATTERN } from "@/lib/commcare/proseHashtags";
import {
	type BlueprintDoc,
	caseRefAcceptMap,
	type Field,
	type FormType,
	reachableCaseTypes,
	toReachableIndex,
	type Uuid,
} from "@/lib/domain";
import { runMain } from "./lib/main";

// ── Core types ───────────────────────────────────────────────────────────────

/** How a single rewritten ref is classified for the report. */
export type ChangeKind = "clean" | "wire-change" | "unresolved";

/** Every ref-bearing field surface this migration scans. */
export type RefSurface =
	| "relevant"
	| "validate"
	| "calculate"
	| "default_value"
	| "required"
	| "repeat_count"
	| "ids_query"
	| "label"
	| "hint"
	| "help"
	| "validate_msg"
	| "option_label";

/**
 * One rewritten (or left-as-is) ref. `from` is the original ref text, `to` the
 * rewritten text — equal when the ref was left as-is (a bare related-node ref, a
 * too-deep parent walk, or any ref on a form with no readable case). `formId` /
 * `fieldId` are the human-readable semantic ids; the uuids travel alongside
 * because ids are not globally unique, so the lead needs the uuid to locate the
 * ref in Firestore.
 */
export interface RefChange {
	appId?: string;
	formId: string;
	formUuid: Uuid;
	fieldId: string;
	fieldUuid: Uuid;
	surface: RefSurface;
	from: string;
	to: string;
	kind: ChangeKind;
}

export interface MigrateResult {
	doc: BlueprintDoc;
	changes: RefChange[];
}

/** A reachable case type reduced to what the rewrite needs: its name, its
 *  parent-index depth, and its declared property names (case_id excluded —
 *  it is a system property handled explicitly). */
interface ReachableType {
	name: string;
	depth: number;
	props: Set<string>;
}

/** The per-form resolution context: the reachable types (for resolving which
 *  type a prop lives on) plus the form-type-narrowed accept map (for honest
 *  classification). */
interface FormContext {
	reachable: ReachableType[];
	accept: Map<string, Set<string>>;
}

// ── Single-ref rewrite ───────────────────────────────────────────────────────

/**
 * Decide the rewrite for one ref's segments against a form's context. `to ===
 * null` means "leave the literal text untouched". A non-null `to` is the
 * rewritten ref text even when classified unresolved (the `#case/` namespace is
 * still removed; only the report label says the validator will reject it).
 */
function rewriteOneRef(
	segments: string[],
	ctx: FormContext,
): { to: string | null; kind: ChangeKind } {
	const { reachable, accept } = ctx;
	const ownType = reachable.length > 0 ? reachable[0].name : undefined;

	// No reachable types — survey form or a module with no case type. There is
	// no own type to anchor to, so every ref is unresolved and left as written.
	if (ownType === undefined) return { to: null, kind: "unresolved" };

	let hops = 0;
	while (hops < segments.length && segments[hops] === "parent") hops += 1;
	const rest = segments.slice(hops).join("/");

	let targetType: string;
	let baseKind: ChangeKind;

	if (hops > 0) {
		// A bare `#case/parent…` related-node ref has no per-type form — leave it.
		if (rest.length === 0) return { to: null, kind: "unresolved" };
		const target = reachable.find((t) => t.depth === hops);
		// No reachable type at that depth — leave as-is (see policy header).
		if (!target) return { to: null, kind: "unresolved" };
		targetType = target.name;
		baseKind = "clean";
	} else if (rest === "case_id") {
		targetType = ownType;
		baseKind = "clean";
	} else {
		// Depth-ascending search — own type (depth 0) wins a name collision.
		const found = reachable.find((t) => t.props.has(rest));
		if (found) {
			targetType = found.name;
			baseKind = found.depth === 0 ? "clean" : "wire-change";
		} else {
			// On no reachable type — anchor to the own type so the validator flags it.
			targetType = ownType;
			baseKind = "unresolved";
		}
	}

	const to = `#${targetType}/${rest}`;
	// Honest classification: downgrade to unresolved when the read side's
	// form-type-narrowed accept map would reject this ref (a non-`case_id` ref on
	// a registration form, or an ancestor read the form can't reach). Still
	// rewritten — only the label changes.
	const accepted = accept.get(targetType)?.has(rest) ?? false;
	return { to, kind: accepted ? baseKind : "unresolved" };
}

// ── Surface rewriters ────────────────────────────────────────────────────────

type MkChange = (from: string, to: string, kind: ChangeKind) => RefChange;

/**
 * Rewrite `#case/` refs in an XPath expression via the Lezer parser — only real
 * `HashtagRef` nodes are touched, so refs inside string literals are left alone
 * and Unicode segments are captured whole. `rewriteHashtags` calls back per
 * `HashtagRef`; we act only when the namespace is the legacy `case` (a
 * per-case-type ref like `#mother/x` has namespace `mother`, so re-running is a
 * no-op), record every match, and return the rewritten text or `undefined` to
 * leave the ref verbatim.
 */
function rewriteXPath(
	expr: string,
	ctx: FormContext,
	mk: MkChange,
): { text: string; changes: RefChange[] } {
	const changes: RefChange[] = [];
	const text = rewriteHashtags(expr, (typeName, segments) => {
		if (typeName !== "case") return undefined;
		const from = `#case/${segments.join("/")}`;
		const { to, kind } = rewriteOneRef(segments, ctx);
		changes.push(mk(from, to ?? from, kind));
		return to ?? undefined;
	});
	return { text, changes };
}

/**
 * Rewrite `#case/` refs in prose via the shared `BARE_HASHTAG_PATTERN` (group 1
 * = namespace) — the exact pattern the prose emitter and deep validator use, so
 * the migration treats a prose hashtag identically to how it ships. Acts only on
 * the legacy `case` namespace.
 */
function rewriteProse(
	text: string,
	ctx: FormContext,
	mk: MkChange,
): { text: string; changes: RefChange[] } {
	const re = new RegExp(BARE_HASHTAG_PATTERN, "g");
	const changes: RefChange[] = [];
	const next = text.replace(re, (match: string, namespace: string) => {
		if (namespace !== "case") return match;
		const segments = match.slice("#case/".length).split("/");
		const { to, kind } = rewriteOneRef(segments, ctx);
		const finalTo = to ?? match;
		changes.push(mk(match, finalTo, kind));
		return finalTo;
	});
	return { text: next, changes };
}

// ── Field surface walk ───────────────────────────────────────────────────────

const XPATH_KEYS = [
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"required",
	"repeat_count",
] as const;
const PROSE_KEYS = ["label", "hint", "help", "validate_msg"] as const;

/**
 * Rewrite every ref-bearing surface of one field. Returns a possibly-new field
 * (cloned only when something changed; the original is returned by reference
 * otherwise) plus the changes. Pure — never mutates the input field.
 */
function rewriteField(
	field: Field,
	ctx: FormContext,
	form: { uuid: Uuid; id: string },
	appId: string | undefined,
): { field: Field; changes: RefChange[] } {
	const changes: RefChange[] = [];
	const draft: Record<string, unknown> = { ...(field as object) };
	let changed = false;

	const make =
		(surface: RefSurface): MkChange =>
		(from, to, kind) => ({
			appId,
			formId: form.id,
			formUuid: form.uuid,
			fieldId: field.id,
			fieldUuid: field.uuid,
			surface,
			from,
			to,
			kind,
		});

	const apply = (
		key: RefSurface,
		value: string | undefined,
		rewrite: (
			text: string,
			ctx: FormContext,
			mk: MkChange,
		) => { text: string; changes: RefChange[] },
		write: (text: string) => void,
	): void => {
		// `#case/` substring is a safe pre-filter — every legacy ref contains it,
		// so this never drops a real ref, it just skips parsing ref-free strings.
		if (!value?.includes("#case/")) return;
		const out = rewrite(value, ctx, make(key));
		if (out.changes.length === 0) return;
		changes.push(...out.changes);
		if (out.text !== value) {
			write(out.text);
			changed = true;
		}
	};

	for (const key of XPATH_KEYS) {
		apply(key, readFieldString(field, key), rewriteXPath, (text) => {
			draft[key] = text;
		});
	}
	for (const key of PROSE_KEYS) {
		apply(key, readFieldString(field, key), rewriteProse, (text) => {
			draft[key] = text;
		});
	}

	// Nested XPath — query-bound repeat's `data_source.ids_query`.
	const dataSource = (field as { data_source?: { ids_query?: unknown } })
		.data_source;
	const idsQuery = dataSource?.ids_query;
	if (typeof idsQuery === "string") {
		apply("ids_query", idsQuery, rewriteXPath, (text) => {
			draft.data_source = { ...dataSource, ids_query: text };
		});
	}

	// Nested prose — each select option's display label.
	const options = (field as { options?: unknown }).options;
	if (Array.isArray(options)) {
		let optionsChanged = false;
		const nextOptions = options.map((opt) => {
			const label = (opt as { label?: unknown })?.label;
			if (typeof label !== "string" || !label.includes("#case/")) return opt;
			const out = rewriteProse(label, ctx, make("option_label"));
			if (out.changes.length === 0) return opt;
			changes.push(...out.changes);
			if (out.text === label) return opt;
			optionsChanged = true;
			return { ...(opt as object), label: out.text };
		});
		if (optionsChanged) {
			draft.options = nextOptions;
			changed = true;
		}
	}

	return { field: changed ? (draft as unknown as Field) : field, changes };
}

// ── Doc walk ─────────────────────────────────────────────────────────────────

/**
 * Build a form's resolution context. A survey form loads no case, so it reads
 * nothing regardless of its module's case type; a module with no case type has
 * nothing to read. Both collapse to an empty context. Otherwise the reachable
 * types drive resolution and `caseRefAcceptMap` narrows by form type for honest
 * classification.
 */
function contextForForm(
	formType: string,
	moduleCaseType: string | undefined,
	doc: BlueprintDoc,
): FormContext {
	const ownType = formType === "survey" ? undefined : moduleCaseType;
	const rct = ownType ? reachableCaseTypes(ownType, doc.caseTypes ?? []) : [];
	const reachable: ReachableType[] = rct.map((t) => ({
		name: t.name,
		depth: t.depth,
		props: new Set(t.properties.map((p) => p.name)),
	}));
	const accept = caseRefAcceptMap(toReachableIndex(rct), formType as FormType);
	return { reachable, accept };
}

/**
 * Pure migration core. Walks every form (module → form → recursive field
 * subtree) and rewrites every `#case/` ref per the policy in the file header.
 * Returns a new doc (changed fields cloned, everything else passed through by
 * reference) plus a flat list of every ref change. Never mutates the input and
 * never reads or writes the derived `fieldParent` index — it operates on the
 * persisted shape directly.
 *
 * Defensive against a malformed blueprint: every collection is defaulted, so a
 * doc missing `moduleOrder` / `fields` / etc. yields an empty result instead of
 * throwing (the CLI's per-app try/catch is the second line of defense).
 */
export function migrateDocCaseRefs(doc: BlueprintDoc): MigrateResult {
	const appId = typeof doc.appId === "string" ? doc.appId : undefined;
	const moduleOrder = doc.moduleOrder ?? [];
	const modules = doc.modules ?? {};
	const forms = doc.forms ?? {};
	const fields = doc.fields ?? {};
	const formOrder = doc.formOrder ?? {};
	const fieldOrder = doc.fieldOrder ?? {};

	const changes: RefChange[] = [];
	const nextFields: Record<string, Field> = { ...fields };
	let anyFieldChanged = false;

	const walk = (
		parentUuid: string,
		ctx: FormContext,
		form: { uuid: Uuid; id: string },
	): void => {
		for (const uuid of fieldOrder[parentUuid] ?? []) {
			const field = fields[uuid];
			if (!field) continue;
			const result = rewriteField(field, ctx, form, appId);
			changes.push(...result.changes);
			if (result.field !== field) {
				nextFields[uuid] = result.field;
				anyFieldChanged = true;
			}
			// Container kinds (group / repeat) carry their own fieldOrder entry.
			if (fieldOrder[uuid] !== undefined) walk(uuid, ctx, form);
		}
	};

	for (const moduleUuid of moduleOrder) {
		const mod = modules[moduleUuid];
		if (!mod) continue;
		for (const formUuid of formOrder[moduleUuid] ?? []) {
			const form = forms[formUuid];
			if (!form) continue;
			const ctx = contextForForm(form.type, mod.caseType, doc);
			walk(formUuid, ctx, { uuid: form.uuid, id: form.id });
		}
	}

	const nextDoc = anyFieldChanged ? { ...doc, fields: nextFields } : doc;
	return { doc: nextDoc, changes };
}

// ── CLI report ───────────────────────────────────────────────────────────────

/**
 * The four report buckets. Three of them WILL be written (the `#case/` is
 * rewritten away); `unresolved-left` is left exactly as written and needs manual
 * review. Splitting unresolved this way keeps the headline honest — the operator
 * decides on `--apply` from these counts.
 */
type Disposition =
	| "clean"
	| "wire-change"
	| "unresolved-written"
	| "unresolved-left";

function dispositionOf(c: RefChange): Disposition {
	if (c.kind === "clean") return "clean";
	if (c.kind === "wire-change") return "wire-change";
	return c.from === c.to ? "unresolved-left" : "unresolved-written";
}

type Counts = Record<Disposition, number>;

function emptyCounts(): Counts {
	return {
		clean: 0,
		"wire-change": 0,
		"unresolved-written": 0,
		"unresolved-left": 0,
	};
}

function tally(into: Counts, changes: RefChange[]): void {
	for (const c of changes) into[dispositionOf(c)] += 1;
}

function printAppSection(
	appId: string,
	appName: string,
	owner: string,
	changes: RefChange[],
): void {
	const counts = emptyCounts();
	tally(counts, changes);
	console.log(`\nApp ${appId} (${appName}) owner=${owner}`);
	console.log(
		`  will be written → clean: ${counts.clean}  wire-change: ${counts["wire-change"]}  unresolved(rewritten): ${counts["unresolved-written"]}`,
	);
	console.log(
		`  left as-is      → unresolved(manual review): ${counts["unresolved-left"]}`,
	);

	const wire = changes.filter((c) => dispositionOf(c) === "wire-change");
	if (wire.length > 0) {
		console.log("  wire-behavior changes:");
		for (const c of wire) {
			console.log(
				`    form ${c.formId} · field ${c.fieldId} [${c.surface}]: ${c.from} → ${c.to}`,
			);
		}
	}

	const rewritten = changes.filter(
		(c) => dispositionOf(c) === "unresolved-written",
	);
	if (rewritten.length > 0) {
		console.log("  unresolved (rewritten to own type — validator will flag):");
		for (const c of rewritten) {
			console.log(
				`    form ${c.formId} · field ${c.fieldId} [${c.surface}]: ${c.from} → ${c.to}`,
			);
		}
	}

	const left = changes.filter((c) => dispositionOf(c) === "unresolved-left");
	if (left.length > 0) {
		console.log("  unresolved (left as-is — needs manual review):");
		for (const c of left) {
			console.log(
				`    form ${c.formId} · field ${c.fieldId} [${c.surface}]: ${c.from}`,
			);
		}
	}
}

// ── Firestore I/O ────────────────────────────────────────────────────────────
//
// A minimal structural view of the Firestore surface `run` touches — the real
// `Firestore` from `./lib/firestore` satisfies it, and the unit test mocks it.
// Defining the contract here (rather than importing `@google-cloud/firestore`
// types) keeps the test mock narrow: it stubs only what the loop actually uses.

/** The Firestore-`Precondition` shape `update` accepts — `lastUpdateTime` is
 *  the optimistic-concurrency guard captured at scan time. */
interface UpdatePrecondition {
	lastUpdateTime?: unknown;
}

interface AppSnapshot {
	readonly id: string;
	/** Present on `doc(id).get()` snapshots; query-result docs are always live. */
	readonly exists?: boolean;
	readonly updateTime?: unknown;
	data(): Record<string, unknown> | undefined;
	readonly ref: {
		update(
			data: Record<string, unknown>,
			precondition?: UpdatePrecondition,
		): Promise<unknown>;
	};
}

interface AppsDb {
	collection(name: string): {
		doc(id: string): { get(): Promise<AppSnapshot> };
		where(
			field: string,
			op: string,
			value: unknown,
		): {
			where(
				field: string,
				op: string,
				value: unknown,
			): { get(): Promise<{ docs: AppSnapshot[] }> };
		};
	};
}

export interface RunOptions {
	readonly apply: boolean;
	/** Scope to one app by id (bypasses the status filter). */
	readonly onlyApp?: string;
}

export interface RunSummary {
	scanned: number;
	appsWithRefs: number;
	appsWritten: number;
	appsSkippedConcurrent: number;
	appsFailed: number;
	totals: Counts;
	/** `--app <id>` was given but no such doc exists. */
	notFound: boolean;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Drive the migration over Firestore. Exported so the test can invoke it with a
 * mocked `AppsDb` instead of scraping `process.argv` and touching production.
 *
 * The bulk path filters to `deleted_at == null && status == "complete"` — every
 * app doc carries `deleted_at: null` at creation (the same filter the app's own
 * list queries use), so in-flight `generating` apps are never touched and the
 * stale-generating reaper's `updated_at` clock is never reset. Each app is
 * processed under its own try/catch so one bad doc is reported and skipped, never
 * aborting the run. On `--apply`, the write carries a `lastUpdateTime`
 * precondition captured at scan time — a concurrent edit aborts that one write
 * (counted as skipped) instead of being silently clobbered.
 */
export async function run(
	db: AppsDb,
	options: RunOptions,
): Promise<RunSummary> {
	const { apply, onlyApp } = options;
	console.log(
		apply
			? "migrate-case-refs — APPLY (writes to Firestore)"
			: "migrate-case-refs — SCAN (dry run, read-only)",
	);

	const summary: RunSummary = {
		scanned: 0,
		appsWithRefs: 0,
		appsWritten: 0,
		appsSkippedConcurrent: 0,
		appsFailed: 0,
		totals: emptyCounts(),
		notFound: false,
	};

	let snaps: AppSnapshot[];
	if (onlyApp) {
		const snap = await db.collection("apps").doc(onlyApp).get();
		if (snap.exists === false) {
			summary.notFound = true;
			return summary;
		}
		snaps = [snap];
	} else {
		const result = await db
			.collection("apps")
			.where("deleted_at", "==", null)
			.where("status", "==", "complete")
			.get();
		snaps = result.docs;
	}

	for (const snap of snaps) {
		try {
			const data = snap.data();
			const blueprint = data?.blueprint;
			// Skip docs with no blueprint object — nothing to rewrite.
			if (!blueprint || typeof blueprint !== "object") continue;
			summary.scanned += 1;

			const { doc, changes } = migrateDocCaseRefs(blueprint as BlueprintDoc);
			if (changes.length === 0) continue;

			summary.appsWithRefs += 1;
			tally(summary.totals, changes);
			printAppSection(
				snap.id,
				typeof data?.app_name === "string" ? data.app_name : "(unnamed)",
				typeof data?.owner === "string" ? data.owner : "(unknown)",
				changes,
			);

			// Only write when the doc text actually changed — a scan whose only
			// findings are left-as-is unresolved refs writes nothing.
			const docChanged = changes.some((c) => c.from !== c.to);
			if (apply && docChanged) {
				try {
					await snap.ref.update(
						{ blueprint: doc, updated_at: FieldValue.serverTimestamp() },
						{ lastUpdateTime: snap.updateTime },
					);
					summary.appsWritten += 1;
					console.log("  ✓ wrote rewritten blueprint");
				} catch (writeErr) {
					summary.appsSkippedConcurrent += 1;
					console.warn(
						`  ⚠ skipped write — app changed since scan: ${errMessage(writeErr)}`,
					);
				}
			}
		} catch (err) {
			// Per-app isolation — one malformed blueprint is reported and skipped,
			// never aborting the run (which would leave a half-applied migration).
			summary.appsFailed += 1;
			console.error(
				`\nApp ${snap.id} failed — skipped (not migrated): ${errMessage(err)}`,
			);
		}
	}

	printTotals(summary, apply);
	return summary;
}

function printTotals(summary: RunSummary, apply: boolean): void {
	const { totals } = summary;
	console.log("\n=== TOTALS ===");
	console.log(`apps scanned (complete, with a blueprint): ${summary.scanned}`);
	console.log(
		`apps with at least one #case/ ref:         ${summary.appsWithRefs}`,
	);
	console.log(
		`apps failed (skipped):                     ${summary.appsFailed}`,
	);
	console.log("\nRefs that WILL be written (#case/ rewritten away):");
	console.log(`  clean:                                ${totals.clean}`);
	console.log(
		`  wire-behavior change:                 ${totals["wire-change"]}`,
	);
	console.log(
		`  unresolved (rewritten to own type):   ${totals["unresolved-written"]}`,
	);
	console.log("Refs LEFT AS-IS (not written — need manual review):");
	console.log(
		`  unresolved:                           ${totals["unresolved-left"]}`,
	);
	if (apply) {
		console.log(
			`\napps written:                          ${summary.appsWritten}`,
		);
		console.log(
			`apps skipped (changed since scan):     ${summary.appsSkippedConcurrent}`,
		);
	} else {
		console.log("\nmode: dry run — nothing written. Pass --apply to write.");
	}
}

// ── CLI main ─────────────────────────────────────────────────────────────────

const HELP = [
	"migrate-case-refs — rewrite legacy #case/ refs to #<case_type>/<prop>.",
	"",
	"  Default mode is a read-only scan (dry run): prints what WOULD change,",
	"  writes nothing. Pass --apply to write the rewritten blueprints back.",
	"  The bulk run targets only status=complete, non-deleted apps.",
	"",
	"Options:",
	"  --apply        Write rewritten blueprints to Firestore (advances updated_at).",
	"  --app <id>     Scope the run to one app by id (bypasses the status filter).",
	"  --help, -h     Print this help and exit.",
].join("\n");

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return;
	}
	const apply = argv.includes("--apply");
	const appFlagIdx = argv.indexOf("--app");
	let onlyApp: string | undefined;
	if (appFlagIdx >= 0) {
		onlyApp = argv[appFlagIdx + 1];
		if (!onlyApp || onlyApp.startsWith("--")) {
			throw new Error(
				"The --app flag needs an app id right after it, like `--app abc123`. It was passed with no id.",
			);
		}
	}

	// Pull the Firestore client in here, at the CLI entrypoint, instead of
	// importing it at module top level. The pure rewrite core
	// (`migrateDocCaseRefs` and friends) is imported by tests; a top-level
	// Firestore client would open an idle connection-pool promise that never
	// settles on import alone, hanging the test runner. Constructing it only
	// when the CLI actually runs keeps the core import side-effect-free.
	const { db } = await import("./lib/firestore");
	const summary = await run(db as unknown as AppsDb, { apply, onlyApp });
	if (summary.notFound) {
		console.error(`\nApp ${onlyApp} was not found in the apps collection.`);
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runMain(main);
}
