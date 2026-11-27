import { splitMultiSelectSearchAnswer } from "@/lib/domain";
import type { LookupChoice } from "@/lib/preview/engine/types";

/** Web Apps iterates its value-to-label dictionary (query.js::_setItemset).
 * Duplicate values keep their final label at the first position, integer
 * keys come first and the inherited __proto__ setter stores no string. */
export function webSearchChoices(
	choices: readonly LookupChoice[],
): LookupChoice[] {
	return Object.values(
		Object.fromEntries(
			choices
				.filter((choice) => choice.value !== "__proto__")
				.map((choice) => [choice.value, choice]),
		),
	);
}

/** Android checks every row whose value occurs in the saved answer
 * (QueryRequestUiController.calculateItemChoices). On Web Apps each
 * projected value already has a single row. */
export function choiceKeysForAnswer(
	answer: string,
	choices: readonly LookupChoice[] | undefined,
): ReadonlySet<string> {
	const tokens = new Set(splitMultiSelectSearchAnswer(answer));
	return new Set(
		choices
			?.filter((choice) => tokens.has(choice.value))
			.map((choice) => choice.key),
	);
}
