/**
 * SA-facing input schemas for the data-model tool (`generateSchema` —
 * it commits the case-type catalog onto the app) and the per-form
 * close-condition + Connect shapes the creation tools and `updateForm`
 * share.
 *
 * Separate from the field-mutation tool schemas in `toolSchemas.ts`
 * because these describe whole-app structure at the case-type level,
 * not per-field edits. They carry rich LLM-facing descriptions on every
 * property — the domain-layer schemas in `lib/domain/` intentionally
 * stay description-free so the domain module graph stays free of
 * prompt-engineering concerns.
 *
 * Every shape here is built so a wrong input can't parse — under the
 * shared input contract (lib/agent/CLAUDE.md § strict-mode
 * normalization): SA tools run `strict: false`, so the model omits what
 * doesn't apply, and every optional slot is ALSO `.nullable()` with
 * null meaning absent on the add path — arbitrary MCP callers and
 * stray nulls stay harmless. Every non-null string must be non-empty
 * (`min(1)`), and cross-field contradictions (a `relationship` with no
 * parent, a connect block with nothing in it) are rejected with a
 * message that says what to pass instead. `cleanCaseTypeRecord`
 * collapses the nulls before a record leaves the boundary, so no null
 * ever lands on the catalog.
 *
 * The shapes are structurally compatible with the corresponding domain
 * Zod schemas (e.g. `casePropertySchema` in `lib/domain/blueprint.ts`)
 * so a validated record lands on the catalog without reshaping.
 */

import { z } from "zod";
import { CONNECT_ID_FIELD_DESCRIPTION } from "@/lib/commcare/connectSlugs";
import { canonicalCasePropertyName } from "@/lib/domain";

// ── Reserved case properties (CommCare platform list) ───────────────
//
// The LLM needs to see the reserved set spelled out so it picks safe
// property names. This exact list also lives in
// `lib/commcare/constants.ts` as an authoritative Set for
// runtime validation — the two stay in sync manually (a mismatch here
// affects LLM guidance only; the runtime check in `formActions.ts` +
// validate rules is the gate).
const RESERVED_CASE_PROPERTIES =
	"case_id, case_type, closed, closed_by, closed_on, date, date_modified, date_opened, doc_type, domain, external_id, index, indices, modified_on, name, opened_by, opened_on, owner_id, server_modified_on, status, type, user_id, xform_id";

// ── Case property data types (excludes media, structural, hidden/secret) ──

const CASE_PROPERTY_DATA_TYPES = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
] as const;

const SELECT_DATA_TYPES: ReadonlySet<string> = new Set([
	"single_select",
	"multi_select",
]);

const selectOptionDescribed = z
	.object({
		value: z.string().min(1).describe("Option value (stored in data)"),
		label: z.string().min(1).describe("Option label (shown to user)"),
	})
	.strict();

const casePropertyDescribed = z
	.object({
		name: z
			.string()
			.min(1)
			.describe(
				"Property name in snake_case. " +
					`Must NOT be a reserved word: ${RESERVED_CASE_PROPERTIES}. ` +
					"Must NOT be media/binary (photos, audio, video, signatures). " +
					'Use descriptive alternatives (e.g. "visit_date" not "date"). For a case or person display name, use the canonical "case_name" field—not "name", "full_name", or another duplicate. Standard metadata such as "external_id", "date_opened", and lifecycle "status" is implicit and should be referenced directly rather than added as custom catalog properties.',
			),
		label: z
			.string()
			.min(1)
			.describe(
				"Human-readable label for this property. Used as the default field label in all forms.",
			),
		data_type: z
			.enum(CASE_PROPERTY_DATA_TYPES)
			.nullable()
			.optional()
			.describe(
				'Data type. Determines the default field kind. null for "text".',
			),
		hint: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Hint text shown below fields collecting this property. null when there is none.",
			),
		required: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"\"true()\" if always required. null if optional. String values must be quoted: `'text'`, not `text`.",
			),
		validation: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"XPath validation expression, e.g. \". > 0 and . < 150\". null when any value is acceptable. String values must be quoted: `'text'`, not `text`.",
			),
		validation_msg: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Error message when validation fails. Only alongside `validation`; null otherwise.",
			),
		options: z
			.array(selectOptionDescribed)
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Options for single_select/multi_select properties. null for every other data_type.",
			),
	})
	.strict()
	.superRefine((prop, ctx) => {
		if (prop.validation_msg && !prop.validation) {
			ctx.addIssue({
				code: "custom",
				path: ["validation_msg"],
				message: `Property "${prop.name}" has a validation_msg but no validation expression for it to accompany. Set \`validation\` to the rule the message explains, or pass null for the message.`,
			});
		}
		const isSelect = prop.data_type && SELECT_DATA_TYPES.has(prop.data_type);
		if (prop.options && !isSelect) {
			ctx.addIssue({
				code: "custom",
				path: ["options"],
				message: `Property "${prop.name}" carries options but its data_type is ${prop.data_type ?? '"text" (the default)'} — options only apply to single_select/multi_select. Pass null for options, or change the data_type.`,
			});
		}
	});

