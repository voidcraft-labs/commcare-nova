/** One explanation and option set for a search-only registration destination. */
export type NoMatchesDestination = "return" | "app_home";
export function noMatchesAfterSubmitModel({
	appHome,
	multiple,
	hasMenuForms,
}: {
	appHome: boolean;
	multiple: boolean;
	hasMenuForms: boolean;
}) {
	const returnLabel = hasMenuForms
		? "Results showing the registered case"
		: "Search";
	const value: NoMatchesDestination = appHome ? "app_home" : "return";
	const options: { value: NoMatchesDestination; label: string }[] = [
		...(!multiple ? [{ value: "return" as const, label: returnLabel }] : []),
		{ value: "app_home", label: "App home" },
	];
	return {
		value,
		options,
		destination: appHome ? "App home" : returnLabel,
		explanation: multiple
			? "This case list selects multiple cases. After registration, App home lets the worker start a new selection."
			: "Return to the search flow or open App home after registering a case.",
	};
}
