/**
 * Resource-level case-list authoring: one coherent call can add known fields,
 * add known search inputs, set the available-case filter, compose the search
 * screen through the same root display fields as `setCaseSearchDisplay`, and
 * arrange all three visible sequences. The tool still emits only the existing
 * granular mutations and commits them as one guarded batch.
 */

import { z } from "zod";
import { planSearchTakeawayDependents } from "@/lib/doc/searchNoMatchesDependents";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type CaseSearchConfig,
	findAuthoredBlueprintIdentity,
	isOwnerOnlyCaseSearchConfig,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { predicateSchema } from "@/lib/domain/predicate";
import {
	addColumnsMutation,
	addSearchInputsMutation,
	reorderColumnsMutation,
	reorderSearchInputsMutation,
	updateModuleMutations,
} from "../../blueprintHelpers";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	applyClusterPatch,
	collapseUnauthoredCaseSearchConfig,
	DISPLAY_SLOT_NAMES,
	type DisplaySlotName,
	pickAdvancedCluster,
	pickSearchActionIntent,
	setCaseSearchDisplayBodySchema,
	snapshotCaseSearchConfig,
} from "../case-search-config/shared";
import {
	applyToDoc,
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
	CALCULATED_SEARCH_EXPRESSION_GUIDANCE,
	columnInputSchema,
	newUuid,
	searchInputDefInputSchema,
	stampColumnUuid,
	stampSearchInputUuid,
	uuidInputSchema,
} from "./shared";

const configureSearchDisplaySchema = setCaseSearchDisplayBodySchema.partial();

export const configureCaseListInputSchema = z
	.object({
		...moduleAddressSchema.shape,
		columns: z
			.array(columnInputSchema)
			.min(1)
			.optional()
			.describe(
				`Known columns to add. Their input order is their initial Results and Details order. Supply columnUuid when an order in this call references the new column. ${CALCULATED_SEARCH_EXPRESSION_GUIDANCE}`,
			),
		searchInputs: z
			.array(searchInputDefInputSchema)
			.min(1)
			.optional()
			.describe(
				"Known search inputs to add. Supply searchInputUuid when searchInputOrder in this call references the new input.",
			),
		filter: predicateSchema
			.nullable()
			.optional()
			.describe(
				"Replacement always-on case-list filter. null clears it; omission leaves it unchanged. Ordinary case lists already omit closed cases.",
			),
		...configureSearchDisplaySchema.shape,
		searchFirst: z
			.literal(true)
			.nullable()
			.optional()
			.describe(
				"`true` makes the module open on its Search screen with no browse list (Results exist only after a completed search); `null` returns it to browse-then-search; omission leaves it unchanged. Same rules as setCaseSearchAdvanced.searchFirst.",
			),
		resultsColumnOrder: z
			.array(uuidInputSchema)
			.optional()
			.describe(
				"Complete visible Results-field order after additions, using existing UUIDs and any declared columnUuid values from this call.",
			),
		detailsColumnOrder: z
			.array(uuidInputSchema)
			.optional()
			.describe(
				"Complete visible Details-field order after additions, using existing UUIDs and any declared columnUuid values from this call.",
			),
		searchInputOrder: z
			.array(uuidInputSchema)
			.optional()
			.describe(
				"Complete search-input order after additions, using existing UUIDs and any declared searchInputUuid values from this call.",
			),
	})
	.strict()
	.superRefine((input, ctx) => {
		const displaySlots = displaySlotsPresent(input);
		if (
			displaySlots.length > 0 &&
			displaySlots.length < DISPLAY_SLOT_NAMES.length
		) {
			const missing = DISPLAY_SLOT_NAMES.filter(
				(slot) => !displaySlots.includes(slot),
			);
			ctx.addIssue({
				code: "custom",
				path: [missing[0]],
				message: `The search-screen display is one complete cluster. Provide all four root fields together; use null to clear a slot. Missing: ${missing.join(", ")}.`,
			});
		}
		if (
			input.columns === undefined &&
			input.searchInputs === undefined &&
			!("filter" in input) &&
			displaySlots.length === 0 &&
			input.resultsColumnOrder === undefined &&
			input.detailsColumnOrder === undefined &&
			input.searchInputOrder === undefined
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Configure at least one case-list resource: columns, search inputs, filter, search display, or an order.",
			});
		}
	});