/**
 * One case-type record — the shape each `generateSchema` entry carries;
 * the tool commits it onto the app's case-type catalog.
 */
export const caseTypeRecordSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.describe('Case type name in snake_case (e.g., "patient", "household")'),
		properties: z
			.array(casePropertyDescribed)
			.min(1)
			.describe(
				'Case properties to track. Forms will create fields to capture these. Include the display/person name once as "case_name"; never add a duplicate "name" or "full_name" property. Standard metadata (external_id, date_opened, lifecycle status) is implicit rather than a custom property.',
			),
		parent_type: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Parent case type name. Set only on a child case type (e.g., a "pregnancy" case type with parent_type "mother") — a standalone case type passes null.',
			),
		relationship: z
			.enum(["child", "extension"])
			.nullable()
			.optional()
			.describe(
				'"child" (default) or "extension". Only meaningful alongside parent_type; null on a standalone case type. Use "extension" when the child should prevent the parent from being closed.',
			),
	})
	.strict()
	.superRefine((record, ctx) => {
		if (record.relationship && !record.parent_type) {
			ctx.addIssue({
				code: "custom",
				path: ["relationship"],
				message: `Case type "${record.name}" has a relationship but no parent_type — relationship describes how a child links to its parent. Set parent_type to the owning case type, or pass null for relationship (a standalone case type has null for both).`,
			});
		}
		const seenCanonical = new Map<string, number>();
		for (const [index, property] of record.properties.entries()) {
			const canonical = canonicalCasePropertyName(property.name);
			const firstIndex = seenCanonical.get(canonical);
			if (firstIndex !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["properties", index, "name"],
					message: `Case type "${record.name}" lists "${property.name}" and "${record.properties[firstIndex].name}", but both mean Nova property "${canonical}". Keep one definition under the canonical name "${canonical}".`,
				});
				continue;
			}
			seenCanonical.set(canonical, index);
		}
	});

// ── Boundary normalization ──────────────────────────────────────────

/**
 * Collapse a validated record's `null` slots (the add path's "nothing
 * here") to real absence so nothing downstream — the catalog mutations, the
 * field-defaults seeding, the stored doc — ever carries a null the domain
 * schemas reject. Pure; returns a new record.
 */
export function cleanCaseTypeRecord(
	record: z.infer<typeof caseTypeRecordSchema>,
): {
	name: string;
	properties: Array<Record<string, unknown>>;
	parent_type?: string;
	relationship?: "child" | "extension";
} {
	const nonNull = <T extends Record<string, unknown>>(obj: T) =>
		Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
	return {
		name: record.name,
		properties: record.properties.map((p) => ({
			...nonNull(p),
			name: canonicalCasePropertyName(p.name),
		})),
		...(record.parent_type != null && { parent_type: record.parent_type }),
		...(record.relationship != null && { relationship: record.relationship }),
	};
}

// ── generateSchema input ────────────────────────────────────────────

/** Input shape for the `generateSchema` tool (first build step). */
export const caseTypesOutputSchema = z.object({
	case_types: z
		.array(caseTypeRecordSchema)
		.min(1)
		.describe("Case types and their properties"),
});

// ── Per-form close condition ────────────────────────────────────────

/**
 * A close form's conditional-close input — the ONE SA-facing shape,
 * shared by the creation tools (`createForm` / `createModule`) and
 * `updateForm`. `field` names the checked field by its bare id; each
 * tool resolves it to the stored uuid against its own context (the doc
 * for an edit, the doc-plus-batch overlay for a creation, so the
 * condition can name a field landing in the same call).
 */
export const closeConditionInputSchema = z
	.object({
		field: z.string().describe("Field id to check"),
		answer: z.string().describe("Value that triggers closure"),
		operator: z
			.enum(["=", "selected"])
			.nullable()
			.optional()
			.describe(
				'"=" for exact match (default — null uses it). "selected" for multi-select fields.',
			),
	})
	.strict();

// ── Per-form Connect block ──────────────────────────────────────────

