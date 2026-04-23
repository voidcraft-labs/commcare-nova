/**
 * SA tool: `updateForm` — patch form-level metadata.
 *
 * Covers the four form-scoped edits the SA exposes: display name,
 * close condition (close forms only), Connect integration, and
 * post-submit navigation. Both the SA chat factory and the MCP adapter
 * call this through the shared `ToolExecutionContext` interface.
 *
 * Every nullable key follows the convention the store's
 * `updateFormMutations` helper establishes: omitted → leave alone,
 * `null` → clear, a value → set. Connect-config patches go through the
 * local `buildConnectConfig` helper which preserves system-derived
 * fields (`entity_id`, `entity_name`) the SA should never set directly.
 *
 * Three exit branches:
 *
 *   1. Form index out of range → `{ error }`, no mutations.
 *   2. Form disappeared after the patch (reducer-level rejection) →
 *      `{ error }`, mutations may have already been persisted.
 *   3. Success → human-readable summary listing the changed keys,
 *      tagged `form:M-F`.
 */

import { z } from "zod";
import type {
	BlueprintDoc,
	ConnectConfig,
	PostSubmitDestination,
} from "@/lib/domain";
import { USER_FACING_DESTINATIONS } from "@/lib/domain";
import { resolveFormUuid, updateFormMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const updateFormInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	formIndex: z.number().describe("0-based form index"),
	name: z.string().optional().describe("New form name"),
	close_condition: z
		.object({
			field: z.string().describe("Field id to check"),
			answer: z.string().describe("Value that triggers closure"),
			operator: z
				.enum(["=", "selected"])
				.optional()
				.describe(
					'"=" for exact match (default). "selected" for multi-select fields.',
				),
		})
		.nullable()
		.optional()
		.describe(
			'Close forms only. Set conditional close. Use operator "selected" for multi-select fields. null to make unconditional (default). Omit to leave unchanged.',
		),
	post_submit: z
		.enum(USER_FACING_DESTINATIONS)
		.nullable()
		.optional()
		.describe(
			"Where the user goes after submitting this form. " +
				'"app_home" = main menu. ' +
				'"module" = this module\'s form list. ' +
				'"previous" = back to where the user was (e.g. case list). ' +
				'Defaults to "previous" for followup, "app_home" for registration/survey. ' +
				"null to reset to default. Omit to leave unchanged.",
		),
	connect: z
		.object({
			learn_module: z
				.object({
					id: z.string().optional(),
					name: z.string(),
					description: z.string(),
					time_estimate: z.number(),
				})
				.optional()
				.describe(
					"Set for forms with educational/training content. Omit for quiz-only forms.",
				),
			assessment: z
				.object({ id: z.string().optional(), user_score: z.string() })
				.optional()
				.describe(
					"Set for forms with a quiz/test. Omit for content-only forms.",
				),
			deliver_unit: z.object({ name: z.string() }).optional(),
			task: z.object({ name: z.string(), description: z.string() }).optional(),
		})
		.nullable()
		.optional()
		.describe(
			"Set Connect config on this form. null to remove. Learn apps: set learn_module and/or assessment independently. Deliver apps: set deliver_unit and/or task independently.",
		),
});

export type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateFormResult = string | { error: string };

/**
 * Merge the SA's partial connect-config input into a full
 * `ConnectConfig`. Preserves every system-derived field the SA doesn't
 * know about (`entity_id`, `entity_name`) from the existing form
 * config; the SA only ever supplies the user-semantic fields
 * (`learn_module`, `assessment`, `deliver_unit.name`, `task`).
 *
 * **Partial-update contract.** Only keys the SA explicitly provided on
 * `input` are touched on the output — every other sub-config is copied
 * verbatim from `existing`. A call like
 * `{ assessment: { user_score: "…" } }` leaves `learn_module`,
 * `deliver_unit`, and `task` on the existing form untouched; the SA
 * never has to round-trip the full connect config just to patch one
 * sub-config. Returns `null` only when the SA's input is explicitly
 * `null` — the caller uses that as the "clear Connect config" signal.
 */
