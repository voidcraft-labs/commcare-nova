/** The destinations an empty-search list action can reach on this menu. */
export type NoMatchesDestination = "return" | "new-case" | "firstMenu";
export function noMatchesAfterSubmitModel({
	firstMenu,
	multiple,
	hasMenuForms,
	afterSubmit,
}: {
	firstMenu: boolean;
	multiple: boolean;
	hasMenuForms: boolean;
	afterSubmit?: "new-case";
}) {
	// Web Apps lands on Results with no record (`lib/preview/CLAUDE.md`, the
	// completed-search context's `listsNoRow`), though the search holds the case.
	const returnLabel = hasMenuForms ? "Results" : "Search";
	const value: NoMatchesDestination = firstMenu
		? "firstMenu"
		: (afterSubmit ?? "return");
	const options: { value: NoMatchesDestination; label: string }[] = [];
	if (!multiple) {
		options.push({ value: "return", label: returnLabel });
		// A bare list has no menu of forms to continue to. Keep a previously
		// chosen destination visible if its last form moved.
		if (hasMenuForms || afterSubmit === "new-case")
			options.push({ value: "new-case", label: "Continue with the new case" });
	}
	options.push({ value: "firstMenu", label: "First menu" });
	return {
		value,
		options,
		destination: firstMenu
			? "First menu"
			: afterSubmit === "new-case" && hasMenuForms
				? "the menu for the new case"
				: returnLabel,
		explanation: multiple
			? "This case list selects multiple cases. After registration, First menu lets the worker start a new selection."
			: afterSubmit === "new-case" && !firstMenu
				? hasMenuForms
					? "The worker sees this menu’s forms with the new case selected. If the form creates no case, the worker returns to Results."
					: "This menu has no forms to continue to, so the worker returns to Search."
				: "Choose where the worker continues after registering a case.",
	};
}
