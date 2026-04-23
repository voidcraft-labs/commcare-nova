/**
 * SA tool: `removeModule` — delete a module (with its forms + field
 * subtrees) from the app.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. The reducer cascades deletion
 * to every form under the module and every field under those forms —
 * the entire subtree is dropped atomically.
 *
 * Like `removeForm`, the tool tolerates a missing module index. Rather
 * than returning an error (which would poison the SA's follow-up
 * reasoning), it returns a clear "does not exist, no change" success
 * message. The SA sees the target-already-gone state explicitly and
 * keeps moving rather than assuming the removal just happened.
 *
 * Two exit branches:
 *
 *   - Missing index → no mutations, "does not exist, no change" message.
 *   - Success → human-readable "Successfully removed" summary tagged
 *     `module:remove:M`.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { removeModuleMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const removeModuleInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
});

export type RemoveModuleInput = z.infer<typeof removeModuleInputSchema>;

/** Human-readable success string or an error record. */
export type RemoveModuleResult = string | { error: string };

export const removeModuleTool = {
	name: "removeModule" as const,
	description: "Remove a module from the app.",
	inputSchema: removeModuleInputSchema,
	async execute(
		input: RemoveModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveModuleResult>> {
		const { moduleIndex } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];

			// Missing index → clear "no change" summary. A
			// "Successfully removed" string on a missing target would
			// poison the SA's follow-up reasoning; it would assume the
			// module is gone and e.g. skip a subsequent recreate step.
			// Reporting the state truthfully keeps the SA's plan
			// synchronized with reality.
			if (!moduleUuid) {
				return {
					mutations: [],
					newDoc: doc,
					result: `Module ${moduleIndex} does not exist — no change. App has ${doc.moduleOrder.length} module${doc.moduleOrder.length === 1 ? "" : "s"}.`,
				};
			}

			// Snapshot the display name off the pre-mutation doc so the
			// summary references the real module even after cascade
			// deletion removes it from `modules`.
			const name = doc.modules[moduleUuid]?.name ?? null;

			const mutations: Mutation[] = removeModuleMutations(doc, moduleUuid);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:remove:${moduleIndex}`,
			);

			return {
				mutations,
				newDoc,
				result: `Successfully removed module "${name ?? `module ${moduleIndex}`}". App now has ${newDoc.moduleOrder.length} module${newDoc.moduleOrder.length === 1 ? "" : "s"}.`,
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
