import {
	assignedLocationUuids,
	type BlueprintDoc,
	levelHoldsWorkers,
	levelMayNestUnder,
	type OrganizationLevel,
	organizationLevelsOf,
	personasOf,
	type Uuid,
} from "@/lib/domain";
import {
	fixedLocationOwnerIssue,
	reverseLocationOwnerIssue,
} from "./ownerTargetVerdicts";
import type { StoredLocation } from "./types";

export type OrganizationLevelPatch = Partial<
	Omit<OrganizationLevel, "uuid" | "code" | "parentLevelUuid">
> & { readonly parentLevelUuid?: Uuid | null };

function candidateWithLevelPatch(
	doc: BlueprintDoc,
	levelUuid: string,
	patch: OrganizationLevelPatch,
): BlueprintDoc | undefined {
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
 */
export function organizationLevelPatchIssue(
	doc: BlueprintDoc,
	locations: readonly StoredLocation[],
	levelUuid: string,
	patch: OrganizationLevelPatch,
): string | undefined {
	const candidate = candidateWithLevelPatch(doc, levelUuid, patch);
	if (candidate === undefined) return "This level no longer exists.";
	const levels = organizationLevelsOf(candidate);
	const byId = new Map<string, StoredLocation>(
		locations.map((location) => [location.id, location]),
	);

	for (const location of locations) {
		const level = levels[location.levelUuid];
		if (level === undefined) {
			return `“${location.name}” stands at a level this change removes.`;
		}
		if (location.parentId === null) {
			if (level.parentLevelUuid !== undefined) {
				return `“${location.name}” would be left without a parent place. Bring it back first if it is archived, move it to a valid parent, then retry this level change.`;
			}
			continue;
		}
		const parent = byId.get(location.parentId);
		if (
			parent === undefined ||
			!levelMayNestUnder(location.levelUuid, parent.levelUuid, levels)
		) {
			return `“${location.name}” would no longer sit under a place at a level above it. Bring it back first if it is archived, move it to a valid parent, then retry this level change.`;
		}
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
		const issue = reverseLocationOwnerIssue(
			candidate,
			verdictRows,
			destinationLevelUuid,
		);
		if (issue !== undefined) return issue;
	}
	return undefined;
}