/**
 * Per-form Connect config — the ONE SA-facing input shape for a form's
 * `connect` block, shared by the creation tools (`createForm` /
 * `createModule`) and `updateForm`. A block marks that the form
 * PARTICIPATES in Connect; a form without one is auxiliary — Connect's
 * ingestion scans per form and silently skips blockless forms
 * (`commcare_connect/opportunity/app_xml.py::extract_modules`). The
 * validator's only coverage demand is the app-level floor of one
 * participating form (`CONNECT_NO_PARTICIPATING_FORMS`), so the
 * creation call is where a participating form's block lands.
 *
 * ONE shape, two refinements — the same object can't be gated the same
 * way on both surfaces because null means different things there (the
 * shared input contract): on creation null ≡ omitted, so an all-empty
 * block opts into nothing and is rejected (`connectFormConfigSchema` —
 * the failure mode it invites is a model padding every form with an
 * empty block "just in case"); on `updateForm`'s patch an omitted
 * sub-config keeps its current value and an explicit null REMOVES it,
 * so a partial-null patch is meaningful and only the says-nothing
 * all-omitted patch rejects (`connectFormPatchSchema`).
 */
const connectFormConfigShape = z
	.object({
		learn_module: z
			.object({
				id: z
					.string()
					.min(1)
					.nullable()
					.optional()
					.describe(CONNECT_ID_FIELD_DESCRIPTION),
				name: z.string().min(1),
				description: z.string().min(1),
				// Match the domain's `connectLearnModuleSchema`: time estimate is
				// in minutes and must be a positive integer. The reducer applies
				// the patch via `Object.assign` without a Zod re-parse, so the
				// SA-facing schema is the only gate against `0` / negatives /
				// floats landing on the persisted doc.
				time_estimate: z
					.number()
					.int("time_estimate must be a whole number of minutes.")
					.min(1, "time_estimate must be at least 1 minute.")
					.describe("Estimated minutes to complete the module's content."),
			})
			.strict()
			.nullable()
			.optional()
			.describe(
				"Set on forms with educational/training content. null on quiz-only forms.",
			),
		assessment: z
			.object({
				id: z
					.string()
					.min(1)
					.nullable()
					.optional()
					.describe(CONNECT_ID_FIELD_DESCRIPTION),
				user_score: z.string().min(1),
			})
			.strict()
			.nullable()
			.optional()
			.describe(
				"Set on forms with a quiz/test; null on content-only forms. `user_score` is an XPath resolving to the user's score, typically `#form/<hidden_score_field>`.",
			),
		deliver_unit: z
			.object({
				id: z
					.string()
					.min(1)
					.nullable()
					.optional()
					.describe(CONNECT_ID_FIELD_DESCRIPTION),
				name: z.string().min(1),
				entity_id: z
					.string()
					.min(1)
					.nullable()
					.optional()
					.describe(
						"XPath dedup key grouping submissions into one paid delivery (CompletedWork). Omit for the daily-aggregate default; override per the Connect guidance in your instructions.",
					),
				entity_name: z
					.string()
					.min(1)
					.nullable()
					.optional()
					.describe(
						"XPath for the human-readable delivery label in Connect dashboards. Display-only; omit for the username default.",
					),
			})
			.strict()
			.nullable()
			.optional()
			.describe(
				"Set on a deliver-app form that counts as a payable delivery; `name` shows in Connect's deliver-unit picker.",
			),
		task: z
			.object({
				id: z
					.string()
					.min(1)
					.nullable()
					.optional()
					.describe(CONNECT_ID_FIELD_DESCRIPTION),
				name: z.string().min(1),
				description: z.string().min(1),
			})
			.strict()
			.nullable()
			.optional()
			.describe(
				"Optional task description rendered in the Connect mobile UI. Independent of `deliver_unit`.",
			),
	})
	.strict();

/** The creation-surface refinement: null ≡ omitted there, so a block
 *  with no non-null sub-config opts the form into nothing. */
export const connectFormConfigSchema = connectFormConfigShape.superRefine(
	(connect, ctx) => {
		if (
			!connect.learn_module &&
			!connect.assessment &&
			!connect.deliver_unit &&
			!connect.task
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"An empty connect block doesn't opt the form into anything. Give it the sub-config that matches the form's content — learn_module/assessment on a learn app, deliver_unit/task on a deliver app — or pass null for the whole `connect` slot on a form that doesn't participate.",
			});
		}
	},
);

/** The `updateForm` patch refinement: omitted sub-configs keep their
 *  current value and explicit nulls remove theirs, so partial-null
 *  patches pass; only a patch naming NO sub-config — which could
 *  change nothing — rejects. */
export const connectFormPatchSchema = connectFormConfigShape.superRefine(
	(connect, ctx) => {
		if (
			connect.learn_module === undefined &&
			connect.assessment === undefined &&
			connect.deliver_unit === undefined &&
			connect.task === undefined
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"This connect patch names no sub-config, so it changes nothing. State the sub-configs to set (omitted ones keep their current value), pass null on a sub-config to remove just it, or pass null for the whole `connect` slot to drop the form's Connect participation.",
			});
		}
	},
);
