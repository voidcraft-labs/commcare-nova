// lib/agent/toolSchemaGenerator.ts
//
// Generates SA tool input schemas from the field registry.
//
// The SA today works with three hand-written schemas in
// `lib/schemas/toolSchemas.ts`:
//
//   - `addQuestionsQuestionSchema` — flat batch generation shape, with 2
//     required sentinels (label, required) and 8 optionals (hint,
//     validation, validation_msg, relevant, calculate, default_value,
//     options, case_property_on) to stay under Anthropic's 8-optional-
//     per-array-item compiler limit.
//   - `addQuestionQuestionSchema` — single-field insertion shape.
//   - `editQuestionUpdatesSchema` — partial patch shape, with nullable
//     optionals for clearable XPath properties.
//
// Phase 3 replaces those hand-written definitions with a GENERATED bundle
// that reads the single-source-of-truth `fieldRegistry` (via the `type`
// enum — every kind listed in `fieldKinds` must appear in the SA's `type`
// field).
//
// Why generate: adding a new field kind becomes one edit (a new file
// under `lib/domain/fields/` plus an entry in the `fieldKinds` tuple).
// Without the generator the tool schemas, the SA prompt, the compiler,
// and the validator all need parallel updates for every new kind —
// exactly the drift the registry is meant to eliminate.
//
// Wire vocabulary. Phase 3 generates the `flat-sentinels` mode byte-
// identically to today's hand-written shape — `type` stays as the
// discriminant key, `validation` / `validation_msg` / `case_property_on`
// stay as the CommCare-flavored names. The future `per-type` mode (one
// tool per kind) + the wire-name flip (`kind`, `validate`, `case_property`)
// are explicit non-goals of this phase (spec §Non-goals).
//
// Byte-identity. `lib/agent/__tests__/toolSchemaGenerator.test.ts`
// compares `JSON.stringify(z.toJSONSchema(generated))` to committed
// fixture snapshots (captured from the CURRENT hand-written schemas
// BEFORE the generator replaces them). A mismatch anywhere — field
// order, description string, enum list, required/optional flag — fails
// the test. This gate ensures the LLM's input schema is visually
// identical to today's, so the SA's behavior is unaffected by the
// migration.

import { z } from "zod";
import type { FieldKind } from "@/lib/domain";
import { fieldKinds } from "@/lib/domain";
import {
	QUESTION_DOCS,
	questionFields,
	selectOptionSchema,
} from "@/lib/schemas/blueprint";

/**
 * The mode controls how the generator shapes tool inputs.
 *
 * - `"flat-sentinels"` (Phase 3 default): one `addQuestions` tool that
 *   accepts any `FieldKind` in its `type` field. The optional key set is
 *   the UNION of all kinds' optionals; each field has sentinel defaults
 *   (empty string for strings, `false` for booleans) so the structured-
 *   output compiler stays under Anthropic's per-array-item optional
 *   limit. Post-processing via `stripEmpty()` collapses sentinels back.
 *
 * - `"per-type"` (future): one tool per kind (`addTextFields`,
 *   `addSelectFields`, …). Each tool's schema carries only the kind's
 *   actual optionals, so no sentinel tricks are needed. Enabled by the
 *   caller passing a different mode; Phase 3 ships only flat-sentinels.
 */
export type ToolSchemaMode = "flat-sentinels" | "per-type";

/**
 * Bundle of generated SA tool schemas.
 *
 * Each field is a Zod schema ready to hand to `tool({ inputSchema: ... })`
 * inside the Solutions Architect. The type is inferred from the generator
 * functions so consumers' `z.infer<typeof ...>` calls see the concrete
 * per-field shape (not `ZodRawShape`, which would erase the field types).
 */
export type GeneratedToolSchemas = {
	addQuestionsQuestionSchema: ReturnType<typeof generateAddQuestionsSchema>;
	addQuestionQuestionSchema: ReturnType<typeof generateAddQuestionSchema>;
	editQuestionUpdatesSchema: ReturnType<
		typeof generateEditQuestionUpdatesSchema
	>;
};

/**
 * The enum of every kind the SA may reference as a question `type`.
 *
 * Built from the caller-supplied `kinds` tuple (which defaults to the
 * authoritative `fieldKinds` registry) so that the `type` field's enum
 * list stays in lockstep with the domain — adding a kind to
 * `fieldKinds` automatically propagates to the SA's tool schema.
 */
