/** Client-safe progress reflects saved authoring state, never parsed model prose. */
import { z } from "zod";

export const DESIGN_BUILD_STAGES = [
	"planning",
	"reviewing-plan",
	"building",
	"reviewing-app",
	"ready",
	"needs-input",
	"incomplete",
	"failed",
] as const;
export type DesignBuildStage = (typeof DESIGN_BUILD_STAGES)[number];
const STAGE_LABELS: Record<DesignBuildStage, string> = {
	planning: "Designing your app",
	"reviewing-plan": "Reviewing the plan",
	building: "Building your app",
	"reviewing-app": "Reviewing your app",
	ready: "Your app is ready",
	"needs-input": "Waiting for your reply",
	incomplete: "Stopped before it finished",
	failed: "Couldn't finish your app",
};
export function designStageLabel(stage: DesignBuildStage) {
	return STAGE_LABELS[stage];
}
export function designStageIsWorking(stage: DesignBuildStage) {
	return !["ready", "needs-input", "incomplete", "failed"].includes(stage);
}
export const appPlanProjectionSchema = z.object({
	revision: z.number().int().positive(),
	markdown: z.string().min(1),
	reviewedRevision: z.number().int().positive().nullable(),
});
export type AppPlanProjection = z.infer<typeof appPlanProjectionSchema>;
const scopeSchema = z.object({
	designSessionId: z.string().min(1),
	materializedAppId: z.string().min(1).nullable(),
});
export type DesignSessionScope = z.infer<typeof scopeSchema>;
export interface DesignSessionSeed extends DesignSessionScope {
	readonly revision: number;
	readonly stage: DesignBuildStage;
	readonly plan?: AppPlanProjection | null;
}
export function parseDesignSessionScope(
	frame: unknown,
): DesignSessionScope | null {
	const parsed = scopeSchema.safeParse(frame);
	return parsed.success ? parsed.data : null;
}
export const authoringProgressSchema = z.object({
	sessionId: z.string().min(1),
	revision: z.number().int().positive(),
	stage: z.enum(DESIGN_BUILD_STAGES),
});
export const authoringPlanFrameSchema = z.object({
	sessionId: z.string().min(1),
	plan: appPlanProjectionSchema,
});
