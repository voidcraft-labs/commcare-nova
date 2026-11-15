/**
 * A Search check's refusal of data the worker's device lacks, held by the
 * Search screen in place of its fields (`SearchInputForm.tsx`) for exactly as
 * long as it is still the answer.
 */

import type { SearchInputDef } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import type { PreviewDataRefusalReason } from "./dataRefusal";
import type { PreviewSearchSessionValues } from "./identity";
import type { PreviewSearchEnvironment } from "./searchExpressionEvaluation";

/** What a Search check is judged against: the screen, its inputs and filter,
 *  the data it reads and the worker's session. */
export interface SearchCheckWorld {
	readonly scopeKey: string;
	readonly searchInputs: ReadonlyArray<SearchInputDef>;
	readonly filter: Expression | undefined;
	readonly environment: PreviewSearchEnvironment;
	readonly session: PreviewSearchSessionValues | undefined;
}

/** A check's refusal, with the world it was judged against. */
export interface HeldCheckRefusal {
	readonly world: SearchCheckWorld;
	readonly reason: PreviewDataRefusalReason;
}

/**
 * The refusal a Search check met, while it still stands: only while every
 * part of the world it was judged against is the same one. Any change (an
 * edit to the inputs or filter, new lookup data, another worker, another
 * screen) can give the device what it lacked, so the screen shows its fields
 * again and the next Search judges anew.
 */
export function heldCheckRefusal(
	held: HeldCheckRefusal | undefined,
	world: SearchCheckWorld,
): PreviewDataRefusalReason | undefined {
	if (held === undefined) return undefined;
	const judged = held.world;
	return judged.scopeKey === world.scopeKey &&
		judged.searchInputs === world.searchInputs &&
		judged.filter === world.filter &&
		judged.environment === world.environment &&
		judged.session === world.session
		? held.reason
		: undefined;
}
