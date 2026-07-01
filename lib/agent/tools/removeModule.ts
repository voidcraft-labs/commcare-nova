/**
 * SA tool: `removeModule` — delete a module (with its forms + field
 * subtrees) from the app.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. The reducer cascades deletion
 * to every form under the module and every field under those forms —
 * the entire subtree is dropped atomically.
 *
 * When the module is the last owner of its case-type record, the same
 * batch retires the record — or, when the type is still referenced
 * elsewhere, the call fails naming each reference and the repair
 * (`lib/doc/caseTypeRetirement.ts`, the shared planner the builder UI
 * consults too). Without the cascade, removing a child case type's
 * module would introduce `MISSING_CHILD_CASE_MODULE` with no
 * satisfiable repair in the direction the user is going.
 *
 * Like `removeForm`, the tool tolerates a missing module index. Rather
 * than returning an error (which would poison the SA's follow-up
 * reasoning), it returns a clear "does not exist, no change" success
 * message. The SA sees the target-already-gone state explicitly and
 * keeps moving rather than assuming the removal just happened.
 *
 * Three exit branches:
 *
 *   - Missing index → no mutations, "does not exist, no change" message.
 *   - Retirement blocked → `{ error }` naming the references.
 *   - Success → human-readable "Successfully removed" summary tagged
 *     `module:remove:M`.
 */

import { z } from "zod";
import { planCaseTypeRetirementOnRemove } from "@/lib/doc/caseTypeRetirement";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { removeModuleMutations, resolveModuleUuid } from "../blueprintHelpers";
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

export const removeModuleInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
	})
	.strict();

export type RemoveModuleInput = z.infer<typeof removeModuleInputSchema>;

/** Human-readable success string or an error record. */
export type RemoveModuleResult = MutationSuccess | string | { error: string };

export const removeModuleTool = {
	description: "Remove a module from the app.",
	inputSchema: removeModuleInputSchema,
	async execute(
		input: RemoveModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveModuleResult>> {
		const { moduleIndex } = input;
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);

			// Missing index → clear "no change" summary. A
			// "Successfully removed" string on a missing target would
			// poison the SA's follow-up reasoning; it would assume the
			// module is gone and e.g. skip a subsequent recreate step.
			// Reporting the state truthfully keeps the SA's plan
			// synchronized with reality.
			if (!moduleUuid) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: `Module ${moduleIndex} does not exist — no change. App has ${doc.moduleOrder.length} module${doc.moduleOrder.length === 1 ? "" : "s"}.`,
				};
			}

			// Snapshot the display name off the pre-mutation doc so the
			// summary references the real module even after cascade
			// deletion removes it from `modules`.
			const name = doc.modules[moduleUuid]?.name ?? null;

			/* Case-type retirement: when this module is the last owner of its
			 * case-type record, retire the record in the same batch — or fail
			 * the call naming what still references the type. The cascade is
			 * explicit mutations here at the batch-building layer (never a
			 * reducer side effect — historical event-log replay must reduce
			 * old `removeModule` events to the same docs it always did). */
			const retirement = planCaseTypeRetirementOnRemove(doc, moduleUuid);
			if (retirement.kind === "blocked") {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: retirement.message },
				};
			}

			const mutations: Mutation[] = [
				...removeModuleMutations(doc, moduleUuid),
				...(retirement.kind === "retire" ? retirement.mutations : []),
			];
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`module:remove:${moduleIndex}`,
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

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully removed module "${name ?? `module ${moduleIndex}`}". App now has ${newDoc.moduleOrder.length} module${newDoc.moduleOrder.length === 1 ? "" : "s"}.${retirement.kind === "retire" ? ` Case type "${retirement.caseType}" had no other module or reference, so its record was retired from the catalog.` : ""}`,
					// `name` is snapshotted off the pre-mutation doc and can be
					// absent if `moduleOrder`/`modules` ever diverge — omit the
					// subject in that case rather than carrying a null.
					summary: { subject: name ?? undefined } satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
