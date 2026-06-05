/**
 * Shared add-path normalization for the SA's field-add tools.
 *
 * Both `addFields` (batch) and `addField` (single) walk this pipeline
 * before emitting `addField` mutations:
 *
 *   1. **`stripEmpty`** — batch-only. Normalizes the in-batch `parentId`
 *      (absent → `null`, the "insert at form level" sentinel the batch
 *      handler reads) and defensively collapses any empty string / empty
 *      array the SA sends to absence. The single-field `addField` path has
 *      no in-batch parent to resolve and skips this step.
 *   2. **`applyDefaults`** — both surfaces. XPath HTML-entity unescape and
 *      case-type property defaulting (seed `kind` / `label` / `hint` /
 *      `required` / `validate` / `options` from the catalog wherever the
 *      payload left them unset). Case preload is NOT seeded here — it's
 *      emitted structurally at the wire layer (`xform/caseBlocks.ts`).
 *   3. **`flatFieldToField`** — both surfaces. Per-kind
 *      `fieldSchema.safeParse` validation + domain `Field` assembly,
 *      returning a tagged success/reason result.
 *
 * Vocabulary is domain-side (`kind`, `validate`, `validate_msg`,
 * `case_property_on`); there is no CommCare → domain translation inside
 * the agent. The one boundary translation this file does is
 * case-type → field: case-type property metadata uses CommCare-flavored
 * `validation` / `validation_msg` (case-type properties describe the
 * CommCare data model directly), and `applyDefaults` maps those onto
 * their domain equivalents when seeding a field's defaults.
 */
