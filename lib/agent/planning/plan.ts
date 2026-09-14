import { z } from "zod";

export const MAX_PLAN_CHARACTERS = 200_000;
export const planMarkdownSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_PLAN_CHARACTERS);
export type PlanEditor = "architect" | "peer" | "migration";

export interface AppPlan {
	readonly sessionId: string;
	readonly revision: number;
	readonly markdown: string;
	readonly editor: PlanEditor;
	readonly reviewedRevision: number | null;
}

export class PlanConflictError extends Error {}

/** Exact text editing preserves prose without assigning meaning to its format. */
export function editPlanText(
	markdown: string,
	oldText: string,
	newText: string,
): string {
	if (!oldText)
		throw new PlanConflictError("The text to replace cannot be empty.");
	const start = markdown.indexOf(oldText);
	if (start < 0)
		throw new PlanConflictError(
			"The text is no longer in the plan. Read the current plan before editing.",
		);
	if (markdown.indexOf(oldText, start + 1) >= 0)
		throw new PlanConflictError(
			"The text appears more than once. Include enough surrounding text to identify one passage.",
		);
	return planMarkdownSchema.parse(
		markdown.slice(0, start) + newText + markdown.slice(start + oldText.length),
	);
}
