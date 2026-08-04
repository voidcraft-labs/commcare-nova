import type { CountArgs } from "@/lib/case-store";
import type {
	Automation,
	AutomationCriterion,
	BlueprintDoc,
	Uuid,
} from "@/lib/domain";
import { personasOf } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import {
	and,
	dateAdd,
	eq,
	gt,
	gte,
	isBlank,
	isIn,
	literal,
	lt,
	lte,
	neq,
	or,
	prop,
	term,
	today,
} from "@/lib/domain/predicate/builders";
import type { StoredLocation } from "@/lib/organization/types";

export interface AutomationMatchProjection {
	readonly countArgs: Pick<
		Extract<CountArgs, { caseType: string }>,
		"predicate" | "automationCriteria"
	>;
	readonly omittedCriteria: readonly string[];
}

function propertyCriterion(
	caseType: string,
	criterion: Extract<AutomationCriterion, { kind: "match-property" }>,
): Predicate | undefined {
	const property = prop(caseType, criterion.property);
	switch (criterion.matchType) {
		case "equal":
			return eq(property, literal(criterion.value ?? ""));
		case "not-equal":
			// HQ compares `None`/blank to the configured string and therefore
			// includes an absent property in NOT_EQUAL.
			return or(
				isBlank(property),
				neq(property, literal(criterion.value ?? "")),
			);
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

/** Location ids plus Preview-persona ids HQ's LocationFilter-equivalent sees. */
export function localOwnerIdsForLocation(
	doc: BlueprintDoc,
	locations: readonly StoredLocation[],
	locationUuid: Uuid,
	includeDescendants: boolean,
): string[] {
	const byParent = new Map<string | null, StoredLocation[]>();
	for (const location of locations) {
		if (location.archivedAt !== null) continue;
		const children = byParent.get(location.parentId) ?? [];
		children.push(location);
		byParent.set(location.parentId, children);
	}
	const locationIds = new Set<string>([locationUuid]);
	if (includeDescendants) {
		const pending = [locationUuid as string];
		while (pending.length > 0) {
			const parent = pending.pop();
			if (parent === undefined) break;
			for (const child of byParent.get(parent) ?? []) {
				if (locationIds.has(child.id)) continue;
				locationIds.add(child.id);
				pending.push(child.id);
			}
		}
	}
	const ownerIds = new Set(locationIds);
	for (const persona of Object.values(personasOf(doc))) {
		if (
			persona.locations?.primaryUuid !== undefined &&
			locationIds.has(persona.locations.primaryUuid)
		) {
			ownerIds.add(persona.uuid);
		}
	}
	return [...ownerIds].sort();
}

/**
 * Lower the locally evaluable part of one automation into the case store's
 * existing Predicate→Kysely path. Setup-only prose and HQ server-modified age
 * are returned as explicit omissions instead of influencing the count.
 */
export function automationMatchProjection(
	doc: BlueprintDoc,
	automation: Automation,
	locations: readonly StoredLocation[],
): AutomationMatchProjection {
	const predicates: Predicate[] = [];
	const regexes: { property: string; pattern: string }[] = [];
	const blankness: { property: string; hasValue: boolean }[] = [];
	const closedParents: {
		identifier: string;
		relationship: "child" | "extension";
	}[] = [];

	for (const criterion of automation.criteria) {
		if (criterion.kind === "match-property") {
			if (criterion.matchType === "regex") {
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
				});
			} else {
				const lowered = propertyCriterion(automation.caseType, criterion);
				if (lowered !== undefined) predicates.push(lowered);
			}
			continue;
		}
		if (criterion.kind === "closed-parent") {
			closedParents.push({
				identifier: "parent",
				relationship: "child",
			});
			continue;
		}
		const ownerIds = localOwnerIdsForLocation(
			doc,
			locations,
			criterion.locationUuid,
			criterion.includeDescendants,
		);
		const owner = prop(automation.caseType, "owner_id");
		predicates.push(
			ownerIds.length === 0
				? { kind: "match-none" }
				: isIn(
						owner,
						literal(ownerIds[0] ?? ""),
						...ownerIds.slice(1).map((id) => literal(id)),
					),
		);
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
		regexes.length > 0 ||
		blankness.length > 0 ||
		closedParents.length > 0;
	const omittedCriteria = [
		...automation.setupOnlyCriteria.map((criterion) => criterion.text),
		...(automation.serverModifiedBoundaryDays === undefined
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
					regexes,
					blankness,
					closedParents,
				},
			}),
		},
		omittedCriteria,
	};
}