import type { z } from "zod";
import type { CaseType, Field, FieldKind, Uuid } from "@/lib/domain";
import {
	fieldKindDeclaresKey,
	fieldKinds,
	fieldSchema,
	pickFieldKeysForKind,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import type { wideFlatItemSchema } from "./toolSchemas";

/** Narrow a possibly-unknown kind string to a `FieldKind` before asking the
 *  per-kind key sets about it — an SA-supplied bad kind would otherwise blow
 *  up `fieldKindDeclaresKey`'s lookup (and is caught later by the field parse). */
function isFieldKind(kind: unknown): kind is FieldKind {
	return (
		typeof kind === "string" && (fieldKinds as readonly string[]).includes(kind)
	);
}

/** A catalog default should fill a slot the SA left unset — treating an empty
 *  string or empty array as "unset" too, so an explicit `""` (which the batch
 *  path's `stripEmpty` already collapses) is seeded the same on both add paths. */
function isUnset(value: unknown): boolean {
	return (
		value === undefined ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	);
}

type CaseTypes = CaseType[] | null;

// ── XPath utilities ──────────────────────────────────────────────────

/**
 * XPath-valued fields on the flat input shape. LLMs occasionally emit
 * HTML-escaped XPath operators (`&gt;` instead of `>`), which XForm
 * parsers reject; `unescapeXPath` undoes that mangling on every XPath
 * key before defaults are merged.
 */
const XPATH_FIELDS = [
	"relevant",
	"calculate",
	"default_value",
	"required",
] as const;

/**
 * Reverse HTML-entity escaping that LLMs sometimes apply to XPath
 * expressions (`&gt;` → `>`, `&apos;` → `'`, etc.). Applied to every
 * XPath-shaped value we accept from the SA — both top-level XPath
 * fields (via `XPATH_FIELDS` in `applyDefaults`) and nested-config
 * XPath fields (validate.expr, repeat.count, repeat.ids_query, both in
 * `flatFieldToField` and `editPatchToFieldPatch`). Without this step
 * mangled entities slip through Zod (`z.string()` accepts anything),
 * land in the stored entity, and only fail at FormPlayer when the XPath
 * parser chokes on `&amp;gt;`.
 */
export function unescapeXPath(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

// ── Flat input shape ─────────────────────────────────────────────────

/**
 * The WIDE flat field shape this pipeline operates on — every key any kind
 * might carry, all optional but `id`/`kind`. Derived from `wideFlatItemSchema`
 * (the generator's wide processing-type source), NOT from the per-kind
 * discriminated-union tool inputs: a validated tool item (one union arm) is
 * a structural subset of this shape, so it flows through `stripEmpty` /
 * `applyDefaults` / `flatFieldToField` without per-kind narrowing. `parentId`
 * is an optional semantic field id (omitted = "insert at the form's top
 * level"); the handler resolves a present value to a UUID when building the
 * `addField` mutation.
 */
export type FlatField = z.infer<typeof wideFlatItemSchema>;

// ── Sentinel collapse ────────────────────────────────────────────────

/**
 * Collapse empty values to absence:
 *   - empty string → drop the key entirely
 *   - empty array  → drop
 *
 * The per-kind tool arms can't even surface a label sentinel (a visible
 * kind requires a non-empty label, `hidden` has no label slot), so this
 * is purely defensive: it drops any stray empty string / empty array the
 * SA sends for an optional slot rather than letting it through as a
 * meaningless "" value.
 *
 * `parentId` is special-cased: missing or empty becomes `null` (rather
 * than just being dropped) so the downstream "no parent = form level"
 * logic reads an explicit value. The SA usually omits `parentId`, which
 * lands here as `undefined` → `null`.
 *
 * Batch-path only — the `addFields` tool runs its input through this
 * before `applyDefaults`. `addField` (single) feeds `applyDefaults`
 * directly.
 *
 * Input is typed as `FlatField` (the wide processing shape); output is
 * `Partial<FlatField>` because any non-required key may be absent after
 * the collapse.
 */
export function stripEmpty(q: FlatField): Partial<FlatField> & {
	parentId?: string | null;
} {
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(q)) {
		if (v === "") continue;
		if (Array.isArray(v) && v.length === 0) continue;
		result[k] = v;
	}
	if (result.parentId === undefined) result.parentId = null;
	return result as Partial<FlatField> & { parentId?: string | null };
}

// ── Data-model defaults ──────────────────────────────────────────────

/**
 * Apply case-type defaults to a flat field and sanitize XPath strings.
 *
 * Two things happen here:
 *
 *   1. **XPath unescape.** Every XPath-valued field is run through
 *      `unescapeXPath` to undo any HTML entity encoding the LLM may
 *      have emitted — a frequent cause of otherwise-subtle XForm
 *      parse failures.
 *
 *   2. **Case-type defaulting.** When `case_property_on` is set, the
 *      matching case type's property metadata seeds any unset keys on
 *      the field:
 *        - `kind` from `property.data_type` (defaulting to "text")
 *        - `label`, `hint`, `required`, `options` verbatim
 *        - `validate` from `property.validation` (case-type vocab is
 *          CommCare-flavored; we translate onto the field's domain
 *          vocab at this boundary)
 *        - `validate_msg` from `property.validation_msg`
 *
 * Case preload is NOT seeded here. A case-loading form's primary properties
 * are read back from the case at the wire layer — `xform/caseBlocks.ts`
 * lowers the derived `case_preload` action into `<setvalue>` reads from
 * `casedb`. Stamping a `default_value = "#case/{id}"` here was a redundant
 * second channel for the same effect; the structural preload owns it.
 */
export function applyDefaults<E extends object = object>(
	q: Partial<FlatField> & E,
	caseTypes: CaseTypes,
): Partial<FlatField> & E {
	const result = { ...q };

	for (const f of XPATH_FIELDS) {
		const val = result[f];
		if (typeof val === "string") {
			result[f] = unescapeXPath(val);
		}
	}

	if (result.case_property_on && caseTypes) {
		const ct = caseTypes.find((c) => c.name === result.case_property_on);
		const prop = ct?.properties.find((p) => p.name === result.id);
		if (prop) {
			// Seed the kind first — every other default depends on knowing it.
			result.kind ??= prop.data_type ?? "text";
			const kind = result.kind;

			// A catalog default applies only when (a) the field left the slot
			// unset — and `""` / `[]` count as unset, so the single- and
			// batch-add paths (the latter pre-collapses empties via
			// `stripEmpty`) seed IDENTICALLY — AND (b) the resolved kind's
			// schema actually DECLARES the slot. Without (b), a computed
			// `hidden` field that writes to a property declared as a select
			// would inherit that property's `options` / `label`, and the
			// strict per-kind schema in `flatFieldToField` would then reject
			// the whole field (the kind doesn't carry those keys).
			const declares = (key: string): boolean =>
				isFieldKind(kind) ? fieldKindDeclaresKey(kind, key) : true;

			if (declares("label") && isUnset(result.label)) {
				result.label = prop.label;
			}
			if (declares("hint") && isUnset(result.hint)) {
				result.hint = prop.hint;
			}
			if (declares("required") && isUnset(result.required)) {
				result.required = prop.required;
			}
			// Case-type → field vocabulary translation. CaseProperty uses
			// CommCare-flavored `validation` / `validation_msg` because the
			// case-type record directly models the CommCare data layer; the
			// field's SA tool surface uses a nested `validate: { expr, msg }`
			// object. Seed it only when the kind supports validation and the
			// SA didn't provide a usable `expr` (an SA stub like
			// `validate: { expr: "" }` must not suppress the catalog default,
			// so we check for a truthy `expr`, not the object's presence).
			if (declares("validate") && prop.validation && !result.validate?.expr) {
				result.validate = {
					expr: prop.validation,
					...(prop.validation_msg && { msg: prop.validation_msg }),
				};
			}
			if (declares("options") && isUnset(result.options)) {
				result.options = prop.options;
			}
		}
	}

	return result;
}

// ── Flat → Field assembly ────────────────────────────────────────────

/**
 * Outcome of assembling a flat payload into a domain `Field`: the built
 * field, or a human-readable `reason` the assembly failed. Callers surface
 * the reason (single-add error, batch skip note) so a failure is
 * diagnosable rather than a generic "missing a required property".
 */
export type FlatFieldResult =
	| { ok: true; field: Field }
	| { ok: false; reason: string };

/**
 * Reduce a `fieldSchema` parse error to the specific reason(s) it failed,
 * digging through the union machinery. `fieldSchema` is a union of two
 * discriminated unions, so the genuinely-useful issue is nested inside an
 * `invalid_union`'s per-branch `errors`; the top-level issue is just a
 * generic "Invalid input" and the wrong-branch attempts say "No matching
 * discriminator". Skip that noise and surface the real leaf messages.
 */
function describeFieldFailure(
	error: z.ZodError,
	kind: string | undefined,
): string {
	type Issue = {
		code?: string;
		message: string;
		path: PropertyKey[];
		errors?: Issue[][];
	};
	const leaves: string[] = [];
	const visit = (issues: readonly Issue[]): void => {
		for (const issue of issues) {
			if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
				for (const branch of issue.errors) visit(branch);
				continue;
			}
			if (/no matching discriminator|invalid input/i.test(issue.message)) {
				continue;
			}
			const path = issue.path.map(String).join(".");
			leaves.push(path ? `${path}: ${issue.message}` : issue.message);
		}
	};
	visit(error.issues as unknown as Issue[]);
	const detail = [...new Set(leaves)].join("; ");
	return detail || `the supplied values don't form a valid "${kind}" field`;
}