export type ConfigureCaseListInput = z.infer<
	typeof configureCaseListInputSchema
>;

type SearchDisplayInput = z.infer<typeof setCaseSearchDisplayBodySchema>;

function displaySlotsPresent(
	input: Partial<Record<DisplaySlotName, unknown>>,
): DisplaySlotName[] {
	return DISPLAY_SLOT_NAMES.filter((slot) => slot in input);
}

function hasCompleteSearchDisplay(
	input: ConfigureCaseListInput,
): input is ConfigureCaseListInput & SearchDisplayInput {
	return DISPLAY_SLOT_NAMES.every(
		(slot) => slot in input && input[slot] !== undefined,
	);
}

export interface ConfigureCaseListSuccess {
	readonly message: string;
	readonly columnUuids: readonly Uuid[];
	readonly searchInputUuids: readonly Uuid[];
	readonly summary: ToolCallSummary;
}

export type ConfigureCaseListResult =
	| ConfigureCaseListSuccess
	| { readonly error: string };

function displayMutations(mod: Module, input: SearchDisplayInput): Mutation[] {
	const existing = snapshotCaseSearchConfig(mod);
	const displayPatch = applyClusterPatch(input, DISPLAY_SLOT_NAMES);
	const authoredDisplaySetting = Object.keys(displayPatch).length > 0;
	const candidate: CaseSearchConfig = {
		...pickAdvancedCluster(existing),
		...(!authoredDisplaySetting && pickSearchActionIntent(existing)),
		...displayPatch,
	};
	return updateModuleMutations(mod, {
		caseSearchConfig:
			collapseUnauthoredCaseSearchConfig(existing, candidate) ?? null,
	});
}

/** Turn Search first on or off, keeping every other Search setting. */
function searchFirstMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	mod: Module,
	searchFirst: true | null,
): { readonly mutations: Mutation[] } | { readonly error: string } {
	const existing = snapshotCaseSearchConfig(mod);
	if (existing !== undefined && isOwnerOnlyCaseSearchConfig(existing)) {
		if (searchFirst === null) return { mutations: [] };
		return {
			error: `Module "${mod.name}" only limits which cases are available and has no Search action, so it cannot open on Search. Add a search input first, then turn Search first on.`,
		};
	}
	if (searchFirst === null && existing?.searchFirst === true) {
		const dependents = planSearchTakeawayDependents(
			doc,
			moduleUuid,
			"search-first",
		);
		if (dependents.kind === "blocked") return { error: dependents.message };
	}
	const { searchFirst: _current, ...rest } = existing ?? {};
	const candidate: CaseSearchConfig =
		searchFirst === true ? { ...rest, searchFirst: true } : rest;
	return {
		mutations: updateModuleMutations(mod, {
			caseSearchConfig:
				collapseUnauthoredCaseSearchConfig(existing, candidate) ?? null,
		}),
	};
}

