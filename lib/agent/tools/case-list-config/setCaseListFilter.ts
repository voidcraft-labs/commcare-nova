import { z } from "zod";
import { enableCaseSearchMutation } from "@/lib/doc/caseSearchConfigMutations";
import type { Mutation } from "@/lib/doc/types";
import { conditionSchema, type Expression } from "@/lib/domain/expression";
import { effectiveCaseSearchConfig } from "@/lib/domain/modules";
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

export const setCaseListFilterInputSchema = moduleAddressSchema
	.extend({
		surface: z
			.enum(["list", "search", "both"])
			.optional()
			.describe(
				"Change the device list, the online search, or both. Omitting this sets both.",
			),
		filter: conditionSchema
			.nullable()
			.describe(
				"Replacement Predicate, or null to clear the filter and show every case of the module's type.",
			),
	})
	.strict();

export type SetCaseListFilterInput = z.infer<
	typeof setCaseListFilterInputSchema
>;

/**
 * Discriminator returned in the structured success arm. On a set call
 * it's the supplied predicate's `kind` (`"eq"`, `"and"`, `"match-all"`,
 * etc., narrowed by `Expression["kind"]`); on a null-clears call it's
 * the literal `"cleared"`. Surfaces the outcome to the SA + any TS
 * consumer without parsing prose, with full discriminated narrowing
 * preserved.
 */
export type SetCaseListFilterKind = Expression["kind"] | "cleared";

/**
 * Success result. `kind` carries the predicate's discriminator on a
 * set call, or the literal `"cleared"` on the null-clears path — the
 * SA reads it without reparsing the message string, mirroring the
 * structured `result.uuid` shape on the atomic-op tools.
 */
export interface SetCaseListFilterSuccess {
	ok: true;
	kind: SetCaseListFilterKind;
	summary: ToolCallSummary;
}

export type SetCaseListFilterResult =
	| SetCaseListFilterSuccess
	| { error: string };

export const setCaseListFilterTool = {
	description:
		"Choose which records can appear on the device list or match the online search. Set the surface to change just one. Null includes all records.",
	inputSchema: setCaseListFilterInputSchema,
	async execute(
		input: SetCaseListFilterInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetCaseListFilterResult>> {
		const doc = ctx.snapshot.doc;
		const { filter } = input;
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: address.error },
				};
			}
			const { moduleUuid, module: mod } = address;

			// The filter rides the GRANULAR `setCaseListMeta` kind (not a
			// wholesale `updateModule{caseListConfig}` that would clobber a
			// concurrent column edit on the guarded re-apply): `null` clears the
			// slot, an Expression sets it. The reducer maps `null → delete`, so a
			// clear crosses the JSON wire intact.
			// A menu with no search has one condition: a list edit there is the
			// combined edit, so no search condition is ever stored beside it
			// (absence projects the list's condition once search is turned on).
			const hasSearch = effectiveCaseSearchConfig(mod) !== undefined;
			const mutations: Mutation[] = [
				{
					kind: "setCaseListMeta",
					uuid: mod.uuid,
					patch:
						input.surface === "list" && hasSearch
							? { listCondition: filter }
							: input.surface === "search"
								? { searchCondition: filter }
								: { filter },
				},
			];
			if (input.surface === "search" && filter !== null && !hasSearch)
				mutations.unshift(
					enableCaseSearchMutation(mod.uuid, mod.caseSearchConfig),
				);
			// Cases available and Search intent are independent. An empty
			// caseSearchConfig is an intentional zero-input manual action, not a
			// synthetic by-product of this filter, so clearing the filter must leave
			// that action in place.
			const commit = await guardedMutate(
				ctx,
				mutations,
				`module:${moduleUuid}:filter`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result:
					filter === null
						? {
								ok: true,
								kind: "cleared",
								summary: { location: mod.name },
							}
						: {
								ok: true,
								kind: filter.kind,
								summary: { location: mod.name },
							},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
