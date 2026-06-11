/**
 * SA-facing input schemas for the initial-build PLANNING tools
 * (`generateSchema`, `planAppDesign`) and the per-form Connect block
 * the creation tools share.
 *
 * Separate from the field-mutation tool schemas in `toolSchemas.ts`
 * because these describe whole-app structure at the module / case
 * type level, not per-field edits. They carry rich LLM-facing
 * descriptions on every property — the domain-layer schemas in
 * `lib/domain/` intentionally stay description-free so the domain
 * module graph stays free of prompt-engineering concerns.
 *
 * The shapes here are structurally compatible with the corresponding
 * domain Zod schemas (e.g. `casePropertySchema` in
 * `lib/domain/blueprint.ts`) so a plan's case-type entries paste
 * verbatim into `createModule`'s `case_type_record` without reshaping.
 */

import { z } from "zod";
import { CONNECT_ID_FIELD_DESCRIPTION } from "@/lib/commcare/connectSlugs";
import { FORM_TYPES, USER_FACING_DESTINATIONS } from "@/lib/domain";

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

const selectOptionDescribed = z.object({
	value: z.string().describe("Option value (stored in data)"),
	label: z.string().describe("Option label (shown to user)"),
});

const casePropertyDescribed = z.object({
	name: z
		.string()
		.describe(
			"Property name in snake_case. " +
				`Must NOT be a reserved word: ${RESERVED_CASE_PROPERTIES}. ` +
				"Must NOT be media/binary (photos, audio, video, signatures). " +
				'Use descriptive alternatives (e.g. "visit_date" not "date", "full_name" not "name").',
		),
	label: z
		.string()
		.describe(
			"Human-readable label for this property. Used as the default field label in all forms.",
		),
	data_type: z
		.enum(CASE_PROPERTY_DATA_TYPES)
		.optional()
		.describe('Data type. Determines the default field kind. Omit for "text".'),
	hint: z
		.string()
		.optional()
		.describe("Hint text shown below fields collecting this property."),
	required: z
		.string()
		.optional()
		.describe(
			"\"true()\" if always required. Omit if optional. String values must be quoted: `'text'`, not `text`.",
		),
	validation: z
		.string()
		.optional()
		.describe(
			"XPath validation expression, e.g. \". > 0 and . < 150\". String values must be quoted: `'text'`, not `text`.",
		),
	validation_msg: z
		.string()
		.optional()
		.describe("Error message when validation fails."),
	options: z
		.array(selectOptionDescribed)
		.optional()
		.describe("Options for single_select/multi_select properties."),
});

/**
 * One case-type record — the shape a `generateSchema` plan entry carries
 * AND the shape `createModule`'s `case_type_record` accepts, so a plan
 * section pastes into the creation call verbatim.
 */
export const caseTypeRecordSchema = z.object({
	name: z
		.string()
		.describe('Case type name in snake_case (e.g., "patient", "household")'),
	properties: z
		.array(casePropertyDescribed)
		.describe(
			'Case properties to track. Forms will create fields to capture these. The case name field must always have id "case_name".',
		),
	parent_type: z
		.string()
		.optional()
		.describe(
			'Parent case type name. Present only for child case types (e.g., a "child" case type with parent_type "mother").',
		),
	relationship: z
		.enum(["child", "extension"])
		.optional()
		.describe(
			'"child" (default) or "extension". Only used when parent_type is set. Use "extension" when the child should prevent the parent from being closed.',
		),
});

// ── generateSchema input ────────────────────────────────────────────

/** Input shape for the `generateSchema` tool (first build step). */
export const caseTypesOutputSchema = z.object({
	case_types: z
		.array(caseTypeRecordSchema)
		.describe("Case types and their properties"),
});

// ── planAppDesign input ─────────────────────────────────────────────

