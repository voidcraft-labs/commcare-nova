import {
	ancestorLevels,
	assignedLocationUuids,
	asUuid,
	type BlueprintDoc,
	levelHoldsWorkers,
	levelOwnsCases,
	type OrganizationCollections,
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

/** The database row shape every caller projects into {@link OwnerVerdictLocation}. */
export interface OwnerVerdictLocationRow {
	readonly id: string;
	readonly name: string;
	readonly level_uuid: string;
	readonly parent_id: string | null;
	readonly archived_at: unknown | null;
}

/** Project stored place rows into the verdict shape.
 *
 * One mapper, because the commit gate, the owner set, and the fixture
 * footprint all ask the same predicates of the same five fields; a second
 * projection is a second place for `archived_at` to be read as truthy. */
export function ownerVerdictRows(
	rows: readonly OwnerVerdictLocationRow[],
): OwnerVerdictLocation[] {
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		levelUuid: row.level_uuid,
		parentId: row.parent_id,
		archivedAt: row.archived_at,
	}));
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

/**
 * The organization slice is all these predicates read.
 *
 * Declared narrower than `BlueprintDoc` on purpose: the preview resolves a
 * worker's owner set from the authorized `PersistableDoc` snapshot, which
 * carries no `fieldParent` index and has no reason to build one to answer a
 * question about places. `BlueprintDoc` is assignable here, so every caller
 * that already had one is unaffected.
 */
function levelDepth(
	levelUuid: string,
	doc: OrganizationCollections,
): number | undefined {
	const levels = organizationLevelsOf(doc);
	const level = levels[levelUuid];
	return level === undefined ? undefined : ancestorLevels(level, levels).length;
}

/**
 * HQ compares a candidate's actual location-tree depth with the configured
 * location-type depth. Those differ on Nova's legal ragged trees: a Facility
 * directly below a Region is one location hop deep even if Facility is two
 * rungs deep in the authored level forest.
 */
function locationIsWithinDepth(
	candidate: OwnerVerdictLocation,
	bottomLevelUuid: string,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
	doc: OrganizationCollections,
): boolean {
	const candidateDepth = ancestors(candidate, byId).length;
	const bottomDepth = levelDepth(bottomLevelUuid, doc);
	return bottomDepth !== undefined && candidateDepth <= bottomDepth;
}

function topSliceIncludes(
	target: OwnerVerdictLocation,
	downToLevelUuid: string | undefined,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
	doc: OrganizationCollections,
): boolean {
	return (
		downToLevelUuid === undefined ||
		locationIsWithinDepth(target, downToLevelUuid, byId, doc)
	);
}

export function assignmentFootprintIncludes(
	target: OwnerVerdictLocation,
	assigned: OwnerVerdictLocation,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
	doc: OrganizationCollections,
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
						locationIsWithinDepth(target, book.downToLevelUuid, byId, doc))) ||
				(book.alsoIncludeTopDownToLevelUuid !== undefined &&
					topSliceIncludes(
						target,
						book.alsoIncludeTopDownToLevelUuid,
						byId,
						doc,
					))
			);
		case "own-branch-limited":
			return (
				targetIsAncestor ||
				(targetInOwnBranch &&
					book.levelUuids.some((uuid) => uuid === target.levelUuid)) ||
				(book.alsoIncludeTopDownToLevelUuid !== undefined &&
					topSliceIncludes(
						target,
						book.alsoIncludeTopDownToLevelUuid,
						byId,
						doc,
					))
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
						locationIsWithinDepth(target, book.downToLevelUuid, byId, doc)))
			);
		}
		case "whole-organization":
			return topSliceIncludes(target, book.downToLevelUuid, byId, doc);
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

/** Whether one assignment can RECEIVE cases owned by `source`.
 *
 * Case delivery is intentionally independent from address-book visibility.
 * A reverse owner hop is applicable when a persona can receive the source
 * case; only after that independent decision do we require the destination in
 * the persona's address-book fixture.
 *
 * Exported because the owner set is this same rule ENUMERATED rather than
 * asked one target at a time (`./ownerSets`). Two encodings of case delivery
 * would drift, and the one that drifted would be the one nobody reads.
 */
