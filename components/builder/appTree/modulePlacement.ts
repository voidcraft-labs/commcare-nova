import type { Uuid } from "@/lib/domain";

export type ModulePlacement = {
	readonly parentModuleUuid?: Uuid | null;
	readonly after: Uuid | null;
};

/** Deterministic destination used by both row actions and module settings.
 * Placement changes append in the chosen sibling group; explicit up/down
 * actions handle finer ordering afterward. */
export function placementAtEnd(
	moduleUuid: Uuid,
	nextParentModuleUuid: Uuid | null,
	rootModuleUuids: readonly Uuid[],
	childModuleUuidsByRoot: Readonly<Record<Uuid, readonly Uuid[]>>,
): Required<ModulePlacement> {
	return {
		parentModuleUuid: nextParentModuleUuid,
		after:
			nextParentModuleUuid === null
				? (rootModuleUuids.filter((uuid) => uuid !== moduleUuid).at(-1) ?? null)
				: (childModuleUuidsByRoot[nextParentModuleUuid]?.at(-1) ?? null),
	};
}

/** Narrow reorder: omission of parentModuleUuid preserves the live sibling
 * group, so a stale reorder cannot undo a collaborator's reparent. */
export function siblingMovePlacement(
	moduleUuid: Uuid,
	siblingModuleUuids: readonly Uuid[],
	direction: "up" | "down",
): ModulePlacement | undefined {
	const index = siblingModuleUuids.indexOf(moduleUuid);
	if (direction === "up") {
		if (index <= 0) return undefined;
		return {
			after: index === 1 ? null : (siblingModuleUuids[index - 2] ?? null),
		};
	}
	if (index < 0 || index >= siblingModuleUuids.length - 1) return undefined;
	return { after: siblingModuleUuids[index + 1] ?? null };
}
