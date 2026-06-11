/**
 * Legacy-finding repair core — the shared engine behind
 * `scripts/scan-legacy-findings.ts` (read-only) and
 * `scripts/repair-legacy-findings.ts` (writer). One-time merge
 * choreography for the valid-by-construction branch: apps built before
 * the commit gate existed can carry standing validator findings, and the
 * zero-tolerance export boundary would refuse them — a regression
 * against "apps are always export-ready". This module decides, per
 * finding class, whether a repair is honest, and performs the honest
 * ones through the real mutation reducers.
 *
 * ## How a stored app is read
 *
 * Production blueprints can still be STRING-expression shaped (written
 * before the expression-AST migration ran), so `toLegacyBlueprintView`
 * loads them the way `migrate-expression-asts.ts` does — raw cast +
 * `rebuildFieldParent` + the shared round-trip-gated converter
 * (`migrateDocExpressions`) on a clone — never the strict runtime Zod
 * gate, which rejects string slots outright. The converted view is the
 * shape the deployed code reads, and it is the shape repairs MUST run
 * on: the current reducers store expression references as identity
 * leaves, so a rename through a still-string-shaped doc would strand
 * text references the old string-rewrite machinery (now deleted) used
 * to chase.
 *
 * ## What "the boundary view" means here
 *
 * `evaluateLegacyFindings` runs the full validator at full scope — the
 * exact evaluation `collectBoundaryViolations` performs MINUS the
 * media-asset manifest arm (asset existence / readiness / kind, and the
 * export byte budget). Asset state is environment, not blueprint
 * content, and media readiness is being fixed at its own source.
 * Two carve-outs, both by design rather than legacy debris:
 *
 *   - an EMPTY app (zero modules) keeps its birth findings
 *     (`NO_MODULES`, and `EMPTY_APP_NAME` while still moduleless) — an
 *     empty app is at rest and valid, and the export refusal is
 *     reachable for it on purpose;
 *   - `CONNECT_FORM_MISSING_BLOCK` is RULE-RETIRING: CommCare Connect's
 *     ingestion reads connect blocks per form and silently skips forms
 *     without one, so the every-form rule was Nova's invention and is
 *     being removed from the validator (relaxing to "≥1 sub-config of
 *     the app's type app-wide"). Those findings vanish with no data
 *     change; they are reported but never repaired.
 *
 * ## The honesty boundary
 *
 * A class whose repair would INVENT content the user never wrote is not
 * mechanically repairable — it is reported per app as needs-owner, never
 * auto-fixed and never silently skipped. `REPAIR_JUDGMENTS` records the
 * judgment for every gating-class code; a test holds the table total.
 * Three tiers:
 *
 *   - MECHANICAL — deterministic surgery on identifiers, debris, or the
 *     validator's own suggested rewrite; applied under `--apply`.
 *   - PROPOSED — defensible but still a content choice (the `case_name`
 *     case-list column); printed in dry-run, applied only under
 *     `--apply-proposed`.
 *   - NEEDS-OWNER — content or behavior decisions; reported per app.
 *
 * ## The safety oracle
 *
 * Every repair batch passes the same commit gate every live write surface
 * runs (`mutationCommitVerdict` — reject any introduced finding), and
 * after an app's repairs the whole-app oracle must hold: the finding
 * count strictly decreased and `diffIntroduced(before, after)` is empty.
 * An app that fails the oracle is never written. Repairs are idempotent:
 * a repaired doc re-evaluates clean, so a re-run plans nothing.
 */

import {
	isReservedXFormNodeName,
	MAX_CASE_PROPERTY_LENGTH,
	RESERVED_XFORM_NODE_PREFIX,
} from "../../lib/commcare";
import {
	connectIdError,
	deriveConnectId,
} from "../../lib/commcare/connectSlugs";
import type {
	ValidationError,
	ValidationErrorCode,
} from "../../lib/commcare/validator/errors";
import {
	FUNCTION_REGISTRY,
	findCaseInsensitiveMatch,
} from "../../lib/commcare/validator/functionRegistry";
import {
	diffIntroduced,
	errorIdentity,
	VALIDITY_CLASS_BY_CODE,
} from "../../lib/commcare/validator/gate";
import { runValidation } from "../../lib/commcare/validator/runner";
import { detectUnquotedStringLiteral, parser } from "../../lib/commcare/xpath";
import { mutationCommitVerdict } from "../../lib/doc/commitVerdicts";
import {
	type DocExpressionMigrationResult,
	migrateDocExpressions,
} from "../../lib/doc/expressionMigration";
import {
	parseXPathForField,
	parseXPathForForm,
} from "../../lib/doc/expressionText";
import { rebuildFieldParent } from "../../lib/doc/fieldParent";
import { renameFieldIdVerdict } from "../../lib/doc/identifierVerdicts";
import type { BlueprintDoc, Mutation, Uuid } from "../../lib/doc/types";
import {
	asUuid,
	type ConnectConfig,
	expressionSource,
	type Field,
	fieldCasePropertyOn,
	formExpressionSource,
	plainColumn,
} from "../../lib/domain";

// ── Judgments — the REPAIRABLE / PROPOSED / NEEDS-OWNER table ────────

export type RepairJudgmentKind =
	| "mechanical"
	| "proposed"
	| "needs-owner"
	| "rule-retiring";

export interface RepairJudgment {
	kind: RepairJudgmentKind;
	/** One line, person-to-person: why this class sits on this side of
	 *  the invent-content line. */
	reason: string;
}

const mechanical = (reason: string): RepairJudgment => ({
	kind: "mechanical",
	reason,
});
const proposed = (reason: string): RepairJudgment => ({
	kind: "proposed",
	reason,
});
const owner = (reason: string): RepairJudgment => ({
	kind: "needs-owner",
	reason,
});

/**
 * The judgment for every gating-class (shape / soundness / completeness)
 * validation code — the classes `runValidation` can produce against a
 * stored blueprint. Environment codes need an asset manifest this
 * evaluation never passes, and oracle codes are post-expansion wire
 * findings `runValidation` never emits, so neither appears here. A test
 * pins the table total against `VALIDITY_CLASS_BY_CODE`.
 */
export const REPAIR_JUDGMENTS: Readonly<
	Partial<Record<ValidationErrorCode, RepairJudgment>>
