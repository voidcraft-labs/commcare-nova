/** One classification for progress, recovery and the canonical app freeze. */
export const ORCHESTRATION_KIND_CLASSIFICATION = {
	planning: "active",
	building: "active",
	"reviewing-plan": "active",
	"reviewing-app": "active",
	"awaiting-input": "active",
	finished: "released",
	failed: "terminal-frozen",
} as const;
export type BuildOrchestrationKind =
	keyof typeof ORCHESTRATION_KIND_CLASSIFICATION;
export type OrchestrationKindClass =
	(typeof ORCHESTRATION_KIND_CLASSIFICATION)[BuildOrchestrationKind];
const kindsInClass = (
	...classes: readonly OrchestrationKindClass[]
): readonly BuildOrchestrationKind[] =>
	(
		Object.keys(ORCHESTRATION_KIND_CLASSIFICATION) as BuildOrchestrationKind[]
	).filter((kind) => classes.includes(ORCHESTRATION_KIND_CLASSIFICATION[kind]));
export const APP_RELEASING_ORCHESTRATION_KINDS = kindsInClass("released");
export const TERMINAL_ORCHESTRATION_KINDS = kindsInClass(
	"released",
	"terminal-frozen",
);
export function isTerminalOrchestrationKind(
	kind: BuildOrchestrationKind,
): boolean {
	return ORCHESTRATION_KIND_CLASSIFICATION[kind] !== "active";
}