/**
 * Build a validated domain `Field` from an add-path flat payload.
 *
 * Two steps: reshape the SA-authoring shape into the domain shape (nested
 * `validate`/`repeat` → flat keys, XPath-entity unescape), then validate.
 * Before validating we FILTER the candidate to the kind's schema-declared
 * keys via `pickFieldKeysForKind` — the same projection `reconcileFieldForKind`
 * and the `updateField` reducer use. The per-kind schemas are `.strict()`,
 * so a stray key the kind doesn't declare would otherwise make the WHOLE
 * field fail to parse; filtering drops the stray key and keeps the field as
 * its valid subset. (The per-kind tool inputs already reject stray keys at
 * the boundary, so this is defense-in-depth for non-tool paths — catalog
 * seeding, or schema drift.)
 *
 * Returns `{ ok: true, field }`, or `{ ok: false, reason }` naming the
 * specific parse failure. After the per-kind tool input + kind-aware
 * `applyDefaults`, a valid payload always assembles — a failure here means
 * the generator and the domain schema have drifted (a code bug), which the
 * reason makes diagnosable. The `__tests__` fuzz over every kind asserts
 * this totality.
 *
 * Lives alongside `stripEmpty` + `applyDefaults` because the three helpers
 * form the shared add-path pipeline both `addFields` and `addField` walk.
 */