> = {
	// ── App-level ────────────────────────────────────────────────────
	EMPTY_APP_NAME: owner(
		"the app's name is content (a still-empty app's nameless birth state is excluded from the tally)",
	),
	NO_MODULES: owner(
		"the at-rest birth state of an empty app — by design it can't export; excluded from the tally",
	),
	DUPLICATE_MODULE_NAME: owner(
		"module names are user-visible menu text — renaming one is a content edit",
	),
	MISSING_CHILD_CASE_MODULE: owner(
		"the fix is a new module managing the child case type — content",
	),
	RESERVED_CASE_TYPE_NAME: owner(
		"renaming a case type re-keys the case database and every cross-reference; no single mutation owns that cascade",
	),
	// ── Module-level ─────────────────────────────────────────────────
	NO_CASE_TYPE: owner(
		"the case type names the entity the module tracks — content (the retired fix guessed from the module name; that guess is the owner's to approve per app)",
	),
	CASE_LIST_ONLY_HAS_FORMS: owner(
		"contradictory module config — whether the forms or the case-list-only flag is the intent is an authoring decision",
	),
	CASE_LIST_ONLY_NO_CASE_TYPE: owner(
		"the case type names the entity the list browses — content",
	),
	NO_FORMS_OR_CASE_LIST: owner("the missing forms are content"),
	INVALID_CASE_TYPE_FORMAT: owner(
		"renaming a case type re-keys the case database and every cross-reference; no single mutation owns that cascade",
	),
	CASE_TYPE_TOO_LONG: owner(
		"renaming a case type re-keys the case database and every cross-reference; no single mutation owns that cascade",
	),
	MISSING_CASE_LIST_COLUMNS: proposed(
		'seed the single "case_name" column: every Nova build leads its case list with it, and the case-name writer is guaranteed content — but which columns to show is still a display choice, so it applies only under --apply-proposed',
	),
	// ── Case-list-config rules ───────────────────────────────────────
	CASE_LIST_COLUMN_UNKNOWN_FIELD: owner(
		"pointing the column at a real case property (or dropping it) is content",
	),
	CASE_LIST_FILTER_TYPE_ERROR: owner(
		"rewriting the filter expression changes what the list shows",
	),
	CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR: owner(
		"rewriting the column expression changes what the column shows",
	),
	CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY: owner(
		"pointing the search input at a real case property is content",
	),
	CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH: owner(
		"resolving the mode-vs-property mismatch changes what the search matches",
	),
	CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH: owner(
		"resolving the widget-vs-property mismatch changes how the input collects values",
	),
	CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR: owner(
		"the default value expression is content",
	),
	CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR: owner(
		"the advanced predicate is content",
	),
	CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME: owner(
		"which input keeps the name decides which prompt the wire keys — an authoring call",
	),
	CASE_LIST_BARE_SEARCH_INPUT_REF: owner(
		"wrapping the reference changes when the predicate applies — the author picks the gating input",
	),
	CASE_LIST_DUPLICATE_SORT_PRIORITY: mechanical(
		"renumber sort priorities in the already-deterministic resolution order (priority ascending, then column order); priority values never reach the wire, so the emitted bytes are identical",
	),
	CASE_LIST_ID_MAPPING_EMPTY_VALUE: owner("mapping entries are content"),
	CASE_LIST_IMAGE_MAP_DUPLICATE_VALUE: owner(
		"which image the duplicated value should show is content",
	),
	CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE: owner(
		"resolving it changes what the search matches",
	),
	CASE_LIST_ANCESTOR_EXISTS_NESTS_CROSS_DIRECTION_WALK: owner(
		"restructuring the relation walk changes what the filter means",
	),
	CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE: owner(
		"resolving the via-vs-mode conflict changes what the search matches",
	),
	CASE_LIST_SEARCH_INPUT_SELECT_WIDGET_NOT_SUPPORTED: owner(
		"choosing a different widget changes how the input collects values",
	),
	CASE_LIST_MATCH_MODE_NOT_ON_DEVICE: owner(
		"picking an on-device match mode changes what the filter matches",
	),
	FIELD_KIND_PROPERTY_TYPE_MISMATCH: owner(
		"the field kind and the property's declared type disagree about the data model — the owner picks which is right",
	),
	FIELD_KIND_WRITERS_DISAGREE: owner(
		"two forms disagree about a property's kind — the owner picks the winner",
	),
	// ── Case-search-config rules ─────────────────────────────────────
	CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR: owner(
		"the display condition is content",
	),
	CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR: owner(
		"the owner-id expression is content",
	),
	CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT: owner(
		"which surface should own the property is a search-design decision",
	),
	CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE: owner(
		"what the search screen should search on is content",
	),
	CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE: owner(
		"the case type names the entity the search targets — content",
	),
	// ── Form-level ───────────────────────────────────────────────────
	EMPTY_FORM: owner("the missing fields are content"),
	NO_CASE_NAME_FIELD: owner(
		"the case-name writer is content the author adds — the fix-dissolution doc's own judgment",
	),
	CASE_NAME_FIELD_MISSING: owner(
		"the wiring names a field that's gone; re-pointing it is content",
	),
	RESERVED_CASE_PROPERTY: mechanical(
		'rename the property to the rule\'s own suggestion ("<name>_value") — identifier surgery, deduplicated against siblings',
	),
	CASE_PROPERTY_MISSING_FIELD: owner(
		"the wiring names a field that's gone; re-pointing it is content",
	),
	MEDIA_CASE_PROPERTY: mechanical(
		"clear case_property_on on the media field; the case-attachment shape is never emitted, so the slot has zero wire effect",
	),
	CASE_PRELOAD_MISSING_FIELD: owner(
		"the preload names a field that's gone; re-pointing it is content",
	),
	CASE_PRELOAD_RESERVED: owner(
		"which property the preload should read instead is content",
	),
	DUPLICATE_CASE_PROPERTY: owner(
		"two fields claim one case property — the owner picks the writer",
	),
	REGISTRATION_NO_CASE_PROPS: owner("which answers to save is content"),
	CLOSE_CONDITION_WRONG_TYPE: mechanical(
		"drop the condition: the emitter reads closeCondition only on close forms, so on any other type it is dead config — zero wire change",
	),
	CLOSE_FORM_NO_CASE_TYPE: owner(
		"the case type names the entity the form closes — content",
	),
	CLOSE_CONDITION_INCOMPLETE: mechanical(
		"drop the condition: the emitter already falls back to unconditional close when either half is missing, so removal matches today's shipped wire exactly",
	),
	CLOSE_CONDITION_FIELD_NOT_FOUND: owner(
		"dropping it would flip today's shipped never-closes wire to always-closes, and re-pointing it is content — the owner calls it",
	),
	INVALID_POST_SUBMIT: mechanical(
		"clear the unrecognized destination; the form falls back to its form-type default (the absent-value semantic)",
	),
	POST_SUBMIT_PARENT_MODULE_UNSUPPORTED: owner(
		"the configured destination contradicts the module shape; the right fix may be restructuring, not silently changing navigation",
	),
	POST_SUBMIT_MODULE_CASE_LIST_ONLY: owner(
		"the configured destination contradicts the module shape; the right fix may be restructuring, not silently changing navigation",
	),
	FORM_LINK_EMPTY: owner("the link's target is content"),
	FORM_LINK_TARGET_NOT_FOUND: owner("re-pointing the link is content"),
	FORM_LINK_CIRCULAR: owner("which edge of the loop to break is content"),
	FORM_LINK_NO_FALLBACK: owner(
		"whether to add a fallback or make a condition exhaustive is content",
	),
	FORM_LINK_SELF_REFERENCE: owner(
		"whether the form should loop to itself or go elsewhere is content",
	),
	CONNECT_FORM_MISSING_BLOCK: {
		kind: "rule-retiring",
		reason:
			"CommCare Connect's ingestion reads connect blocks per form and silently skips forms without one — the every-form rule was Nova's invention and is being removed from the validator (relaxing to ≥1 sub-config of the app's type app-wide), so these findings vanish with no data change",
	},
	CONNECT_MISSING_LEARN: owner(
		"sub-config names and descriptions are content — collected from the user, never invented",
	),
	CONNECT_MISSING_DELIVER: owner(
		"sub-config names and descriptions are content — collected from the user, never invented",
	),
	CONNECT_UNQUOTED_XPATH: mechanical(
		"wrap the bare word in single quotes — the validator's own suggested rewrite",
	),
	CONNECT_EMPTY_XPATH: mechanical(
		"clear the explicit-empty slot; the wire layer substitutes the canonical default for an absent value, and an empty calculate can't build at all",
	),
	CONNECT_ID_INVALID_FORMAT: mechanical(
		"re-derive by the same name-derivation the at-source autofill uses (deriveConnectId) — ids are internal slugs, not content",
	),
	CONNECT_ID_TOO_LONG: mechanical(
		"re-derive by the same name-derivation the at-source autofill uses — ids are internal slugs, not content",
	),
	CONNECT_ID_MISSING: mechanical(
		"derive by the same name-derivation the at-source autofill uses — exactly what a block created through the normal paths would have received",
	),
	CONNECT_ID_DUPLICATE: mechanical(
		"first occurrence keeps the id (matching the validator's own anchoring); later occurrences re-derive from their names",
	),
	CASE_HASHTAG_ON_CREATE_FORM: owner(
		"the expression reads a case that doesn't exist at fill time; what it should read instead is content",
	),
	PRIMARY_CASE_FIELD_IN_REPEAT: owner(
		"moving the field or re-typing the property is a structural authoring decision",
	),
	CHILD_CASE_NO_NAME_FIELD: owner(
		"the child case's name writer is content the author adds",
	),
	DUPLICATE_FIELD_ID: mechanical(
		"rename later non-case-bound siblings with a numeric suffix (readers resolve pre-order first match, so the first keeps the id and resolution doesn't move); case-bound duplicates are an ambiguous data model and are reported instead",
	),
	CASE_PROPERTY_BAD_FORMAT: mechanical(
		"sanitize to a legal property name (letters/digits/underscores, letter-first) — identifier surgery, deduplicated against siblings",
	),
	CASE_PROPERTY_TOO_LONG: mechanical(
		`truncate to the ${MAX_CASE_PROPERTY_LENGTH}-character cap — identifier surgery, deduplicated against siblings`,
	),
	// ── Field-level ──────────────────────────────────────────────────
	SELECT_NO_OPTIONS: owner(
		'option values and labels are device-visible content (the retired fix invented "Option 1/2" — exactly the line this table refuses to cross)',
	),
	HIDDEN_NO_VALUE: owner("what the hidden field should compute is content"),
	REQUIRED_ON_HIDDEN: mechanical(
		"clear required on the hidden field — an unanswerable requirement that can wedge form submission with nothing on screen to fix",
	),
	CALCULATE_ON_VISIBLE_INPUT: owner(
		"clearing the formula deletes authored logic and makes the field editable; converting to hidden changes structure — the owner picks",
	),
	UNQUOTED_STRING_LITERAL: mechanical(
		"wrap the bare word in single quotes — the validator's own suggested rewrite",
	),
	INVALID_FIELD_ID: mechanical(
		"sanitize to a legal element name (letters/digits/underscores, letter-first) — identifier surgery, deduplicated against siblings",
	),
	RESERVED_FIELD_ID_PREFIX: mechanical(
		'drop the reserved "__nova_" prefix — the rule\'s own suggested fix',
	),
	VALIDATION_ON_NON_INPUT_KIND: mechanical(
		"clear validate / validate_msg; the XForm emitter already drops them on these kinds — zero wire change",
	),
	EMPTY_REPEAT_COUNT: owner("the count expression is content"),
	EMPTY_IDS_QUERY: owner("the data-source query is content"),
	FIXTURE_REFERENCE_NOT_MODELED: owner(
		"the fixture needs modeling work, not a doc edit",
	),
	// ── XPath deep validation ────────────────────────────────────────
	XPATH_SYNTAX: owner("rewriting a broken expression means guessing intent"),
	UNKNOWN_FUNCTION: mechanical(
		"case-correct a function name with an exact case-insensitive registry match; a genuinely unknown function is reported, never guessed",
	),
	WRONG_ARITY: mechanical(
		"round(x, …) → round(x): CommCare's round() takes one argument and the extra-arg call crashes on device — the deterministic rewrite the retired FIX_REGISTRY shipped; other arity errors are reported",
	),
	INVALID_REF: owner("re-pointing a dangling reference is content"),
	INVALID_CASE_REF: owner("re-pointing a dangling reference is content"),
	CYCLE: owner("which edge of the loop to break is content"),
	TYPE_ERROR: owner(
		"fixing a type mismatch changes what the expression computes",
	),
};

