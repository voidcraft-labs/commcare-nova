/**
 * Post-processing helpers for SA batch-field tool input.
 *
 * The SA's `addFields` tool emits a flat array of field descriptors with
 * sentinel-padded optionals (see `toolSchemaGenerator.ts` for why: the
 * Anthropic structured-output compiler caps array items at ~8 optional
 * fields, so `label` and `required` are promoted to required-with-sentinel).
 * This module is where those sentinels are collapsed and the per-field
 * case-type defaults from the app's data model are merged in before the
 * handler assembles `addField` mutations.
 *
 * Vocabulary is domain-side (`kind`, `validate`, `validate_msg`,
 * `case_property`); there is no CommCare → domain translation inside
 * the agent. The one boundary translation this file does is
 * case-type → field: case-type property metadata uses CommCare-flavored
 * `validation` / `validation_msg` (case-type properties describe the
 * CommCare data model directly), and `applyDefaults` maps those onto
 * their domain equivalents when seeding a field's defaults.
 */
import type { z } from "zod";
import type { CaseType, Field, FormType, Uuid } from "@/lib/domain";
import { CASE_LOADING_FORM_TYPES, fieldSchema } from "@/lib/domain";
import { log } from "@/lib/logger";
import type { addFieldsItemSchema } from "./toolSchemas";

type CaseTypes = CaseType[] | null;

// ── XPath utilities ──────────────────────────────────────────────────

/**
 * XPath-valued fields on the flat input shape. LLMs occasionally emit
 * HTML-escaped XPath operators (`&gt;` instead of `>`), which XForm
 * parsers reject; `unescapeXPath` undoes that mangling on every XPath
 * key before defaults are merged.
 */
const XPATH_FIELDS = [
	"validate",
	"relevant",
	"calculate",
	"default_value",
	"required",
] as const;

function unescapeXPath(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

// ── Flat input shape ─────────────────────────────────────────────────

/**
 * The flat field shape the SA emits inside an `addFields` batch item.
 * Derived directly from `addFieldsItemSchema` so the interface can't
 * drift from the tool's input contract. `label`, `required`, and
 * `parentId` are required-with-sentinel (empty string = absent) to stay
 * under Anthropic's 8-optional-fields-per-array-item compiler ceiling;
 * `stripEmpty` normalizes the sentinels to absence before the handler
 * assembles a domain `Field`. `parentId` is a semantic field id (or
 * empty string for "insert at the form's top level"); the handler
 * resolves it to a UUID when building the `addField` mutation.
 */
export type FlatField = z.infer<typeof addFieldsItemSchema>;

// ── Sentinel collapse ────────────────────────────────────────────────

/**
 * Collapse sentinel values to absence:
 *   - empty string → drop the key entirely
 *   - empty array  → drop
 *
 * `parentId` is special-cased: an empty string becomes `null` (rather
 * than being dropped) so downstream "no parent = form level" logic can
 * distinguish "field omitted this key" from "SA explicitly said
 * top-level." Today both paths converge on the same insertion point,
 * but the null is retained for clarity and future branching.
 *
 * Input is typed as `FlatField` (the Zod-validated shape with sentinel-
 * required keys); output is `Partial<FlatField>` because any of those
 * keys may now be absent.
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
 *   2. **Case-type defaulting.** When `case_property` is set, the
 *      matching case type's property metadata seeds any unset keys on
 *      the field:
 *        - `kind` from `property.data_type` (defaulting to "text")
 *        - `label`, `hint`, `required`, `options` verbatim
 *        - `validate` from `property.validation` (case-type vocab is
 *          CommCare-flavored; we translate onto the field's domain
 *          vocab at this boundary)
 *        - `validate_msg` from `property.validation_msg`
 *
 *   3. **Preload auto-default.** For case-loading forms (followup,
 *      close), any field whose `case_property` matches the module's
 *      own case type (other than `case_name`) gets `default_value`
 *      auto-set to `#case/{id}`. Mirrors the `case_preload` logic in
 *      `deriveCaseConfig.ts`, which preloads every primary case
 *      property regardless of whether the id is declared on the
 *      case-type catalog. The field's id names the slot the preload
 *      writes to; the compiler emits a `<setvalue>` binding, and the
 *      UI renders the preloaded value as the field's initial state.
 */
export function applyDefaults(
	q: Partial<FlatField>,
	caseTypes: CaseTypes,
	formType?: FormType,
	moduleCaseType?: string,
): Partial<FlatField> {
	const result = { ...q };

	for (const f of XPATH_FIELDS) {
		const val = result[f];
		if (typeof val === "string") {
			result[f] = unescapeXPath(val);
		}
	}

	if (result.case_property && caseTypes) {
		const ct = caseTypes.find((c) => c.name === result.case_property);
		const prop = ct?.properties.find((p) => p.name === result.id);
		if (prop) {
			result.kind ??= prop.data_type ?? "text";
			result.label ??= prop.label;
			result.hint ??= prop.hint;
			result.required ??= prop.required;
			// Case-type → field vocabulary translation. CaseProperty uses
			// CommCare-flavored `validation` / `validation_msg` because the
			// case-type record directly models the CommCare data layer; the
			// field uses `validate` / `validate_msg` because the field is
			// our domain entity. This single line is the one point in the
			// agent module where the two vocabularies meet.
			result.validate ??= prop.validation;
			result.validate_msg ??= prop.validation_msg;
			result.options ??= prop.options;
		}
	}

	if (
		formType &&
		CASE_LOADING_FORM_TYPES.has(formType) &&
		result.case_property &&
		result.case_property === moduleCaseType &&
		result.id !== "case_name" &&
		!result.default_value &&
		!result.calculate
	) {
		result.default_value = `#case/${result.id}`;
	}

	return result;
}

// ── Flat → Field assembly ────────────────────────────────────────────

/**
 * Build a validated domain `Field` from the SA's flat batch-item payload.
 *
 * The SA can in principle emit any combination of optional keys for any
 * `kind` — there's no per-kind Zod validation on the tool input because
 * the flat schema is a union across all kinds. Per-kind validity is
 * enforced HERE: the assembled candidate runs through `fieldSchema`
 * (the discriminated union) so Zod strips keys the target kind doesn't
 * declare (e.g. `label` on `hidden`, `case_property` on media kinds)
 * and rejects invalid values. Returns `undefined` when the shape can't
 * be salvaged into a valid `Field`; callers skip and log.
 *
 * `label`, `hint`, etc. are included only when they carry a non-empty
 * value. The batch schema's sentinel-required `label`/`required` fields
 * are already stripped to absent by `stripEmpty` before this runs, but
 * the extra guard here is cheap and keeps the helper standalone.
 *
 * Lives alongside `stripEmpty` + `applyDefaults` because the three
 * helpers form a pipeline — sentinels collapse, defaults merge, then
 * assembly — that every SA field-add tool (`addFields`, `addField`)
 * walks in order.
 */
export function flatFieldToField(
	q: Partial<FlatField>,
	uuid: Uuid,
): Field | undefined {
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
		...(typeof q.validate === "string" &&
			q.validate.length > 0 && {
				validate: q.validate,
			}),
		...(typeof q.validate_msg === "string" &&
			q.validate_msg.length > 0 && {
				validate_msg: q.validate_msg,
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
		...(typeof q.case_property === "string" &&
			q.case_property.length > 0 && {
				case_property: q.case_property,
			}),
	};
	const result = fieldSchema.safeParse(candidate);
	if (!result.success) {
		log.warn(
			`[addFields] dropped invalid field candidate id=${q.id} kind=${q.kind}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		);
		return undefined;
	}
	return result.data;
}
