/**
 * The closed orchestration-event kind vocabulary, classified ONCE.
 *
 * A dependency-free leaf (no zod, no db) so the SQL freeze gate in
 * `lib/db/unfinishedMaterializedDesign.ts`, the progress fold in
 * `progress.ts`, and the chat route's interruption stamp all derive from the
 * same classification instead of hand-enumerating kinds. The schema union in
 * `orchestratorState.ts` is compile-locked against this record, so adding a
 * kind there without deciding its classification here is a compile error —
 * never a silently frozen app.
 *
 * - `active` — the build is running or awaiting input. Later events may
 *   append, and a materialized app stays frozen.
 * - `released` — successful terminal: the app leaves the reviewed-build
 *   freeze. `finished` is the only current writer; `accepted-partial`
 *   remains solely so apps released through the historical "Use what's
 *   built" path stay editable.
 * - `terminal-frozen` — authoritative terminal that KEEPS the freeze:
 *   a `failed` head is never stamped over, and a recoverable failure is
 *   continued by a fresh claim appending later events, not by rewriting
 *   the terminal record.
 */
export const ORCHESTRATION_KIND_CLASSIFICATION = {
	designing: "active",
	"awaiting-user": "active",
	"awaiting-user-questions": "active",
	planning: "active",
	"executing-slice": "active",
	translating: "active",
	finished: "released",
	"accepted-partial": "released",
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

/** The head kinds that release a materialized app from the reviewed-build
 * freeze — the SQL gate's allow list. */
export const APP_RELEASING_ORCHESTRATION_KINDS = kindsInClass("released");

/** Every authoritative terminal head kind — released plus the
 * freeze-keeping `failed`. */
export const TERMINAL_ORCHESTRATION_KINDS = kindsInClass(
	"released",
	"terminal-frozen",
);

/** Whether a head of this kind is an authoritative terminal record that no
 * later event may be stamped over. */
export function isTerminalOrchestrationKind(
	kind: BuildOrchestrationKind,
): boolean {
	return ORCHESTRATION_KIND_CLASSIFICATION[kind] !== "active";
}