/** Every code the commit/boundary gate weighs — the judgment table's
 *  required domain. Exported for the totality test and the CLIs' table
 *  rendering. */
export function gatingValidationCodes(): ValidationErrorCode[] {
	return (Object.keys(VALIDITY_CLASS_BY_CODE) as ValidationErrorCode[]).filter(
		(code) => {
			const cls = VALIDITY_CLASS_BY_CODE[code];
			return cls === "shape" || cls === "soundness" || cls === "completeness";
		},
	);
}

/** Judgment for a code; total. An unanticipated code (added after this
 *  table) reads needs-owner — report, never auto-fix. */
export function judgmentFor(code: ValidationErrorCode): RepairJudgment {
	return (
		REPAIR_JUDGMENTS[code] ?? {
			kind: "needs-owner",
			reason:
				"no recorded judgment for this class — added after the legacy-repair table; report to the owner",
		}
	);
}

// ── Loading — the raw stored blueprint → the boundary's view ────────

export interface LegacyBlueprintView {
	doc: BlueprintDoc;
	/** Round-trip failures here are parser/printer bugs, never repaired —
	 *  the scan surfaces them verbatim (scan-expression-asts owns sizing). */
	conversion: DocExpressionMigrationResult;
}

/**
 * Clone a raw stored blueprint and promote it to the view the deployed
 * code reads: derived `fieldParent` rebuilt, expression slots converted
 * string → AST and close refs id → uuid through the shared round-trip-
 * gated converter. Never mutates the input.
 */
