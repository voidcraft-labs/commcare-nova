/** Tool parts belonging to Nova's design protocol. They render in the
 * transcript as friendly projected rows (the same card the build tools use),
 * but their raw payloads — model-facing teaching messages, rejection
 * diagnostics, workspace views — never face the user: `toolSummary` speaks
 * for them with plain-language action phrases and suppresses their prose. */
const DESIGN_PROTOCOL_TOOL_PART_TYPES = new Set([
	"tool-stageContract",
	"tool-stageRevision",
	"tool-inspectDesignWorkspace",
	"tool-submitContract",
	"tool-requestReview",
	"tool-submitRevision",
]);

export function isDesignProtocolToolPartType(type: string): boolean {
	return DESIGN_PROTOCOL_TOOL_PART_TYPES.has(type);
}
