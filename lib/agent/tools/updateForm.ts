import {
	parseXPathForForm,
	resolveCloseFieldRef,
} from "@/lib/doc/expressionText";
/**
 * SA tool: `updateForm` — patch form-level metadata.
 *
 * Covers the four form-scoped edits the SA exposes: display name,
 * close condition (close forms only), Connect integration, and
 * post-submit navigation. Both the SA chat factory and the MCP adapter
 * call this through the shared `ToolExecutionContext` interface.
 *
 * Every key is nullable, and `null` means "leave unchanged" — the wire
 * forces every key present on a tool call, so null is the model's only
 * way to not touch a slot; treating it as a clear would strip the close
 * condition, the post-submit override, and the Connect block off every
 * unrelated rename. Clears are EXPLICIT via the `clear` list. Connect-
 * config patches go through `buildConnectConfig`, a structural
 * partial-update merge: each sub-config the SA supplied (non-null) is
 * merged with the matching existing sub-config; the others pass through
 * unchanged.
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
import type { BlueprintDoc, PostSubmitDestination } from "@/lib/domain";
import { asUuid, USER_FACING_DESTINATIONS } from "@/lib/domain";
import {
	resolveFormUuid,
	resolveModuleUuid,
	updateFormMutations,
} from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import { collectConnectIds, enforceConnectIds } from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const updateFormInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		name: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe("New form name. null keeps the current name."),
		close_condition: z
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
			.strict()
			.nullable()
			.optional()
			.describe(
				'Close forms only. Set conditional close; use operator "selected" for multi-select fields. null leaves the current condition unchanged — to make the close unconditional again, list "close_condition" in `clear`.',
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
					'null leaves the current setting unchanged — to reset to the default, list "post_submit" in `clear`.',
			),
		connect: z
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
					.nullable()
					.optional()
					.describe(
						"Set for forms with educational/training content. null on quiz-only forms.",
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
						"Set for forms with a quiz/test. null on content-only forms.",
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
								"XPath that resolves to the dedup key Connect uses to group form submissions into one logical delivery (one CompletedWork). Connect deduplicates per `(FLW, entity_id, payment_unit)`: two visits with the same entity_id from the same FLW in the same payment unit collapse into one CompletedWork; a different entity_id (or a different payment unit) produces a separate one. " +
									"Omit to fall back to `concat(#user/username, '-', today())` — one CompletedWork per FLW per day, the right default when the unit of payment is the FLW's daily aggregate. " +
									"Override when one paid delivery corresponds to a specific beneficiary, case, or site rather than a daily aggregate. The expression must produce the same value across all forms in the same payment unit for the same delivery target — that's how Connect links a multi-form payment unit (e.g. registration + followup + close) into one CompletedWork. Examples: `#<case_type>/case_id` for case-tracking deliveries, `#form/beneficiary_id` for forms that capture the beneficiary identifier directly, `concat(#<case_type>/household_id, '-', #form/visit_date)` when one paid delivery is one household visit on one date.",
							),
						entity_name: z
							.string()
							.min(1)
							.nullable()
							.optional()
							.describe(
								"XPath that resolves to a human-readable label Connect shows in dashboards for this delivery. Display-only; doesn't affect dedup or payment. " +
									"Omit to fall back to `#user/username` — the FLW's username, fine when no more meaningful identifier is available. " +
									"Override to surface a more useful label: a beneficiary name (`#<case_type>/case_name`), a location label, or any human-readable identifier captured in the form.",
							),
					})
					.strict()
					.nullable()
					.optional()
					.describe(
						"Set on a deliver-app form that counts as a payable delivery. `name` is what shows up in the deliver-unit picker on Connect. `entity_id` and `entity_name` are wire-format defaults that work for daily-aggregate workflows; override only when the workflow demands a different dedup key or a more useful display label.",
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
					.optional(),
			})
			.strict()
			.nullable()
			.optional()
			.describe(
				'Set Connect config on this form — a block opts the form into Connect. null leaves the current config unchanged; to remove the block (the form stops participating; rejected only when it is the app\'s last participating form), list "connect" in `clear`. Learn apps: set learn_module and/or assessment independently. Deliver apps: set deliver_unit and/or task independently.',
			),
		clear: z
			.array(z.enum(["close_condition", "post_submit", "connect"]))
			.nullable()
			.optional()
			.describe(
				'Form settings to REMOVE: drop the close condition (unconditional close), reset post_submit to its form-type default, or remove the Connect block. This is the only way to clear — null in the slots above means "leave unchanged". Pass null when nothing is being removed.',
			),
	})
	.strict();

export type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateFormResult = MutationSuccess | { error: string };

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
			clear,
		} = input;
		const clearRequested = new Set(clear ?? []);
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
			// domain vocabulary. `null` = leave unchanged; clears come from
			// the explicit `clear` list (a slot both set and cleared is a
			// contradiction, rejected before anything stages).
			const setAndCleared = [
				close_condition != null && clearRequested.has("close_condition")
					? "close_condition"
					: null,
				post_submit != null && clearRequested.has("post_submit")
					? "post_submit"
					: null,
				connect != null && clearRequested.has("connect") ? "connect" : null,
			].filter((c): c is string => c !== null);
			if (setAndCleared.length > 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `${setAndCleared.map((c) => `"${c}"`).join(", ")} ${setAndCleared.length === 1 ? "is" : "are"} both set and listed in \`clear\` — pick one: a new value, or the clear.`,
					},
				};
			}
			const patch: Parameters<typeof updateFormMutations>[2] = {};
			if (name != null) patch.name = name;
			if (clearRequested.has("close_condition")) patch.closeCondition = null;
			if (close_condition != null) {
				// The SA names the checked field by id; the stored form is the
				// field's stable uuid. An id nothing answers to stays verbatim
				// — the gate rejects the introduction with the validator's
				// close-condition finding.
				patch.closeCondition = {
					field: asUuid(
						resolveCloseFieldRef(doc, formUuid, close_condition.field),
					),
					answer: close_condition.answer,
					...(close_condition.operator && {
						operator: close_condition.operator,
					}),
				};
			}
			if (clearRequested.has("post_submit")) patch.postSubmit = null;
			if (post_submit != null) {
				patch.postSubmit = post_submit as PostSubmitDestination;
			}
			if (clearRequested.has("connect")) patch.connect = null;
			if (connect != null) {
				// Structural partial-update merge + the text → AST parse
				// boundary for the connect XPath slots, resolved against
				// the owning form (`shared/connectInput.ts`). Null
				// sub-configs / inner slots mean "not supplied" — the
				// merge itself drops them.
				const merged = buildConnectConfig(
					connect,
					existing.connect ?? undefined,
					(text) => parseXPathForForm(doc, formUuid, text),
				);
				// Force connect ids correct at the source: autofill omitted
				// ids, reject explicit-invalid ids (fail the call, write
				// nothing). `existingIds` excludes this form's own ids so a
				// re-patch of an unchanged id doesn't read as a self-conflict.
				const moduleUuid = resolveModuleUuid(doc, moduleIndex);
				const moduleName = moduleUuid
					? (doc.modules[moduleUuid]?.name ?? "module")
					: "module";
				const enforced = enforceConnectIds(
					merged,
					moduleName,
					existing.name,
					collectConnectIds(doc, formUuid),
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

			// Compute the mutations, apply via Immer, and persist through
			// the shared context so both surfaces write the same stream +
			// log + Firestore trio.
			const mutations = updateFormMutations(doc, formUuid, patch);
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${moduleIndex}-${formIndex}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

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
			if (name != null) formChanges.push(`name → "${formAfter.name}"`);
			if (clearRequested.has("close_condition"))
				formChanges.push("close_condition removed (unconditional close)");
			if (close_condition != null) formChanges.push("close_condition updated");
			if (clearRequested.has("post_submit") || post_submit != null)
				formChanges.push(
					`post_submit → "${formAfter.postSubmit ?? "form-type default"}"`,
				);
			if (clearRequested.has("connect")) formChanges.push("connect removed");
			if (connect != null) formChanges.push("connect updated");
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully updated form "${formAfter.name}" (${formAfter.type}, m${moduleIndex}-f${formIndex}). Changed: ${formChanges.join(", ")}.`,
					summary: {
						location: (() => {
							const mu = resolveModuleUuid(doc, moduleIndex);
							return mu ? doc.modules[mu]?.name : undefined;
						})(),
						subject: formAfter.name,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