/**
 * Per-form Connect config — the ONE SA-facing input shape for a form's
 * `connect` block, shared by the `planAppDesign` plan and the atomic
 * creation tools (`createForm` / `createModule`). On a Connect-typed
 * app, a form without its block introduces CONNECT_FORM_MISSING_BLOCK,
 * so the creation call is where the block must land.
 */
export const connectFormConfigSchema = z.object({
	learn_module: z
		.object({
			id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
			name: z.string(),
			description: z.string(),
			// Match the domain's `connectLearnModuleSchema`: time estimate is
			// in minutes and must be a positive integer. The reducer applies
			// the patch via `Object.assign` without a Zod re-parse, so the
			// SA-facing schema is the only gate against `0` / negatives /
			// floats landing on the persisted doc.
			time_estimate: z
				.number()
				.refine(
					(n) => Number.isInteger(n) && n >= 1,
					"time_estimate must be a positive integer (minutes).",
				),
		})
		.optional()
		.describe(
			"Set on forms with educational/training content. Omit on quiz-only forms.",
		),
	assessment: z
		.object({
			id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
			user_score: z.string(),
		})
		.optional()
		.describe(
			"Set on forms with a quiz/test. `user_score` is an XPath resolving to the user's score, typically `#form/<hidden_score_field>`.",
		),
	deliver_unit: z
		.object({
			id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
			name: z.string(),
		})
		.optional()
		.describe(
			"Set on every form in a Connect deliver app. Connect's deliver-unit picker reads these from the released CCZ.",
		),
	task: z
		.object({
			id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
			name: z.string(),
			description: z.string(),
		})
		.optional()
		.describe(
			"Optional task description rendered in the Connect mobile UI. Independent of `deliver_unit`.",
		),
});

/** Input shape for the `planAppDesign` tool (second planning step). */
export const appDesignPlanSchema = z.object({
	app_name: z.string().describe("Name of the CommCare application"),
	description: z
		.string()
		.describe("Brief description of the app purpose and target users"),
	connect_type: z
		.enum(["learn", "deliver", ""])
		.describe(
			'CommCare Connect app type: "learn" for training/certification, "deliver" for paid service delivery. Empty string for standard apps.',
		),
	modules: z.array(
		z.object({
			name: z.string().describe("Display name for the module/menu"),
			case_type: z
				.string()
				.nullable()
				.describe(
					'References a case_type name from the data model. Required if any form is "registration", "followup", or "close". null for survey-only modules.',
				),
			case_list_only: z
				.boolean()
				.describe(
					"True when this module exists solely to display a case list with no forms. " +
						"Use for child case types that need to be viewable but have no follow-up workflow.",
				),
			purpose: z
				.string()
				.describe("Brief description of this module's role in the app"),
			forms: z.array(
				z.object({
					name: z.string().describe("Display name for the form"),
					type: z
						.enum(FORM_TYPES)
						.describe(
							'"registration" creates a new case. "followup" updates an existing case. "close" loads and closes an existing case. "survey" is standalone.',
						),
					purpose: z
						.string()
						.describe("Brief description of what this form collects and why"),
					post_submit: z
						.enum(USER_FACING_DESTINATIONS)
						.optional()
						.describe(
							'Where the user goes after submitting. Defaults to "previous" for followup forms, "app_home" for registration/survey. Only set to override.',
						),
					connect: connectFormConfigSchema
						.optional()
						.describe(
							"Per-form Connect config. REQUIRED on every form when the app's `connect_type` is `learn` or `deliver`; omit entirely on standard apps. Pick sub-configs by content: `learn_module` for educational content, `assessment` for quizzes, `deliver_unit` for every deliver-app form, optional `task` for delivery descriptions.",
						),
					formDesign: z
						.string()
						.describe(
							"Free-text UX design spec for this form. Describe the intended field flow, " +
								"grouping, skip logic patterns, calculated fields, and how this form relates to " +
								"sibling forms.",
						),
				}),
			),
		}),
	),
});

// ── Inferred TS types ───────────────────────────────────────────────

export type AppDesignPlan = z.infer<typeof appDesignPlanSchema>;
