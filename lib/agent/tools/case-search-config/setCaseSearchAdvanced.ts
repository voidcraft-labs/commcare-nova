/**
 * SA tool: `setCaseSearchAdvanced` — set the advanced cluster of a
 * module's case-search config: the rare owner-availability
 * `excludedOwnerIds` slot, what the menu opens on (`searchWorkflow`, stored
 * as `workflow` with search first absent), and whether its forms read the
 * search (`formsReadSearch`). The owner value is global: it may read
 * session/current-user values and Search answers, but never a case property
 * or relationship because it resolves before a case is selected.
 *
 * Every slot is required on the SA boundary. `excludedOwnerIds` and
 * `formsReadSearch` are nullable (`null` clears); `searchWorkflow` always
 * names one workflow. The tool computes a whole editor projection so the display
 * cluster round-trips byte-identically, then `updateModuleMutations` splits
 * it into final fresh-state per-slot writes.
 *
 * Two exit branches: an invalid module UUID returns `{ error }`
 * with no mutations; success returns `{ message, advancedSlotsSet }`
 * with the persisted mutation tagged `module:M:caseSearch:advanced`.
 */

import type { z } from "zod";
import { planSearchTakeawayDependents } from "@/lib/doc/searchReadDependents";
import {
	type CaseSearchConfig,
	isOrdinaryCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
} from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
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
import {
	ADVANCED_SLOT_NAMES,
	type AdvancedSlotName,
	collapseUnauthoredCaseSearchConfig,
	pickDisplayCluster,
	setCaseSearchAdvancedBodySchema,
	snapshotCaseSearchConfig,
	storedSearchWorkflow,
} from "./shared";

export const setCaseSearchAdvancedInputSchema = moduleAddressSchema
	.extend(setCaseSearchAdvancedBodySchema.shape)
	.strict();

export type SetCaseSearchAdvancedInput = z.infer<
	typeof setCaseSearchAdvancedInputSchema
>;

/**
 * Success result. `advancedSlotsSet` is the structured discriminator
 * the SA reads to confirm which slots landed non-null without re-
 * parsing the prose message; `searchWorkflow` is always among them.
 */
export interface SetCaseSearchAdvancedSuccess {
	ok: true;
	advancedSlotsSet: readonly AdvancedSlotName[];
	summary: ToolCallSummary;
}

export type SetCaseSearchAdvancedResult =
	| SetCaseSearchAdvancedSuccess
	| { error: string };

export const setCaseSearchAdvancedTool = {
	description:
		"Set the excluded-owner rule, what the menu opens on, and whether its forms read the search. The owner rule can use fixed owners, worker values and Search answers before record selection.",
	inputSchema: setCaseSearchAdvancedInputSchema,
	async execute(
		input: SetCaseSearchAdvancedInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetCaseSearchAdvancedResult>> {
		const doc = ctx.snapshot.doc;
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

			if (
				input.searchWorkflow === "listFirst" &&
				input.formsReadSearch === true
			) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Module "${mod.name}" can't open on its case list while its forms read the search, because the search runs as a form opens only after the worker searched. Choose searchFirst or skipToResults, or set formsReadSearch to null.`,
					},
				};
			}
			// Preserve the display cluster, layer the advanced slots on top.
			// Search first is the stored absence of `workflow`.
			const existing = snapshotCaseSearchConfig(mod);
			const excludedOwnerIds = input.excludedOwnerIds ?? undefined;
			const workflow = storedSearchWorkflow(input.searchWorkflow);
			const formsReadSearch = input.formsReadSearch === true;
			const clearingOwnerOnly =
				existing !== undefined &&
				"searchActionEnabled" in existing &&
				excludedOwnerIds === undefined;
			const addingFirstOwnerRule =
				existing === undefined &&
				(mod.caseListConfig?.searchInputs.length ?? 0) === 0 &&
				excludedOwnerIds !== undefined;
			const ownerOnlyModule =
				addingFirstOwnerRule ||
				(existing !== undefined && isOwnerOnlyCaseSearchConfig(existing));
			const keepOwnerOnly = excludedOwnerIds !== undefined && ownerOnlyModule;
			// An owner-only module has no Search action to open on, whether the
			// call keeps its owner rule or clears it in the same breath: clearing
			// leaves no config at all, so a workflow or formsReadSearch riding
			// along would be dropped while the result still named it as set.
			if (ownerOnlyModule && (workflow !== undefined || formsReadSearch)) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Module "${mod.name}" only limits which cases are available and has no Search action, so there is no search for it to open on or for its forms to read. Add a search input first, then choose what the menu opens on.`,
					},
				};
			}
			const nextConfigCandidate: CaseSearchConfig =
				keepOwnerOnly && excludedOwnerIds !== undefined
					? { searchActionEnabled: false, excludedOwnerIds }
					: {
							...pickDisplayCluster(existing),
							...(excludedOwnerIds !== undefined && { excludedOwnerIds }),
							...(workflow !== undefined && { workflow }),
							...(formsReadSearch && { formsReadSearch: true as const }),
						};
			const nextConfig = clearingOwnerOnly
				? undefined
				: collapseUnauthoredCaseSearchConfig(existing, nextConfigCandidate);

			/* A case list registration form needs the menu's forms to keep
			 * reading the search; the shared planner refuses and names the form
			 * (`searchReadDependents.ts`). */
			const formsRead = (config: CaseSearchConfig | undefined): boolean =>
				isOrdinaryCaseSearchConfig(config) && config.formsReadSearch === true;
			if (formsRead(existing) && !formsRead(nextConfig)) {
				const dependents = planSearchTakeawayDependents(
					doc,
					moduleUuid,
					nextConfig === undefined ? "search" : "forms-read-search",
				);
				if (dependents.kind === "blocked") {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: { error: dependents.message },
					};
				}
			}

			const mutations = updateModuleMutations(mod, {
				caseSearchConfig: nextConfig ?? null,
			});
			const commit = await guardedMutate(
				ctx,
				mutations,
				`module:${moduleUuid}:caseSearch:advanced`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}

			// Every slot the call stated with a value; `searchWorkflow` is
			// always stated.
			const advancedSlotsSet = ADVANCED_SLOT_NAMES.filter(
				(slot) => input[slot] !== null,
			);

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true,
					advancedSlotsSet,
					summary: { location: mod.name },
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