export function toLegacyBlueprintView(raw: unknown): LegacyBlueprintView {
	const doc = structuredClone(raw) as BlueprintDoc;
	doc.fieldParent = {};
	rebuildFieldParent(doc);
	const conversion = migrateDocExpressions(doc);
	return { doc, conversion };
}

// ── Evaluation — the boundary view minus the media-manifest arm ─────

export interface LegacyEvaluation {
	/** The findings the legacy migration must clear. */
	findings: ValidationError[];
	/** An empty app's birth findings — by-design at-rest state, reported
	 *  separately and never counted as legacy debris. */
	birth: ValidationError[];
}

const BIRTH_CODES: ReadonlySet<ValidationErrorCode> = new Set([
	"NO_MODULES",
	"EMPTY_APP_NAME",
]);

export function evaluateLegacyFindings(doc: BlueprintDoc): LegacyEvaluation {
	const all = runValidation(doc);
	if (doc.moduleOrder.length > 0) return { findings: all, birth: [] };
	return {
		findings: all.filter((err) => !BIRTH_CODES.has(err.code)),
		birth: all.filter((err) => BIRTH_CODES.has(err.code)),
	};
}

/** Human-readable location line for a finding. */
export function describeFindingLocation(err: ValidationError): string {
	const l = err.location;
	const parts: string[] = [];
	if (l.moduleName !== undefined) parts.push(`module "${l.moduleName}"`);
	else if (l.moduleUuid !== undefined) parts.push(`module ${l.moduleUuid}`);
	if (l.formName !== undefined) parts.push(`form "${l.formName}"`);
	else if (l.formUuid !== undefined) parts.push(`form ${l.formUuid}`);
	if (l.fieldId !== undefined) parts.push(`field "${l.fieldId}"`);
	else if (l.fieldUuid !== undefined) parts.push(`field ${l.fieldUuid}`);
	const where = parts.length > 0 ? parts.join(" › ") : "app";
	return l.field !== undefined ? `${where} (${l.field})` : where;
}

// ── Shared repair machinery ──────────────────────────────────────────

export interface RepairPlan {
	tier: "mechanical" | "proposed";
	/** Person-readable: what the repair does, concretely. */
	description: string;
	mutations: Mutation[];
}

type RepairModule = (
	finding: ValidationError,
	doc: BlueprintDoc,
) => RepairPlan | undefined;

/** The field expression slots the deep validator anchors via
 *  `location.field`, mapped to their `updateField` patch shape. */
const FIELD_XPATH_SLOTS: ReadonlySet<string> = new Set([
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"required",
	"repeat_count",
	"ids_query",
]);

function fieldSlotPatch(slot: string, expr: unknown): Record<string, unknown> {
	return slot === "ids_query"
		? { data_source: { ids_query: expr } }
		: { [slot]: expr };
}

function updateFieldMutation(
	field: Field,
	patch: Record<string, unknown>,
): Mutation {
	// The per-kind patch arm types only the keys the kind declares; some
	// repairs clear keys a lenient legacy path parked off-kind (e.g.
	// `case_property_on` on a media field). The reducer handles them:
	// null deletes the key, then the merged entity re-parses through the
	// strict field schema before landing.
	return {
		kind: "updateField",
		uuid: field.uuid,
		targetKind: field.kind,
		patch,
	} as unknown as Mutation;
}

/** Pre-order first-match field lookup by semantic id within one form's
 *  subtree — the same resolution order the wire emitter's `findField`
 *  applies, so a repair lands on the field the wire already reads. */
function findFieldByIdInForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	id: string,
): Field | undefined {
	const find = (parentUuid: Uuid): Field | undefined => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			if (field.id === id) return field;
			if (doc.fieldOrder[uuid] !== undefined) {
				const found = find(uuid);
				if (found) return found;
			}
		}
		return undefined;
	};
	return find(formUuid);
}

/**
 * Deterministic identifier sanitize satisfying BOTH the XML element-name
 * rule and the case-property rule (letter-first; letters, digits,
 * underscores): illegal characters become underscores, the reserved
 * `__nova_` prefix is stripped, and a non-letter start gains a `q_`
 * prefix — mirroring the validator's own suggestion text.
 */
export function sanitizeIdentifier(raw: string): string {
	let out = raw.replace(/[^a-zA-Z0-9_]/g, "_");
	while (isReservedXFormNodeName(out)) {
		out = out.slice(RESERVED_XFORM_NODE_PREFIX.length);
	}
	if (out.length === 0) return "field";
	if (!/^[a-zA-Z]/.test(out)) out = `q_${out}`;
	if (out.length > MAX_CASE_PROPERTY_LENGTH) {
		out = out.slice(0, MAX_CASE_PROPERTY_LENGTH);
	}
	return out;
}

/** First conflict-free rename target derived from `candidate` — the
 *  shared peer-aware verdict decides, numeric suffixes disambiguate. */
function uniqueRenameTarget(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	candidate: string,
): string {
	if (renameFieldIdVerdict({ doc, fieldUuid, newId: candidate }).ok) {
		return candidate;
	}
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const next =
			candidate.slice(0, MAX_CASE_PROPERTY_LENGTH - suffix.length) + suffix;
		if (renameFieldIdVerdict({ doc, fieldUuid, newId: next }).ok) return next;
	}
}

// ── Lezer-walk XPath text rewriters ──────────────────────────────────
//
// Structural span replacement over the parse tree — never regex over
// the expression text. The rewritten text re-enters the doc through
// the same parse boundary every live commit runs (`parseXPathForField`
// / `parseXPathForForm`), so references re-resolve to identity leaves.

const XPATH_NODE_TYPES = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	return {
		Invoke: one("Invoke"),
		FunctionName: one("FunctionName"),
		ArgumentList: one("ArgumentList"),
		Comma: one(","),
	};
})();

interface SpanEdit {
	from: number;
	to: number;
	text: string;
}

