/**
 * Atomic replacement of a select field's required, exclusive options source.
 *
 * A source is always either a complete inline list or a complete Project-table
 * binding. There is no absent state, null clear, retained inactive body, or
 * precedence rule. Mode switches and lookup-source edits therefore travel as
 * one ordinary `updateField` patch carrying the complete destination arm.
 */

import type { SelectOptionsSource, Uuid } from "@/lib/domain";
import type { Mutation } from "./types";

export type SelectOptionsSourceCarrierKind = "single_select" | "multi_select";

export function replaceFieldOptionsSourceMutation(
	uuid: Uuid,
	targetKind: SelectOptionsSourceCarrierKind,
	next: SelectOptionsSource,
): Mutation {
	return {
		kind: "updateField",
		uuid,
		targetKind,
		patch: { optionsSource: next },
	};
}
