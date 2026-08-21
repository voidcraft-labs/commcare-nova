/**
 * SA tool: `removeModule` — delete a module (with its forms + field
 * subtrees) from the app.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext` interface. The reducer cascades deletion
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
 * Like `removeForm`, the tool tolerates an already-missing module UUID. Rather
 * than returning an error (which would poison the SA's follow-up
 * reasoning), it returns a clear "does not exist, no change" success
 * message. The SA sees the target-already-gone state explicitly and
 * keeps moving rather than assuming the removal just happened.
 *
 * Four exit branches:
 *
 *   - Missing UUID → no mutations, "does not exist, no change" message.
 *   - Retirement blocked → `{ error }` naming the references.
 *   - After-submit links from other modules' forms point into it →
 *     `{ error }` naming each link and the repair
 *     (`lib/doc/formLinkDependents.ts`).
 *   - Success → human-readable "Successfully removed" summary tagged
 *     `module:remove:M`.
 */

import type { z } from "zod";
import { planCaseTypeRetirementOnRemove } from "@/lib/doc/caseTypeRetirement";
import { planFormLinkDependentsOnRemove } from "@/lib/doc/formLinkDependents";
import type { Mutation } from "@/lib/doc/types";
import { removeModuleMutations } from "../blueprintHelpers";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "./shared/entityAddresses";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const removeModuleInputSchema = moduleAddressSchema;

export type RemoveModuleInput = z.infer<typeof removeModuleInputSchema>;

/** Human-readable success string or an error record. */
export type RemoveModuleResult = MutationSuccess | string | { error: string };

export const removeModuleTool = {
	description: "Remove a module from the app.",
	inputSchema: removeModuleInputSchema,
	async execute(
		input: RemoveModuleInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<RemoveModuleResult>> {
		const { moduleUuid: rawModuleUuid } = input;
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveModuleAddress(doc, input);

			// Missing UUID → clear "no change" summary. A
			// "Successfully removed" string on a missing target would
			// poison the SA's follow-up reasoning; it would assume the
			// module is gone and e.g. skip a subsequent recreate step.
			// Reporting the state truthfully keeps the SA's plan
			// synchronized with reality.
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: `Module ${rawModuleUuid} does not exist — no change. App has ${doc.moduleOrder.length} module${doc.moduleOrder.length === 1 ? "" : "s"}.`,
				};
			}
			const { moduleUuid, module } = address;

			// Snapshot the display name off the pre-mutation doc so the
			// summary references the real module even after cascade
			// deletion removes it from `modules`.
			const name = module.name;

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
					result: { error: retirement.message },
				};
			}

			/* After-submit links from forms OUTSIDE this module that point at
			 * it (or at one of its forms) would dangle; the shared planner
			 * refuses naming each link and the repair
			 * (`lib/doc/formLinkDependents.ts`), as the builder's remove flow
			 * does. Links on the module's own forms leave with them. */
			const dependents = planFormLinkDependentsOnRemove(doc, {
				kind: "module",
				moduleUuid,
			});
			if (dependents.kind === "blocked") {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: dependents.message },
				};
			}

			const mutations: Mutation[] = [
				...removeModuleMutations(doc, moduleUuid),
				...(retirement.kind === "retire" ? retirement.mutations : []),
			];
			const commit = await guardedMutate(
				ctx,
				mutations,
				`module:remove:${moduleUuid}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Successfully removed module "${name}". App now has ${newDoc.moduleOrder.length} module${newDoc.moduleOrder.length === 1 ? "" : "s"}.${retirement.kind === "retire" ? ` Case type "${retirement.caseType}" had no other module or reference, so its record was retired from the catalog.` : ""}`,
					// `name` is snapshotted off the pre-mutation doc and can be
					// absent if `moduleOrder`/`modules` ever diverge — omit the
					// subject in that case rather than carrying a null.
					summary: { subject: name } satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
