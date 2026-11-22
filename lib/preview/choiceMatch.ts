import type { ChoiceLayout } from "@/lib/domain/choicePresentation";
import type { Platform } from "@/lib/domain/platforms";
import { fuzzyMatch, levenshteinDistance } from "./listFilterMatch";

type MatchWords = Extract<ChoiceLayout, { kind: "search" }>["matchWords"];

/** Web Apps' ComboboxEntry.filter and Core's Standard, MultiWord and
 * FuzzyMatchFilterRule. Neither normalizes accents or reorders choices. */
export function choiceMatches(
	text: string,
	entered: string,
	mode: MatchWords,
	platform: Platform,
): boolean {
	const choice = text.toLowerCase();
	const query = (
		platform === "web-apps" ? entered.trim() : entered
	).toLowerCase();
	if (!query || (platform === "web-apps" && !choice)) return true;
	if (platform === "android") {
		if (mode === "multiword" || mode === "android-multiword")
			return query.split(" ").every((word) => choice.includes(word));
		if (mode === "fuzzy" || mode === "android-fuzzy") {
			const matches = (part: string, term: string, threshold: number) =>
				part.includes(term) || fuzzyMatch(term, part, threshold).matches;
			return (
				matches(choice, query, 2) ||
				query
					.split(" ")
					.every((term) =>
						choice.split(" ").some((part) => matches(part, term, 1)),
					)
			);
		}
		return choice.startsWith(query);
	}
	if (choice.startsWith(query)) return true;
	const terms = query.split(/\s+/);
	const words = choice.split(/\s+/);
	if (mode === "multiword") return terms.every((term) => words.includes(term));
	if (mode !== "fuzzy") return false;
	const close = (part: string, term: string) =>
		part === term ||
		(term.length > 3 &&
			Math.abs(part.length - term.length) <= 2 &&
			levenshteinDistance(part, term) <= 2);
	return (
		close(choice.slice(0, query.length + 2), query) ||
		((terms.length > 1 || words.length > 1) &&
			terms.some((term) => words.some((part) => close(part, term))))
	);
}