export const configureCaseListTool = {
	description:
		"Configure a module's case list as one coherent resource: add known columns and search inputs, set or clear its filter, compose the search screen, and arrange Results, Details, and search-input order. Search display uses the four root fields searchScreenTitle, searchScreenSubtitle, searchButtonLabel, and searchButtonDisplayCondition, matching setCaseSearchDisplay; provide all four together and use null to clear a slot. Omit any other part that should stay unchanged. Returns created UUIDs.",
	inputSchema: configureCaseListInputSchema,
	async execute(
		input: ConfigureCaseListInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<ConfigureCaseListResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: address.error },
				};
			}
			const { moduleUuid, module: originalModule } = address;
			const columnUuids = (input.columns ?? []).map((column) =>
				column.columnUuid === undefined ? newUuid() : asUuid(column.columnUuid),
			);
			const searchInputUuids = (input.searchInputs ?? []).map((searchInput) =>
				searchInput.searchInputUuid === undefined
					? newUuid()
					: asUuid(searchInput.searchInputUuid),
			);
			const createdUuids = [...columnUuids, ...searchInputUuids];
			const collision = createdUuids.find(
				(uuid, index) =>
					createdUuids.indexOf(uuid) !== index ||
					findAuthoredBlueprintIdentity(doc, uuid) !== undefined,
			);
			if (collision !== undefined) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error: `UUID "${collision}" is duplicated in this call or already belongs to an authored object.`,
					},
				};
			}

			const mutations: Mutation[] = [];
			let workingModule = originalModule;
			const append = (next: readonly Mutation[]): void => {
				mutations.push(...next);
				workingModule = applyToDoc(doc, mutations).modules[moduleUuid];
			};

			if (input.columns !== undefined) {
				append(
					addColumnsMutation(
						workingModule,
						input.columns.map((column, index) =>
							stampColumnUuid(column, columnUuids[index]),
						),
					).mutations,
				);
			}
			if (input.searchInputs !== undefined) {
				append(
					addSearchInputsMutation(
						workingModule,
						input.searchInputs.map((searchInput, index) =>
							stampSearchInputUuid(searchInput, searchInputUuids[index]),
						),
					).mutations,
				);
			}
			if ("filter" in input) {
				append([
					{
						kind: "setCaseListMeta",
						uuid: moduleUuid,
						patch: { filter: input.filter ?? null },
					},
				]);
			}
			if (hasCompleteSearchDisplay(input)) {
				append(displayMutations(workingModule, input));
			}
			if (input.searchFirst !== undefined) {
				const searchFirst = searchFirstMutations(
					doc,
					moduleUuid,
					workingModule,
					input.searchFirst,
				);
				if ("error" in searchFirst) {
					return {
						kind: "mutate",
						mutations: [],
						result: { error: searchFirst.error },
					};
				}
				append(searchFirst.mutations);
			}

			for (const [order, surface] of [
				[input.resultsColumnOrder, "list"],
				[input.detailsColumnOrder, "detail"],
			] as const) {
				if (order === undefined) continue;
				const result = reorderColumnsMutation(
					workingModule,
					order.map(asUuid),
					surface,
				);
				if ("error" in result) {
					return {
						kind: "mutate",
						mutations: [],
						result: { error: result.error },
					};
				}
				append(result.mutations);
			}
			if (input.searchInputOrder !== undefined) {
				const result = reorderSearchInputsMutation(
					workingModule,
					input.searchInputOrder.map(asUuid),
				);
				if ("error" in result) {
					return {
						kind: "mutate",
						mutations: [],
						result: { error: result.error },
					};
				}
				append(result.mutations);
			}

			const commit = await guardedMutate(
				ctx,
				mutations,
				`module:${moduleUuid}:caseList:configure`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: commit.error },
				};
			}

			const actions = [
				...(columnUuids.length > 0
					? [
							`added ${columnUuids.length} case-list column${columnUuids.length === 1 ? "" : "s"}`,
						]
					: []),
				...(searchInputUuids.length > 0
					? [
							`added ${searchInputUuids.length} search input${searchInputUuids.length === 1 ? "" : "s"}`,
						]
					: []),
				...("filter" in input
					? [
							input.filter === null
								? "cleared the available-case filter"
								: "set the available-case filter",
						]
					: []),
				...(hasCompleteSearchDisplay(input)
					? ["composed the search screen"]
					: []),
				...(input.resultsColumnOrder !== undefined ? ["arranged Results"] : []),
				...(input.detailsColumnOrder !== undefined ? ["arranged Details"] : []),
				...(input.searchInputOrder !== undefined
					? ["arranged search inputs"]
					: []),
			];
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `Configured the case list for module "${originalModule.name}": ${actions.join(", ")}.`,
					columnUuids,
					searchInputUuids,
					summary: { location: originalModule.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
