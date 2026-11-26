/**
 * SA-facing input schemas for the data-model tool (`generateSchema` —
 * it commits the case-type catalog onto the app), the per-form
 * close-condition creation/update shape, and the case-type declarations.
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
 * parent) are rejected with a
 * message that says what to pass instead. `cleanCaseTypeRecord`
 * collapses the nulls before a record leaves the boundary, so no null
 * ever lands on the catalog.
 *
 * The shapes are structurally compatible with the corresponding domain
 * Zod schemas (e.g. `casePropertySchema` in `lib/domain/blueprint.ts`)
 * so a validated record lands on the catalog without reshaping.
 */

import { z } from "zod";
import {
	authoredCasePropertyNameSchema,
	proseTemplateSchema,
	selectOptionValueSchema,
} from "@/lib/domain";

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

const selectOptionDescribed = z.strictObject({
	value: selectOptionValueSchema,
	label: proseTemplateSchema.describe(
		"Option label shown to the user. Put the wording here, never in `value`.",
	),
});

export const casePropertyInputSchema = z
	.strictObject({
		name: authoredCasePropertyNameSchema.describe(
			"Property name in snake_case. " +
				`Must NOT be a reserved word: ${RESERVED_CASE_PROPERTIES}. ` +
				"Must NOT be media/binary (photos, audio, video, signatures). " +
				'Use descriptive alternatives (e.g. "visit_date" not "date"). For a case or person display name, use the canonical "case_name" field—not "name", "full_name", or another duplicate. Standard metadata such as "external_id", "date_opened", and lifecycle "status" is implicit and should be referenced directly rather than added as custom catalog properties.',
		),
		label: proseTemplateSchema.describe(
			"Human-readable label for this property. Used as the default field label in all forms.",
		),
		data_type: z
			.enum(CASE_PROPERTY_DATA_TYPES)
			.nullable()
			.optional()
			.describe(
				'Data type. Determines the default field kind. null for "text".',
			),
		hint: proseTemplateSchema
			.nullable()
			.optional()
			.describe(
				"Hint text shown below fields collecting this property. null when there is none.",
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
	.superRefine((prop, ctx) => {
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
	.strictObject({
		name: z
			.string()
			.min(1)
			.describe('Case type name in snake_case (e.g., "patient", "household")'),
		properties: z
			.array(casePropertyInputSchema)
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
	.superRefine((record, ctx) => {
		if (record.relationship && !record.parent_type) {
			ctx.addIssue({
				code: "custom",
				path: ["relationship"],
				message: `Case type "${record.name}" has a relationship but no parent_type — relationship describes how a child links to its parent. Set parent_type to the owning case type, or pass null for relationship (a standalone case type has null for both).`,
			});
		}
		const seen = new Map<string, number>();
		for (const [index, property] of record.properties.entries()) {
			const firstIndex = seen.get(property.name);
			if (firstIndex !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["properties", index, "name"],
					message: `Case type "${record.name}" lists property "${property.name}" more than once. Keep one definition.`,
				});
				continue;
			}
			seen.set(property.name, index);
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
		properties: record.properties.map((p) => nonNull(p)),
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