function makeKindEnum(kinds: readonly FieldKind[]) {
	return z
		.enum(kinds as readonly [FieldKind, ...FieldKind[]])
		.describe(QUESTION_DOCS.type);
}

/**
 * `addQuestions`-tool batch input shape. Two required sentinels
 * (`label`, `required`) hold strings that the consumer normalizes away
 * via `stripEmpty()`, keeping the optional-field count at exactly 8 —
 * the ceiling the Anthropic structured-output compiler can handle for
 * array items without timing out.
 */
function generateAddQuestionsSchema(kinds: readonly FieldKind[]) {
	return z.object({
		id: questionFields.id,
		type: makeKindEnum(kinds),
		parentId: z
			.string()
			.describe("Parent group/repeat ID. Empty string for top-level."),
		// Required sentinels — empty string means "not set"
		label: z.string().describe(QUESTION_DOCS.label),
		required: z.string().describe(QUESTION_DOCS.required),
		// Optionals — exactly 8 to stay under Anthropic's per-array-item limit
		hint: questionFields.hint,
		validation: questionFields.validation,
		validation_msg: questionFields.validation_msg,
		relevant: questionFields.relevant,
		calculate: questionFields.calculate,
		default_value: questionFields.default_value,
		options: questionFields.options,
		case_property_on: questionFields.case_property_on,
	});
}

/**
 * `addQuestion`-tool single-insert shape. All fields optional except
 * `id` and `type` (the SA always knows both). No `parentId` — the
 * caller already located the insertion point.
 */
function generateAddQuestionSchema(kinds: readonly FieldKind[]) {
	return z.object({
		id: questionFields.id,
		type: makeKindEnum(kinds),
		label: questionFields.label,
		hint: questionFields.hint,
		required: questionFields.required,
		validation: questionFields.validation,
		validation_msg: questionFields.validation_msg,
		relevant: questionFields.relevant,
		calculate: questionFields.calculate,
		default_value: questionFields.default_value,
		options: questionFields.options,
		case_property_on: questionFields.case_property_on,
	});
}

/**
 * `editQuestion`-tool patch shape. Every field optional (the SA only
 * includes properties it wants to change). `relevant` / `calculate` /
 * `default_value` / `options` / `case_property_on` accept `null` so the
 * SA can explicitly CLEAR a value — distinct from "leave unchanged"
 * (field absent).
 */
function generateEditQuestionUpdatesSchema(kinds: readonly FieldKind[]) {
	return z
		.object({
			id: questionFields.id.optional(),
			label: questionFields.label,
			type: makeKindEnum(kinds).optional(),
			hint: questionFields.hint,
			required: questionFields.required,
			validation: questionFields.validation,
			validation_msg: questionFields.validation_msg,
			// Nullable optionals — accept null to clear the value
			relevant: z
				.string()
				.nullable()
				.optional()
				.describe(QUESTION_DOCS.relevant),
			calculate: z
				.string()
				.nullable()
				.optional()
				.describe(QUESTION_DOCS.calculate),
			default_value: z
				.string()
				.nullable()
				.optional()
				.describe(QUESTION_DOCS.default_value),
			options: z
				.array(selectOptionSchema)
				.nullable()
				.optional()
				.describe(QUESTION_DOCS.options),
			case_property_on: z
				.string()
				.nullable()
				.optional()
				.describe(QUESTION_DOCS.case_property_on),
		})
		.describe(
			"Properties to update. Only include properties you want to change.",
		);
}

/**
 * Generate the three SA tool schemas from the field registry.
 *
 * The `kinds` parameter defaults to `fieldKinds` (the authoritative
 * registry tuple) but is exposed for tests that want to exercise the
 * generator against a custom subset.
 *
 * Throws if the mode is anything other than `"flat-sentinels"` — the
 * per-type mode is explicit future work.
 */
export function generateToolSchemas(
	mode: ToolSchemaMode,
	kinds: readonly FieldKind[] = fieldKinds,
): GeneratedToolSchemas {
	if (mode !== "flat-sentinels") {
		throw new Error(
			`toolSchemaGenerator: mode "${mode}" is not implemented. ` +
				`Only "flat-sentinels" is supported in Phase 3.`,
		);
	}

	return {
		addQuestionsQuestionSchema: generateAddQuestionsSchema(kinds),
		addQuestionQuestionSchema: generateAddQuestionSchema(kinds),
		editQuestionUpdatesSchema: generateEditQuestionUpdatesSchema(kinds),
	};
}
