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
 * `null` → clear, a value → set. Connect-config patches go through
 * `buildConnectConfig`, a structural partial-update merge: each
 * sub-config the SA explicitly supplied is merged with the matching
 * existing sub-config; the others pass through unchanged.
 *
 * The merged connect config then runs through `enforceConnectIds` (the
 * agent-path source guard): an omitted connect id is autofilled with a
 * valid, unique, name-derived id (the doc carries it from then on), and an
 * explicitly-supplied invalid or duplicate id fails the call. Other
 * defaults are NOT invented here — `deliver_unit` may still land without
 * `entity_id`/`entity_name`, and the wire-emit layer supplies those XPath
 * fallbacks at bind time.
 *
 * Four exit branches:
 *
 *   1. Form index out of range → `{ error }`, no mutations.
 *   2. An explicit connect id is invalid/duplicate → `{ error }`, no
 *      mutations (nothing written).
 *   3. Form disappeared after the patch (reducer-level rejection) →
 *      `{ error }`, mutations may have already been persisted.
 *   4. Success → human-readable summary listing the changed keys,
 *      tagged `form:M-F`.
 */

import { z } from "zod";
import { CONNECT_ID_FIELD_DESCRIPTION } from "@/lib/commcare/connectSlugs";
import type {
	BlueprintDoc,
	ConnectConfig,
	PostSubmitDestination,
} from "@/lib/domain";
import { USER_FACING_DESTINATIONS } from "@/lib/domain";
import { resolveFormUuid, updateFormMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";
import {
	collectConnectIdsExcept,
	enforceConnectIds,
} from "./shared/connectIds";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const updateFormInputSchema = z
	.object({
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
			.strict()
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
						id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
						name: z.string(),
						description: z.string(),
						// Match the domain's `connectLearnModuleSchema`:
						// positive integer minutes. The reducer doesn't
						// re-parse patches via Zod, so the SA-facing schema
						// is the only gate against invalid values.
						time_estimate: z
							.number()
							.refine(
								(n) => Number.isInteger(n) && n >= 1,
								"time_estimate must be a positive integer (minutes).",
							),
					})
					.strict()
					.optional()
					.describe(
						"Set for forms with educational/training content. Omit for quiz-only forms.",
					),
				assessment: z
					.object({
						id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
						user_score: z.string(),
					})
					.strict()
					.optional()
					.describe(
						"Set for forms with a quiz/test. Omit for content-only forms.",
					),
				deliver_unit: z
					.object({
						id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
						name: z.string(),
						entity_id: z
							.string()
							.optional()
							.describe(
								"XPath that resolves to the dedup key Connect uses to group form submissions into one logical delivery (one CompletedWork). Connect deduplicates per `(FLW, entity_id, payment_unit)`: two visits with the same entity_id from the same FLW in the same payment unit collapse into one CompletedWork; a different entity_id (or a different payment unit) produces a separate one. " +
									"Omit to fall back to `concat(#user/username, '-', today())` — one CompletedWork per FLW per day, the right default when the unit of payment is the FLW's daily aggregate. " +
									"Override when one paid delivery corresponds to a specific beneficiary, case, or site rather than a daily aggregate. The expression must produce the same value across all forms in the same payment unit for the same delivery target — that's how Connect links a multi-form payment unit (e.g. registration + followup + close) into one CompletedWork. Examples: `#case/case_id` for case-tracking deliveries, `#form/beneficiary_id` for forms that capture the beneficiary identifier directly, `concat(#case/household_id, '-', #form/visit_date)` when one paid delivery is one household visit on one date.",
							),
						entity_name: z
							.string()
							.optional()
							.describe(
								"XPath that resolves to a human-readable label Connect shows in dashboards for this delivery. Display-only; doesn't affect dedup or payment. " +
									"Omit to fall back to `#user/username` — the FLW's username, fine when no more meaningful identifier is available. " +
									"Override to surface a more useful label: a beneficiary name (`#case/case_name`), a location label, or any human-readable identifier captured in the form.",
							),
					})
					.strict()
					.optional()
					.describe(
						"Set for forms in a Connect deliver app. `name` is what shows up in the deliver-unit picker on Connect. `entity_id` and `entity_name` are wire-format defaults that work for daily-aggregate workflows; override only when the workflow demands a different dedup key or a more useful display label.",
					),
				task: z
					.object({
						id: z.string().optional().describe(CONNECT_ID_FIELD_DESCRIPTION),
						name: z.string(),
						description: z.string(),
					})
					.strict()
					.optional(),
			})
			.strict()
			.nullable()
			.optional()
			.describe(
				"Set Connect config on this form. null to remove. Learn apps: set learn_module and/or assessment independently. Deliver apps: set deliver_unit and/or task independently.",
			),
	})
	.strict();

export type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateFormResult = MutationSuccess | { error: string };

/**
 * Merge the SA's partial connect-config input into a full
 * `ConnectConfig`. Pure structural merge: keys absent from `input` are
 * copied verbatim from `existing`. Keys present on `input` overlay the
 * matching existing sub-config (`existing.learn_module` ←
 * `input.learn_module`, etc.). Returns `null` only when the SA's input
 * is explicitly `null` — the caller uses that as the "clear Connect
 * config" signal.
 *
 * No defaults are invented here. `deliver_unit` may land without
 * `entity_id`/`entity_name` — that's a normal state of the domain
 * type, and the XForm builder substitutes the canonical XPath defaults
 * when emitting the binds.
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
		out.deliver_unit = { ...existing?.deliver_unit, ...input.deliver_unit };
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
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Form m${moduleIndex}-f${formIndex} not found` },
				};
			}
			const existing = doc.forms[formUuid];
			if (!existing) {
				return {
					kind: "mutate" as const,
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
				const merged = buildConnectConfig(
					connect,
					existing.connect ?? undefined,
				);
				if (merged === null) {
					patch.connect = null;
				} else {
					// Force connect ids correct at the source: autofill omitted
					// ids, reject explicit-invalid ids (fail the call, write
					// nothing). `existingIds` excludes this form's own ids so a
					// re-patch of an unchanged id doesn't read as a self-conflict.
					const moduleUuid = doc.moduleOrder[moduleIndex];
					const moduleName = moduleUuid
						? (doc.modules[moduleUuid]?.name ?? "module")
						: "module";
					const enforced = enforceConnectIds(
						merged,
						moduleName,
						existing.name,
						collectConnectIdsExcept(doc, formUuid),
					);
					if (!enforced.ok) {
						return {
							kind: "mutate" as const,
							mutations: [],
							newDoc: doc,
							result: { error: enforced.error },
						};
					}
					patch.connect = enforced.config;
				}
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
					kind: "mutate" as const,
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
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully updated form "${formAfter.name}" (${formAfter.type}, m${moduleIndex}-f${formIndex}). Changed: ${formChanges.join(", ")}.`,
					summary: {
						location: doc.modules[doc.moduleOrder[moduleIndex]]?.name,
						subject: formAfter.name,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return {
				kind: "mutate" as const,
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
