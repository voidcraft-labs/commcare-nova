import type { AppDesignContract } from "@/lib/agent/design/contract";

/** Small, stable read-only quality profile for tuning reviewed app designs. */
export function designCompositionSummary(contract: AppDesignContract) {
	const items = contract.formCompositions.flatMap((form) =>
		form.layout.kind === "sectioned"
			? form.layout.sections.flatMap((section) => section.items)
			: form.layout.items,
	);
	const formsPerWorkflow = new Map<string, number>();
	for (const form of contract.formCompositions) {
		formsPerWorkflow.set(
			form.workflowId,
			(formsPerWorkflow.get(form.workflowId) ?? 0) + 1,
		);
	}
	const icons = [
		...contract.moduleCompositions.map((module) => module.icon),
		...contract.formCompositions.map((form) => form.icon),
	];
	return {
		modules: contract.moduleCompositions.length,
		forms: contract.formCompositions.length,
		sectionedForms: contract.formCompositions.filter(
			(form) => form.layout.kind === "sectioned",
		).length,
		flatForms: contract.formCompositions.filter(
			(form) => form.layout.kind === "flat",
		).length,
		sections: contract.formCompositions.reduce(
			(total, form) =>
				total +
				(form.layout.kind === "sectioned" ? form.layout.sections.length : 0),
			0,
		),
		inputItems: items.filter((item) => item.kind === "input").length,
		guidanceItems: items.filter((item) => item.kind === "guidance").length,
		recordSummaries: items.filter((item) => item.kind === "record-summary")
			.length,
		actorSpecificForms: contract.formCompositions.filter(
			(form) => form.variant === "actor-specific",
		).length,
		duplicatedWorkflows: [...formsPerWorkflow.values()].filter(
			(count) => count > 1,
		).length,
		builtinIcons: icons.filter((icon) => icon.kind === "builtin").length,
		noIcons: icons.filter((icon) => icon.kind === "none").length,
	};
}
