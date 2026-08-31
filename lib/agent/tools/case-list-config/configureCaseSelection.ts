import type { z } from "zod";
import { planCaseSelectionChange } from "@/lib/doc/caseSelectionMutations";
import { type CaseSelection, caseSelectionSchema } from "@/lib/domain";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "../shared/entityAddresses";
import type { ToolCallSummary } from "../shared/toolCallSummary";

export const configureCaseSelectionInputSchema = moduleAddressSchema
	.extend({
		selection: caseSelectionSchema
			.nullable()
			.describe(
				'How workers choose cases from Results. Pass `{ kind: "multiple", maximum: N }` to let them choose a bounded set before continuing, where N is an integer from 1 through 100. Pass null to return to opening one case at a time.',
			),
	})
	.strict();

export type ConfigureCaseSelectionInput = z.infer<
	typeof configureCaseSelectionInputSchema
>;

export interface ConfigureCaseSelectionSuccess {
	readonly message: string;
	readonly selection: CaseSelection | null;
	readonly clearedPersistentTile: boolean;
	readonly summary: ToolCallSummary;
}

export type ConfigureCaseSelectionResult =
	| ConfigureCaseSelectionSuccess
	| { readonly error: string };

export const configureCaseSelectionTool = {
	description:
		"Choose whether a module opens one case at a time or lets workers select a bounded set of cases before continuing. Multiple selection accepts an integer maximum from 1 through 100. null returns to one-case selection. If a case tile was configured to stay above forms, enabling multiple selection removes only that incompatible presentation setting and keeps the tile layout and grouping.",
	inputSchema: configureCaseSelectionInputSchema,
	async execute(
		input: ConfigureCaseSelectionInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<ConfigureCaseSelectionResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) return errorResult(address.error);
			const { moduleUuid, module: mod } = address;
			const selection = input.selection ?? undefined;
			const plan = planCaseSelectionChange(mod, selection);
			if (!plan.ok) {
				return errorResult(
					`Tried to change case selection on module "${mod.name}" (${moduleUuid}), but that module has no case list. Add its Results fields first, then choose how workers select cases.`,
				);
			}

			const commit =
				plan.mutations.length === 0
					? { ok: true as const, mutations: plan.mutations }
					: await guardedMutate(
							ctx,
							plan.mutations,
							`module:${moduleUuid}:caseList:selection`,
						);
			if (!commit.ok) return errorResult(commit.error);

			const selectionMessage =
				selection === undefined
					? `Set module "${mod.name}" (${moduleUuid}) to open one selected case at a time.`
					: `Set module "${mod.name}" (${moduleUuid}) to let workers select up to ${selection.maximum} ${selection.maximum === 1 ? "case" : "cases"} before continuing.`;
			const tileMessage = plan.clearsPersistentTile
				? " The case tile will no longer stay above forms because that view requires one selected case. Its Results layout and grouping are unchanged."
				: "";

			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `${selectionMessage}${tileMessage}`,
					selection: input.selection,
					clearedPersistentTile: plan.clearsPersistentTile,
					summary: { location: mod.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

function errorResult(
	error: string,
): MutatingToolResult<ConfigureCaseSelectionResult> {
	return { kind: "mutate", mutations: [], result: { error } };
}