function applySpanEdits(source: string, edits: SpanEdit[]): string {
	// Drop edits nested inside another edit's span (their text is being
	// replaced wholesale anyway), then apply right-to-left so earlier
	// offsets stay valid.
	const kept: SpanEdit[] = [];
	let lastEnd = -1;
	for (const edit of [...edits].sort((a, b) => a.from - b.from)) {
		if (edit.from < lastEnd) continue;
		kept.push(edit);
		lastEnd = edit.to;
	}
	let out = source;
	for (const edit of kept.reverse()) {
		out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
	}
	return out;
}

function parseTreeHasError(source: string): boolean {
	let hasError = false;
	parser.parse(source).iterate({
		enter(node) {
			if (node.type.isError) hasError = true;
		},
	});
	return hasError;
}

/**
 * Rewrite every function name that misses the registry but matches a
 * registered function case-insensitively (`Today(` → `today(`) — the
 * exact arm the validator's did-you-mean covers. Returns the rewritten
 * text, or `undefined` when nothing rewrites (including any parse
 * error: rewriting over a broken tree would guess).
 */
export function rewriteCaseMismatchedFunctionNames(
	source: string,
): string | undefined {
	if (parseTreeHasError(source)) return undefined;
	const edits: SpanEdit[] = [];
	parser.parse(source).iterate({
		enter(node) {
			if (node.type !== XPATH_NODE_TYPES.Invoke) return;
			const nameNode = node.node.getChild(XPATH_NODE_TYPES.FunctionName.id);
			if (!nameNode) return;
			const name = source.slice(nameNode.from, nameNode.to);
			if (FUNCTION_REGISTRY.has(name)) return;
			const match = findCaseInsensitiveMatch(name);
			if (match === undefined) return;
			edits.push({ from: nameNode.from, to: nameNode.to, text: match });
		},
	});
	if (edits.length === 0) return undefined;
	return applySpanEdits(source, edits);
}

/**
 * Rewrite `round(x, …)` to `round(x)` — CommCare's `round()` takes one
 * argument, so the extra-argument call throws an arity exception on
 * device. Drops everything from the first top-level comma of the
 * argument list. Returns `undefined` when no such call exists.
 */
export function rewriteRoundExtraArguments(source: string): string | undefined {
	if (parseTreeHasError(source)) return undefined;
	const edits: SpanEdit[] = [];
	parser.parse(source).iterate({
		enter(node) {
			if (node.type !== XPATH_NODE_TYPES.Invoke) return;
			const nameNode = node.node.getChild(XPATH_NODE_TYPES.FunctionName.id);
			if (!nameNode) return;
			if (source.slice(nameNode.from, nameNode.to) !== "round") return;
			const argList = node.node.getChild(XPATH_NODE_TYPES.ArgumentList.id);
			if (!argList) return;
			let comma: { from: number } | undefined;
			for (let child = argList.firstChild; child; child = child.nextSibling) {
				if (child.type === XPATH_NODE_TYPES.Comma) {
					comma = { from: child.from };
					break;
				}
			}
			if (!comma) return;
			// The ArgumentList span ends just past ")": cut from the comma up
			// to (not including) the closing paren.
			edits.push({ from: comma.from, to: argList.to - 1, text: "" });
		},
	});
	if (edits.length === 0) return undefined;
	return applySpanEdits(source, edits);
}

// ── Repair modules ───────────────────────────────────────────────────

/** Resolve a field-slot finding to its field + printed slot text. */
function fieldSlotContext(
	finding: ValidationError,
	doc: BlueprintDoc,
): { field: Field; slot: string; text: string } | undefined {
	const fieldUuid = finding.location.fieldUuid;
	const slot = finding.location.field;
	if (fieldUuid === undefined || slot === undefined) return undefined;
	if (!FIELD_XPATH_SLOTS.has(slot)) return undefined;
	const field = doc.fields[fieldUuid];
	if (!field) return undefined;
	const text = expressionSource(
		field,
		slot as Parameters<typeof expressionSource>[1],
		doc,
	);
	if (text === undefined) return undefined;
	return { field, slot, text };
}

function planFieldSlotRewrite(
	finding: ValidationError,
	doc: BlueprintDoc,
	rewrite: (text: string) => string | undefined,
	describe: (slot: string, fieldId: string, next: string) => string,
): RepairPlan | undefined {
	const ctx = fieldSlotContext(finding, doc);
	if (!ctx) return undefined;
	const next = rewrite(ctx.text);
	if (next === undefined || next === ctx.text) return undefined;
	const expr = parseXPathForField(doc, ctx.field.uuid, next);
	return {
		tier: "mechanical",
		description: describe(ctx.slot, ctx.field.id, next),
		mutations: [updateFieldMutation(ctx.field, fieldSlotPatch(ctx.slot, expr))],
	};
}

const planQuoteBareWord: RepairModule = (finding, doc) => {
	const bare = finding.details?.bareWord;
	if (bare === undefined) return undefined;
	return planFieldSlotRewrite(
		finding,
		doc,
		(text) =>
			detectUnquotedStringLiteral(text) === bare ? `'${bare}'` : undefined,
		(slot, fieldId) =>
			`quote the bare word in ${slot} of field "${fieldId}": ${bare} → '${bare}'`,
	);
};

const planFunctionNameCase: RepairModule = (finding, doc) =>
	planFieldSlotRewrite(
		finding,
		doc,
		rewriteCaseMismatchedFunctionNames,
		(slot, fieldId, next) =>
			`case-correct function name(s) in ${slot} of field "${fieldId}" → ${next}`,
	);

const planRoundArity: RepairModule = (finding, doc) =>
	planFieldSlotRewrite(
		finding,
		doc,
		rewriteRoundExtraArguments,
		(slot, fieldId, next) =>
			`drop round()'s extra argument in ${slot} of field "${fieldId}" → ${next}`,
	);

const planFieldIdRename: RepairModule = (finding, doc) => {
	const fieldUuid =
		finding.location.fieldUuid ??
		(finding.details?.fieldUuid as Uuid | undefined);
	if (fieldUuid === undefined) return undefined;
	const field = doc.fields[fieldUuid];
	if (!field) return undefined;
	const candidate = sanitizeIdentifier(field.id);
	if (candidate === field.id) return undefined;
	const newId = uniqueRenameTarget(doc, field.uuid, candidate);
	return {
		tier: "mechanical",
		description: `rename field "${field.id}" → "${newId}"`,
		mutations: [{ kind: "renameField", uuid: field.uuid, newId }],
	};
};

/** Shared rename plan for the case-property identifier findings — the
 *  flagged property name IS the writing field's id. */
