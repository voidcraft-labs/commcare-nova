import {
	assignedLocationUuids,
	levelHoldsWorkers,
	levelMayNestUnder,
	type OrganizationLevel,
	organizationLevelsOf,
	personasOf,
	type Uuid,
} from "@/lib/domain";
import { managedOrganizationCommitRefusal } from "@/lib/publish/managedData";
import {
	fixedLocationOwnerIssue,
	type ManagedPlacesContext,
	type OrganizationRuleInputs,
	reverseLocationOwnerRefusal,
} from "./ownerTargetVerdicts";
import type { StoredLocation } from "./types";

export type OrganizationLevelPatch = Partial<
	Omit<OrganizationLevel, "uuid" | "code" | "parentLevelUuid">
> & { readonly parentLevelUuid?: Uuid | null };

function candidateWithLevelPatch(
	doc: OrganizationRuleInputs,
	levelUuid: string,
	patch: OrganizationLevelPatch,
): OrganizationRuleInputs | undefined {
	const current = organizationLevelsOf(doc)[levelUuid];
	if (current === undefined) return undefined;
	const next: OrganizationLevel = { ...current, ...patch } as OrganizationLevel;
	if (patch.parentLevelUuid === null) delete next.parentLevelUuid;
	return {
		...doc,
		organizationLevels: {
			...organizationLevelsOf(doc),
			[levelUuid]: next,
		},
	};
}

/**
 * Pure preflight for the Builder's level controls.
 *
 * The server repeats these checks under locks; this planner's job is to keep a
 * gesture that is already known to be cross-store-invalid out of the local
 * Blueprint in the first place, so conflict recovery never has to discard it.
 *
 * `managed` is where CommCare HQ manages the app's places, where it does
 * (the snapshot's `hq.domain` and `hq.goneIds`). There, as in the commit's
 * own check, a placement and a reverse owner hop are answered with the step
 * that works (the place in CommCare HQ and a refresh, or, for a place CommCare
 * HQ no longer has, what in the app uses it), and archived places are passed
 * over: each is a place CommCare HQ no longer lists, which no one can bring
 * back or move in Nova.
 */
export function organizationLevelPatchIssue(
	doc: OrganizationRuleInputs,
	locations: readonly StoredLocation[],
	levelUuid: string,
	patch: OrganizationLevelPatch,
	managed?: ManagedPlacesContext,
): string | undefined {
	const candidate = candidateWithLevelPatch(doc, levelUuid, patch);
	if (candidate === undefined) return "This level no longer exists.";
	const levels = organizationLevelsOf(candidate);
	const byId = new Map<string, StoredLocation>(
		locations.map((location) => [location.id, location]),
	);

	for (const location of locations) {
		if (managed !== undefined && location.archivedAt !== null) continue;
		const level = levels[location.levelUuid];
		const parent =
			location.parentId === null ? undefined : byId.get(location.parentId);
		const sentence =
			level === undefined
				? `“${location.name}” stands at a level this change removes.`
				: location.parentId === null
					? level.parentLevelUuid === undefined
						? undefined
						: `“${location.name}” would be left without a parent place. Bring it back first if it is archived, move it to a valid parent, then retry this level change.`
					: parent === undefined ||
							!levelMayNestUnder(location.levelUuid, parent.levelUuid, levels)
						? `“${location.name}” would no longer sit under a place at a level above it. Bring it back first if it is archived, move it to a valid parent, then retry this level change.`
						: undefined;
		if (sentence === undefined) continue;
		return managed === undefined
			? sentence
			: managedOrganizationCommitRefusal(
					{
						kind: "placement",
						place: `“${location.name}”`,
						kept: managed.goneIds.has(location.id),
					},
					managed.domain,
				);
	}

	for (const persona of Object.values(personasOf(candidate))) {
		for (const locationId of assignedLocationUuids(persona.locations)) {
			const location = byId.get(locationId);
			const level =
				location === undefined ? undefined : levels[location.levelUuid];
			if (
				location === undefined ||
				location.archivedAt !== null ||
				level === undefined ||
				!levelHoldsWorkers(level)
			) {
				return `${persona.name} is assigned to “${location?.name ?? "a missing place"}”. Move that assignment before changing who can work at this level.`;
			}
		}
	}

	const verdictRows = locations.map((location) => ({
		id: location.id,
		name: location.name,
		levelUuid: location.levelUuid,
		parentId: location.parentId,
		archivedAt: location.archivedAt,
	}));
	const reverseLevels = new Set<string>();
	for (const form of Object.values(candidate.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (owner?.kind !== "term") continue;
			if (owner.term.kind === "fixed-location") {
				const issue = fixedLocationOwnerIssue(
					candidate,
					verdictRows,
					owner.term.locationUuid,
				);
				if (issue !== undefined) return issue;
			}
			if (owner.term.kind === "owner-location-at-level") {
				reverseLevels.add(owner.term.levelUuid);
			}
		}
	}
	for (const destinationLevelUuid of reverseLevels) {
		const issue = reverseLocationOwnerRefusal(
			candidate,
			verdictRows,
			destinationLevelUuid,
			managed,
		);
		if (issue !== undefined) return issue;
	}
	return undefined;
}
