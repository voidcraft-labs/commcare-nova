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

import { z } from "zod";

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
	"translating",
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
	"revising-design": "Improving the design",
	planning: "Planning your app",
	"building-first-workflow": "Building the first workflow",
	building: "Building your app",
	"reviewing-implementation": "Reviewing what was built",
	translating: "Preparing app languages",
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
	readonly lists: readonly string[];
	readonly assumptions: readonly string[];
	readonly blockingQuestions: readonly string[];
	readonly outOfScope: readonly string[];
	readonly reviewed: boolean;
}

/** Counts and names only. */
export interface BuildPlanSummaryProjection {
	readonly sliceCount: number;
	readonly sliceNames: readonly string[];
	readonly externalActionCount: number;
}

/** The design phases a live-activity pulse can name (restated from
 *  `lib/agent/build/progress.ts`, pinned by the wire test): `design` is the
 *  agent loop streaming, `review` the independent reviewer's call, `revise`
 *  and `plan` those submissions' streaming arguments. */
export const DESIGN_PULSE_PHASES = [
	"design",
	"review",
	"revise",
	"plan",
] as const;
export type DesignPulsePhase = (typeof DESIGN_PULSE_PHASES)[number];

/** One live-activity pulse: which phase is streaming, its cumulative
 *  delivered character count, and optionally the sub-step label the server
 *  derived from a submission's streaming keys ("Working out the records").
 *  Volume and a canned label, never content. */
export interface DesignPulseProjection {
	readonly phase: DesignPulsePhase;
	readonly chars: number;
	readonly step?: string;
}

/** The §15.2 stage a streaming phase truthfully puts the build in — the
 *  server named the call it is running; the client only displays it. */
export function designPulseStage(phase: DesignPulsePhase): DesignBuildStage {
	switch (phase) {
		case "design":
			return "designing";
		case "review":
			return "reviewing-design";
		case "revise":
			return "revising-design";
		case "plan":
			return "planning";
	}
}

export interface BuildSliceStartedProjection {
	readonly sliceId: string;
	readonly sliceName: string;
}

export interface BuildSliceCommittedProjection
	extends BuildSliceStartedProjection {
	readonly seq: number;
}

export interface BuildLocalizationProjection {
	readonly languageCode: string;
	readonly languageName: string;
	readonly batch: number;
	readonly batchCount: number;
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
 *  scope plus the stage the server folded
 *  from the durable session and its orchestration head. Deliberately no
 *  outline or plan — those exist only in the frames a run streams, and a
 *  reconstructed card would be invented progress. */
export interface DesignSessionSeed extends DesignSessionScope {
	readonly stage: DesignBuildStage;
}

// ── Parsing ────────────────────────────────────────────────────────
//
// Zod is the one frame-admission idiom on the client (the same discipline
// every other admitted wire shape uses); each parser FAILS CLOSED to `null`.

const nonBlank = z
	.string()
	.min(1)
	.refine((value) => value.trim().length > 0);
const wholeCount = z.number().int().nonnegative();

const envelopeSchema = z
	.object({
		eventVersion: z.literal(1),
		designSessionId: nonBlank,
		orchestrationEventId: z.string(),
		orchestrationRevision: wholeCount,
		data: z.unknown(),
	})
	.strict();

/**
 * Unwrap one progress envelope for a KNOWN design session. A frame whose
 * version this client does not speak, or whose session is not the one this
 * conversation is scoped to, returns `null` — the fail-closed rule (§15.4).
 */
export function designProgressPayload(
	frame: unknown,
	designSessionId: string,
): unknown | null {
	const parsed = envelopeSchema.safeParse(frame);
	if (!parsed.success) return null;
	if (parsed.data.designSessionId !== designSessionId) return null;
	return parsed.data.data ?? null;
}

const designSessionScopeSchema = z.object({
	designSessionId: nonBlank,
	materializedAppId: nonBlank.nullable(),
});

export function parseDesignSessionScope(
	frame: unknown,
): DesignSessionScope | null {
	const parsed = designSessionScopeSchema.safeParse(frame);
	return parsed.success ? parsed.data : null;
}

const designOutlineSchema = z.object({
	objective: z.string(),
	actors: z.array(z.string()),
	tasks: z.array(z.string()),
	records: z.array(z.string()),
	lists: z.array(z.string()),
	assumptions: z.array(z.string()),
	blockingQuestions: z.array(z.string()),
	outOfScope: z.array(z.string()),
	reviewed: z.boolean(),
});

const buildPlanSummarySchema = z.object({
	sliceCount: wholeCount,
	sliceNames: z.array(z.string()),
	externalActionCount: wholeCount,
});

const designPulseSchema = z.object({
	phase: z.enum(DESIGN_PULSE_PHASES),
	chars: wholeCount,
	step: z.string().min(1).optional(),
});

const buildSliceStartedSchema = z.object({
	sliceId: nonBlank,
	sliceName: nonBlank,
});

const buildSliceCommittedSchema = buildSliceStartedSchema.extend({
	seq: wholeCount,
});

const buildLocalizationSchema = z.object({
	languageCode: nonBlank,
	languageName: nonBlank,
	batch: z.number().int().positive(),
	batchCount: z.number().int().positive(),
});

const buildCompletionSchema = z.object({
	appId: nonBlank,
	appSeq: wholeCount,
	plannedSlices: wholeCount,
});

function parsePayload<T>(
	frame: unknown,
	designSessionId: string,
	schema: z.ZodType<T>,
): T | null {
	const data = designProgressPayload(frame, designSessionId);
	if (data === null) return null;
	const parsed = schema.safeParse(data);
	return parsed.success ? parsed.data : null;
}

export function parseDesignOutline(
	frame: unknown,
	designSessionId: string,
): DesignOutlineProjection | null {
	return parsePayload(frame, designSessionId, designOutlineSchema);
}

export function parseBuildPlanSummary(
	frame: unknown,
	designSessionId: string,
): BuildPlanSummaryProjection | null {
	return parsePayload(frame, designSessionId, buildPlanSummarySchema);
}

export function parseDesignPulse(
	frame: unknown,
	designSessionId: string,
): DesignPulseProjection | null {
	return parsePayload(frame, designSessionId, designPulseSchema);
}

export function parseBuildSliceStarted(
	frame: unknown,
	designSessionId: string,
): BuildSliceStartedProjection | null {
	return parsePayload(frame, designSessionId, buildSliceStartedSchema);
}

export function parseBuildSliceCommitted(
	frame: unknown,
	designSessionId: string,
): BuildSliceCommittedProjection | null {
	return parsePayload(frame, designSessionId, buildSliceCommittedSchema);
}

export function parseBuildLocalization(
	frame: unknown,
	designSessionId: string,
): BuildLocalizationProjection | null {
	return parsePayload(frame, designSessionId, buildLocalizationSchema);
}

export function parseBuildCompletion(
	frame: unknown,
	designSessionId: string,
): BuildCompletionProjection | null {
	return parsePayload(frame, designSessionId, buildCompletionSchema);
}