function planPropertyRename(
	finding: ValidationError,
	doc: BlueprintDoc,
	property: string | undefined,
	toCandidate: (property: string) => string,
): RepairPlan | undefined {
	const formUuid = finding.location.formUuid;
	if (formUuid === undefined || property === undefined) return undefined;
	const field = findFieldByIdInForm(doc, formUuid, property);
	if (!field || fieldCasePropertyOn(field) === undefined) return undefined;
	const candidate = sanitizeIdentifier(toCandidate(property));
	if (candidate === field.id) return undefined;
	const newId = uniqueRenameTarget(doc, field.uuid, candidate);
	return {
		tier: "mechanical",
		description: `rename case property "${property}" → "${newId}" (renames the writing field; case-bound peers rename in lockstep)`,
		mutations: [{ kind: "renameField", uuid: field.uuid, newId }],
	};
}

const planCasePropertyRename: RepairModule = (finding, doc) =>
	planPropertyRename(finding, doc, finding.details?.property, (p) =>
		finding.code === "CASE_PROPERTY_TOO_LONG"
			? p.slice(0, MAX_CASE_PROPERTY_LENGTH)
			: p,
	);

const planReservedPropertyRename: RepairModule = (finding, doc) =>
	planPropertyRename(
		finding,
		doc,
		finding.details?.reservedName,
		(p) => `${p}_value`,
	);

const planDuplicateSiblingRenames: RepairModule = (finding, doc) => {
	const formUuid = finding.location.formUuid;
	if (formUuid === undefined) return undefined;
	const mutations: Mutation[] = [];
	const renames: string[] = [];
	const walk = (parentUuid: Uuid): void => {
		const order = doc.fieldOrder[parentUuid] ?? [];
		const seen = new Set<string>();
		const claimed = new Set<string>(
			order.map((u) => doc.fields[u]?.id ?? "").filter((id) => id.length > 0),
		);
		for (const uuid of order) {
			const field = doc.fields[uuid];
			if (!field) continue;
			if (!seen.has(field.id)) {
				seen.add(field.id);
			} else if (fieldCasePropertyOn(field) === undefined) {
				// Later duplicate, not case-bound: suffix-rename it. The first
				// occurrence keeps the id — pre-order first match is what every
				// reader already resolved to, so resolution doesn't move.
				// Case-bound duplicates stay reported: the rename cascade
				// re-keys the shared case property everywhere, so separating
				// the twins is a data-model decision.
				for (let n = 2; ; n++) {
					const next = `${field.id}_${n}`;
					if (claimed.has(next)) continue;
					if (!renameFieldIdVerdict({ doc, fieldUuid: uuid, newId: next }).ok)
						continue;
					claimed.add(next);
					mutations.push({ kind: "renameField", uuid, newId: next });
					renames.push(`"${field.id}" → "${next}"`);
					break;
				}
			}
			if (doc.fieldOrder[uuid] !== undefined) walk(uuid);
		}
	};
	walk(formUuid);
	if (mutations.length === 0) return undefined;
	return {
		tier: "mechanical",
		description: `rename later duplicate sibling(s): ${renames.join(", ")}`,
		mutations,
	};
};

const planClearMediaCaseProperty: RepairModule = (finding, doc) => {
	const formUuid = finding.location.formUuid;
	const fieldId = finding.details?.questionId;
	if (formUuid === undefined || fieldId === undefined) return undefined;
	const field = findFieldByIdInForm(doc, formUuid, fieldId);
	if (!field || fieldCasePropertyOn(field) === undefined) return undefined;
	return {
		tier: "mechanical",
		description: `clear case_property_on on media field "${field.id}" (the case-attachment shape is never emitted)`,
		mutations: [updateFieldMutation(field, { case_property_on: null })],
	};
};

const planClearValidation: RepairModule = (finding, doc) => {
	const fieldUuid = finding.location.fieldUuid;
	if (fieldUuid === undefined) return undefined;
	const field = doc.fields[fieldUuid];
	if (!field) return undefined;
	const raw = field as unknown as Record<string, unknown>;
	const patch: Record<string, unknown> = {};
	if (raw.validate !== undefined) patch.validate = null;
	if (raw.validate_msg !== undefined) patch.validate_msg = null;
	if (Object.keys(patch).length === 0) return undefined;
	return {
		tier: "mechanical",
		description: `clear ${Object.keys(patch).join(" + ")} on ${field.kind} field "${field.id}" (the emitter drops validation on this kind)`,
		mutations: [updateFieldMutation(field, patch)],
	};
};

const planClearRequired: RepairModule = (finding, doc) => {
	const fieldUuid = finding.location.fieldUuid;
	if (fieldUuid === undefined) return undefined;
	const field = doc.fields[fieldUuid];
	if (!field) return undefined;
	return {
		tier: "mechanical",
		description: `clear required on hidden field "${field.id}"`,
		mutations: [updateFieldMutation(field, { required: null })],
	};
};

const planClearPostSubmit: RepairModule = (finding, doc) => {
	const formUuid = finding.location.formUuid;
	if (formUuid === undefined || !doc.forms[formUuid]) return undefined;
	return {
		tier: "mechanical",
		description:
			"clear the unrecognized post-submit destination (falls back to the form-type default)",
		mutations: [
			{ kind: "updateForm", uuid: formUuid, patch: { postSubmit: undefined } },
		],
	};
};

const planDropCloseCondition: RepairModule = (finding, doc) => {
	const formUuid = finding.location.formUuid;
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	if (!form || form.closeCondition === undefined || formUuid === undefined) {
		return undefined;
	}
	const why =
		finding.code === "CLOSE_CONDITION_WRONG_TYPE"
			? "dead config on a non-close form"
			: "the emitter already closes unconditionally when a half is missing";
	return {
		tier: "mechanical",
		description: `drop the close condition on "${form.name}" (${why})`,
		mutations: [
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: { closeCondition: undefined },
			},
		],
	};
};

// ── Connect repairs ──────────────────────────────────────────────────

type ConnectKind = "learn_module" | "assessment" | "deliver_unit" | "task";
const CONNECT_KINDS: readonly ConnectKind[] = [
	"learn_module",
	"assessment",
	"deliver_unit",
	"task",
];

/**
 * One doc-wide derivation pass clearing all four CONNECT_ID_* classes
 * at once — the same walk order, live-kind scope, and name derivation
 * as the at-source autofill (`enforceConnectIds` + the validator's
 * first-occurrence-wins anchoring): a live block keeps a valid unique
 * id; a missing, malformed, over-length, or later-duplicate id
 * re-derives from the module/form names; a cross-mode stray's id is
 * re-derived only when malformed (it never reaches the wire, but the
 * format rules still flag it).
 */
