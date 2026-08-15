/** Tool parts belonging to Nova's design protocol. They render in the
 * transcript as friendly projected rows (the same card the build tools use),
 * but their raw payloads — model-facing teaching messages, rejection
 * diagnostics, workspace views — never face the user: `toolSummary` speaks
 * for them with plain-language action phrases and suppresses their prose. */
const DESIGN_PROTOCOL_TOOL_PART_TYPES = new Set([
	"tool-setDesignRoot",
	"tool-updateActors",
	"tool-updateRecords",
	"tool-updateWorkflows",
	"tool-updateLists",
	"tool-updateAccess",
	"tool-updateNavigation",
	"tool-updateModuleCompositions",
	"tool-updateFormCompositions",
	"tool-updateExternalRequirements",
	"tool-updateDecisions",
	"tool-updateAssumptions",
	"tool-updateOpenQuestions",
	"tool-updateFindingDispositions",
	"tool-inspectDesign",
	"tool-finishDesign",
	"tool-requestReview",
]);

export function isDesignProtocolToolPartType(type: string): boolean {
	return DESIGN_PROTOCOL_TOOL_PART_TYPES.has(type);
}
