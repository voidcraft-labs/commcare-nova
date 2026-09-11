import type { BuildPlan, BuildSlice } from "../design/buildPlan";

export function orderSlicesForExecution(plan: BuildPlan): BuildSlice[] {
	const root = plan.slices.find(
		(slice) => slice.role === "materialization-root",
	);
	if (root === undefined) {
		throw new Error("The build plan carries no materialization root.");
	}
	if (root.prerequisiteSliceIds.length > 0) {
		throw new Error(
			"The materialization root names prerequisite slices, but no slice can commit before the app exists.",
		);
	}
	const byId = new Map(plan.slices.map((slice) => [slice.id as string, slice]));
	const ordered: BuildSlice[] = [];
	const placed = new Set<string>([root.id as string]);
	ordered.push(root);
	const remaining = plan.slices.filter((slice) => slice !== root);
	let progressed = true;
	while (remaining.length > 0 && progressed) {
		progressed = false;
		for (let index = 0; index < remaining.length; index += 1) {
			const slice = remaining[index];
			if (slice?.prerequisiteSliceIds.every((id) => placed.has(id as string))) {
				ordered.push(slice);
				placed.add(slice.id as string);
				remaining.splice(index, 1);
				progressed = true;
				index -= 1;
			}
		}
	}
	if (remaining.length > 0) {
		throw new Error(
			`The build plan's prerequisite graph did not resolve for slice(s) ${remaining
				.map((slice) => slice.name)
				.join(", ")}.`,
		);
	}
	return ordered.filter((slice) => byId.has(slice.id as string));
}
