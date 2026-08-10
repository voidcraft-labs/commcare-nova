/** Tool parts that belong to Nova's internal design protocol. They remain in
 * durable history for model replay, but the user sees Nova's own prose and the
 * live design status instead of raw protocol names, inputs, or results. */
const INTERNAL_DESIGN_TOOL_PART_TYPES = new Set([
	"tool-stageContract",
	"tool-stageRevision",
	"tool-stagePlan",
	"tool-inspectDesignWorkspace",
	"tool-submitContract",
	"tool-requestReview",
	"tool-submitRevision",
	"tool-submitPlan",
]);

export function isInternalDesignToolPartType(type: string): boolean {
	return INTERNAL_DESIGN_TOOL_PART_TYPES.has(type);
}
