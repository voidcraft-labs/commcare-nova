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
 * Omission keeps, null clears: a slot left out keeps its current value;
 * an explicit `null` clears it (unconditional close again, post-submit
 * back to the form-type default, Connect block removed). `name` is not
 * nullable — a form always has a name. Connect-config patches go through
 * `buildConnectConfig`, a structural partial-update merge that applies
 * the same law per sub-config: a supplied sub-config merges with its
 * existing counterpart, a null one is REMOVED, an omitted one passes
 * through unchanged — and a patch that removes the last sub-config
 * collapses to whole-block removal (an empty block means nothing).
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
import type { BlueprintDoc, PostSubmitDestination } from "@/lib/domain";
import { USER_FACING_DESTINATIONS } from "@/lib/domain";
import {
	resolveFormUuid,
	resolveModuleUuid,
	updateFormMutations,
} from "../blueprintHelpers";
import {
	closeConditionInputSchema,
	connectFormPatchSchema,
} from "../planningSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import { collectConnectIds, enforceConnectIds } from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
import { resolveCloseCondition } from "./shared/fieldAssembly";
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
			.optional()
			.describe("New form name. Leave it out to keep the current name."),
		close_condition: closeConditionInputSchema
			.nullable()
			.optional()
			.describe(
				'Close forms only. Set conditional close; use operator "selected" for multi-select fields. Pass null to make the close unconditional again; leave it out to keep the current condition.',
			),
		post_submit: z
			.enum(USER_FACING_DESTINATIONS)
			.nullable()
			.optional()
			.describe(
				'Post-submit destination: "app_home", "module" (its form list), or "previous". null resets to the form-type default.',
			),
		connect: connectFormPatchSchema
			.nullable()
			.optional()
			.describe(
				"Connect participation patch: omitted sub-configs keep their current value, null on a sub-config removes just it, a stated one replaces it (learn apps: learn_module/assessment; deliver apps: deliver_unit/task). null for the whole slot removes the block (rejected only on the app's last participating form).",
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
			// domain vocabulary. Omitted = leave unchanged; `null` = clear
			// (a `null` patch entry — the reducer deletes the key).
			const patch: Parameters<typeof updateFormMutations>[2] = {};
			if (name !== undefined) patch.name = name;
			if (close_condition === null) patch.closeCondition = null;
			// The SA names the checked field by id; the stored form is the
			// field's stable uuid. An id nothing answers to stays verbatim
			// — the gate rejects the introduction with the validator's
			// close-condition finding. One resolver shared with the
			// creation tools (`fieldAssembly.ts::resolveCloseCondition`);
			// a null/omitted condition resolves to undefined and patches
			// nothing here (the null-clears arm above already ran).
			const resolvedClose = resolveCloseCondition(
				(ref) => resolveCloseFieldRef(doc, formUuid, ref),
				close_condition,
			);
			if (resolvedClose) patch.closeCondition = resolvedClose;
			if (post_submit === null) patch.postSubmit = null;
			if (post_submit != null) {
				patch.postSubmit = post_submit as PostSubmitDestination;
			}
			if (connect === null) patch.connect = null;
			if (connect != null) {
				// Structural partial-update merge + the text → AST parse
				// boundary for the connect XPath slots, resolved against
				// the owning form (`shared/connectInput.ts`). Per
				// sub-config: omitted keeps the existing one, an explicit
				// null REMOVES it, a stated one replaces it.
				const merged = buildConnectConfig(
					connect,
					existing.connect ?? undefined,
					(text) => parseXPathForForm(doc, formUuid, text),
				);
				if (
					!merged.learn_module &&
					!merged.assessment &&
					!merged.deliver_unit &&
					!merged.task
				) {
					// The patch removed the last sub-config. An empty block
					// means nothing on the doc, so the patch collapses to
					// whole-block removal — the same write as
					// `connect: null`.
					patch.connect = null;
				} else {
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
			}

			// Compute the mutations, apply via Immer, and persist through
			// the shared context so both surfaces write the same stream +
			// log + Postgres trio.
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
			if (name !== undefined) formChanges.push(`name → "${formAfter.name}"`);
			if (close_condition === null)
				formChanges.push("close_condition removed (unconditional close)");
			if (close_condition != null) formChanges.push("close_condition updated");
			if (post_submit !== undefined)
				formChanges.push(
					`post_submit → "${formAfter.postSubmit ?? "form-type default"}"`,
				);
			// A partial patch can itself collapse to removal (last sub-config
			// cleared), so the phrase keys off what was WRITTEN, not the
			// input shape.
			if (connect !== undefined)
				formChanges.push(
					patch.connect === null ? "connect removed" : "connect updated",
				);
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
