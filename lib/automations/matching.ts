import type { CountArgs } from "@/lib/case-store";
import type {
	Automation,
	AutomationCriterion,
	BlueprintDoc,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import {
	ancestorPath,
	and,
	dateAdd,
	eq,
	gt,
	gte,
	literal,
	lt,
	lte,
	or,
	prop,
	relationStep,
	term,
	today,
} from "@/lib/domain/predicate/builders";

export interface AutomationMatchProjection {
	readonly countArgs: Pick<
		Extract<CountArgs, { caseType: string }>,
		"predicate" | "automationCriteria"
	>;
	readonly omittedCriteria: readonly string[];
}

function propertyCriterion(
	doc: BlueprintDoc,
	automation: Automation,
	criterion: Extract<AutomationCriterion, { kind: "match-property" }>,
): Predicate | undefined {
	const source = effectiveCaseTypes(doc).find(
		(caseType) => caseType.name === automation.caseType,
	);
	const property = prop(
		automation.caseType,
		criterion.property,
		criterion.scope === "case"
			? undefined
			: ancestorPath(relationStep(criterion.scope, source?.parent_type)),
	);
	switch (criterion.matchType) {
		case "equal":
		case "not-equal":
		case "has-value":
		case "has-no-value":
		case "regex":
			return undefined;
		case "date-days-before":
		case "date-days-lte":
		case "date-days-gt":
		case "date-days": {
			const threshold = dateAdd(
				term(property),
				"days",
				term(literal(criterion.days ?? 0)),
			);
			if (criterion.matchType === "date-days-before") {
				return lt(today(), threshold);
			}
			if (criterion.matchType === "date-days-lte") {
				return lte(today(), threshold);
			}
			if (criterion.matchType === "date-days-gt") {
				return gt(today(), threshold);
			}
			return gte(today(), threshold);
		}
	}
}

/**
 * Lower the locally evaluable part of one automation into the case store's
 * existing Predicate→Kysely path. Setup-only prose and HQ server-modified age
 * are returned as explicit omissions instead of influencing the count.
 */
export function automationMatchProjection(
	doc: BlueprintDoc,
	automation: Automation,
): AutomationMatchProjection {
	const predicates: Predicate[] = [];
	const comparisons: {
		property: string;
		value: string;
		equal: boolean;
		scope: "case" | "parent" | "host";
	}[] = [];
	const regexes: { property: string; pattern: string }[] = [];
	const blankness: {
		property: string;
		hasValue: boolean;
		scope: "case" | "parent" | "host";
	}[] = [];
	const closedParents: {
		identifier: string;
		relationship: "child" | "extension";
	}[] = [];

	for (const criterion of automation.criteria) {
		if (criterion.kind === "match-property") {
			if (
				criterion.matchType === "equal" ||
				criterion.matchType === "not-equal"
			) {
				comparisons.push({
					property: criterion.property,
					value: criterion.value ?? "",
					equal: criterion.matchType === "equal",
					scope: criterion.scope,
				});
			} else if (criterion.matchType === "regex") {
				regexes.push({
					property: criterion.property,
					pattern: criterion.value ?? "",
				});
			} else if (
				criterion.matchType === "has-value" ||
				criterion.matchType === "has-no-value"
			) {
				blankness.push({
					property: criterion.property,
					hasValue: criterion.matchType === "has-value",
					scope: criterion.scope,
				});
			} else {
				const lowered = propertyCriterion(doc, automation, criterion);
				if (lowered !== undefined) predicates.push(lowered);
			}
			continue;
		}
		if (criterion.kind === "closed-parent") {
			closedParents.push({
				identifier: "parent",
				relationship: "child",
			});
		}
	}

	const groupedPredicate =
		predicates.length === 0
			? undefined
			: predicates.length === 1
				? predicates[0]
				: automation.criteriaOperator === "all"
					? and(predicates[0], predicates[1], ...predicates.slice(2))
					: or(predicates[0], predicates[1], ...predicates.slice(2));
	const hasCriteria =
		groupedPredicate !== undefined ||
		comparisons.length > 0 ||
		regexes.length > 0 ||
		blankness.length > 0 ||
		closedParents.length > 0;
	const omittedCriteria = [
		...automation.setupOnlyCriteria.map((criterion) => criterion.text),
		...(automation.kind !== "case-update" ||
		automation.serverModifiedBoundaryDays === undefined
			? []
			: [
					`HQ server-modified age of at least ${automation.serverModifiedBoundaryDays} days`,
				]),
	];

	return {
		countArgs: {
			// AutomaticUpdateRule skips closed cases before criteria evaluation.
			predicate: eq(prop(automation.caseType, "status"), literal("open")),
			...(hasCriteria && {
				automationCriteria: {
					operator: automation.criteriaOperator,
					...(groupedPredicate === undefined
						? {}
						: { predicate: groupedPredicate }),
					comparisons,
					regexes,
					blankness,
					closedParents,
				},
			}),
		},
		omittedCriteria,
	};
}