export function assignmentReceivesCasesFrom(
	source: OwnerVerdictLocation,
	assigned: OwnerVerdictLocation,
	byId: ReadonlyMap<string, OwnerVerdictLocation>,
	doc: OrganizationCollections,
): boolean {
	const levels = organizationLevelsOf(doc);
	const assignedLevel = levels[assigned.levelUuid];
	if (assignedLevel?.caseFlow.workers !== "assigned") return false;
	if (source.id === assigned.id) return true;
	if (!isSameOrDescendant(source, assigned, byId)) return false;
	const scope = assignedLevel.caseFlow.descendantCases;
	if (scope.kind === "none") return false;
	if (scope.kind === "all") return true;
	return locationIsWithinDepth(source, scope.levelUuid, byId, doc);
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
	if (!levelOwnsCases(destinationLevel)) {
		return `${destinationLevel.name} does not own cases. Choose a case-owning destination level.`;
	}
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
			const receivesSourceCases = assigned.some((row) =>
				assignmentReceivesCasesFrom(source, row, byId, doc),
			);
			if (!receivesSourceCases) continue;
			const destinationIsReachable = assigned.some((row) =>
				assignmentFootprintIncludes(destination, row, byId, doc),
			);
			if (!destinationIsReachable) {
				return `The ${destinationLevel.name} owner rule can resolve to "${destination.name}", but that place is outside ${persona.name}'s address book. Widen the address book or choose a fixed place the worker carries.`;
			}
		}
	}
	for (const source of live) {
		if (source.levelUuid !== sourceLevel.uuid) continue;
		if (firstBySource.has(source.id)) continue;
		return `The owner rule for ${destinationLevel.name} has no live ${destinationLevel.name.toLowerCase()} below "${source.name}". Add exactly one there (include it in the same create request's descendants when adding this source), or choose a fixed place owner.`;
	}
	return undefined;
}

function authoredLocationReferenceIssue(
	doc: BlueprintDoc,
	rows: readonly OwnerVerdictLocation[],
): string | undefined {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const levels = organizationLevelsOf(doc);
	for (const persona of Object.values(personasOf(doc))) {
		for (const locationId of assignedLocationUuids(persona.locations)) {
			const row = byId.get(locationId);
			const level = row === undefined ? undefined : levels[row.levelUuid];
			if (
				row === undefined ||
				row.archivedAt !== null ||
				level === undefined ||
				!levelHoldsWorkers(level)
			) {
				return `${persona.name} cannot work at "${row?.name ?? "a missing place"}". Choose a live place at a level where people work.`;
			}
		}
	}
	const reverseLevels = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (owner?.kind !== "term") continue;
			if (owner.term.kind === "fixed-location") {
				const issue = fixedLocationOwnerIssue(
					doc,
					rows,
					owner.term.locationUuid,
				);
				if (issue !== undefined) return issue;
			}
			if (owner.term.kind === "owner-location-at-level") {
				reverseLevels.add(owner.term.levelUuid);
			}
		}
	}
	for (const levelUuid of reverseLevels) {
		const issue = reverseLocationOwnerIssue(doc, rows, levelUuid);
		if (issue !== undefined) return issue;
	}
	return undefined;
}

/** Pure Builder preflight for replacing one persona's complete assignment. */
export function personaAssignmentIssue(
	doc: BlueprintDoc,
	rows: readonly OwnerVerdictLocation[],
	personaUuid: string,
	locationIds: readonly string[],
): string | undefined {
	const persona = personasOf(doc)[personaUuid];
	if (persona === undefined) return "This persona no longer exists.";
	const unique = [...new Set(locationIds)];
	const [primaryUuid, ...additionalUuids] = unique;
	const candidatePersona = {
		...persona,
		...(primaryUuid === undefined
			? { locations: undefined }
			: {
					locations: {
						primaryUuid: asUuid(primaryUuid),
						...(additionalUuids.length === 0
							? {}
							: { additionalUuids: additionalUuids.map(asUuid) }),
					},
				}),
	};
	const candidate: BlueprintDoc = {
		...doc,
		personas: { ...personasOf(doc), [personaUuid]: candidatePersona },
	};
	return authoredLocationReferenceIssue(candidate, rows);
}

/**
 * Preflight every removal from one persona without rebuilding and validating
 * the complete organization once per rendered row.
 *
 * Removing an assignment cannot change place topology, fixed-owner validity,
 * reverse-hop totality, or another persona. It can only shrink this persona's
 * address-book footprint (and, independently, the cases they receive), so the
 * shared topology and authored owner targets are prepared once and each
 * candidate checks only that delta.
 */
