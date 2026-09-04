/**
 * SA tool: `setCaseSearchAdvanced` — set the advanced cluster of a
 * module's case-search config (today, the rare owner-availability
 * `excludedOwnerIds` slot). The value is global: it may read session/current-
 * user values and Search answers, but never a case property or relationship
 * because it resolves before a case is selected.
 *
 * Every slot is required-and-nullable on the SA boundary: `null` clears,
 * non-null sets. The tool computes a whole editor projection so the display
 * cluster round-trips byte-identically, then `updateModuleMutations` splits
 * it into final fresh-state per-slot writes.
 *
 * Two exit branches: an invalid module UUID returns `{ error }`
 * with no mutations; success returns `{ message, advancedSlotsSet }`
 * with the persisted mutation tagged `module:M:caseSearch:advanced`.
 */

import type { z } from "zod";
import {
	type CaseSearchConfig,
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
	applyClusterPatch,
	collapseUnauthoredCaseSearchConfig,
	pickDisplayCluster,
	setCaseSearchAdvancedBodySchema,
	slotsSetByInput,
	snapshotCaseSearchConfig,
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
 * parsing the prose message; empty array means every advanced slot
 * was cleared.
 */
export interface SetCaseSearchAdvancedSuccess {
	message: string;
	advancedSlotsSet: readonly AdvancedSlotName[];
	summary: ToolCallSummary;
}

export type SetCaseSearchAdvancedResult =
	| SetCaseSearchAdvancedSuccess
	| { error: string };

export const setCaseSearchAdvancedTool = {
	description:
		"Set a module's rare owner-availability rule (excludedOwnerIds). The value can use fixed owner ids, current-user/session values, or Search answers, but not case properties or relationships; null clears it. Search action text lives on setCaseSearchDisplay.",
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

			// Preserve the display cluster, layer the advanced patch on
			// top. Both halves key off the same slot tuples; partition
			// assertions in `shared.ts` catch cluster-home omissions at
			// compile time.
			const existing = snapshotCaseSearchConfig(mod);
			const advancedPatch = applyClusterPatch(input, ADVANCED_SLOT_NAMES);
			const clearingOwnerOnly =
				existing !== undefined &&
				"searchActionEnabled" in existing &&
				advancedPatch.excludedOwnerIds === undefined;
			const addingFirstOwnerRule =
				existing === undefined &&
				(mod.caseListConfig?.searchInputs.length ?? 0) === 0 &&
				advancedPatch.excludedOwnerIds !== undefined;
			const ownerOnlyModule =
				addingFirstOwnerRule ||
				(existing !== undefined && isOwnerOnlyCaseSearchConfig(existing));
			const keepOwnerOnly =
				advancedPatch.excludedOwnerIds !== undefined && ownerOnlyModule;
			// An owner-only module has no Search action to open on, whether the
			// call keeps its owner rule or clears it in the same breath: clearing
			// leaves no config at all, so a `searchFirst` riding along would be
			// dropped while the result still named it as set.
			if (ownerOnlyModule && advancedPatch.searchFirst === true) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Module "${mod.name}" only limits which cases are available and has no Search action, so it cannot open on Search. Add a search input first, then turn Search first on.`,
					},
				};
			}
			const nextExcludedOwnerIds = advancedPatch.excludedOwnerIds;
			const nextConfigCandidate: CaseSearchConfig = keepOwnerOnly
				? {
						searchActionEnabled: false,
						excludedOwnerIds: nextExcludedOwnerIds,
					}
				: {
						...pickDisplayCluster(existing),
						...advancedPatch,
					};
			const nextConfig = clearingOwnerOnly
				? undefined
				: collapseUnauthoredCaseSearchConfig(existing, nextConfigCandidate);

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

			// Derive the message from the same slot tuple. A new entry
			// on `ADVANCED_SLOT_NAMES` flows through verbatim.
			const advancedSlotsSet = slotsSetByInput(input, ADVANCED_SLOT_NAMES);

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message:
						advancedSlotsSet.length === 0
							? `Cleared every case-search advanced slot on module "${mod.name}" (${moduleUuid}).`
							: `Set case-search advanced on module "${mod.name}" (${moduleUuid}): ${advancedSlotsSet.join(", ")}.`,
					advancedSlotsSet,
					summary: { location: mod.name },
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
