/**
 * The owner rules of a document brought in from CommCare HQ that the places
 * CommCare HQ holds cannot satisfy, as the questions a review asks, and the
 * explicit rule a person's answer gives in their place.
 *
 * A rule that gives a case to the place at a level below its owner holds only
 * where exactly one such place stands below each place that owns cases: the
 * check a birth's organization integrity step runs over the stored rows
 * (`lib/organization/commitIntegrity.ts::assertReverseHopTargetsUnambiguous`),
 * run here over the planned places, each a live place whose id is its site
 * code. Where it does not hold, the review names the level and the zero or
 * two places it met, and offers the one explicit rule Nova can give without
 * choosing a place: the worker who fills in the form owns each case it
 * creates or changes. The other
 * remedy is to change the places in CommCare HQ and read the app again. Nova
 * never chooses a candidate place.
 *
 * Pure.
 */

import { caseOperationChangesForUpdate } from "@/lib/doc/caseOperationMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	organizationLevelsOf,
	type Uuid,
} from "@/lib/domain";
import { actingUser } from "@/lib/domain/expression/builders";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { ownRecordValue } from "@/lib/domain/records";
import type { ManagedPlacePlan } from "@/lib/organization/managed";
import {
	type OwnerVerdictLocationRow,
	ownerVerdictRows,
	type ReverseLocationOwnerVerdict,
	reverseHopDestinationLevelUuids,
	reverseLocationOwnerVerdict,
} from "@/lib/organization/ownerTargetVerdicts";
import type { OwnerRuleConflict, ReviewOwnerRule } from "./reviewTypes";

/** Code-unit order: the same answer on every machine, unlike a locale's. */
function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether an operation's owner rule finds a place at one of `levels`. */
function ownerReachesLevel(
	operation: CaseOperation,
	levels: ReadonlySet<string>,
): boolean {
	if (operation.owner === undefined) return false;
	let reaches = false;
	walkExpressionTerms(operation.owner, (term) => {
		if (term.kind === "owner-location-at-level" && levels.has(term.levelUuid))
			reaches = true;
	});
	return reaches;
}

/** Every form of `doc`: each menu's forms, menus in order, then any other. */
function formsInOrder(doc: BlueprintDoc): readonly Uuid[] {
	const listed = doc.moduleOrder.flatMap(
		(moduleUuid) => ownRecordValue(doc.formOrder, moduleUuid) ?? [],
	);
	const seen = new Set<string>(listed);
	return [
		...listed,
		...(Object.keys(doc.forms) as Uuid[]).filter((uuid) => !seen.has(uuid)),
	];
}

function conflictOf(verdict: ReverseLocationOwnerVerdict): OwnerRuleConflict {
	switch (verdict.kind) {
		case "ambiguous":
			return {
				kind: "two-places",
				source: verdict.source.name,
				places: [verdict.first.name, verdict.second.name],
			};
		case "none-below":
			return { kind: "no-place", source: verdict.source.name };
		case "level-owns-no-cases":
			return { kind: "level-owns-no-cases" };
		case "no-owning-level-above":
			return { kind: "no-owning-level-above" };
		case "outside-address-book":
			return {
				kind: "outside-address-book",
				place: verdict.destination.name,
				persona: verdict.persona,
			};
		case "level-missing":
			throw new Error(
				"A brought-in document's owner rule names a level the document does not hold. The reader gives an owner rule only for a level it read; look at lib/commcare/reader/expressions/folds.ts.",
			);
	}
}

/** Every case change of `doc` whose owner rule finds a place at a level below its owner, form by
 *  form in menu order. */
export function reverseHopOwnerChanges(
	doc: BlueprintDoc,
): readonly { readonly formUuid: Uuid; readonly operation: CaseOperation }[] {
	const destinations = new Set<string>(reverseHopDestinationLevelUuids(doc));
	if (destinations.size === 0) return [];
	return formsInOrder(doc).flatMap((formUuid) =>
		(doc.forms[formUuid]?.caseOperations ?? [])
			.filter((operation) => ownerReachesLevel(operation, destinations))
			.map((operation) => ({ formUuid, operation })),
	);
}

/**
 * Whether `committed` gives a case change to the worker who fills in the form
 * where `reading`, CommCare HQ's app as Nova read it, gives it to a place
 * below its owner: what the person's answer to an owner rule did, and what
 * the next publish changes in CommCare HQ until it is made.
 */
export function ownerGivenToWorker(
	reading: BlueprintDoc,
	committed: BlueprintDoc,
): boolean {
	return reverseHopOwnerChanges(reading).some(
		({ formUuid, operation }) =>
			ownRecordValue(committed.forms, formUuid)?.caseOperations?.find(
				(one) => one.uuid === operation.uuid,
			)?.owner?.kind === "acting-user",
	);
}

/**
 * The owner rules of `doc` the planned places cannot satisfy, one question a
 * level, by level code.
 */
export function managedPlacesOwnerRules(
	doc: BlueprintDoc,
	plan: ManagedPlacePlan,
): readonly ReviewOwnerRule[] {
	const destinations = reverseHopDestinationLevelUuids(doc);
	if (destinations.length === 0) return [];
	const rows = ownerVerdictRows(
		plan.places.map(
			(place): OwnerVerdictLocationRow => ({
				id: place.siteCode,
				name: place.name,
				level_uuid: place.levelUuid,
				parent_id: place.parentSiteCode,
				archived_at: null,
			}),
		),
	);
	const levels = organizationLevelsOf(doc);
	const questions: ReviewOwnerRule[] = [];
	for (const levelUuid of destinations) {
		const verdict = reverseLocationOwnerVerdict(doc, rows, levelUuid);
		if (!verdict) continue;
		const level = levels[levelUuid];
		if (level === undefined) conflictOf({ kind: "level-missing" });
		const only = new Set([levelUuid]);
		questions.push({
			level: level?.code ?? "",
			levelName: level?.name ?? "",
			conflict: conflictOf(verdict),
			forms: formsInOrder(doc)
				.filter((formUuid) =>
					(doc.forms[formUuid]?.caseOperations ?? []).some((operation) =>
						ownerReachesLevel(operation, only),
					),
				)
				.map((formUuid) => doc.forms[formUuid]?.name ?? ""),
		});
	}
	return questions.sort((a, b) => compareCodeUnits(a.level, b.level));
}

/**
 * The mutations that give every case change whose owner rule finds a place
 * at one of `levelCodes` to the worker who fills in the form, by the rule
 * that names that worker (`acting-user`); no rule at all would leave a case
 * the form changes with the owner it had. Applied to the document the review read, before the gate,
 * by the create and by the bring-in of changes. Empty for no level.
 */
export function workerOwnerMutations(
	doc: BlueprintDoc,
	levelCodes: readonly string[],
): readonly Mutation[] {
	if (levelCodes.length === 0) return [];
	const codes = new Set(levelCodes);
	const levels = new Set(
		Object.values(organizationLevelsOf(doc))
			.filter((level) => codes.has(level.code))
			.map((level) => level.uuid),
	);
	const mutations: Mutation[] = [];
	for (const formUuid of formsInOrder(doc)) {
		for (const operation of doc.forms[formUuid]?.caseOperations ?? []) {
			if (!ownerReachesLevel(operation, levels)) continue;
			/* The rule names the worker in so many words: a case a form changes
			 * with no owner rule keeps the owner it had. */
			mutations.push(
				...caseOperationChangesForUpdate(formUuid, operation, {
					...operation,
					owner: actingUser(),
				}),
			);
		}
	}
	return mutations;
}