export function personaAssignmentRemovalIssues(
	doc: BlueprintDoc,
	rows: readonly OwnerVerdictLocation[],
	personaUuid: string,
	locationIds: readonly string[],
	candidateRemovalIds: readonly string[] = locationIds,
): ReadonlyMap<string, string> {
	const issues = new Map<string, string>();
	const persona = personasOf(doc)[personaUuid];
	if (persona === undefined) {
		for (const id of candidateRemovalIds)
			issues.set(id, "This persona no longer exists.");
		return issues;
	}
	const byId = new Map(rows.map((row) => [row.id, row]));
	const levels = organizationLevelsOf(doc);
	const fixedTargets: OwnerVerdictLocation[] = [];
	const reverseLevelUuids = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (owner?.kind !== "term") continue;
			if (owner.term.kind === "fixed-location") {
				const target = byId.get(owner.term.locationUuid);
				if (target !== undefined) fixedTargets.push(target);
			}
			if (owner.term.kind === "owner-location-at-level") {
				reverseLevelUuids.add(owner.term.levelUuid);
			}
		}
	}
	const live = rows.filter((row) => row.archivedAt === null);
	const liveById = new Map(live.map((row) => [row.id, row]));
	const reversePairs: Array<{
		source: OwnerVerdictLocation;
		destination: OwnerVerdictLocation;
		destinationLevelName: string;
	}> = [];
	for (const destinationLevelUuid of reverseLevelUuids) {
		const destinationLevel = levels[destinationLevelUuid];
		if (destinationLevel === undefined) continue;
		const sourceLevel = ancestorLevels(destinationLevel, levels).find(
			levelOwnsCases,
		);
		if (sourceLevel === undefined) continue;
		for (const destination of live) {
			if (destination.levelUuid !== destinationLevelUuid) continue;
			const source = ancestors(destination, liveById).find(
				(ancestor) => ancestor.levelUuid === sourceLevel.uuid,
			);
			if (source !== undefined) {
				reversePairs.push({
					source,
					destination,
					destinationLevelName: destinationLevel.name,
				});
			}
		}
	}

	for (const removedId of candidateRemovalIds) {
		const assigned = locationIds
			.filter((id) => id !== removedId)
			.map((id) => byId.get(id));
		const invalidIndex = assigned.findIndex((row) => {
			const level = row === undefined ? undefined : levels[row.levelUuid];
			return (
				row === undefined ||
				row.archivedAt !== null ||
				level === undefined ||
				!levelHoldsWorkers(level)
			);
		});
		if (invalidIndex >= 0) {
			const invalid = assigned[invalidIndex];
			issues.set(
				removedId,
				`${persona.name} cannot work at "${invalid?.name ?? "a missing place"}". Choose a live place at a level where people work.`,
			);
			continue;
		}
		const liveAssigned = assigned.filter(
			(row): row is OwnerVerdictLocation => row !== undefined,
		);
		if (liveAssigned.length === 0) continue;
		const fixedOutside = fixedTargets.find(
			(target) =>
				!liveAssigned.some((row) =>
					assignmentFootprintIncludes(target, row, byId, doc),
				),
		);
		if (fixedOutside !== undefined) {
			issues.set(
				removedId,
				`"${fixedOutside.name}" is outside ${persona.name}'s address book. Change that level's visibility or choose a destination this worker can carry on the device.`,
			);
			continue;
		}
		const reverseOutside = reversePairs.find(
			({ source, destination }) =>
				liveAssigned.some((row) =>
					assignmentReceivesCasesFrom(source, row, liveById, doc),
				) &&
				!liveAssigned.some((row) =>
					assignmentFootprintIncludes(destination, row, liveById, doc),
				),
		);
		if (reverseOutside !== undefined) {
			issues.set(
				removedId,
				`The ${reverseOutside.destinationLevelName} owner rule can resolve to "${reverseOutside.destination.name}", but that place is outside ${persona.name}'s address book. Widen the address book or choose a fixed place the worker carries.`,
			);
		}
	}
	return issues;
}

/** Pure Builder preflight for a move/retype before its Server Action. */
export function locationTopologyChangeIssue(
	doc: BlueprintDoc,
	rows: readonly OwnerVerdictLocation[],
	locationId: string,
	patch: { readonly levelUuid?: string; readonly parentId?: string | null },
): string | undefined {
	const candidateRows = rows.map((row) =>
		row.id === locationId ? { ...row, ...patch } : row,
	);
	return authoredLocationReferenceIssue(doc, candidateRows);
}
