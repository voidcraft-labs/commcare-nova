// components/preview/shared/multiSelectChoiceKeys.ts
//
// Which lookup rows a stored multiple-choice search answer ticks. Lookup
// rows guarantee neither unique nor non-blank values, so the answer string
// (one token per ticked row, in row order) is mapped back to rows greedily:
// each token claims the first row of that value not already claimed. An
// answer naming a value once therefore ticks one row even when several rows
// share the value, and naming it twice ticks two.

import { splitMultiSelectSearchAnswer } from "@/lib/domain";
import type { LookupChoice } from "@/lib/preview/engine/types";

export function choiceKeysForAnswer(
	answer: string,
	choices: readonly LookupChoice[] | undefined,
): ReadonlySet<string> {
	const keys = new Set<string>();
	if (choices === undefined) return keys;
	for (const token of splitMultiSelectSearchAnswer(answer)) {
		const row = choices.find(
			(choice) => choice.value === token && !keys.has(choice.key),
		);
		if (row !== undefined) keys.add(row.key);
	}
	return keys;
}
