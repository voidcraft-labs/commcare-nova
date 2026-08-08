/**
 * Design-build progress frames — the client-safe wire leaf (§15.2–§15.4).
 *
 * The server producer is `lib/agent/build/progress.ts`; the orchestrator
 * writes these frames from `lib/agent/build/orchestrator.ts`. The shapes are
 * RESTATED here rather than imported because that module's type graph reaches
 * `lib/db/designSessions` and the design-artifact schemas, and this leaf is
 * imported by the chat client. `__tests__/designProgressWire.test.ts` pins the
 * restatement against the server declarations, so the two cannot drift.
 *
 * Every parser FAILS CLOSED: an unknown `eventVersion`, a frame naming a
 * different design session, or a payload missing a field yields `null`, and
 * the caller ignores it rather than rendering a half-read projection.
 */

/** The truthful, non-percentage stages. Text, never a percentage, and never
 *  color alone (§15.13). */
export const DESIGN_BUILD_STAGES = [
	"understanding",
	"designing",
	"reviewing-design",
	"revising-design",
	"planning",
	"building-first-workflow",
	"building",
	"reviewing-implementation",
	"ready",
	"needs-input",
	"incomplete",
	"failed",
] as const;

export type DesignBuildStage = (typeof DESIGN_BUILD_STAGES)[number];

/** One short sentence-case line per stage — what the progress region says and
 *  what a Designs-in-progress row reads. Present tense while work is running,
 *  past tense once it has stopped. */
const STAGE_LABELS: Record<DesignBuildStage, string> = {
	understanding: "Working out what you need",
	designing: "Designing your app",
	"reviewing-design": "Reviewing the design",
	"revising-design": "Revising the design",
	planning: "Planning the build",
	"building-first-workflow": "Building the first workflow",
	building: "Building your app",
	"reviewing-implementation": "Reviewing what was built",
	ready: "Your app is ready",
	"needs-input": "Waiting on your answer",
	incomplete: "Stopped before it finished",
	failed: "Couldn't finish this design",
};

export function designStageLabel(stage: DesignBuildStage): string {
	return STAGE_LABELS[stage];
}

/** Whether a stage means work is still moving — drives the spinner-vs-mark
 *  choice and nothing else, so the label always carries the meaning. */
export function designStageIsWorking(stage: DesignBuildStage): boolean {
	return (
		stage !== "ready" &&
		stage !== "needs-input" &&
		stage !== "incomplete" &&
		stage !== "failed"
	);
}

/** The versioned envelope every progress frame rides in (§15.4). */
export interface DesignProgressEnvelope<T> {
	readonly eventVersion: 1;
	readonly designSessionId: string;
	readonly orchestrationEventId: string;
	readonly orchestrationRevision: number;
	readonly data: T;
}

/** The safe outline card — a projection of the Design Contract, never the
 *  contract (§15.3): no source excerpts, no attachment bodies, no reasoning,
 *  no private steps, no implementation UUIDs. */
export interface DesignOutlineProjection {
	readonly objective: string;
	readonly actors: readonly string[];
	readonly tasks: readonly string[];
	readonly records: readonly string[];
	readonly readModels: readonly string[];
	readonly assumptions: readonly string[];
	readonly blockingQuestions: readonly string[];
	readonly outOfScope: readonly string[];
	readonly reviewed: boolean;
	readonly findingCounts: {
		readonly critical: number;
		readonly important: number;
		readonly advisory: number;
	};
}

/** Counts and names only. */
export interface BuildPlanSummaryProjection {
	readonly sliceCount: number;
	readonly sliceNames: readonly string[];
	readonly externalActionCount: number;
}

export interface BuildSliceStartedProjection {
	readonly sliceId: string;
	readonly sliceName: string;
}

export interface BuildSliceCommittedProjection
	extends BuildSliceStartedProjection {
	readonly seq: number;
}

export interface BuildCompletionProjection {
	readonly appId: string;
	readonly appSeq: number;
	readonly plannedSlices: number;
}

/** The design-session scope frame — the id every later send echoes, and the
 *  `materializedAppId: null` signal that a build is in flight with no app. */
export interface DesignSessionScope {
	readonly designSessionId: string;
	readonly materializedAppId: string | null;
}

/** What a COLD load of an existing design carries from the RSC page: the
 *  scope plus the stage the server folded from the durable session and its
 *  orchestration head. Deliberately no outline or plan — those exist only in
 *  the frames a run streams, and a reconstructed card would be invented
 *  progress. */
export interface DesignSessionSeed extends DesignSessionScope {
	readonly stage: DesignBuildStage;
}

