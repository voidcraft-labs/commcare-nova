/**
 * SA tool: `removeForm` — delete a form (with its field subtree) from
 * a module.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. The reducer cascades
 * deletion to the form's fields — the full subtree is dropped atomically.
 *
 * The tool tolerates a missing form index: instead of returning an
 * error (which would poison the SA's follow-up logic), it returns a
 * clear "does not exist, no change" success message. The SA sees the
 * target-already-gone state explicitly and keeps moving rather than
 * reasoning as though the removal just happened. This mirrors the
 * `removeModule` contract.
 *
 * Two exit branches:
 *
 *   - Missing index → no mutations, "does not exist, no change" message.
 *   - Success → human-readable "Successfully removed" summary tagged
 *     `form:M-F`.
 */

import { z } from "zod";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { removeFormMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";

export const removeFormInputSchema = formAddressSchema;

export type RemoveFormInput = z.infer<typeof removeFormInputSchema>;

/** Human-readable success string or an error record. */
export type RemoveFormResult = MutationSuccess | string | { error: string };

export const removeFormTool = {
	description: "Remove a form from a module.",
	inputSchema: removeFormInputSchema,
	async execute(
		input: RemoveFormInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveFormResult>> {
		const { moduleUuid: rawModuleUuid, formUuid: rawFormUuid } = input;
		try {
			const address = resolveFormAddress(doc, input);

			// Missing index → return a clear "no change" summary. A
			// "Successfully removed" string on a missing target would
			// poison the SA's follow-up reasoning — it would assume the
			// form was just deleted and e.g. skip a subsequent recreate
			// step. Reporting the state truthfully (target not present,
			// no mutation applied) keeps the SA aligned with reality.
			if (!address.ok) {
				const unresolvedModuleUuid = asUuid(rawModuleUuid);
				const remainingForms = doc.modules[unresolvedModuleUuid]
					? orderedFormUuids(doc, unresolvedModuleUuid)
					: [];
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: `Form ${rawFormUuid} does not exist in module ${rawModuleUuid} — no change. That module has ${remainingForms.length} form${remainingForms.length === 1 ? "" : "s"}.`,
				};
			}
			const { moduleUuid, module: mod, formUuid, form } = address;

			// Snapshot the pre-mutation display name so the summary can
			// reference the real form even after cascade deletion removes
			// it from `forms`.
			const removedName = form.name;

			const mutations: Mutation[] = removeFormMutations(doc, formUuid);
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${formUuid}`,
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

			const remainingForms = orderedFormUuids(newDoc, moduleUuid);
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully removed form "${removedName}" from module "${mod.name}". Module now has ${remainingForms.length} form${remainingForms.length === 1 ? "" : "s"}.`,
					summary: {
						location: mod.name,
						subject: removedName,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
