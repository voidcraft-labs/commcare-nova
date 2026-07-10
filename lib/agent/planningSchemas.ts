/**
 * SA-facing input schemas for the data-model planning tool
 * (`generateSchema`) and the per-form Connect block the creation tools
 * share.
 *
 * Separate from the field-mutation tool schemas in `toolSchemas.ts`
 * because these describe whole-app structure at the case-type level,
 * not per-field edits. They carry rich LLM-facing descriptions on every
 * property — the domain-layer schemas in `lib/domain/` intentionally
 * stay description-free so the domain module graph stays free of
 * prompt-engineering concerns.
 *
 * Every shape here is built so a wrong input can't parse: optional means
 * genuinely optional (omit it — there are no `""`/`[]` sentinels on this
 * surface), every string that is present must be non-empty (`min(1)`),
 * and cross-field contradictions (a `relationship` with no parent, a
 * connect block with nothing in it) are rejected with a message that
 * says what to do instead.
 *
 * The shapes are structurally compatible with the corresponding domain
 * Zod schemas (e.g. `casePropertySchema` in `lib/domain/blueprint.ts`)
 * so a plan's case-type entries paste verbatim into `createModule`'s
 * `case_type_record` without reshaping.
 */

import { z } from "zod";
import { CONNECT_ID_FIELD_DESCRIPTION } from "@/lib/commcare/connectSlugs";

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
					'Use descriptive alternatives (e.g. "visit_date" not "date", "full_name" not "name").',
			),
		label: z
			.string()
			.min(1)
			.describe(
				"Human-readable label for this property. Used as the default field label in all forms.",
			),
		data_type: z
			.enum(CASE_PROPERTY_DATA_TYPES)
			.optional()
			.describe(
				'Data type. Determines the default field kind. Omit for "text".',
			),
		hint: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Hint text shown below fields collecting this property. Omit when there is none.",
			),
		required: z
			.string()
			.min(1)
			.optional()
			.describe(
				"\"true()\" if always required. Omit if optional. String values must be quoted: `'text'`, not `text`.",
			),
		validation: z
			.string()
			.min(1)
			.optional()
			.describe(
				"XPath validation expression, e.g. \". > 0 and . < 150\". Omit when any value is acceptable. String values must be quoted: `'text'`, not `text`.",
			),
		validation_msg: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Error message when validation fails. Only alongside `validation`.",
			),
		options: z
			.array(selectOptionDescribed)
			.min(1)
			.optional()
			.describe(
				"Options for single_select/multi_select properties. Omit for every other data_type.",
			),
	})
	.strict()
	.superRefine((prop, ctx) => {
		if (prop.validation_msg && !prop.validation) {
			ctx.addIssue({
				code: "custom",
				path: ["validation_msg"],
				message: `Property "${prop.name}" has a validation_msg but no validation expression for it to accompany. Set \`validation\` to the rule the message explains, or drop the message.`,
			});
		}
		const isSelect = prop.data_type && SELECT_DATA_TYPES.has(prop.data_type);
		if (prop.options && !isSelect) {
			ctx.addIssue({
				code: "custom",
				path: ["options"],
				message: `Property "${prop.name}" carries options but its data_type is ${prop.data_type ?? '"text" (the default)'} — options only apply to single_select/multi_select. Drop the options, or change the data_type.`,
			});
		}
	});

/**
 * One case-type record — the shape a `generateSchema` plan entry carries
 * AND the shape `createModule`'s `case_type_record` accepts, so a plan
 * section pastes into the creation call verbatim.
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
				'Case properties to track. Forms will create fields to capture these. The case name field must always have id "case_name".',
			),
		parent_type: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Parent case type name. Set only on a child case type (e.g., a "pregnancy" case type with parent_type "mother") — a standalone case type omits it.',
			),
		relationship: z
			.enum(["child", "extension"])
			.optional()
			.describe(
				'"child" (default) or "extension". Only meaningful alongside parent_type. Use "extension" when the child should prevent the parent from being closed.',
			),
	})
	.strict()
	.superRefine((record, ctx) => {
		if (record.relationship && !record.parent_type) {
			ctx.addIssue({
				code: "custom",
				path: ["relationship"],
				message: `Case type "${record.name}" has a relationship but no parent_type — relationship describes how a child links to its parent. Set parent_type to the owning case type, or drop relationship (a standalone case type carries neither).`,
			});
		}
	});

// ── generateSchema input ────────────────────────────────────────────

/** Input shape for the `generateSchema` tool (first build step). */
export const caseTypesOutputSchema = z.object({
	case_types: z
		.array(caseTypeRecordSchema)
		.min(1)
		.describe("Case types and their properties"),
});

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
 * A block must carry at least one sub-config: participation with
 * nothing in it means nothing, and the failure mode it invites — a
 * model padding every form with an empty block "just in case" — is
 * exactly what the refinement rejects.
 */
export const connectFormConfigSchema = z
	.object({
		learn_module: z
			.object({
				id: z.string().min(1).optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
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
			.optional()
			.describe(
				"Set on forms with educational/training content. Omit on quiz-only forms.",
			),
		assessment: z
			.object({
				id: z.string().min(1).optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
				user_score: z.string().min(1),
			})
			.strict()
			.optional()
			.describe(
				"Set on forms with a quiz/test. `user_score` is an XPath resolving to the user's score, typically `#form/<hidden_score_field>`.",
			),
		deliver_unit: z
			.object({
				id: z.string().min(1).optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
				name: z.string().min(1),
			})
			.strict()
			.optional()
			.describe(
				"Set on a deliver-app form that counts as a payable delivery. Connect's deliver-unit picker reads these from the released CCZ.",
			),
		task: z
			.object({
				id: z.string().min(1).optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
				name: z.string().min(1),
				description: z.string().min(1),
			})
			.strict()
			.optional()
			.describe(
				"Optional task description rendered in the Connect mobile UI. Independent of `deliver_unit`.",
			),
	})
	.strict()
	.superRefine((connect, ctx) => {
		if (
			!connect.learn_module &&
			!connect.assessment &&
			!connect.deliver_unit &&
			!connect.task
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"An empty connect block doesn't opt the form into anything. Give it the sub-config that matches the form's content — learn_module/assessment on a learn app, deliver_unit/task on a deliver app — or omit `connect` entirely on a form that doesn't participate.",
			});
		}
	});
