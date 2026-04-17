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

import type { z } from "zod";
import type { FieldKind } from "@/lib/domain";
import { fieldKinds } from "@/lib/domain";

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
 * inside the Solutions Architect. Consumers treat these as opaque Zod
 * objects; the only legitimate shape assertion is the byte-identity
 * snapshot test at `lib/agent/__tests__/toolSchemaGenerator.test.ts`.
 */
export interface GeneratedToolSchemas {
	addQuestionsQuestionSchema: z.ZodObject<z.ZodRawShape>;
	addQuestionQuestionSchema: z.ZodObject<z.ZodRawShape>;
	editQuestionUpdatesSchema: z.ZodObject<z.ZodRawShape>;
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
	// biome-ignore lint/correctness/noUnusedFunctionParameters: part of the scaffolded public API — Task 13 consumes this when implementing the body
	kinds: readonly FieldKind[] = fieldKinds,
): GeneratedToolSchemas {
	if (mode !== "flat-sentinels") {
		throw new Error(
			`toolSchemaGenerator: mode "${mode}" is not implemented. ` +
				`Only "flat-sentinels" is supported in Phase 3.`,
		);
	}

	// Implementation lands in Task 13.
	throw new Error("toolSchemaGenerator: not yet implemented");
}
