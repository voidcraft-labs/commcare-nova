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
	algorithmVersion: 1;
}

/**
 * Depth thresholds: 0–2 compact, 3–6 standard, 7+ extended.
 *
 * Each component is a workflow-shape reading, not an object count for its
 * own sake: record hierarchy, actor handoffs, task breadth, lifecycle
 * richness, access carving, derived/lookup data, and sensitivity each add
 * real design risk that earns more process.
 */
export function computeDesignComplexity(
	contract: AppDesignContract,
): DesignComplexityEvidence {
	const recordCount = contract.records.length;
	const hasRecordHierarchy = contract.records.some(
		(record) => record.parentRecordId !== undefined,
	);
	const actorCount = contract.actors.length;
	const taskCount = contract.tasks.length;
	const linkingTransitions = contract.transitions.filter(
		(transition) =>
			transition.transitionKind === "link" ||
			transition.transitionKind === "reassign",
	).length;
	const ruleCount = contract.rules.length;
	const readModelCount = contract.readModels.length;
	const accessPolicyCount = contract.accessPolicies.length;
	const hasLocationScope = contract.accessPolicies.some(
		(policy) => policy.locationScopeIntent !== undefined,
	);
	const lookupFactCount = contract.facts.filter(
		(fact) => fact.source.kind === "lookup",
	).length;
	const sensitiveFactCount = contract.facts.filter(
		(fact) => fact.sensitivity !== "ordinary",
	).length;

	const components: Record<string, number | boolean> = {
		recordCount,
		hasRecordHierarchy,
		actorCount,
		taskCount,
		linkingTransitions,
		ruleCount,
		readModelCount,
		accessPolicyCount,
		hasLocationScope,
		lookupFactCount,
		sensitiveFactCount,
	};

	let score = 0;
	if (recordCount >= 2) score += 1;
	if (hasRecordHierarchy) score += 1;
	if (actorCount >= 2) score += 1;
	if (actorCount >= 3) score += 1;
	if (taskCount >= 3) score += 1;
	if (taskCount >= 6) score += 1;
	if (linkingTransitions > 0) score += 1;
	if (ruleCount >= 3) score += 1;
	if (readModelCount >= 2) score += 1;
	if (accessPolicyCount > 0) score += 1;
	if (hasLocationScope) score += 1;
	if (lookupFactCount > 0) score += 1;
	if (sensitiveFactCount > 0) score += 1;

	const depth: DesignDepth =
		score <= 2 ? "compact" : score <= 6 ? "standard" : "extended";
	return { score, components, depth, algorithmVersion: 1 };
}
