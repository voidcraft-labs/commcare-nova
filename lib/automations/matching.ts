import type { CountArgs } from "@/lib/case-store";
import type {
	Automation,
	AutomationContent,
	AutomationMessageTemplate,
	BlueprintDoc,
} from "@/lib/domain";
import { personasOf } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate/builders";
import type { StoredLocation } from "@/lib/organization/types";

export interface AutomationMatchProjection {
	readonly countArgs: Pick<
		Extract<CountArgs, { caseType: string }>,
		"predicate" | "automationCriteria"
	>;
	readonly omittedCriteria: readonly string[];
}

function templateUsesHostScopedRead(
	template: AutomationMessageTemplate,
): boolean {
	return template.parts.some(
		(part) => part.kind === "case-property" && part.scope === "host",
	);
}

function contentUsesHostScopedRead(content: AutomationContent): boolean {
	switch (content.kind) {
		case "sms":
		case "sms-callback":
		case "connect-message":
			return templateUsesHostScopedRead(content.message);
		case "email":
			return (
				templateUsesHostScopedRead(content.subject) ||
				templateUsesHostScopedRead(
					content.body.kind === "plain-text"
						? content.body.message
						: content.body.html,
				)
			);
		case "sms-survey":
		case "connect-survey":
		case "ivr":
		case "custom":
			return false;
	}
}

/** True when HQ must resolve the first extension host anywhere in the rule. */
export function automationUsesHostScopedRead(automation: Automation): boolean {
	if (
		automation.criteria.some(
			(criterion) =>
				criterion.kind === "match-property" && criterion.scope === "host",
		)
	) {
		return true;
	}
	if (automation.kind === "case-update") {
		return automation.updates.some(
			(update) =>
				update.value.kind === "case-property" &&
				update.value.source.scope === "host",
		);
	}
	return automation.schedule.events.some((event) =>
		contentUsesHostScopedRead(event.content),
	);
}

function automationCriteriaUseHostScopedRead(automation: Automation): boolean {
	return automation.criteria.some(
		(criterion) =>
			criterion.kind === "match-property" && criterion.scope === "host",
	);
}

/**
 * Lower the locally evaluable part of one automation into the case store's
 * same count query. Setup-only prose and HQ server-modified age are returned as
 * explicit omissions instead of influencing the count.
 */
export function automationMatchProjection(
	doc: BlueprintDoc,
	automation: Automation,
	locations: readonly StoredLocation[] = [],
): AutomationMatchProjection {
	const dates: {
		property: string;
		days: number;
		matchType:
			| "date-days-before"
			| "date-days-lte"
			| "date-days-gt"
			| "date-days";
		scope: "case" | "parent" | "host";
	}[] = [];
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
	const locationOwnerSets: string[][] = [];
	const children = new Map<string, string[]>();
	for (const location of locations) {
		if (location.parentId === null) continue;
		const siblings = children.get(location.parentId) ?? [];
		siblings.push(location.id);
		children.set(location.parentId, siblings);
	}
	const locationOwnerIds = (
		locationUuid: string,
		includeDescendants: boolean,
	): string[] => {
		const matchedLocations = new Set<string>([locationUuid]);
		if (includeDescendants) {
			const pending = [locationUuid];
			while (pending.length > 0) {
				const parent = pending.pop();
				if (parent === undefined) continue;
				for (const child of children.get(parent) ?? []) {
					if (matchedLocations.has(child)) continue;
					matchedLocations.add(child);
					pending.push(child);
				}
			}
		}
		const ownerIds = new Set(matchedLocations);
		for (const persona of Object.values(personasOf(doc))) {
			if (
				persona.locations !== undefined &&
				matchedLocations.has(persona.locations.primaryUuid)
			) {
				ownerIds.add(persona.uuid);
			}
		}
		return [...ownerIds].sort();
	};

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
				dates.push({
					property: criterion.property,
					days: criterion.days ?? 0,
					matchType: criterion.matchType,
					scope: criterion.scope,
				});
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
		if (criterion.kind === "location") {
			locationOwnerSets.push(
				locationOwnerIds(criterion.locationUuid, criterion.includeDescendants),
			);
		}
	}

	const omittedCriteria = [
		...automation.setupOnlyCriteria.map(
			(criterion) =>
				`${criterion.kind === "ucr-filter" ? "User-configurable report (UCR) filter" : "Registered custom criterion"}: ${criterion.text}`,
		),
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
			automationCriteria: {
				requiresUnambiguousHost:
					automationCriteriaUseHostScopedRead(automation),
				operator: automation.criteriaOperator,
				dates,
				comparisons,
				regexes,
				blankness,
				closedParents,
				locationOwnerSets,
			},
		},
		omittedCriteria,
	};
}
