/**
 * SA tool: `removeModule` — delete a module (with its forms + field
 * subtrees) from the app.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. The reducer cascades deletion
 * to every form under the module and every field under those forms —
 * the entire subtree is dropped atomically.
 *
 * Like `removeForm`, the tool tolerates a missing module index:
 * instead of erroring, it falls through with an informational success
 * message. The SA's loop keeps moving rather than rejecting on a target
 * that's already gone.
 *
 * One exit branch reached by every call:
 *
 *   - Success (or silent no-op on a missing index) → human-readable
 *     summary; stage tagged `module:remove:M` whenever mutations
 *     actually apply.
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
			// Snapshot the display name off the pre-mutation doc so the
			// summary references the real module even after cascade deletion
			// removes it from `modules`.
			const name = moduleUuid ? (doc.modules[moduleUuid]?.name ?? null) : null;

			// Only emit + apply when the module actually exists — mirror the
			// `removeForm` lenient contract. A missing index resolves to
			// `undefined` and we fall through with a success message so the
			// SA's loop keeps moving rather than hard-failing on a stale
			// target.
			let mutations: Mutation[] = [];
			let newDoc = doc;
			if (moduleUuid) {
				mutations = removeModuleMutations(doc, moduleUuid);
				newDoc = applyToDoc(doc, mutations);
				await ctx.recordMutations(
					mutations,
					newDoc,
					`module:remove:${moduleIndex}`,
				);
			}

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