const planConnectIdDerivation: RepairModule = (_finding, doc) => {
	if (!doc.connectType) return undefined;
	const live: ReadonlySet<ConnectKind> =
		doc.connectType === "learn"
			? new Set(["learn_module", "assessment"])
			: new Set(["deliver_unit", "task"]);
	const taken = new Set<string>();
	const mutations: Mutation[] = [];
	const notes: string[] = [];

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			const connect = form?.connect;
			if (!form || !connect) continue;
			let next: ConnectConfig = connect;
			for (const kind of CONNECT_KINDS) {
				const sub = next[kind];
				if (!sub) continue;
				const isLive = live.has(kind);
				const id = sub.id;
				const malformed = id !== undefined && connectIdError(id) !== null;
				const duplicate =
					isLive && id !== undefined && !malformed && taken.has(id);
				const rederive = isLive
					? id === undefined || malformed || duplicate
					: malformed;
				if (rederive) {
					const deriveName =
						kind === "learn_module" || kind === "deliver_unit"
							? mod.name
							: `${mod.name} ${form.name}`;
					const fresh = deriveConnectId(deriveName, taken);
					next = { ...next, [kind]: { ...sub, id: fresh } };
					if (isLive) taken.add(fresh);
					notes.push(
						`"${form.name}" ${kind}: ${id === undefined ? "(no id)" : `"${id}"`} → "${fresh}"`,
					);
				} else if (isLive && id !== undefined) {
					taken.add(id);
				}
			}
			if (next !== connect) {
				mutations.push({
					kind: "updateForm",
					uuid: formUuid,
					patch: { connect: next },
				});
			}
		}
	}
	if (mutations.length === 0) return undefined;
	return {
		tier: "mechanical",
		description: `re-derive connect id(s): ${notes.join("; ")}`,
		mutations,
	};
};

/**
 * Repair the form's Connect XPath slots in one pass — re-running the
 * exact checks the validator ran (the findings carry no slot pointer):
 * an explicit-empty slot is removed (the wire layer fills the canonical
 * default for an absent value) and a bare word is quoted.
 */
const planConnectXPathRepair: RepairModule = (finding, doc) => {
	const formUuid = finding.location.formUuid;
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	const connect = form?.connect;
	if (!form || !connect || formUuid === undefined) return undefined;

	let next: ConnectConfig = connect;
	const notes: string[] = [];
	const repairSlot = <K extends ConnectKind>(
		kind: K,
		key: string,
		slotId: Parameters<typeof formExpressionSource>[1],
	): void => {
		const sub = next[kind] as Record<string, unknown> | undefined;
		if (!sub) return;
		const text = formExpressionSource(form, slotId, doc);
		if (text === undefined) return;
		if (text.trim().length === 0) {
			const { [key]: _dropped, ...rest } = sub;
			next = { ...next, [kind]: rest } as ConnectConfig;
			notes.push(`${kind}.${key}: cleared the explicit-empty expression`);
			return;
		}
		const bare = detectUnquotedStringLiteral(text);
		if (bare !== null) {
			next = {
				...next,
				[kind]: {
					...sub,
					[key]: parseXPathForForm(doc, formUuid, `'${bare}'`),
				},
			} as ConnectConfig;
			notes.push(`${kind}.${key}: ${bare} → '${bare}'`);
		}
	};
	repairSlot("assessment", "user_score", "assessment_user_score");
	repairSlot("deliver_unit", "entity_id", "deliver_entity_id");
	repairSlot("deliver_unit", "entity_name", "deliver_entity_name");

	if (next === connect) return undefined;
	return {
		tier: "mechanical",
		description: `repair Connect expression slot(s) on "${form.name}": ${notes.join("; ")}`,
		mutations: [
			{ kind: "updateForm", uuid: formUuid, patch: { connect: next } },
		],
	};
};

// ── Case-list repairs ────────────────────────────────────────────────

/**
 * Renumber colliding sort priorities in the resolution order the
 * runtime, preview, and wire emitter already apply (priority ascending,
 * tie-break to column order). Priority VALUES never reach the wire —
 * the emitter writes sequential 1-based `order` attributes — so the
 * emitted bytes are identical before and after.
 */
const planSortPriorityRenumber: RepairModule = (finding, doc) => {
	const moduleUuid = finding.location.moduleUuid;
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	const config = mod?.caseListConfig;
	if (!mod || !config || moduleUuid === undefined) return undefined;

	const sorted = config.columns
		.map((column, index) => ({ column, index }))
		.filter((entry) => entry.column.sort !== undefined)
		.sort(
			(a, b) =>
				(a.column.sort?.priority ?? 0) - (b.column.sort?.priority ?? 0) ||
				a.index - b.index,
		);
	const newPriority = new Map<number, number>();
	for (const [rank, entry] of sorted.entries()) {
		newPriority.set(entry.index, rank);
	}

	let changed = false;
	const columns = config.columns.map((column, index) => {
		const rank = newPriority.get(index);
		if (rank === undefined || !column.sort || column.sort.priority === rank) {
			return column;
		}
		changed = true;
		return { ...column, sort: { ...column.sort, priority: rank } };
	});
	if (!changed) return undefined;
	return {
		tier: "mechanical",
		description: `renumber sort priorities on module "${mod.name}" in the existing resolution order (wire bytes unchanged)`,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { ...config, columns } },
			},
		],
	};
};

/**
 * PROPOSED: seed the single `case_name` column. The case for it: every
 * Nova build leads its case list with the case-name column, and the
 * case-name writer is guaranteed content on every registering form (the
 * gate refuses its removal) — so every case has a name to show. Still a
 * display choice, so it applies only under `--apply-proposed`.
 */
const planSeedCaseNameColumn: RepairModule = (finding, doc) => {
	const moduleUuid = finding.location.moduleUuid;
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (!mod || moduleUuid === undefined) return undefined;
	if ((mod.caseListConfig?.columns.length ?? 0) > 0) return undefined;
	const column = plainColumn(asUuid(crypto.randomUUID()), "case_name", "Name");
	return {
		tier: "proposed",
		description: `seed the case list of module "${mod.name}" with the single "case_name" column (header "Name") — the column every Nova build leads with`,
		mutations: [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {
					caseListConfig: {
						...(mod.caseListConfig ?? {}),
						columns: [column],
						searchInputs: mod.caseListConfig?.searchInputs ?? [],
					},
				},
			},
		],
	};
};

// ── Dispatch ─────────────────────────────────────────────────────────

