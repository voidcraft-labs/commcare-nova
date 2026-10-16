/** One explanation and option set for a search-only registration destination. */
export type NoMatchesDestination = "return" | "firstMenu";
export function noMatchesAfterSubmitModel({
	firstMenu,
	multiple,
	hasMenuForms,
}: {
	firstMenu: boolean;
	multiple: boolean;
	hasMenuForms: boolean;
}) {
	const returnLabel = hasMenuForms
		? "Results showing the registered case"
		: "Search";
	const value: NoMatchesDestination = firstMenu ? "firstMenu" : "return";
	const options: { value: NoMatchesDestination; label: string }[] = [
		...(!multiple ? [{ value: "return" as const, label: returnLabel }] : []),
		{ value: "firstMenu", label: "First menu" },
	];
	return {
		value,
		options,
		destination: firstMenu ? "First menu" : returnLabel,
		explanation: multiple
			? "This case list selects multiple cases. After registration, First menu lets the worker start a new selection."
			: "Return to the search flow or open First menu after registering a case.",
	};
}
