import {
	ancestorLevels,
	assignedLocationUuids,
	type BlueprintDoc,
	levelOwnsCases,
	organizationLevelsOf,
	personasOf,
} from "@/lib/domain";

/** The topology fields shared by stored rows and the browser projection. */
export interface OwnerVerdictLocation {
	readonly id: string;
	readonly name: string;
	readonly levelUuid: string;
	readonly parentId: string | null;
	readonly archivedAt: unknown | null;
}

function ancestors(
	row: OwnerVerdictLocation,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
): OwnerVerdictLocation[] {
	const out: OwnerVerdictLocation[] = [];
	const seen = new Set<string>([row.id]);
	let parentId = row.parentId;
	while (parentId !== null && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (parent === undefined) break;
		out.push(parent);
		parentId = parent.parentId;
	}
	return out;
}

function isSameOrDescendant(
	candidate: OwnerVerdictLocation,
	root: OwnerVerdictLocation,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
): boolean {
	return (
		candidate.id === root.id ||
		ancestors(candidate, byId).some((ancestor) => ancestor.id === root.id)
	);
}

function levelIsAtOrAbove(
	candidateLevelUuid: string,
	bottomLevelUuid: string,
	doc: BlueprintDoc,
): boolean {
	if (candidateLevelUuid === bottomLevelUuid) return true;
	const levels = organizationLevelsOf(doc);
	const bottom = levels[bottomLevelUuid];
	return (
		bottom !== undefined &&
		ancestorLevels(bottom, levels).some(
			(ancestor) => ancestor.uuid === candidateLevelUuid,
		)
	);
}

function topSliceIncludes(
	target: OwnerVerdictLocation,
	downToLevelUuid: string | undefined,
	doc: BlueprintDoc,
): boolean {
	return (
		downToLevelUuid === undefined ||
		levelIsAtOrAbove(target.levelUuid, downToLevelUuid, doc)
	);
}

export function assignmentFootprintIncludes(
	target: OwnerVerdictLocation,
	assigned: OwnerVerdictLocation,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
	doc: BlueprintDoc,
): boolean {
	const levels = organizationLevelsOf(doc);
	const assignedLevel = levels[assigned.levelUuid];
	if (assignedLevel === undefined) return false;
	const book = assignedLevel.addressBook;
	const targetIsAncestor = ancestors(assigned, byId).some(
		(ancestor) => ancestor.id === target.id,
	);
	const targetInOwnBranch = isSameOrDescendant(target, assigned, byId);

	switch (book.reach) {
		case "own-branch":
			return (
				targetIsAncestor ||
				(targetInOwnBranch &&
					(book.downToLevelUuid === undefined ||
						levelIsAtOrAbove(target.levelUuid, book.downToLevelUuid, doc))) ||
				(book.alsoIncludeTopDownToLevelUuid !== undefined &&
					topSliceIncludes(target, book.alsoIncludeTopDownToLevelUuid, doc))
			);
		case "own-branch-limited":
			return (
				targetIsAncestor ||
				(targetInOwnBranch &&
					book.levelUuids.some((uuid) => uuid === target.levelUuid)) ||
				(book.alsoIncludeTopDownToLevelUuid !== undefined &&
					topSliceIncludes(target, book.alsoIncludeTopDownToLevelUuid, doc))
			);
		case "shared-branch": {
			const from = [assigned, ...ancestors(assigned, byId)].find(
				(row) => row.levelUuid === book.fromLevelUuid,
			);
			return (
				targetIsAncestor ||
				(from !== undefined &&
					isSameOrDescendant(target, from, byId) &&
					(book.downToLevelUuid === undefined ||
						levelIsAtOrAbove(target.levelUuid, book.downToLevelUuid, doc)))
			);
		}
		case "whole-organization":
			return topSliceIncludes(target, book.downToLevelUuid, doc);
	}
}

function liveAssignments(
	doc: BlueprintDoc,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
) {
	return Object.values(personasOf(doc)).map((persona) => ({
		persona,
		assigned: assignedLocationUuids(persona.locations)
			.map((uuid) => byId.get(uuid))
			.filter(
				(row): row is OwnerVerdictLocation =>
					row !== undefined && row.archivedAt === null,
			),
	}));
}

/** The exact fixed-owner admission verdict, also used to filter its picker. */
export function fixedLocationOwnerIssue(
	doc: BlueprintDoc,
	rows: readonly OwnerVerdictLocation[],
	targetId: string,
): string | undefined {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const target = byId.get(targetId);
	const level =
		target === undefined
			? undefined
			: organizationLevelsOf(doc)[target.levelUuid];
	if (
		target === undefined ||
		target.archivedAt !== null ||
		level === undefined
	) {
		return "A case owner points at a place that no longer exists or is archived. Reload the organization, then choose a live place.";
	}
	if (!levelOwnsCases(level)) {
		return `"${target.name}" is at the ${level.name} level, which does not own cases. Choose a place at a case-owning level.`;
	}
	for (const { persona, assigned } of liveAssignments(doc, byId)) {
		if (assigned.length === 0) continue;
		if (
			assigned.some((row) =>
				assignmentFootprintIncludes(target, row, byId, doc),
			)
		) {
			continue;
		}
		return `"${target.name}" is outside ${persona.name}'s address book. Change that level's visibility or choose a destination this worker can carry on the device.`;
	}
	return undefined;
}

/** The exact reverse-hop scalar/footprint verdict for one destination level. */
export function reverseLocationOwnerIssue(
	doc: BlueprintDoc,
	rows: readonly OwnerVerdictLocation[],
	destinationLevelUuid: string,
): string | undefined {
	const levels = organizationLevelsOf(doc);
	const destinationLevel = levels[destinationLevelUuid];
	if (destinationLevel === undefined)
		return "The owner level no longer exists.";
	const sourceLevel = ancestorLevels(destinationLevel, levels).find(
		levelOwnsCases,
	);
	if (sourceLevel === undefined) {
		return `${destinationLevel.name} has no case-owning level above it.`;
	}
	const live = rows.filter((row) => row.archivedAt === null);
	const byId = new Map(live.map((row) => [row.id, row]));
	const assignments = liveAssignments(doc, byId);
	const firstBySource = new Map<string, OwnerVerdictLocation>();
	for (const destination of live) {
		if (destination.levelUuid !== destinationLevelUuid) continue;
		const source = ancestors(destination, byId).find(
			(ancestor) => ancestor.levelUuid === sourceLevel.uuid,
		);
		if (source === undefined) continue;
		const first = firstBySource.get(source.id);
		if (first !== undefined) {
			return `The owner rule for ${destinationLevel.name} is ambiguous below "${source.name}": both "${first.name}" and "${destination.name}" match. Keep one live ${destinationLevel.name.toLowerCase()} there, or choose a fixed place owner.`;
		}
		firstBySource.set(source.id, destination);
		for (const { persona, assigned } of assignments) {
			if (assigned.length === 0) continue;
			const sourceIsReachable = assigned.some((row) =>
				assignmentFootprintIncludes(source, row, byId, doc),
			);
			if (!sourceIsReachable) continue;
			const destinationIsReachable = assigned.some((row) =>
				assignmentFootprintIncludes(destination, row, byId, doc),
			);
			if (!destinationIsReachable) {
				return `The ${destinationLevel.name} owner rule can resolve to "${destination.name}", but that place is outside ${persona.name}'s address book. Widen the address book or choose a fixed place the worker carries.`;
			}
		}
	}
	return undefined;
}