const REPAIR_MODULES: Partial<Record<ValidationErrorCode, RepairModule>> = {
	UNQUOTED_STRING_LITERAL: planQuoteBareWord,
	UNKNOWN_FUNCTION: planFunctionNameCase,
	WRONG_ARITY: planRoundArity,
	INVALID_FIELD_ID: planFieldIdRename,
	RESERVED_FIELD_ID_PREFIX: planFieldIdRename,
	CASE_PROPERTY_BAD_FORMAT: planCasePropertyRename,
	CASE_PROPERTY_TOO_LONG: planCasePropertyRename,
	RESERVED_CASE_PROPERTY: planReservedPropertyRename,
	DUPLICATE_FIELD_ID: planDuplicateSiblingRenames,
	MEDIA_CASE_PROPERTY: planClearMediaCaseProperty,
	VALIDATION_ON_NON_INPUT_KIND: planClearValidation,
	REQUIRED_ON_HIDDEN: planClearRequired,
	INVALID_POST_SUBMIT: planClearPostSubmit,
	CLOSE_CONDITION_WRONG_TYPE: planDropCloseCondition,
	CLOSE_CONDITION_INCOMPLETE: planDropCloseCondition,
	CONNECT_ID_MISSING: planConnectIdDerivation,
	CONNECT_ID_INVALID_FORMAT: planConnectIdDerivation,
	CONNECT_ID_TOO_LONG: planConnectIdDerivation,
	CONNECT_ID_DUPLICATE: planConnectIdDerivation,
	CONNECT_EMPTY_XPATH: planConnectXPathRepair,
	CONNECT_UNQUOTED_XPATH: planConnectXPathRepair,
	CASE_LIST_DUPLICATE_SORT_PRIORITY: planSortPriorityRenumber,
	MISSING_CASE_LIST_COLUMNS: planSeedCaseNameColumn,
};

/** Codes carrying an implemented repair module — pinned against the
 *  judgment table by a test (mechanical/proposed ⇔ module exists). */
export function repairableCodes(): ValidationErrorCode[] {
	return Object.keys(REPAIR_MODULES) as ValidationErrorCode[];
}

/** Plan the repair for one finding, or `undefined` when the class (or
 *  this instance of it) has no honest mechanical move. */
export function planRepair(
	finding: ValidationError,
	doc: BlueprintDoc,
): RepairPlan | undefined {
	return REPAIR_MODULES[finding.code]?.(finding, doc);
}

// ── Per-app repair loop + the strictly-decreasing oracle ────────────

export interface FindingReport {
	finding: ValidationError;
	description: string;
}

export interface RejectedRepair extends FindingReport {
	introduced: ValidationError[];
}

export interface RepairOutcomeVerdict {
	ok: boolean;
	/** Findings in `after` with no identity counterpart in `before` —
	 *  must be empty for any acceptable outcome. */
	introduced: ValidationError[];
}

/**
 * The whole-app oracle: a repaired app must end with STRICTLY fewer
 * findings and ZERO introduced identities (`diffIntroduced` over
 * `errorIdentity` — the same machinery the commit gate diffs with). An
 * app where nothing was applied passes trivially; its doc is discarded
 * unwritten either way.
 */
export function repairOutcomeVerdict(
	before: readonly ValidationError[],
	after: readonly ValidationError[],
	appliedCount: number,
): RepairOutcomeVerdict {
	const introduced = diffIntroduced(before, after);
	const ok =
		introduced.length === 0 &&
		(appliedCount === 0 || after.length < before.length);
	return { ok, introduced };
}

export interface AppRepairOutcome {
	/** Findings before any repair. */
	before: ValidationError[];
	/** Findings after the applied repairs. */
	after: ValidationError[];
	/** The doc with every applied repair — write it only when
	 *  `changed && verdict.ok`. */
	doc: BlueprintDoc;
	changed: boolean;
	applied: FindingReport[];
	/** Proposed repairs withheld because `applyProposed` was off. */
	proposed: FindingReport[];
	/** Plans the commit gate refused — kept as findings, never written. */
	rejected: RejectedRepair[];
	/** Plans that committed but did not clear their finding. */
	uncleared: FindingReport[];
	verdict: RepairOutcomeVerdict;
}

export interface RepairAppOptions {
	/** Apply the PROPOSED tier too (the `--apply-proposed` flag). */
	applyProposed: boolean;
}

/**
 * Repair one app's doc in memory. Each plan commits through the same
 * gate every live write surface runs (`mutationCommitVerdict` — a plan
 * that would introduce a finding is refused and reported), findings are
 * re-evaluated after every step so plans compose against current state,
 * and the strictly-decreasing oracle adjudicates the final doc. Pure on
 * the input: the caller owns persistence.
 */
export function repairApp(
	input: BlueprintDoc,
	options: RepairAppOptions,
): AppRepairOutcome {
	const before = evaluateLegacyFindings(input).findings;
	let working = input;
	const applied: FindingReport[] = [];
	const proposedSkipped: FindingReport[] = [];
	const rejected: RejectedRepair[] = [];
	const uncleared: FindingReport[] = [];
	// Identities already handled (repaired, withheld, refused, or
	// planless) — the loop never revisits one, which bounds it.
	const settled = new Set<string>();

	const maxSteps = before.length * 4 + 8;
	for (let step = 0; step < maxSteps; step++) {
		const findings = evaluateLegacyFindings(working).findings;
		const next = findings.find((f) => !settled.has(errorIdentity(f)));
		if (!next) break;
		const identity = errorIdentity(next);
		const plan = planRepair(next, working);
		if (!plan) {
			settled.add(identity);
			continue;
		}
		if (plan.tier === "proposed" && !options.applyProposed) {
			proposedSkipped.push({ finding: next, description: plan.description });
			settled.add(identity);
			continue;
		}
		const gate = mutationCommitVerdict(working, plan.mutations);
		if (!gate.ok) {
			rejected.push({
				finding: next,
				description: plan.description,
				introduced: gate.introduced,
			});
			settled.add(identity);
			continue;
		}
		const remaining = evaluateLegacyFindings(gate.nextDoc).findings;
		working = gate.nextDoc;
		if (remaining.some((f) => errorIdentity(f) === identity)) {
			// The reducers accepted the batch but the finding survived (e.g.
			// a patch skipped over a field whose other slots don't parse).
			// Report it; never retry the same identity.
			uncleared.push({ finding: next, description: plan.description });
			settled.add(identity);
		} else {
			applied.push({ finding: next, description: plan.description });
		}
	}

	const after = evaluateLegacyFindings(working).findings;
	return {
		before,
		after,
		doc: working,
		changed: applied.length > 0,
		applied,
		proposed: proposedSkipped,
		rejected,
		uncleared,
		verdict: repairOutcomeVerdict(before, after, applied.length),
	};
}