function buildConnectConfig(
	input: NonNullable<UpdateFormInput["connect"]> | null,
	existing?: ConnectConfig,
): ConnectConfig | null {
	if (input === null) return null;
	const out: ConnectConfig = { ...existing };
	if (input.learn_module !== undefined) {
		out.learn_module = { ...existing?.learn_module, ...input.learn_module };
	}
	if (input.assessment !== undefined) {
		out.assessment = { ...existing?.assessment, ...input.assessment };
	}
	if (input.deliver_unit !== undefined) {
		out.deliver_unit = {
			...existing?.deliver_unit,
			...input.deliver_unit,
			entity_id: existing?.deliver_unit?.entity_id ?? "",
			entity_name: existing?.deliver_unit?.entity_name ?? "",
		};
	}
	if (input.task !== undefined) {
		out.task = { ...existing?.task, ...input.task };
	}
	return out;
}

export const updateFormTool = {
	description:
		"Update form metadata: name, close condition (close forms only), Connect integration, or post-submit navigation.",
	inputSchema: updateFormInputSchema,
	async execute(
		input: UpdateFormInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateFormResult>> {
		const {
			moduleIndex,
			formIndex,
			name,
			close_condition,
			post_submit,
			connect,
		} = input;
		try {
			const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
			if (!formUuid) {
				return {
					mutations: [],
					newDoc: doc,
					result: { error: `Form m${moduleIndex}-f${formIndex} not found` },
				};
			}
			const existing = doc.forms[formUuid];
			if (!existing) {
				return {
					mutations: [],
					newDoc: doc,
					result: { error: `Form m${moduleIndex}-f${formIndex} not found` },
				};
			}

			// Build the helper's patch shape. The SA's tool arg uses
			// `field` directly — no translation needed since the SA speaks
			// domain vocabulary. `null` clears.
			const patch: Parameters<typeof updateFormMutations>[2] = {};
			if (name !== undefined) patch.name = name;
			if (close_condition !== undefined) {
				patch.closeCondition =
					close_condition === null
						? null
						: {
								field: close_condition.field,
								answer: close_condition.answer,
								...(close_condition.operator && {
									operator: close_condition.operator,
								}),
							};
			}
			if (post_submit !== undefined) {
				patch.postSubmit = post_submit as PostSubmitDestination | null;
			}
			if (connect !== undefined) {
				patch.connect = buildConnectConfig(
					connect,
					existing.connect ?? undefined,
				);
			}

			// Compute the mutations, apply via Immer, and persist through
			// the shared context so both surfaces write the same stream +
			// log + Firestore trio.
			const mutations = updateFormMutations(doc, formUuid, patch);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`form:${moduleIndex}-${formIndex}`,
			);

			const formAfter = newDoc.forms[formUuid];
			if (!formAfter) {
				return {
					mutations,
					newDoc,
					result: {
						error: `Form m${moduleIndex}-f${formIndex} not found after update`,
					},
				};
			}
			const formChanges: string[] = [];
			if (name !== undefined) formChanges.push(`name → "${formAfter.name}"`);
			if (close_condition !== undefined)
				formChanges.push(
					close_condition === null
						? "close_condition removed (unconditional close)"
						: "close_condition updated",
				);
			if (post_submit !== undefined)
				formChanges.push(
					`post_submit → "${formAfter.postSubmit ?? "form-type default"}"`,
				);
			if (connect !== undefined)
				formChanges.push(
					connect === null ? "connect removed" : "connect updated",
				);
			return {
				mutations,
				newDoc,
				result: `Successfully updated form "${formAfter.name}" (${formAfter.type}, m${moduleIndex}-f${formIndex}). Changed: ${formChanges.join(", ")}.`,
			};
		} catch (err) {
			return {
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
