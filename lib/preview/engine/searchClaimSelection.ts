import "server-only";

import { z } from "zod";
import type { SearchClaimSelection } from "@/lib/case-store/store";
import {
	caseSelectionMaximum,
	effectiveCaseSearchConfig,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { previewMenuCaseContext } from "../menuProjection";
import { runningCaseSelectionQuery } from "./caseDataBindingHelpers";
import { searchInputAnswerKeys } from "./searchRunState";
import { type ServerSearchWorld, serverRecordsRead } from "./serverSearchRead";

const recordIds = z
	.array(z.string().min(1).max(255))
	.min(1)
	.max(100)
	.refine((ids) => new Set(ids).size === ids.length);
const workerAnswers = z.array(
	z.strictObject({ name: z.string().min(1), value: z.string() }),
);
export const searchClaimSourceSchema = z.strictObject({
	moduleUuid: uuidSchema,
	caseIds: recordIds,
	answers: workerAnswers,
	defaultSearch: z.literal(true).optional(),
});
export type SearchClaimSource = z.infer<typeof searchClaimSourceSchema>;
export const claimPriorSelectionsSchema = z.array(
	searchClaimSourceSchema.extend({
		answers: workerAnswers.optional(),
	}),
);
export type ClaimPriorSelection = z.infer<
	typeof claimPriorSelectionsSchema
>[number];

export class SearchChoiceUnavailable extends Error {
	constructor() {
		super(
			"These records are no longer available from this search. Search again to choose the records to open.",
		);
	}
}

/** The browser supplies only what a worker could type. The committed entry,
 * hidden values, result limit, and restore all come from the authorized world. */
async function selectionMembership(
	world: ServerSearchWorld,
	source: ClaimPriorSelection,
	prior: boolean,
): Promise<SearchClaimSelection> {
	const mod = world.doc.modules[source.moduleUuid];
	if (!mod?.caseType || source.caseIds.length > caseSelectionMaximum(mod))
		throw new SearchChoiceUnavailable();
	const searching = source.answers !== undefined;
	if (searching && !effectiveCaseSearchConfig(mod))
		throw new SearchChoiceUnavailable();
	const keys = searchInputAnswerKeys(mod.caseListConfig?.searchInputs ?? []);
	const answers = source.defaultSearch
		? undefined
		: source.answers?.filter((input) => keys.has(input.name));
	const prepared = await serverRecordsRead(
		world,
		{ moduleUuid: source.moduleUuid, answers },
		() => new SearchChoiceUnavailable(),
	);
	if (
		!prepared.read ||
		prepared.refusal ||
		searching !== prepared.searched ||
		(source.defaultSearch === true && !prepared.search.defaultSearch) ||
		(searching &&
			(!prepared.search.hasSubmitted ||
				!prepared.read.searchPopulation?.request)) ||
		(!searching && !prepared.read.restoreScope)
	)
		throw new SearchChoiceUnavailable();
	return {
		query: runningCaseSelectionQuery(prepared.read),
		caseIds: source.caseIds,
		...(prior && { prerequisite: true }),
	};
}

export function searchClaimSelection(
	world: ServerSearchWorld,
	source: SearchClaimSource,
) {
	return selectionMembership(world, source, false);
}

/** Reconstruct only the menu selections that supply an entry's earlier datums.
 * A parent may have come from its own completed search and need not be in the
 * restore yet. Every parent is checked against its own list in the claim's
 * transaction, even when the post itself claims only the child. */
export async function searchClaimMemberships(
	world: ServerSearchWorld,
	sources: readonly SearchClaimSource[],
	prior: readonly ClaimPriorSelection[],
): Promise<SearchClaimSelection[]> {
	const priorByMenu = new Map(
		prior.map((source) => [source.moduleUuid, source]),
	);
	if (priorByMenu.size !== prior.length) throw new SearchChoiceUnavailable();
	const supplied: Record<string, PreviewMenuCaseSelection> =
		Object.create(null);
	for (const source of prior) {
		const module = world.doc.modules[source.moduleUuid];
		if (module?.caseType)
			supplied[source.moduleUuid] = {
				caseType: module.caseType,
				cases: source.caseIds.map((caseId) => ({ caseId })),
			};
	}
	const selections: Record<string, PreviewMenuCaseSelection> =
		Object.create(null);
	const memberships: SearchClaimSelection[] = [];
	const visiting = new Set<Uuid>();
	const parents = async (moduleUuid: Uuid) => {
		if (visiting.has(moduleUuid)) throw new SearchChoiceUnavailable();
		visiting.add(moduleUuid);
		const frame = previewMenuCaseContext(world.doc, moduleUuid, supplied);
		if (frame.requiredParentCase) throw new SearchChoiceUnavailable();
		const id = frame.parentModuleUuid;
		if (id && !selections[id]) {
			const source = priorByMenu.get(id);
			if (!source) throw new SearchChoiceUnavailable();
			await parents(id);
			memberships.push(
				await selectionMembership({ ...world, selections }, source, true),
			);
			selections[id] = supplied[id];
		}
		visiting.delete(moduleUuid);
	};
	for (const source of sources) {
		await parents(source.moduleUuid);
		memberships.push(
			await searchClaimSelection({ ...world, selections }, source),
		);
	}
	return memberships;
}
