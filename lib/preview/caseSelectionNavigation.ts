/** The running Results row action, shared by the browser and app tests. */
export function caseSelectionRowAction(args: {
	readonly hasDetails: boolean;
	readonly multiple: boolean;
	readonly canContinue: boolean;
}): "detail" | "form" | "none" {
	return args.hasDetails
		? "detail"
		: args.multiple
			? "none"
			: args.canContinue
				? "form"
				: "none";
}
