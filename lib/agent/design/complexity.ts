/**
 * Deterministic design complexity — the score that sets PROCESS depth
 * (`compact | standard | extended`), computed only after a draft passes
 * schema and graph validation.
 *
 * The score controls how much review/revision process a design gets. It
 * never controls Blueprint features, model authority, or validity — a
 * compact design and an extended design cross the same absolute gate.
 *
 * Both the component readings and the final score persist with the draft
 * artifact so a depth decision is auditable. `algorithmVersion` bumps on any
 * change to the components or thresholds; persisted evidence is never
 * silently reinterpreted.
 */

import type { AppDesignContract } from "@/lib/agent/design/contract";

export type DesignDepth = "compact" | "standard" | "extended";

/** Conservative user-facing estimate for each deterministic effort level. */
export const DESIGN_EFFORT_TIME_ESTIMATES: Record<DesignDepth, string> = {
	compact: "about 30 minutes",
	standard: "about an hour",
	extended: "about 90 minutes",
};

export interface DesignComplexityEvidence {
	score: number;
	components: Record<string, number | boolean>;
	depth: DesignDepth;
	algorithmVersion: 1 | 2;
}

/**
 * Depth thresholds: 0–2 compact, 3–6 standard, 7+ extended.
 *
 * Each component is a workflow-shape reading, not an object count for its
 * own sake: record hierarchy, actor handoffs, task breadth, record linking,
 * access carving, external references, and sensitivity each add real design
 * risk that earns more process.
 */
export function computeDesignComplexity(
	contract: AppDesignContract,
): DesignComplexityEvidence {
	const recordCount = contract.records.length;
	const hasRecordHierarchy = contract.records.some(
		(record) => record.parentRecordId !== undefined,
	);
	const actorCount = contract.actors.length;
	const workflowCount = contract.workflows.length;
	const linkingEffects = contract.workflows.flatMap((workflow) =>
		workflow.recordEffects.filter(
			(effect) => effect.kind === "link" || effect.kind === "reassign",
		),
	).length;
	const decisionCount = contract.workflows.reduce(
		(total, workflow) => total + workflow.decisions.length,
		0,
	);
	const listCount = contract.lists.length;
	const accessPolicyCount = contract.access.length;
	const hasLocationScope = contract.access.some(
		(policy) => policy.locationScope !== undefined,
	);
	const externalReferenceCount = contract.externalRequirements.filter(
		(requirement) => requirement.kind === "existing-reference",
	).length;
	const sensitivePropertyCount = contract.records
		.flatMap((record) => record.properties)
		.filter((property) => property.sensitivity !== "ordinary").length;
	const nestedMenuCount = contract.moduleCompositions.filter(
		(composition) => composition.parentModuleCompositionId !== undefined,
	).length;

	const components: Record<string, number | boolean> = {
		recordCount,
		hasRecordHierarchy,
		actorCount,
		workflowCount,
		linkingEffects,
		decisionCount,
		listCount,
		accessPolicyCount,
		hasLocationScope,
		externalReferenceCount,
		sensitivePropertyCount,
		nestedMenuCount,
	};

	let score = 0;
	if (recordCount >= 2) score += 1;
	if (hasRecordHierarchy) score += 1;
	if (actorCount >= 2) score += 1;
	if (actorCount >= 3) score += 1;
	if (workflowCount >= 3) score += 1;
	if (workflowCount >= 6) score += 1;
	if (linkingEffects > 0) score += 1;
	if (decisionCount >= 3) score += 1;
	if (listCount >= 2) score += 1;
	if (accessPolicyCount > 0) score += 1;
	if (hasLocationScope) score += 1;
	if (externalReferenceCount > 0) score += 1;
	if (sensitivePropertyCount > 0) score += 1;
	if (nestedMenuCount > 0) score += 1;

	const depth: DesignDepth =
		score <= 2 ? "compact" : score <= 6 ? "standard" : "extended";
	return { score, components, depth, algorithmVersion: 2 };
}