// ── Parsing ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown): readonly string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((entry) => typeof entry === "string")
		? (value as string[])
		: null;
}

function wholeCount(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

/**
 * Unwrap one progress envelope for a KNOWN design session. A frame whose
 * version this client does not speak, or whose session is not the one this
 * conversation is scoped to, returns `null` — the fail-closed rule (§15.4).
 */
export function designProgressPayload(
	frame: unknown,
	designSessionId: string,
): unknown | null {
	if (!isRecord(frame)) return null;
	if (frame.eventVersion !== 1) return null;
	if (frame.designSessionId !== designSessionId) return null;
	if (typeof frame.orchestrationEventId !== "string") return null;
	if (wholeCount(frame.orchestrationRevision) === null) return null;
	return frame.data ?? null;
}

export function parseDesignSessionScope(
	frame: unknown,
): DesignSessionScope | null {
	if (!isRecord(frame)) return null;
	const designSessionId = nonBlankString(frame.designSessionId);
	if (designSessionId === null) return null;
	const materialized = frame.materializedAppId;
	if (materialized !== null && nonBlankString(materialized) === null) {
		return null;
	}
	return {
		designSessionId,
		materializedAppId: materialized === null ? null : (materialized as string),
	};
}

export function parseDesignOutline(
	frame: unknown,
	designSessionId: string,
): DesignOutlineProjection | null {
	const data = designProgressPayload(frame, designSessionId);
	if (!isRecord(data)) return null;
	const objective = typeof data.objective === "string" ? data.objective : null;
	const actors = stringList(data.actors);
	const tasks = stringList(data.tasks);
	const records = stringList(data.records);
	const readModels = stringList(data.readModels);
	const assumptions = stringList(data.assumptions);
	const blockingQuestions = stringList(data.blockingQuestions);
	const outOfScope = stringList(data.outOfScope);
	const counts = isRecord(data.findingCounts) ? data.findingCounts : null;
	const critical = wholeCount(counts?.critical);
	const important = wholeCount(counts?.important);
	const advisory = wholeCount(counts?.advisory);
	if (
		objective === null ||
		actors === null ||
		tasks === null ||
		records === null ||
		readModels === null ||
		assumptions === null ||
		blockingQuestions === null ||
		outOfScope === null ||
		typeof data.reviewed !== "boolean" ||
		critical === null ||
		important === null ||
		advisory === null
	) {
		return null;
	}
	return {
		objective,
		actors,
		tasks,
		records,
		readModels,
		assumptions,
		blockingQuestions,
		outOfScope,
		reviewed: data.reviewed,
		findingCounts: { critical, important, advisory },
	};
}

export function parseBuildPlanSummary(
	frame: unknown,
	designSessionId: string,
): BuildPlanSummaryProjection | null {
	const data = designProgressPayload(frame, designSessionId);
	if (!isRecord(data)) return null;
	const sliceCount = wholeCount(data.sliceCount);
	const sliceNames = stringList(data.sliceNames);
	const externalActionCount = wholeCount(data.externalActionCount);
	if (
		sliceCount === null ||
		sliceNames === null ||
		externalActionCount === null
	)
		return null;
	return { sliceCount, sliceNames, externalActionCount };
}

export function parseBuildSliceStarted(
	frame: unknown,
	designSessionId: string,
): BuildSliceStartedProjection | null {
	const data = designProgressPayload(frame, designSessionId);
	if (!isRecord(data)) return null;
	const sliceId = nonBlankString(data.sliceId);
	const sliceName = nonBlankString(data.sliceName);
	if (sliceId === null || sliceName === null) return null;
	return { sliceId, sliceName };
}

export function parseBuildSliceCommitted(
	frame: unknown,
	designSessionId: string,
): BuildSliceCommittedProjection | null {
	const started = parseBuildSliceStarted(frame, designSessionId);
	if (started === null) return null;
	const data = designProgressPayload(frame, designSessionId);
	const seq = isRecord(data) ? wholeCount(data.seq) : null;
	if (seq === null) return null;
	return { ...started, seq };
}

export function parseBuildCompletion(
	frame: unknown,
	designSessionId: string,
): BuildCompletionProjection | null {
	const data = designProgressPayload(frame, designSessionId);
	if (!isRecord(data)) return null;
	const appId = nonBlankString(data.appId);
	const appSeq = wholeCount(data.appSeq);
	const plannedSlices = wholeCount(data.plannedSlices);
	if (appId === null || appSeq === null || plannedSlices === null) return null;
	return { appId, appSeq, plannedSlices };
}