export function flatFieldToField(
	q: Partial<FlatField>,
	uuid: Uuid,
): FlatFieldResult {
	const candidate: Record<string, unknown> = {
		kind: q.kind,
		uuid,
		id: q.id,
		...(typeof q.label === "string" &&
			q.label.length > 0 && {
				label: q.label,
			}),
		...(typeof q.hint === "string" && q.hint.length > 0 && { hint: q.hint }),
		...(typeof q.required === "string" &&
			q.required.length > 0 && {
				required: q.required,
			}),
		...(typeof q.relevant === "string" &&
			q.relevant.length > 0 && {
				relevant: q.relevant,
			}),
		// Nested validate config: SA passes `validate: { expr, msg? }`;
		// the schema stores `validate` (string) + `validate_msg`
		// (optional string). Reshape here, unescaping XPath HTML
		// entities on the expression — same mangling risk as the other
		// XPath fields, just inlined since `validate.expr` isn't a
		// top-level FlatField key.
		...(q.validate &&
			typeof q.validate.expr === "string" &&
			q.validate.expr.length > 0 && {
				validate: unescapeXPath(q.validate.expr),
				...(typeof q.validate.msg === "string" &&
					q.validate.msg.length > 0 && {
						validate_msg: q.validate.msg,
					}),
			}),
		...(typeof q.calculate === "string" &&
			q.calculate.length > 0 && {
				calculate: q.calculate,
			}),
		...(typeof q.default_value === "string" &&
			q.default_value.length > 0 && {
				default_value: q.default_value,
			}),
		...(Array.isArray(q.options) &&
			q.options.length > 0 && {
				options: q.options,
			}),
		...(typeof q.case_property_on === "string" &&
			q.case_property_on.length > 0 && {
				case_property_on: q.case_property_on,
			}),
		// Nested repeat config: SA passes `repeat: { mode, count?,
		// ids_query? }`; the domain schema is a discriminated union over
		// `repeat_mode` with `repeat_count` (count_bound) or
		// `data_source: { ids_query }` (query_bound). Reshape here,
		// unescaping XPath HTML entities on the inner expressions.
		// Mode is required inside the nested object so there's no
		// silent default — if the SA emits `kind: "repeat"` without a
		// `repeat` object, the candidate has no `repeat_mode` and the
		// discriminated union rejects, surfacing the omission as a
		// parse error rather than a silent fallback.
		...(q.kind === "repeat" &&
			q.repeat && {
				repeat_mode: q.repeat.mode,
				...(typeof q.repeat.count === "string" &&
					q.repeat.count.length > 0 && {
						repeat_count: unescapeXPath(q.repeat.count),
					}),
				...(typeof q.repeat.ids_query === "string" &&
					q.repeat.ids_query.length > 0 && {
						data_source: {
							ids_query: unescapeXPath(q.repeat.ids_query),
						},
					}),
			}),
	};
	// Filter to the kind's declared keys before the strict parse, so a stray
	// key drops out rather than failing the whole field (see the doc comment).
	const kind = candidate.kind;
	const filtered = isFieldKind(kind)
		? pickFieldKeysForKind(candidate, kind)
		: candidate;
	const result = fieldSchema.safeParse(filtered);
	if (!result.success) {
		const reason = describeFieldFailure(result.error, q.kind);
		log.warn(
			`[flatFieldToField] could not assemble field id=${q.id} kind=${q.kind}: ${reason}`,
		);
		return { ok: false, reason };
	}
	return { ok: true, field: result.data };
}
